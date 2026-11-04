// Run with: node --test worker/test
// Exercises the Worker against an in-memory stand-in for Workers KV.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

function memoryKV() {
  const m = new Map();
  const ops = { read: 0, write: 0, del: 0, list: 0 };
  return {
    m, ops,
    async get(k, type) { ops.read++; const e = m.get(k); if (!e) return null; return type === "json" ? JSON.parse(e.v) : e.v; },
    async getWithMetadata(k) { ops.read++; const e = m.get(k); return e ? { value: e.v, metadata: e.meta || null } : { value: null, metadata: null }; },
    async put(k, v, o = {}) { ops.write++; m.set(k, { v, meta: o.metadata }); },
    async delete(k) { ops.del++; m.delete(k); },
    async list({ prefix }) { ops.list++; return { keys: [...m.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name, metadata: m.get(name).meta })), list_complete: true }; },
  };
}
const NATE = "nate-owner-token-0123456789";
const env = () => ({ NOW_AND_THEN: memoryKV(), TOKEN_NATE: NATE + "\n", TOKEN_TIFFANY: "tiffany-owner-token-0123", ADMINS: "nate", MAX_BOARDS: "3" });
const W = "https://w.example";
const call = (e, method, path, { token, body, headers = {} } = {}) => worker.fetch(new Request(W + path, {
  method, body: body === undefined ? undefined : JSON.stringify(body),
  headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...headers },
}), e);
const board = (text) => ({ lists: [{ id: "l1", name: "Now", updatedAt: 1 }], todos: [{ id: "t1", listId: "l1", text, updatedAt: 1 }] });

test("owner boards work as before", async () => {
  const e = env();
  let r = await call(e, "PUT", "/data", { token: NATE, body: board("milk") });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("X-Board"), "nate");
  assert.equal(r.headers.get("X-Board-Kind"), "owner");
  assert.equal(r.headers.get("X-Board-Admin"), "1");
  assert.ok(e.NOW_AND_THEN.m.has("board:nate"));
  r = await call(e, "GET", "/data", { token: "tiffany-owner-token-0123" });
  assert.equal(r.headers.get("X-Board"), "tiffany");
  assert.equal(r.headers.get("X-Board-Admin"), null);
  r = await call(e, "DELETE", "/data?confirm=delete", { token: NATE });
  assert.equal(r.status, 403, "owner boards can't be self-deleted");
  assert.ok(e.NOW_AND_THEN.m.has("board:nate"));
});

