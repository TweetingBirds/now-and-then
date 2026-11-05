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
  assert.equal(e.NOW_AND_THEN.ops.read - before, 2, "two reads (the board and its quick add inbox) per cached GET");
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

// ---------- audit fixes (1.17) ----------
import { putBoard } from "../worker.js";

test("a quick add survives a device saving an older copy of the board at the same moment", async () => {
  const e = env();
  const lists = [{ id: "n", name: "Now", role: "now", order: 1, updatedAt: 1 }];
  await put(e, NATE, { lists, todos: [] });
  const stale = await e.NOW_AND_THEN.get("board:nate", "json"); // what the device's save read
  await call(e, "POST", "/add", { token: NATE, body: { text: "from Siri" } });
  // The device's save lands after the quick add, starting from the stale copy.
  const merged = await putBoard(e, { board: "nate" }, stale, { lists, todos: [{ id: "d1", listId: "n", text: "typed", updatedAt: Date.now() }] });
  assert.ok(merged.todos.some(t => t.text === "from Siri"), "returned to the device");
  const b = await get(e, NATE);
  assert.ok(b.todos.some(t => t.text === "from Siri") && b.todos.some(t => t.text === "typed"));
  // Deleting it later still wins over the inbox copy.
  const added = b.todos.find(t => t.text === "from Siri");
  await put(e, NATE, { lists, todos: [{ ...added, deleted: true, updatedAt: Date.now() + 5 }] });
  assert.ok((await get(e, NATE)).todos.find(t => t.id === added.id).deleted);
});

test("quick add skips archived lists", async () => {
  const e = env();
  await put(e, NATE, { lists: [
    { id: "n", name: "Now", role: "now", order: 1, updatedAt: 1 },
    { id: "p", name: "Packing", order: 2, archived: true, archivedDay: "2026-11-01", updatedAt: 1 },
  ], todos: [] });
  const r = await call(e, "POST", "/add", { token: NATE, body: { text: "socks", to: "packing" } });
  assert.equal((await r.json()).list, "Now");
});

test("list colors can only be #rrggbb", async () => {
  const { e, sid } = await setUp();
  const nb = await get(e, NATE);
  Object.assign(nb.lists.find(l => l.id === "groc"), { color: "#fff;background-image:url(https://x.example/p)", updatedAt: Date.now() + 1000 });
  nb.lists.push({ id: "mine", name: "Mine", color: "red", order: 3, updatedAt: Date.now() + 1000 });
  await put(e, NATE, nb);
  const t = await get(e, TIFF);
  assert.equal(t.lists.find(l => l.id === "groc").color, "#a3a9b5");
  assert.equal(JSON.parse(e.NOW_AND_THEN.m.get("shared:" + sid).v).list.color, "#a3a9b5");
  assert.equal((await get(e, NATE)).lists.find(l => l.id === "mine").color, "#a3a9b5");
});

test("someone on a shared list can't reach a private todo by its id", async () => {
  const { e, sid } = await setUp();
  // Nate's private todo n1: Tiffany writes a newer deletion, and a live copy, under that id.
  const doc = JSON.parse(e.NOW_AND_THEN.m.get("shared:" + sid).v);
  doc.todos.push({ id: "n1", listId: "groc", deleted: true, updatedAt: Date.now() + 1000 });
  await e.NOW_AND_THEN.put("shared:" + sid, JSON.stringify(doc));
  const n = await get(e, NATE);
  const n1 = n.todos.find(x => x.id === "n1");
  assert.ok(n1 && !n1.deleted && n1.listId === "n-now");
});

