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

const TOMBSTONE_DAYS = 60;
const SNAPSHOT_DAYS = 30;
const INVITE_DAYS = 14;    // default life of an invite link
const GONE_DAYS = 30;      // how long a deleted token answers "board deleted" instead of 401
const SNAP_ID = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const INVITE_CODE = /^[A-Za-z0-9_-]{22}$/;
const BOARD_ID = /^b_[a-f0-9]{16}$/;
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
export async function snapshotAll(env) {
  for (const k of await listKeys(env, "board:")) {
    const data = await env.NOW_AND_THEN.get(k.name, "json");
    if (data && Array.isArray(data.lists) && data.lists.length) await takeSnapshot(env, k.name.slice(6), data, "daily");
  }
}

// Removes a board and every copy of it. For an invited board the token goes too,
// and a small marker (the token's hash, nothing else) stays for GONE_DAYS so the
// person's other devices are told the board was deleted instead of "wrong token".
export async function deleteBoard(env, board, hash) {
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
          const current = await env.NOW_AND_THEN.get(KEY, "json");
          const reason = (url.searchParams.get("reason") || "manual").replace(/[^a-z -]/gi, "").slice(0, 30) || "manual";
          return json(await takeSnapshot(env, who.board, current || EMPTY(), reason), 200, hdrs);
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

      if (request.method === "GET") return json(stored || EMPTY(), 200, hdrs);

      if (request.method === "PUT") {
        const { value: incoming, error } = await readJson(request);
        if (error) return error;
        if (!incoming || !Array.isArray(incoming.lists) || !Array.isArray(incoming.todos)) return json({ error: "not a board" }, 400, hdrs);
        const merged = stored ? mergeBoards(stored, incoming) : mergeBoards({}, incoming);
        await env.NOW_AND_THEN.put(KEY, JSON.stringify(merged));
        return json(merged, 200, hdrs);
      }

      return json({ error: "method not allowed" }, 405);
    }

    return new Response("Now and Then sync is running. Your lists live at /data and need your access token.\n", {
      status: 200,
      headers: cors({ "Content-Type": "text/plain; charset=utf-8" }),
    });
  },
};