test("invite, join, sync, delete", async () => {
  const e = env();
  let r = await call(e, "POST", "/invites", { token: "tiffany-owner-token-0123", body: {} });
  assert.equal(r.status, 403, "only admins invite");
  r = await call(e, "POST", "/invites", { token: NATE, body: { label: "Mom", days: 7 } });
  const inv = await r.json();
  assert.match(inv.code, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(inv.label, "Mom");
  r = await call(e, "GET", "/invites", { token: NATE });
  assert.equal((await r.json()).invites.length, 1);

  r = await call(e, "POST", "/join", { body: { code: "x".repeat(22) } });
  assert.equal(r.status, 404);
  r = await call(e, "POST", "/join", { body: { code: inv.code, name: "Linda <b>" } });
  assert.equal(r.status, 200);
  const joined = await r.json();
  assert.match(joined.token, /^nt_/);
  assert.match(joined.board, /^b_[a-f0-9]{16}$/);
  assert.equal(joined.name, "Linda b");
  assert.ok(![...e.NOW_AND_THEN.m.values()].some(x => String(x.v).includes(joined.token)), "token itself is never stored");
  r = await call(e, "POST", "/join", { body: { code: inv.code } });
  assert.equal(r.status, 404, "invites are single use");

  const tok = joined.token;
  r = await call(e, "PUT", "/data", { token: tok, body: board("call Mom"), headers: { "X-Expect-Board": joined.board } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("X-Board"), joined.board);
  assert.equal(decodeURIComponent(r.headers.get("X-Board-Name")), "Linda b");
  assert.equal(r.headers.get("X-Board-Kind"), "invited");
  r = await call(e, "PUT", "/data", { token: tok, body: board("x"), headers: { "X-Expect-Board": "nate" } });
  assert.equal(r.status, 409);
  r = await call(e, "POST", "/snapshots", { token: tok });
  assert.equal(r.status, 200);
  r = await call(e, "GET", "/boards", { token: NATE });
  const boards = (await r.json()).boards;
  assert.equal(boards.length, 1); assert.equal(boards[0].invite, "Mom"); assert.equal(boards[0].by, "nate");
  r = await call(e, "GET", "/boards", { token: tok });
  assert.equal(r.status, 403);

  r = await call(e, "DELETE", "/data", { token: tok });
  assert.equal(r.status, 400, "needs confirm");
  r = await call(e, "DELETE", "/data?confirm=delete", { token: tok });
  assert.equal(r.status, 200);
  const res = await r.json();
  assert.equal(res.snapshots, 1);
  const left = [...e.NOW_AND_THEN.m.keys()];
  assert.ok(!left.some(k => k.includes(joined.board)), "board and snapshots gone: " + left);
  assert.ok(!left.some(k => k.startsWith("tok:")), "token gone");
  assert.ok(left.some(k => k.startsWith("gone:")));
  r = await call(e, "GET", "/data", { token: tok });
  assert.equal(r.status, 410);
  r = await call(e, "PUT", "/data", { token: tok, body: board("again") });
  assert.equal(r.status, 410, "a deleted board can't be written back");
  assert.ok(![...e.NOW_AND_THEN.m.keys()].some(k => k.startsWith("board:b_")));
});

test("admin can remove an invited board; board cap; revoke", async () => {
  const e = env();
  const join = async () => {
    const inv = await (await call(e, "POST", "/invites", { token: NATE, body: {} })).json();
    return call(e, "POST", "/join", { body: { code: inv.code } });
  };
  const a = await (await join()).json();
  await join(); await join();
  const r4 = await join();
  assert.equal(r4.status, 503, "MAX_BOARDS reached");
  let r = await call(e, "DELETE", "/boards/" + a.board, { token: NATE });
  assert.equal(r.status, 200);
  r = await call(e, "GET", "/data", { token: a.token });
  assert.equal(r.status, 410);
  const inv = await (await call(e, "POST", "/invites", { token: NATE, body: {} })).json();
  r = await call(e, "DELETE", "/invites/" + inv.code, { token: NATE });
  assert.equal(r.status, 200);
  r = await call(e, "POST", "/join", { body: { code: inv.code } });
  assert.equal(r.status, 404);
});

test("GET lookups are cached, writes are not", async () => {
  const e = env();
  const inv = await (await call(e, "POST", "/invites", { token: NATE, body: {} })).json();
  const { token } = await (await call(e, "POST", "/join", { body: { code: inv.code } })).json();
  await call(e, "GET", "/data", { token });
  const before = e.NOW_AND_THEN.ops.read;
  await call(e, "GET", "/data", { token });
  assert.equal(e.NOW_AND_THEN.ops.read - before, 1, "one read (the board) per cached GET");
});

test("snapshotAll covers invited boards", async () => {
  const e = env();
  const inv = await (await call(e, "POST", "/invites", { token: NATE, body: {} })).json();
  const j = await (await call(e, "POST", "/join", { body: { code: inv.code } })).json();
  await call(e, "PUT", "/data", { token: j.token, body: board("a") });
  await call(e, "PUT", "/data", { token: NATE, body: board("b") });
  let waited; await worker.scheduled({}, e, { waitUntil: p => { waited = p; } }); await waited;
  const snaps = [...e.NOW_AND_THEN.m.keys()].filter(k => k.startsWith("snap:"));
  assert.equal(snaps.length, 2);
  assert.ok(snaps.some(k => k.startsWith(`snap:${j.board}:`)));
});
