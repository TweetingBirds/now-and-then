// Cloudflare Worker: personal sync endpoint for Now and Then.
//
// Stores the board as one JSON document in Workers KV, protected by a bearer token.
// Each device PUTs its whole board; the Worker merges it with what it already has
// (the newest edit wins for each list, each todo and the settings) and returns the
// merged board, so two devices editing at once don't overwrite each other.
//
// Each person has their own board and their own token. Every secret named
// TOKEN_<NAME> (for example TOKEN_NATE, TOKEN_TIFFANY) is one person's access
// token, and their board is stored under the KV key "board:<name>". Two people
// who want to share one board can be given the same token.
//
// Backups: once a day (the cron trigger in wrangler.toml) the Worker copies every
// board to a snapshot key "snap:<name>:<ISO time>" that KV deletes by itself after
// SNAPSHOT_DAYS. The app also asks for a snapshot right before it restores a backup.
// GET /snapshots lists a board's snapshots, GET /snapshots/<id> returns one, and
// POST /snapshots takes one now. A token only ever sees its own board's snapshots.
//
// Bindings (see wrangler.toml and the README):
//   KV namespace binding:  NOW_AND_THEN
//   Secrets:               TOKEN_<NAME>, one per person (any long random string)

// Finds whose token this is. Returns { name } for a match, { clash: [names] } when
// two TOKEN_* secrets hold the same value (that would silently put two people on
// one board, so it is refused), or null if no TOKEN_* secret matches.
// Both sides are trimmed, because a pasted secret often carries a trailing newline.
function ownerOf(token, env) {
  token = (token || "").trim();
  if (!token) return null;
  const names = [];
  for (const [name, raw] of Object.entries(env)) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (name.startsWith("TOKEN_") && value.length >= 16 && value === token) names.push(name.slice(6).toLowerCase());
  }
  if (names.length > 1) return { clash: names.sort() };
  return names.length ? { name: names[0] } : null;
}
const TOMBSTONE_DAYS = 60;
const SNAPSHOT_DAYS = 30;
const SNAP_ID = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const EMPTY = () => ({ version: 1, settings: {}, lists: [], todos: [] });

// Copies a board into a snapshot key that expires on its own. The metadata lets
// GET /snapshots describe each one without reading it.
export async function takeSnapshot(env, name, board, reason) {
  const at = new Date().toISOString();
  const live = (xs) => (xs || []).filter((x) => x && !x.deleted);
  const metadata = {
    at,
    reason,
    lists: live(board.lists).length,
    todos: live(board.todos).filter((t) => !t.archived).length,
    done: live(board.todos).filter((t) => t.archived).length,
  };
  await env.NOW_AND_THEN.put(`snap:${name}:${at}`, JSON.stringify(board), {
    expirationTtl: SNAPSHOT_DAYS * 86400,
    metadata,
  });
  return { id: at, ...metadata };
}

async function listSnapshots(env, name) {
  const out = [];
  let cursor;
  do {
    const page = await env.NOW_AND_THEN.list({ prefix: `snap:${name}:`, cursor });
    for (const k of page.keys) out.push({ id: k.name.slice(`snap:${name}:`.length), ...(k.metadata || {}) });
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out.sort((a, b) => b.id.localeCompare(a.id)); // newest first
}

// The daily cron: snapshot every board that has anything on it.
export async function snapshotAll(env) {
  let cursor;
  do {
    const page = await env.NOW_AND_THEN.list({ prefix: "board:", cursor });
    for (const k of page.keys) {
      const board = await env.NOW_AND_THEN.get(k.name, "json");
      if (board && Array.isArray(board.lists) && board.lists.length) await takeSnapshot(env, k.name.slice(6), board, "daily");
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*", // security rests on the token
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Expect-Board",
    "Access-Control-Expose-Headers": "X-Board",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: cors({ "Content-Type": "application/json", ...extra }) });
}

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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(snapshotAll(env));
  },

  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

    const url = new URL(request.url);
    const snap = url.pathname.match(/\/snapshots(?:\/([^/]+))?\/?$/);
    if (url.pathname.endsWith("/data") || snap) {
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const owner = ownerOf(token, env);
      if (!owner) return json({ error: "unauthorized" }, 401);
      if (owner.clash) return json({ error: "token clash", boards: owner.clash }, 409);
      const KEY = "board:" + owner.name;
      const who = { "X-Board": owner.name };

      if (snap) {
        const id = snap[1] ? decodeURIComponent(snap[1]) : null;
        if (request.method === "GET" && !id) return json({ board: owner.name, days: SNAPSHOT_DAYS, snapshots: await listSnapshots(env, owner.name) }, 200, who);
        if (request.method === "GET" && id) {
          if (!SNAP_ID.test(id)) return json({ error: "not found" }, 404, who);
          const got = await env.NOW_AND_THEN.get(`snap:${owner.name}:${id}`, "json");
          return got ? json(got, 200, who) : json({ error: "not found" }, 404, who);
        }
        if (request.method === "POST" && !id) {
          const current = await env.NOW_AND_THEN.get(KEY, "json");
          const reason = (url.searchParams.get("reason") || "manual").replace(/[^a-z -]/gi, "").slice(0, 30) || "manual";
          return json(await takeSnapshot(env, owner.name, current || EMPTY(), reason), 200, who);
        }
        return json({ error: "method not allowed" }, 405, who);
      }

      // A device says which board it last synced with. If this token now opens a
      // different board (for example after the secrets were changed), refuse rather
      // than merge one person's lists into another's.
      const expect = (request.headers.get("X-Expect-Board") || "").trim().toLowerCase();
      if (request.method === "PUT" && expect && expect !== owner.name) {
        return json({ error: "board changed", board: owner.name, expected: expect }, 409, who);
      }

      const stored = await env.NOW_AND_THEN.get(KEY, "json");

      if (request.method === "GET") return json(stored || EMPTY(), 200, who);

      if (request.method === "PUT") {
        const body = await request.text();
        if (body.length > 4_000_000) return json({ error: "too large" }, 413, who);
        let incoming;
        try { incoming = JSON.parse(body); } catch (e) { return json({ error: "bad json" }, 400, who); }
        if (!incoming || !Array.isArray(incoming.lists) || !Array.isArray(incoming.todos)) return json({ error: "not a board" }, 400, who);
        const merged = stored ? mergeBoards(stored, incoming) : mergeBoards({}, incoming);
        await env.NOW_AND_THEN.put(KEY, JSON.stringify(merged));
        return json(merged, 200, who);
      }

      return json({ error: "method not allowed" }, 405);
    }

    return new Response("Now and Then sync is running. Your lists live at /data and need your access token.\n", {
      status: 200,
      headers: cors({ "Content-Type": "text/plain; charset=utf-8" }),
    });
  },
};