test("device links work once, give the device its own token, and can be taken back", async () => {
  const e = env();
  await put(e, NATE, board("milk"));
  let r = await call(e, "POST", "/devices", { token: NATE });
  const { code, expires } = await r.json();
  assert.match(code, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(Date.parse(expires) - Date.now() <= 24 * 3600e3 + 1000);
  r = await call(e, "POST", "/devices/connect", { body: { code, label: "iPad" } });
  assert.equal(r.status, 200);
  const { token } = await r.json();
  assert.match(token, /^nd_/);
  assert.ok(![...e.NOW_AND_THEN.m.values()].some(x => String(x.v).includes(token)), "token itself is never stored");
  assert.equal((await call(e, "POST", "/devices/connect", { body: { code } })).status, 404, "single use");
  r = await call(e, "GET", "/data", { token });
  assert.equal(r.headers.get("X-Board"), "nate");
  assert.equal(r.headers.get("X-Board-Admin"), "1");
  assert.equal((await r.json()).todos[0].text, "milk");
  const list = (await (await call(e, "GET", "/devices", { token: NATE })).json()).devices;
  assert.equal(list.length, 1); assert.equal(list[0].label, "iPad");
  assert.equal((await call(e, "DELETE", "/devices/" + list[0].id, { token: TIFF })).status, 404, "only from the same board");
  assert.equal((await call(e, "DELETE", "/devices/" + list[0].id, { token: NATE })).status, 200);
  assert.equal((await call(e, "GET", "/data", { token })).status, 410);
  assert.equal((await call(e, "GET", "/data", { token: "nd_" + "A".repeat(43) })).status, 401);
});

test("deleting an invited board from a device link removes the board and every token", async () => {
  const e = env();
  const inv = await (await call(e, "POST", "/invites", { token: NATE, body: {} })).json();
  const j = await (await call(e, "POST", "/join", { body: { code: inv.code } })).json();
  await put(e, j.token, board("a"));
  const { code } = await (await call(e, "POST", "/devices", { token: j.token })).json();
  const { token } = await (await call(e, "POST", "/devices/connect", { body: { code } })).json();
  assert.equal((await call(e, "DELETE", "/data?confirm=delete", { token })).status, 200);
  assert.equal((await call(e, "GET", "/data", { token: j.token })).status, 410);
  assert.equal((await call(e, "GET", "/data", { token })).status, 410);
  assert.ok(![...e.NOW_AND_THEN.m.keys()].some(k => k.startsWith("tok:") || k.startsWith("dtok:") || k === "board:" + j.board));
});

test("shared list links: listed, withdrawn, and dead once their maker leaves", async () => {
  const { e, sid } = await setUp();
  const a = await (await call(e, "POST", `/shared/${sid}/invites`, { token: TIFF })).json();
  const b = await (await call(e, "POST", `/shared/${sid}/invites`, { token: NATE })).json();
  let info = await (await call(e, "GET", `/shared/${sid}`, { token: NATE })).json();
  assert.equal(info.owner, true);
  assert.deepEqual(info.members.map(m => m.name), ["Nate", "Tiffany"]);
  assert.equal(info.invites.length, 2);
  assert.equal((await call(e, "DELETE", `/shared/${sid}/invites/${b.code}`, { token: NATE })).status, 200);
  info = await (await call(e, "GET", `/shared/${sid}`, { token: TIFF })).json();
  assert.equal(info.owner, false);
  assert.deepEqual(info.invites.map(i => i.code), [a.code]);
  // Tiffany leaves: her link stops working.
  await call(e, "DELETE", `/shared/${sid}`, { token: TIFF });
  const inv = await (await call(e, "POST", "/invites", { token: NATE, body: {} })).json();
  const linda = await (await call(e, "POST", "/join", { body: { code: inv.code } })).json();
  await put(e, linda.token, board("x"));
  assert.equal((await call(e, "POST", "/shared/join", { token: linda.token, body: { code: a.code } })).status, 404);
});

test("the owner can take someone off a shared list, and it doesn't come back as a private copy", async () => {
  const { e, sid } = await setUp();
  const herPhone = await get(e, TIFF); // still has the shared list
  assert.equal((await call(e, "DELETE", `/shared/${sid}/members/nate`, { token: TIFF })).status, 403, "only the owner");
  assert.equal((await call(e, "DELETE", `/shared/${sid}/members/tiffany`, { token: NATE })).status, 200);
  assert.deepEqual((await get(e, NATE)).lists.find(l => l.id === "groc").members, ["Nate"]);
  // Her phone saves what it has: the list and its todos come back as tombstones.
  herPhone.todos.find(t => t.id === "g1").updatedAt = Date.now();
  const t = await put(e, TIFF, herPhone);
  assert.ok(t.lists.find(l => l.id === "groc").deleted);
  assert.ok(t.todos.find(x => x.id === "g1").deleted);
  assert.ok(t.todos.some(x => x.id === "t1" && !x.deleted), "her own todos stay");
  assert.ok((await get(e, NATE)).todos.some(x => x.id === "g1" && !x.deleted), "Nate keeps the list's todos");
});

test("a device offline for months can't bring back deleted todos", async () => {
  const e = env();
  const old = Date.now() - 90 * 864e5;
  const lists = [{ id: "n", name: "Now", role: "now", order: 1, updatedAt: old }];
  await put(e, NATE, { lists, todos: [] });
  const zombie = { id: "z", listId: "n", text: "deleted in the spring", updatedAt: old };
  const synced = String(Date.now() - 80 * 864e5);
  let r = await call(e, "PUT", "/data", { token: NATE, body: { lists, todos: [zombie, { id: "new", listId: "n", text: "new", updatedAt: Date.now() }] }, headers: { "X-Synced-At": synced } });
  let b = await r.json();
  assert.ok(!b.todos.some(t => t.id === "z"));
  assert.ok(b.todos.some(t => t.id === "new"));
  // A device that has never synced here keeps everything it brings, however old.
  r = await call(e, "PUT", "/data", { token: NATE, body: { lists, todos: [zombie] } });
  assert.ok((await r.json()).todos.some(t => t.id === "z"));
});

test("the nightly copy skips boards that haven't changed", async () => {
  const e = env();
  await put(e, NATE, board("a"));
  const run = async () => { let w; await worker.scheduled({}, e, { waitUntil: p => { w = p; } }); await w; };
  const snaps = () => [...e.NOW_AND_THEN.m.keys()].filter(k => k.startsWith("snap:nate:")).length;
  await run(); assert.equal(snaps(), 1);
  await new Promise(r => setTimeout(r, 5));
  await run(); assert.equal(snaps(), 1, "unchanged: skipped");
  await put(e, NATE, { lists: [], todos: [{ id: "t2", listId: "l1", text: "b", updatedAt: Date.now() }] });
  await new Promise(r => setTimeout(r, 5));
  await run(); assert.equal(snaps(), 2, "changed: copied");
});

test("Done todos older than 90 days move to old, and come back from GET /old", async () => {
  const e = env();
  const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const lists = [{ id: "n", name: "Now", role: "now", order: 1, updatedAt: 1 }, { id: "p", name: "Packing", order: 2, archived: true, archivedDay: day(200), updatedAt: 1 }];
  const done = (id, d, listId = "n") => ({ id, listId, text: id, done: true, doneDay: d, archived: true, archivedDay: d, updatedAt: Date.parse(d) });
  let r = await call(e, "PUT", "/data", { token: NATE, body: { lists, todos: [done("recent", day(10)), done("ancient", day(120)), done("packed", day(200), "p"), { id: "open", listId: "n", text: "open", updatedAt: 1 }] } });
  let b = await r.json();
  assert.deepEqual(b.todos.map(t => t.id).sort(), ["open", "packed", "recent"], "old Done leaves the board; an archived list keeps its todos");
  r = await call(e, "GET", "/old", { token: NATE });
  assert.deepEqual((await r.json()).todos.map(t => t.id), ["ancient"]);

  // An older app on a device that has synced before still sends it. It goes to old,
  // and doesn't come back as a tombstone.
  r = await call(e, "PUT", "/data", { token: NATE, body: { lists, todos: [done("ancient", day(120))] }, headers: { "X-Synced-At": String(Date.now() - 1000) } });
  b = await r.json();
  assert.ok(!b.todos.some(t => t.id === "ancient"), "not on the board, not even as a tombstone");
  assert.equal((await (await call(e, "GET", "/old", { token: NATE })).json()).todos.length, 1);

  // Put back from a search: newer and not in Done, so it's back on the board.
  r = await call(e, "PUT", "/data", { token: NATE, body: { lists, todos: [{ id: "ancient", listId: "n", text: "ancient", done: false, archived: false, updatedAt: Date.now() }] }, headers: { "X-Synced-At": String(Date.now() - 1000) } });
  assert.ok((await r.json()).todos.some(t => t.id === "ancient" && !t.archived));

  // Deleting the board deletes old too.
  const { deleteBoard } = await import("../worker.js");
  await deleteBoard(e, "nate");
  assert.ok(!e.NOW_AND_THEN.m.has("old:nate"));
});

test("a clock far ahead can't stamp edits into the future, and responses carry the server time", async () => {
  const e = env();
  const ahead = Date.now() + 30 * 864e5;
  const r = await call(e, "PUT", "/data", { token: NATE, body: { lists: [{ id: "n", name: "Now", updatedAt: ahead }], todos: [{ id: "t", listId: "n", text: "x", updatedAt: ahead }] } });
  const b = await r.json();
  assert.ok(b.lists[0].updatedAt <= Date.now() && b.todos[0].updatedAt <= Date.now());
  assert.ok(Math.abs(Number(r.headers.get("X-Server-Time")) - Date.now()) < 5000);
  assert.match(r.headers.get("Access-Control-Expose-Headers"), /X-Server-Time/);
});

test("manual snapshots of an unchanged board reuse the last one for a few minutes", async () => {
  const e = env();
  await call(e, "PUT", "/data", { token: NATE, body: board("milk") });
  const a = await (await call(e, "POST", "/snapshots", { token: NATE })).json();
  const b = await (await call(e, "POST", "/snapshots", { token: NATE })).json();
  assert.equal(b.id, a.id); assert.equal(b.reused, true);
  await call(e, "PUT", "/data", { token: NATE, body: { lists: [], todos: [{ id: "t2", listId: "l1", text: "eggs", updatedAt: Date.now() }] } });
  await new Promise(r => setTimeout(r, 5)); // a new id, to the millisecond
  const c = await (await call(e, "POST", "/snapshots", { token: NATE })).json();
  assert.notEqual(c.id, a.id, "a changed board gets a fresh copy, so a restore can be undone");
});

test("older Done a device packed before it synced arrives in the PUT's old array", async () => {
  const e = env();
  const d = new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10);
  const r = await call(e, "PUT", "/data", { token: NATE, body: { lists: [{ id: "n", name: "Now", updatedAt: 1 }], todos: [],
    old: [{ id: "o1", listId: "n", text: "long ago", done: true, archived: true, archivedDay: d, updatedAt: 5 }, { id: "x", deleted: true, updatedAt: 5 }] } });
  assert.equal((await r.json()).todos.length, 0);
  assert.deepEqual((await (await call(e, "GET", "/old", { token: NATE })).json()).todos.map(t => t.id), ["o1"]);
});
