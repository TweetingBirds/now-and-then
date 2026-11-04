// Cloudflare Worker: sync endpoint for Now and Then.
//
// Stores each board as one JSON document in Workers KV, protected by a bearer token.
// Each device PUTs its whole board; the Worker merges it with what it already has
// (the newest edit wins for each list, each todo and the settings) and returns the
// merged board, so two devices editing at once don't overwrite each other.
//
// Two kinds of token open a board:
//
// - Owner tokens. Every secret named TOKEN_<NAME> (for example TOKEN_NATE) is one
//   person's token, and their board is stored under "board:<name>". These are set
//   by hand with `wrangler secret put` and deploys never touch them.
// - Invited tokens. Someone listed in ADMINS (a plain var in wrangler.toml) creates
//   an invite in the app. Opening the invite link calls POST /join, which creates a
//   new board "board:b_<random>" and a token for it. Only a SHA-256 hash of the
//   token is stored, under "tok:<hash>", so the KV namespace never holds a usable
//   token. The person holding an invited token can delete their board, its backups
//   and the token itself with DELETE /data?confirm=delete.
//
// Shared lists: one list can live on several boards at once (a family's
// "Groceries", say) while the rest of each board stays private. A shared list is
// its own document, "shared:s_<random>", holding the list's name and color, its
// todos and who's on it. Each member's board keeps only a small placement record
// in board.shared ([{ sid, order, updatedAt }]), so everyone can put the list
// wherever they like. GET /data returns the board with its shared lists mixed in
// (each marked with list.shared = sid and list.members = names); PUT /data splits
// the incoming board back apart by each todo's listId. Moving a todo out of a
// shared list leaves a tombstone in the shared document, so the other members'
// devices drop it instead of writing it back. Endpoints:
//   POST   /shared                { listId }  turn one of your lists into a shared list
//   POST   /shared/<sid>/invites              make a one-time link for someone else
//   POST   /shared/join           { code }    add a shared list to your board
//   DELETE /shared/<sid>                      leave it (the last one out deletes it)
//
// Backups: once a day (the cron trigger in wrangler.toml) the Worker copies every
// board to a snapshot key "snap:<board>:<ISO time>" that KV deletes by itself after
// SNAPSHOT_DAYS. The app also asks for a snapshot right before it restores a backup.
// GET /snapshots lists a board's snapshots, GET /snapshots/<id> returns one, and
// POST /snapshots takes one now. A token only ever sees its own board's snapshots.
//
// Everything here stays inside Workers KV's free tier for a family-sized group: see
// "Costs and limits" in the README.
//
// Bindings (see wrangler.toml and the README):
//   KV namespace binding:  NOW_AND_THEN
//   Secrets:               TOKEN_<NAME>, one per owner (any long random string)
//   Vars:                  ADMINS      owner names who may create invites, e.g. "nate"
//                          MAX_BOARDS  how many invited boards may exist (default 50)
//                          MAX_SHARED  how many shared lists may exist (default 100)

const TOMBSTONE_DAYS = 60;
const SNAPSHOT_DAYS = 30;
const INVITE_DAYS = 14;    // default life of an invite link
const GONE_DAYS = 30;      // how long a deleted token answers "board deleted" instead of 401
const SNAP_ID = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const INVITE_CODE = /^[A-Za-z0-9_-]{22}$/;
const BOARD_ID = /^b_[a-f0-9]{16}$/;
const SHARED_ID = /^s_[a-f0-9]{16}$/;
const MAX_LISTS = 10;      // same as the app: shared lists count toward it
const MAX_MEMBERS = 10;    // boards per shared list
const UNSHAREABLE = new Set(["now", "tomorrow"]); // the morning rollover moves todos between these
const EMPTY = () => ({ version: 1, settings: {}, lists: [], todos: [] });

// ---------- tokens ----------

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function hashToken(token) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
}
const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 40);

