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

// ---------- shared lists ----------
const TIFF = "tiffany-owner-token-0123";
const get = async (e, token) => (await call(e, "GET", "/data", { token })).json();
const put = async (e, token, body) => (await call(e, "PUT", "/data", { token, body })).json();
const live = (b) => ({ lists: b.lists.filter(l => !l.deleted), todos: b.todos.filter(t => !t.deleted) });
async function setUp() {
  const e = env();
  await put(e, NATE, { lists: [
    { id: "n-now", name: "Now", role: "now", order: 1, updatedAt: 1 },
    { id: "groc", name: "Groceries", color: "#5cc6a7", role: "later", order: 2, updatedAt: 1 },
  ], todos: [
    { id: "n1", listId: "n-now", text: "Nate's private", updatedAt: 1 },
    { id: "g1", listId: "groc", text: "milk", updatedAt: 1 },
  ] });
  await put(e, TIFF, { lists: [{ id: "t-now", name: "Now", role: "now", order: 1, updatedAt: 1 }],
    todos: [{ id: "t1", listId: "t-now", text: "Tiffany's private", updatedAt: 1 }] });
  let r = await call(e, "POST", "/shared", { token: NATE, body: { listId: "groc" } });
  assert.equal(r.status, 200);
  const { sid } = await r.json();
  const inv = await (await call(e, "POST", `/shared/${sid}/invites`, { token: NATE })).json();
  r = await call(e, "POST", "/shared/join", { token: TIFF, body: { code: inv.code } });
  assert.equal(r.status, 200);
  return { e, sid, code: inv.code };
}

test("sharing a list puts it on both boards and nothing else", async () => {
  const { e, sid, code } = await setUp();
  const t = live(await get(e, TIFF));
  assert.deepEqual(t.lists.map(l => l.name).sort(), ["Groceries", "Now"]);
  const g = t.lists.find(l => l.name === "Groceries");
  assert.equal(g.shared, sid);
  assert.deepEqual(g.members, ["Nate", "Tiffany"]);
  assert.equal(g.role, null, "shared lists drop the Later role");
  assert.equal(g.order, 2, "placed after Tiffany's lists");
  assert.deepEqual(t.todos.map(x => x.text).sort(), ["Tiffany's private", "milk"]);
  const n = live(await get(e, NATE));
  assert.deepEqual(n.todos.map(x => x.text).sort(), ["Nate's private", "milk"]);
  assert.ok(!e.NOW_AND_THEN.m.get("board:nate").v.includes("milk"), "the shared todos moved out of Nate's board");
  const r = await call(e, "POST", "/shared/join", { token: TIFF, body: { code } });
  assert.equal(r.status, 404, "share links are single use");
});

test("edits, moves and renames flow between the two boards", async () => {
  const { e, sid } = await setUp();
  // Tiffany adds to the shared list and moves her private todo into it.
  let tb = await get(e, TIFF);
  tb.todos.push({ id: "g2", listId: "groc", text: "eggs", updatedAt: Date.now() });
  tb.todos.find(x => x.id === "t1").listId = "groc"; tb.todos.find(x => x.id === "t1").updatedAt = Date.now();
  tb = await put(e, TIFF, tb);
  let n = live(await get(e, NATE));
  assert.deepEqual(n.todos.filter(x => x.listId === "groc").map(x => x.text).sort(), ["Tiffany's private", "eggs", "milk"]);
  assert.ok(!e.NOW_AND_THEN.m.get("board:tiffany").v.includes("Tiffany's private"));

  // Nate takes "milk" into his private Now list.
  const nb = await get(e, NATE);
  Object.assign(nb.todos.find(x => x.id === "g1"), { listId: "n-now", updatedAt: Date.now() });
  await put(e, NATE, nb);
  n = live(await get(e, NATE));
  assert.equal(n.todos.find(x => x.id === "g1").listId, "n-now", "still live for Nate");
  let t = await get(e, TIFF);
  assert.ok(t.todos.find(x => x.id === "g1").deleted, "gone for Tiffany");
  // Tiffany's phone hadn't synced and sends its old copy back: it stays gone.
  const stale = { lists: tb.lists, todos: tb.todos };
  t = await put(e, TIFF, stale);
  assert.ok(t.todos.find(x => x.id === "g1").deleted);
  n = live(await get(e, NATE));
  assert.equal(n.todos.find(x => x.id === "g1").listId, "n-now");
  assert.ok(!e.NOW_AND_THEN.m.get("board:tiffany").v.includes('"g1"'), "the tombstone lives in the shared list, not her board");

  // Tiffany renames and moves the list on her board; Nate gets the name, not her order.
  const tl = await get(e, TIFF);
  Object.assign(tl.lists.find(l => l.id === "groc"), { name: "Shopping", order: 0, updatedAt: Date.now() + 1 });
  await put(e, TIFF, tl);
  const ng = (await get(e, NATE)).lists.find(l => l.id === "groc");
  assert.equal(ng.name, "Shopping");
  assert.equal(ng.order, 2);
  assert.equal(ng.shared, sid);
});

