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

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*", // security rests on the token
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
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
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

    const url = new URL(request.url);
    if (url.pathname.endsWith("/data")) {
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const owner = ownerOf(token, env);
      if (!owner) return json({ error: "unauthorized" }, 401);
      if (owner.clash) return json({ error: "token clash", boards: owner.clash }, 409);
      const KEY = "board:" + owner.name;
      const who = { "X-Board": owner.name };

      // A device says which board it last synced with. If this token now opens a
      // different board (for example after the secrets were changed), refuse rather
      // than merge one person's lists into another's.
      const expect = (request.headers.get("X-Expect-Board") || "").trim().toLowerCase();
      if (request.method === "PUT" && expect && expect !== owner.name) {
        return json({ error: "board changed", board: owner.name, expected: expect }, 409, who);
      }

      const stored = await env.NOW_AND_THEN.get(KEY, "json");

      if (request.method === "GET") return json(stored || { version: 1, settings: {}, lists: [], todos: [] }, 200, who);

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