// Owner tokens: finds whose TOKEN_* secret this is. Returns { board } for a match,
// { clash: [names] } when two secrets hold the same value (that would silently put
// two people on one board, so it is refused), or null. Both sides are trimmed,
// because a pasted secret often carries a trailing newline.
function ownerOf(token, env) {
  const names = [];
  for (const [name, raw] of Object.entries(env)) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (name.startsWith("TOKEN_") && value.length >= 16 && value === token) names.push(name.slice(6).toLowerCase());
  }
  if (names.length > 1) return { clash: names.sort() };
  return names.length ? { board: names[0], name: names[0], kind: "owner" } : null;
}

const firstName = (name) => (name ? name.charAt(0).toUpperCase() + name.slice(1) : "");
const admins = (env) => String(env.ADMINS || "").toLowerCase().split(/[\s,]+/).filter(Boolean);

// Invited tokens are looked up in KV. The 20-second auto-sync means a phone left
// open reads /data often, so read-only requests reuse a lookup for a minute
// within the same Worker instance to halve KV reads. Anything that writes or
// deletes always reads the token fresh, so a deleted board can't be written back.
const tokenCache = new Map();
const CACHE_MS = 60_000;

// Returns { board, name, kind, admin } for a good token, { gone: true } for a token
// whose board was deleted, { clash } for duplicate owner secrets, or null.
export async function whoIs(request, env, { fresh = false } = {}) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const owner = ownerOf(token, env);
  if (owner) return owner.clash ? owner : { ...owner, admin: admins(env).includes(owner.board) };
  if (!token.startsWith("nt_")) return null;
  const hash = await hashToken(token);
  const hit = tokenCache.get(hash);
  if (!fresh && hit && hit.until > Date.now()) return hit.who;
  let who = null;
  const rec = await env.NOW_AND_THEN.get("tok:" + hash, "json");
  if (rec && BOARD_ID.test(rec.board)) who = { board: rec.board, name: rec.name || "", kind: "invited", admin: false, hash };
  else if (await env.NOW_AND_THEN.get("gone:" + hash)) who = { gone: true };
  if (who && !who.gone) tokenCache.set(hash, { who, until: Date.now() + CACHE_MS });
  else tokenCache.delete(hash);
  return who;
}

// ---------- snapshots ----------

// Copies a board into a snapshot key that expires on its own. The metadata lets
// GET /snapshots describe each one without reading it.
export async function takeSnapshot(env, board, data, reason) {
  const at = new Date().toISOString();
  const live = (xs) => (xs || []).filter((x) => x && !x.deleted);
  const metadata = {
    at,
    reason,
    lists: live(data.lists).length,
    todos: live(data.todos).filter((t) => !t.archived).length,
    done: live(data.todos).filter((t) => t.archived).length,
  };
  await env.NOW_AND_THEN.put(`snap:${board}:${at}`, JSON.stringify(data), {
    expirationTtl: SNAPSHOT_DAYS * 86400,
    metadata,
  });
  return { id: at, ...metadata };
}