test("sharing limits", async () => {
  const { e, sid } = await setUp();
  let r = await call(e, "POST", "/shared", { token: NATE, body: { listId: "n-now" } });
  assert.equal(r.status, 400, "Now can't be shared");
  r = await call(e, "POST", "/shared", { token: NATE, body: { listId: "nope" } });
  assert.equal(r.status, 404);
  const inv = await (await call(e, "POST", "/invites", { token: NATE, body: {} })).json();
  const linda = await (await call(e, "POST", "/join", { body: { code: inv.code, name: "linda" } })).json();
  r = await call(e, "POST", `/shared/${sid}/invites`, { token: linda.token });
  assert.equal(r.status, 404, "only members can invite");
  // Linda's board is full: 10 lists.
  await put(e, linda.token, { lists: Array.from({ length: 10 }, (_, i) => ({ id: "L" + i, name: "L" + i, order: i, updatedAt: 1 })), todos: [] });
  const code = (await (await call(e, "POST", `/shared/${sid}/invites`, { token: TIFF })).json()).code;
  r = await call(e, "POST", "/shared/join", { token: linda.token, body: { code } });
  assert.equal(r.status, 409);
});

test("leaving takes it off your board only; the last one out deletes it", async () => {
  const { e, sid } = await setUp();
  const before = await get(e, TIFF);
  let r = await call(e, "DELETE", `/shared/${sid}`, { token: TIFF });
  assert.equal(r.status, 200);
  let t = await get(e, TIFF);
  assert.ok(t.lists.find(l => l.id === "groc").deleted);
  assert.ok(t.todos.find(x => x.id === "g1").deleted);
  // Her other phone still has the list and sends it: it doesn't come back.
  t = live(await put(e, TIFF, before));
  assert.ok(!t.lists.some(l => l.id === "groc"));
  assert.ok(!t.todos.some(x => x.id === "g1"));
  let n = live(await get(e, NATE));
  const g = n.lists.find(l => l.id === "groc");
  assert.deepEqual(g.members, ["Nate"]);
  assert.ok(n.todos.some(x => x.id === "g1"), "the list keeps its todos for Nate");

  // An older app deletes the list instead of leaving: same thing.
  const nb = await get(e, NATE);
  Object.assign(nb.lists.find(l => l.id === "groc"), { deleted: true, updatedAt: Date.now() });
  await put(e, NATE, nb);
  assert.ok(!e.NOW_AND_THEN.m.has("shared:" + sid), "deleted when the last member leaves");
  n = live(await get(e, NATE));
  assert.ok(!n.lists.some(l => l.id === "groc"));
  assert.ok(n.todos.some(x => x.id === "n1"), "Nate's private todos are untouched");
});

test("rejoining after leaving shows the list again; deleting a board leaves its lists", async () => {
  const { e, sid } = await setUp();
  await call(e, "DELETE", `/shared/${sid}`, { token: TIFF });
  const code = (await (await call(e, "POST", `/shared/${sid}/invites`, { token: NATE })).json()).code;
  await call(e, "POST", "/shared/join", { token: TIFF, body: { code } });
  const t = live(await get(e, TIFF));
  assert.ok(t.lists.some(l => l.id === "groc"));
  assert.ok(t.todos.some(x => x.id === "g1"));

  const inv = await (await call(e, "POST", "/invites", { token: NATE, body: {} })).json();
  const linda = await (await call(e, "POST", "/join", { body: { code: inv.code, name: "linda" } })).json();
  const c2 = (await (await call(e, "POST", `/shared/${sid}/invites`, { token: NATE })).json()).code;
  await call(e, "POST", "/shared/join", { token: linda.token, body: { code: c2 } });
  assert.deepEqual((await get(e, NATE)).lists.find(l => l.id === "groc").members, ["Nate", "Tiffany", "Linda"]);
  await call(e, "DELETE", "/data?confirm=delete", { token: linda.token });
  assert.deepEqual((await get(e, NATE)).lists.find(l => l.id === "groc").members, ["Nate", "Tiffany"]);
});

