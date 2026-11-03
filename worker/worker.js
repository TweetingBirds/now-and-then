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
// Bindings (see wrangler.toml and the README):
//   KV namespace binding:  NOW_AND_THEN
//   Secrets:               TOKEN_<NAME>, one per person (any long random string)

// Returns the board's KV key for this token, or null if no TOKEN_* secret matches.
function boardKeyFor(token, env) {
  if (!token) return null;
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("TOKEN_") && typeof value === "string" && value.length >= 16 && value === token) {
      return "board:" + name.slice(6).toLowerCase();
    }
  }
  return null;
}
const TOMBSTONE_DAYS = 60;

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*", // security rests on the token
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: cors({ "Content-Type": "application/json" }) });
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
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

    const url = new URL(request.url);
    if (url.pathname.endsWith("/data")) {
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const KEY = boardKeyFor(token, env);
      if (!KEY) return json({ error: "unauthorized" }, 401);

      const stored = await env.NOW_AND_THEN.get(KEY, "json");

      if (request.method === "GET") return json(stored || { version: 1, settings: {}, lists: [], todos: [] });

      if (request.method === "PUT") {
        const body = await request.text();
        if (body.length > 4_000_000) return json({ error: "too large" }, 413);
        let incoming;
        try { incoming = JSON.parse(body); } catch (e) { return json({ error: "bad json" }, 400); }
        if (!incoming || !Array.isArray(incoming.lists) || !Array.isArray(incoming.todos)) return json({ error: "not a board" }, 400);
        const merged = stored ? mergeBoards(stored, incoming) : mergeBoards({}, incoming);
        await env.NOW_AND_THEN.put(KEY, JSON.stringify(merged));
        return json(merged);
      }

      return json({ error: "method not allowed" }, 405);
    }

    return new Response("Now and Then sync is running. Your lists live at /data and need your access token.\n", {
      status: 200,
      headers: cors({ "Content-Type": "text/plain; charset=utf-8" }),
    });
  },
};