async function listKeys(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.NOW_AND_THEN.list({ prefix, cursor });
    out.push(...page.keys);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

async function listSnapshots(env, board) {
  const prefix = `snap:${board}:`;
  return (await listKeys(env, prefix))
    .map((k) => ({ id: k.name.slice(prefix.length), ...(k.metadata || {}) }))
    .sort((a, b) => b.id.localeCompare(a.id)); // newest first
}

// The daily cron: snapshot every board that has anything on it.
// Snapshots hold the board as its owner sees it, shared lists included.
export async function snapshotAll(env) {
  for (const k of await listKeys(env, "board:")) {
    const data = await env.NOW_AND_THEN.get(k.name, "json");
    if (!data || !Array.isArray(data.lists)) continue;
    const view = await openBoard(env, k.name.slice(6), data);
    if (view.board.lists.length) await takeSnapshot(env, k.name.slice(6), view.board, "daily");
  }
}

// Removes a board and every copy of it. For an invited board the token goes too,
// and a small marker (the token's hash, nothing else) stays for GONE_DAYS so the
// person's other devices are told the board was deleted instead of "wrong token".
export async function deleteBoard(env, board, hash) {
  const stored = await env.NOW_AND_THEN.get("board:" + board, "json");
  for (const m of (stored && stored.shared) || []) await leaveShared(env, board, m.sid);
  const snaps = await listKeys(env, `snap:${board}:`);
  for (const k of snaps) await env.NOW_AND_THEN.delete(k.name);
  await env.NOW_AND_THEN.delete("board:" + board);
  if (hash) {
    await env.NOW_AND_THEN.delete("tok:" + hash);
    await env.NOW_AND_THEN.put("gone:" + hash, "1", { expirationTtl: GONE_DAYS * 86400 });
    tokenCache.delete(hash);
  }
  return { deleted: true, board, snapshots: snaps.length };
}

// ---------- merge ----------

// Keep in sync with mergeBoards() in app/app.js.
export function mergeBoards(a, b) {
  const cutoff = Date.now() - TOMBSTONE_DAYS * 864e5;
  const mergeById = (x = [], y = []) => {
    const m = new Map();
    for (const item of [...x, ...y]) {
      if (!item || typeof item.id !== "string") continue;
      const prev = m.get(item.id);
      if (!prev || (item.updatedAt || 0) >= (prev.updatedAt || 0)) m.set(item.id, item);
    }
    return [...m.values()].filter((i) => !(i.deleted && (i.updatedAt || 0) < cutoff));
  };
  const sa = (a && a.settings) || {}, sb = (b && b.settings) || {};
  return {
    version: 1,
    settings: (sb.updatedAt || 0) >= (sa.updatedAt || 0) ? sb : sa,
    lists: mergeById(a && a.lists, b && b.lists),
    todos: mergeById(a && a.todos, b && b.todos),
  };
}

// ---------- shared lists ----------

const stamp = (x) => (x && x.updatedAt) || 0;
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pruneTombstones = (xs) => {
  const cutoff = Date.now() - TOMBSTONE_DAYS * 864e5;
  return xs.filter((i) => !(i.deleted && stamp(i) < cutoff));
};
// Newest wins. A tie between a live copy and a tombstone is a todo that moved
// from one shared list to another list at that moment: the live copy wins.
function pickNewest(groups) {
  const m = new Map();
  for (const xs of groups) for (const item of xs || []) {
    if (!item || typeof item.id !== "string") continue;
    const prev = m.get(item.id);
    if (!prev || stamp(item) > stamp(prev) || (stamp(item) === stamp(prev) && prev.deleted && !item.deleted)) m.set(item.id, item);
  }
  return [...m.values()];
}
const memberNames = (doc) => doc.members.map((x) => x.name || "Someone");
const sharedKey = (sid) => "shared:" + sid;

// Reads a board's shared lists. Placements whose list is gone (the last member
// left) or that no longer name this board are dropped.
export async function openBoard(env, boardId, stored) {
  stored = stored || EMPTY();
  const docs = new Map();
  const shared = [];
  for (const m of stored.shared || []) {
    if (!m || !SHARED_ID.test(m.sid) || docs.has(m.sid)) continue;
    const doc = await env.NOW_AND_THEN.get(sharedKey(m.sid), "json");
    if (doc && doc.members.some((x) => x.board === boardId)) { docs.set(m.sid, doc); shared.push(m); }
  }
  return { stored, docs, shared, board: compose(stored, docs, shared) };
}

// The board as the app sees it: its own lists and todos plus each shared list,
// placed where this person put it.
function compose(stored, docs, shared) {
  const lists = [...(stored.lists || [])];
  const groups = [stored.todos || []];
  for (const m of shared) {
    const doc = docs.get(m.sid);
    lists.push({ ...doc.list, order: m.order, updatedAt: Math.max(stamp(doc.list), stamp(m)), shared: m.sid, members: memberNames(doc) });
    groups.push(doc.todos);
  }
  return { version: 1, settings: stored.settings || {}, lists, todos: pickNewest(groups) };
}

// Merges an incoming board into the stored board and its shared lists, writes
// whatever changed, and returns the merged view.
export async function putBoard(env, who, stored, incoming) {
  const view = await openBoard(env, who.board, stored);
  const { docs } = view;
  let shared = view.shared.map((m) => ({ ...m }));
  const merged = mergeBoards(view.board, incoming);
  merged.todos = pickNewest([view.board.todos, incoming.todos || []]);
  const sidOf = new Map([...docs].map(([sid, doc]) => [doc.list.id, sid]));
  const before = new Map([...docs].map(([sid, doc]) => [sid, JSON.stringify(doc)]));
  const wasIn = new Map(); // todo id -> { sid, item } as stored in a shared list
  for (const [sid, doc] of docs) for (const t of doc.todos) wasIn.set(t.id, { sid, item: t });

  const leaving = new Set();
  const lists = [];
  for (const l of merged.lists) {
    const sid = sidOf.get(l.id);
    const { shared: _s, members: _m, ...plain } = l;
    if (!sid) { lists.push(plain); continue; }
    // Deleting a shared list (older app versions offer it) means leaving it.
    if (l.deleted) { leaving.add(sid); continue; }
    const doc = docs.get(sid), m = shared.find((x) => x.sid === sid);
    if (stamp(l) > stamp(doc.list)) {
      const { order: _o, ...rest } = plain;
      doc.list = { ...rest, role: null };
    }
    if (stamp(l) > stamp(m)) Object.assign(m, { order: l.order, updatedAt: stamp(l) });
  }

  const own = [];
  const into = new Map([...docs.keys()].map((sid) => [sid, []]));
  for (const t of merged.todos) {
    const sid = sidOf.get(t.listId);
    if (sid && leaving.has(sid)) continue;
    if (sid) into.get(sid).push(t); else own.push(t);
    // Moved out of a shared list: leave a tombstone there (or keep the one that's
    // already there) so the list's other members drop it instead of sending it back.
    const was = wasIn.get(t.id);
    if (was && was.sid !== sid && !leaving.has(was.sid)) {
      into.get(was.sid).push(was.item.deleted ? was.item : { id: t.id, listId: was.item.listId, deleted: true, updatedAt: stamp(t) });
    }
  }
  for (const [sid, doc] of docs) if (!leaving.has(sid)) doc.todos = pruneTombstones(pickNewest([into.get(sid)]));

  const next = { version: 1, settings: merged.settings, lists, todos: pruneTombstones(own), shared };
  for (const sid of leaving) {
    await leaveShared(env, who.board, sid, docs.get(sid));
    tombstoneLeft(next, docs.get(sid));
  }
  for (const [sid, doc] of docs) {
    if (!leaving.has(sid) && JSON.stringify(doc) !== before.get(sid)) await env.NOW_AND_THEN.put(sharedKey(sid), JSON.stringify(doc));
  }
  if (!sameJson(next, stored)) await env.NOW_AND_THEN.put("board:" + who.board, JSON.stringify(next));
  return compose(next, docs, next.shared);
}

// After leaving, the board keeps tombstones for the list and its todos, so this
// person's other devices remove them instead of sending them back.
function tombstoneLeft(boardDoc, doc) {
  // Newer than anything a device could still hold for this list.
  const mine = (boardDoc.shared || []).find((m) => m.sid === doc.sid);
  const t = Math.max(Date.now(), stamp(doc.list), stamp(mine), ...doc.todos.map(stamp)) + 1;
  boardDoc.shared = (boardDoc.shared || []).filter((m) => m.sid !== doc.sid);
  const gone = new Set([doc.list.id, ...doc.todos.map((x) => x.id)]);
  boardDoc.lists = boardDoc.lists.filter((x) => !gone.has(x.id));
  boardDoc.todos = boardDoc.todos.filter((x) => !gone.has(x.id));
  boardDoc.lists.push({ id: doc.list.id, deleted: true, updatedAt: t });
  for (const x of doc.todos) boardDoc.todos.push({ id: x.id, deleted: true, updatedAt: t });
}

// Takes one board off a shared list. The last member out deletes the list.
export async function leaveShared(env, boardId, sid, doc) {
  doc = doc || (await env.NOW_AND_THEN.get(sharedKey(sid), "json"));
  if (!doc) return null;
  doc.members = doc.members.filter((x) => x.board !== boardId);
  if (!doc.members.length) { await env.NOW_AND_THEN.delete(sharedKey(sid)); return doc; }
  doc.list = { ...doc.list, updatedAt: Date.now() }; // everyone's member names refresh
  await env.NOW_AND_THEN.put(sharedKey(sid), JSON.stringify(doc));
  return doc;
}

const liveCount = (stored) => (stored.lists || []).filter((l) => !l.deleted).length + (stored.shared || []).length;

async function sharedApi(request, env, who, url) {
  const [, sid, sub] = url.pathname.replace(/\/+$/, "").match(/\/shared(?:\/([^/]+))?(?:\/([^/]+))?$/) || [];
  const m = request.method;
  const hdrs = boardHeaders(who);
  const KEY = "board:" + who.board;
  const stored = (await env.NOW_AND_THEN.get(KEY, "json")) || EMPTY();

  // Turn one of your lists into a shared list.
  if (m === "POST" && !sid) {
    const { value, error } = await readJson(request, 2000);
    if (error) return error;
    const list = (stored.lists || []).find((l) => l.id === value.listId && !l.deleted);
    if (!list) return json({ error: "list not found" }, 404, hdrs);
    if (UNSHAREABLE.has(list.role)) return json({ error: "can't share this list" }, 400, hdrs);
    const max = Number(env.MAX_SHARED) || 100;
    if ((await listKeys(env, "shared:")).length >= max) return json({ error: "full" }, 503, hdrs);
    const id = "s_" + hex(randomBytes(8));
    const t = Date.now();
    const doc = {
      version: 1, sid: id, created: new Date(t).toISOString(), by: who.board,
      list: { id: list.id, name: list.name, color: list.color, role: null, updatedAt: t },
      todos: (stored.todos || []).filter((x) => x.listId === list.id),
      members: [{ board: who.board, name: firstName(who.name), joined: new Date(t).toISOString() }],
    };
    stored.lists = stored.lists.filter((l) => l.id !== list.id);
    stored.todos = (stored.todos || []).filter((x) => x.listId !== list.id);
    stored.shared = [...(stored.shared || []), { sid: id, order: list.order, updatedAt: t }];
    await env.NOW_AND_THEN.put(sharedKey(id), JSON.stringify(doc));
    await env.NOW_AND_THEN.put(KEY, JSON.stringify(stored));
    return json({ sid: id, name: list.name }, 200, hdrs);
  }

  // Add a shared list to your board with a link someone on it sent you.
  if (m === "POST" && sid === "join") {
    const { value, error } = await readJson(request, 2000);
    if (error) return error;
    const code = String(value.code || "");
    const inv = INVITE_CODE.test(code) ? await env.NOW_AND_THEN.getWithMetadata("sinv:" + code) : { value: null };
    const meta = inv.metadata || {};
    const doc = inv.value !== null && SHARED_ID.test(meta.sid || "") ? await env.NOW_AND_THEN.get(sharedKey(meta.sid), "json") : null;
    if (!doc) return json({ error: "invite not found" }, 404, hdrs);
    if (doc.members.some((x) => x.board === who.board) && (stored.shared || []).some((x) => x.sid === doc.sid)) {
      return json({ sid: doc.sid, name: doc.list.name, already: true }, 200, hdrs);
    }
    if (doc.members.length >= MAX_MEMBERS) return json({ error: "list full" }, 409, hdrs);
    if (liveCount(stored) >= MAX_LISTS) return json({ error: "too many lists" }, 409, hdrs);
    await env.NOW_AND_THEN.delete("sinv:" + code);
    const t = Date.now();
    doc.members = [...doc.members.filter((x) => x.board !== who.board), { board: who.board, name: firstName(who.name), joined: new Date(t).toISOString() }];
    doc.list = { ...doc.list, updatedAt: t };
    // Clear tombstones from an earlier time on this list, or they'd hide it.
    const ids = new Set([doc.list.id, ...doc.todos.map((x) => x.id)]);
    stored.lists = (stored.lists || []).filter((x) => !ids.has(x.id));
    stored.todos = (stored.todos || []).filter((x) => !ids.has(x.id));
    const order = Math.max(0, ...stored.lists.filter((l) => !l.deleted).map((l) => l.order || 0), ...(stored.shared || []).map((x) => x.order || 0)) + 1;
    stored.shared = [...(stored.shared || []).filter((x) => x.sid !== doc.sid), { sid: doc.sid, order, updatedAt: t }];
    await env.NOW_AND_THEN.put(sharedKey(doc.sid), JSON.stringify(doc));
    await env.NOW_AND_THEN.put(KEY, JSON.stringify(stored));
    return json({ sid: doc.sid, name: doc.list.name, by: meta.byName || "" }, 200, hdrs);
  }

  if (!SHARED_ID.test(sid || "") || !(stored.shared || []).some((x) => x.sid === sid)) return json({ error: "not found" }, 404, hdrs);
  const doc = await env.NOW_AND_THEN.get(sharedKey(sid), "json");
  if (!doc || !doc.members.some((x) => x.board === who.board)) return json({ error: "not found" }, 404, hdrs);

  // A one-time link for someone else to add this list to their board.
  if (m === "POST" && sub === "invites") {
    const code = b64url(randomBytes(16));
    const expires = new Date(Date.now() + INVITE_DAYS * 864e5).toISOString();
    const metadata = { sid, by: who.board, byName: firstName(who.name), created: new Date().toISOString(), expires };
    await env.NOW_AND_THEN.put("sinv:" + code, "1", { expirationTtl: INVITE_DAYS * 86400, metadata });
    return json({ code, expires }, 200, hdrs);
  }

  // Leave it. It stays on everyone else's board.
  if (m === "DELETE" && !sub) {
    await leaveShared(env, who.board, sid, doc);
    tombstoneLeft(stored, doc);
    await env.NOW_AND_THEN.put(KEY, JSON.stringify(stored));
    return json({ left: true, deleted: doc.members.length === 0 }, 200, hdrs);
  }
  return json({ error: "method not allowed" }, 405, hdrs);
}

// ---------- HTTP ----------

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*", // security rests on the token
    "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Expect-Board",
    "Access-Control-Expose-Headers": "X-Board, X-Board-Name, X-Board-Kind, X-Board-Admin",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: cors({ "Content-Type": "application/json", ...extra }) });
}