test("snapshots include shared lists", async () => {
  const { e } = await setUp();
  const r = await call(e, "POST", "/snapshots", { token: TIFF });
  const s = await r.json();
  assert.equal(s.lists, 2);
  assert.equal(s.todos, 2);
});

test("quick add puts text at the bottom of Now, or the list named by to", async () => {
  const e = env();
  const lists = [
    { id: "n", name: "Now", role: "now", order: 1, updatedAt: 1 },
    { id: "tm", name: "Tomorrow", role: "tomorrow", order: 2, updatedAt: 1 },
    { id: "g", name: "Groceries", role: null, order: 3, updatedAt: 1 },
  ];
  await call(e, "PUT", "/data", { token: NATE, body: { lists, todos: [{ id: "a", listId: "n", text: "first", order: 4, updatedAt: 1 }] } });

  let r = await call(e, "POST", "/add", { token: NATE, body: { text: "call the dentist" } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { added: 1, list: "Now", todos: ["call the dentist"] });

  r = await worker.fetch(new Request(W + "/add", { method: "POST", body: "- eggs\n\n• milk \n", headers: { Authorization: "Bearer " + NATE, "Content-Type": "text/plain" } }), e);
  assert.equal((await r.json()).added, 2);
  r = await call(e, "POST", "/add", { token: NATE, body: { text: "pack", to: "tomorrow" } });
  assert.equal((await r.json()).list, "Tomorrow");
  r = await call(e, "POST", "/add?to=groceries", { token: NATE, body: { text: "bread" } });
  assert.equal((await r.json()).list, "Groceries");
  r = await call(e, "POST", "/add", { token: NATE, body: { text: "x", to: "nope" } });
  assert.equal((await r.json()).list, "Now", "an unknown list falls back to Now");

  const b = await (await call(e, "GET", "/data", { token: NATE })).json();
  const inNow = b.todos.filter(t => t.listId === "n").sort((x, y) => x.order - y.order).map(t => t.text);
  assert.deepEqual(inNow, ["first", "call the dentist", "eggs", "milk", "x"]);
  assert.ok(b.todos.find(t => t.text === "pack").listId === "tm");
  assert.ok(b.todos.find(t => t.text === "bread").listId === "g");
  assert.equal(b.lists.length, 3, "lists untouched");
});

test("quick add needs a token, text, POST and a board with lists", async () => {
  const e = env();
  assert.equal((await call(e, "POST", "/add", { body: { text: "hi" } })).status, 401);
  assert.equal((await call(e, "GET", "/add", { token: NATE })).status, 405);
  assert.equal((await call(e, "POST", "/add", { token: NATE, body: { text: "hi" } })).status, 409, "no lists yet");
  await call(e, "PUT", "/data", { token: NATE, body: board("milk") });
  assert.equal((await call(e, "POST", "/add", { token: NATE, body: { text: "  \n " } })).status, 400);
  assert.equal((await call(e, "POST", "/add", { token: NATE, body: { text: "hi" } })).status, 200);
  assert.equal((await call(e, "POST", "/add", { token: "tiffany-owner-token-0123", body: { text: "hers" } })).status, 409, "her board has no lists");
});

test("quick add into a shared list reaches the other board", async () => {
  const e = env(), TIF = "tiffany-owner-token-0123";
  await call(e, "PUT", "/data", { token: NATE, body: { lists: [{ id: "n", name: "Now", role: "now", order: 1, updatedAt: 1 }, { id: "g", name: "Groceries", order: 2, updatedAt: 1 }], todos: [] } });
  await call(e, "PUT", "/data", { token: TIF, body: { lists: [{ id: "tn", name: "Now", role: "now", order: 1, updatedAt: 1 }], todos: [] } });
  const { sid } = await (await call(e, "POST", "/shared", { token: NATE, body: { listId: "g" } })).json();
  const { code } = await (await call(e, "POST", `/shared/${sid}/invites`, { token: NATE })).json();
  assert.equal((await call(e, "POST", "/shared/join", { token: TIF, body: { code } })).status, 200);
  const r = await call(e, "POST", "/add", { token: NATE, body: { text: "apples", to: "Groceries" } });
  assert.equal((await r.json()).list, "Groceries");
  const hers = await (await call(e, "GET", "/data", { token: TIF })).json();
  assert.ok(hers.todos.some(t => t.text === "apples" && t.listId === "g"));
});