// Tells the app whose board this is. X-Board is the board's id, which the app
// remembers to make sure a device never merges into a different board.
const boardHeaders = (who) => ({
  "X-Board": who.board,
  "X-Board-Name": encodeURIComponent(who.name || ""),
  "X-Board-Kind": who.kind,
  ...(who.admin ? { "X-Board-Admin": "1" } : {}),
});

async function readJson(request, max = 4_000_000) {
  const body = await request.text();
  if (body.length > max) return { error: json({ error: "too large" }, 413) };
  if (!body) return { value: {} };
  try { return { value: JSON.parse(body) }; } catch (e) { return { error: json({ error: "bad json" }, 400) }; }
}

function authError(who) {
  if (!who) return json({ error: "unauthorized" }, 401);
  if (who.gone) return json({ error: "board deleted" }, 410);
  if (who.clash) return json({ error: "token clash", boards: who.clash }, 409);
  return null;
}

// POST /join { code, name } — no token needed; the invite code is the secret.
async function join(request, env) {
  const { value, error } = await readJson(request, 2000);
  if (error) return error;
  const code = String(value.code || "");
  if (!INVITE_CODE.test(code)) return json({ error: "invite not found" }, 404);
  const invite = await env.NOW_AND_THEN.getWithMetadata("inv:" + code);
  if (invite.value === null) return json({ error: "invite not found" }, 404);
  const max = Number(env.MAX_BOARDS) || 50;
  if ((await listKeys(env, "tok:")).length >= max) return json({ error: "full" }, 503);

  // Single use: the invite is deleted before the board is made. (KV is eventually
  // consistent, so two people opening one link in the same second could both get
  // in. Invites are made one at a time for people you know, so that's acceptable.)
  await env.NOW_AND_THEN.delete("inv:" + code);
  const token = "nt_" + b64url(randomBytes(32));
  const board = "b_" + hex(randomBytes(8));
  const name = cleanName(value.name);
  const meta = invite.metadata || {};
  const rec = { board, name, created: new Date().toISOString(), invite: cleanName(meta.label), by: meta.by || "" };
  // Metadata repeats the record, so GET /boards can list boards without reading each one.
  await env.NOW_AND_THEN.put("tok:" + (await hashToken(token)), JSON.stringify(rec), { metadata: rec });
  return json({ token, board, name }, 200, boardHeaders({ board, name, kind: "invited" }));
}

// Admin endpoints: create, list and revoke invites; list and remove invited boards.
async function admin(request, env, who, url) {
  if (!who.admin) return json({ error: "forbidden" }, 403);
  const [, area, id] = url.pathname.match(/\/(invites|boards)(?:\/([^/]+))?\/?$/);
  const m = request.method;

  if (area === "invites") {
    if (m === "POST" && !id) {
      const { value, error } = await readJson(request, 2000);
      if (error) return error;
      const days = Math.min(30, Math.max(1, Math.round(Number(value.days) || INVITE_DAYS)));
      const code = b64url(randomBytes(16));
      const expires = new Date(Date.now() + days * 864e5).toISOString();
      const metadata = { label: cleanName(value.label), by: who.board, created: new Date().toISOString(), expires };
      await env.NOW_AND_THEN.put("inv:" + code, "1", { expirationTtl: days * 86400, metadata });
      return json({ code, ...metadata });
    }
    if (m === "GET" && !id) {
      const keys = await listKeys(env, "inv:");
      return json({ invites: keys.map((k) => ({ code: k.name.slice(4), ...(k.metadata || {}) })).sort((a, b) => (b.created || "").localeCompare(a.created || "")) });
    }
    if (m === "DELETE" && id) {
      if (!INVITE_CODE.test(id)) return json({ error: "not found" }, 404);
      await env.NOW_AND_THEN.delete("inv:" + id);
      return json({ revoked: true });
    }
  }

  if (area === "boards") {
    const keys = await listKeys(env, "tok:");
    if (m === "GET" && !id) {
      return json({ max: Number(env.MAX_BOARDS) || 50, boards: keys.map((k) => ({ ...(k.metadata || {}) })).filter((b) => b.board) });
    }
    if (m === "DELETE" && id) {
      const k = keys.find((k) => k.metadata && k.metadata.board === id);
      if (!BOARD_ID.test(id) || !k) return json({ error: "not found" }, 404);
      return json(await deleteBoard(env, id, k.name.slice(4)));
    }
  }
  return json({ error: "method not allowed" }, 405);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(snapshotAll(env));
  },

  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    // First: /shared/join and /shared/<sid>/invites aren't the board invite routes.
    if (/\/shared(\/[^/]+){0,2}$/.test(path)) {
      const who = await whoIs(request, env, { fresh: true });
      return authError(who) || sharedApi(request, env, who, url);
    }

    if (path.endsWith("/join")) {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      return join(request, env);
    }

    if (/\/(invites|boards)(\/[^/]+)?$/.test(path)) {
      const who = await whoIs(request, env, { fresh: true });
      return authError(who) || admin(request, env, who, url);
    }

    const snap = path.match(/\/snapshots(?:\/([^/]+))?$/);
    if (path.endsWith("/data") || snap) {
      const writes = request.method !== "GET";
      const who = await whoIs(request, env, { fresh: writes });
      const bad = authError(who);
      if (bad) return bad;
      const KEY = "board:" + who.board;
      const hdrs = boardHeaders(who);

      if (snap) {
        const id = snap[1] ? decodeURIComponent(snap[1]) : null;
        if (request.method === "GET" && !id) return json({ board: who.board, days: SNAPSHOT_DAYS, snapshots: await listSnapshots(env, who.board) }, 200, hdrs);
        if (request.method === "GET" && id) {
          if (!SNAP_ID.test(id)) return json({ error: "not found" }, 404, hdrs);
          const got = await env.NOW_AND_THEN.get(`snap:${who.board}:${id}`, "json");
          return got ? json(got, 200, hdrs) : json({ error: "not found" }, 404, hdrs);
        }
        if (request.method === "POST" && !id) {
          const view = await openBoard(env, who.board, await env.NOW_AND_THEN.get(KEY, "json"));
          const reason = (url.searchParams.get("reason") || "manual").replace(/[^a-z -]/gi, "").slice(0, 30) || "manual";
          return json(await takeSnapshot(env, who.board, view.board, reason), 200, hdrs);
        }
        return json({ error: "method not allowed" }, 405, hdrs);
      }

      // A device says which board it last synced with. If this token now opens a
      // different board (for example after the secrets were changed), refuse rather
      // than merge one person's lists into another's.
      const expect = (request.headers.get("X-Expect-Board") || "").trim().toLowerCase();
      if ((request.method === "PUT" || request.method === "DELETE") && expect && expect !== who.board) {
        return json({ error: "board changed", board: who.board, expected: expect }, 409, hdrs);
      }

      // Delete this board, its backups and (for an invited board) its token.
      // Owner boards come from TOKEN_* secrets that only the Worker's owner can
      // remove, so those are deleted by hand (see the README).
      if (request.method === "DELETE") {
        if (url.searchParams.get("confirm") !== "delete") return json({ error: "confirm" }, 400, hdrs);
        if (who.kind !== "invited") return json({ error: "owner board" }, 403, hdrs);
        return json(await deleteBoard(env, who.board, who.hash), 200, hdrs);
      }

      const stored = await env.NOW_AND_THEN.get(KEY, "json");

      if (request.method === "GET") {
        if (!stored) return json(EMPTY(), 200, hdrs);
        return json((await openBoard(env, who.board, stored)).board, 200, hdrs);
      }

      if (request.method === "PUT") {
        const { value: incoming, error } = await readJson(request);
        if (error) return error;
        if (!incoming || !Array.isArray(incoming.lists) || !Array.isArray(incoming.todos)) return json({ error: "not a board" }, 400, hdrs);
        return json(await putBoard(env, who, stored, incoming), 200, hdrs);
      }

      return json({ error: "method not allowed" }, 405);
    }

    return new Response("Now and Then sync is running. Your lists live at /data and need your access token.\n", {
      status: 200,
      headers: cors({ "Content-Type": "text/plain; charset=utf-8" }),
    });
  },
};
