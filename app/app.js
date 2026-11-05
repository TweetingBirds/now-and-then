// Now and Then: a notebook-style todo board.
// Lists live on this device (localStorage) and, when configured, sync through a
// small Cloudflare Worker that merges changes todo by todo (see /worker).
(() => {
  "use strict";

  // APP_VERSION is bumped by hand for notable releases. The BUILD_* values are
  // stamped by the GitHub Pages workflow on every deploy (left as-is locally).
  const APP_VERSION = "1.10.0";
  const BUILD_NUMBER = "__BUILD_NUMBER__";
  const BUILD_SHA = "__BUILD_SHA__";
  const BUILD_DATE = "__BUILD_DATE__";
  const STAMPED = !BUILD_NUMBER.startsWith("__");

  const BOARD_KEY = "nat.board.v1";
  const LOCAL_KEY = "nat.local.v1"; // per-device: lastDay, sync settings
  const SYNCED_KEY = "nat.synced.v1"; // per-device: updatedAt of each item as the Worker last had it
  const MAX_LISTS = 10;
  const TOMBSTONE_DAYS = 60;
  const PALETTE = ["#f2b84b", "#7b9cff", "#9b8cf0", "#5cc6a7", "#f28b82", "#f6a6cf", "#8ecae6", "#b5d16b", "#c9a27e", "#ff9f5a", "#7fd1d8", "#a3a9b5"];
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const now = () => Date.now();

  // ---------- storage ----------
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  let local = Object.assign({ lastDay: null, syncUrl: "", syncToken: "", pristine: false, synced: false, board: "", boardName: "", boardKind: "", admin: false, switching: false, otherBoard: "", theme: "system", haptics: true }, read(LOCAL_KEY) || {});
  let board = read(BOARD_KEY);
  if (!board) { board = starterBoard(); local.pristine = true; write(LOCAL_KEY, local); }
  // What the Worker last confirmed it has, as { lists: {id: updatedAt}, todos: {...}, settings }.
  // Anything on this device that is newer hasn't reached the Worker yet. A device that
  // synced before this was tracked starts from its current board, so an upgrade
  // doesn't report every todo as unsynced.
  let serverSeen = read(SYNCED_KEY);
  if (!serverSeen) { serverSeen = local.synced ? stampsOf(board) : { lists: {}, todos: {}, settings: 0 }; write(SYNCED_KEY, serverSeen); }

  function starterBoard() {
    const t = now();
    const ids = { now: uid(), tom: uid(), later: uid() };
    const todo = (text, listId, order) => ({ id: uid(), text, listId, order, done: false, doneDay: null, archived: false, updatedAt: t });
    return {
      version: 1,
      settings: { carry: true, doneNow: false, updatedAt: t },
      lists: [
        { id: ids.now, name: "Now", color: "#f2b84b", role: "now", order: 1, updatedAt: t },
        { id: ids.tom, name: "Tomorrow", color: "#7b9cff", role: "tomorrow", order: 2, updatedAt: t },
        { id: ids.later, name: "Later", color: "#5cc6a7", role: "later", order: 3, updatedAt: t },
      ],
      todos: [
        todo("Tap a list name to rename it", ids.now, 1),
        todo("Drag me by the handle to another list", ids.now, 2),
        todo("Things for tomorrow go here", ids.tom, 1),
        todo("Someday ideas go in Later", ids.later, 1),
      ],
    };
  }

  // Same merge the Worker runs: newest edit wins per list, per todo, and for settings.
  // Unlike the Worker, it keeps a's objects (this device's board) and copies the winning
  // fields into them. The rendered rows and an in-progress drag hold references to those
  // objects, so replacing them would make the next drop or edit change a copy that is no
  // longer on the board, and the todo would snap back.
  function mergeBoards(a, b) {
    const cutoff = now() - TOMBSTONE_DAYS * 864e5;
    const mergeById = (x = [], y = []) => {
      const m = new Map();
      for (const item of x) m.set(item.id, item);
      for (const item of y) {
        const prev = m.get(item.id);
        if (!prev) m.set(item.id, item);
        else if (prev !== item && (item.updatedAt || 0) >= (prev.updatedAt || 0)) {
          for (const k of Object.keys(prev)) if (!(k in item)) delete prev[k];
          Object.assign(prev, item);
        }
      }
      return [...m.values()].filter(i => !(i.deleted && (i.updatedAt || 0) < cutoff));
    };
    const sa = a.settings || {}, sb = b.settings || {};
    return {
      version: 1,
      settings: (sb.updatedAt || 0) >= (sa.updatedAt || 0) ? sb : sa,
      lists: mergeById(a.lists, b.lists),
      todos: mergeById(a.todos, b.todos),
    };
  }

  // ---------- helpers over the board ----------
  const lists = () => board.lists.filter(l => !l.deleted).sort((a, b) => a.order - b.order);
  const listById = (id) => board.lists.find(l => l.id === id && !l.deleted);
  const todosIn = (listId) => board.todos.filter(t => !t.deleted && !t.archived && t.listId === listId).sort((a, b) => a.order - b.order);
  const archived = () => board.todos.filter(t => !t.deleted && t.archived).sort((a, b) => (b.archivedDay || "").localeCompare(a.archivedDay || "") || (b.updatedAt - a.updatedAt));
  const touch = (o, fields) => Object.assign(o, fields, { updatedAt: now() });

  // Lists can be deleted on another device; keep orphaned todos visible in the first list.
  function repairOrphans() {
    const first = lists()[0];
    if (!first) { board = mergeBoards(board, starterBoard()); return; }
    board.todos.forEach(t => { if (!t.deleted && !t.archived && !listById(t.listId)) touch(t, { listId: first.id }); });
  }

  // ---------- dates ----------
  function dayDate() { const d = new Date(); d.setHours(12, 0, 0, 0); return d; }
  const keyOf = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const todayKey = () => keyOf(dayDate());
  function pretty(key, opts = { weekday: "long", month: "long", day: "numeric" }) {
    const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, opts);
  }

  function archive(t) {
    const l = listById(t.listId);
    touch(t, { archived: true, archivedDay: t.doneDay || todayKey(), fromName: l ? l.name : "", fromColor: l ? l.color : "#a3a9b5" });
  }

  // Checked todos move to Done: right away when the "doneNow" setting is on,
  // otherwise the morning after they were checked.
  function sweepDone() {
    const today = todayKey();
    let moved = 0;
    for (const t of board.todos) {
      if (!t.deleted && !t.archived && t.done && (board.settings.doneNow || (t.doneDay && t.doneDay < today))) { archive(t); moved++; }
    }
    return moved;
  }

  // The morning ritual: yesterday's checked todos go to Done, and (optionally)
  // unfinished Tomorrow todos move into Now.
  function rollover() {
    const today = todayKey();
    // Builds before this one had a "Start next day" test button that could push
    // lastDay into the future; pull it back so mornings roll over again.
    if (!local.lastDay || local.lastDay > today) { local.lastDay = today; write(LOCAL_KEY, local); return sweepDone(); }
    if (local.lastDay === today) return sweepDone();
    const moved = sweepDone();
    if (board.settings.carry) {
      const nowL = lists().find(l => l.role === "now"), tomL = lists().find(l => l.role === "tomorrow");
      if (nowL && tomL) {
        let o = Math.max(0, ...todosIn(nowL.id).map(t => t.order));
        todosIn(tomL.id).forEach(t => touch(t, { listId: nowL.id, order: ++o }));
      }
    }
    local.lastDay = today; write(LOCAL_KEY, local);
    return moved;
  }

  // ---------- persistence + sync ----------
  let pushTimer = null, syncing = false, again = false;
  function commit() {
    if (local.pristine) { local.pristine = false; write(LOCAL_KEY, local); }
    write(BOARD_KEY, board);
    render();
    schedulePush();
  }
  function syncConfigured() { return !!(local.syncUrl && local.syncToken); }
  function dataUrl() { return local.syncUrl.replace(/\/+$/, "") + "/data"; }

  // ---------- sync status ----------
  // The badge in the header always says whether this device's edits have reached
  // the Worker, and which board it syncs with, so a wrong token or a dropped
  // connection is visible instead of silent.
  let syncError = "";   // last error from the Worker, cleared by the next good sync
  let netDown = false;  // the last request couldn't reach the Worker at all

  function stampsOf(b) {
    const m = xs => Object.fromEntries((xs || []).map(i => [i.id, i.updatedAt || 0]));
    return { lists: m(b.lists), todos: m(b.todos), settings: (b.settings && b.settings.updatedAt) || 0 };
  }
  function rememberServer(remote) { serverSeen = stampsOf(remote); write(SYNCED_KEY, serverSeen); }
  const isPending = (kind, i) => kind in serverSeen && (i.id in serverSeen[kind] ? (i.updatedAt || 0) > serverSeen[kind][i.id] : !i.deleted);
  // Lists, todos and settings edited here since the Worker last confirmed them.
  function pendingChanges() {
    if (!syncConfigured()) return [];
    const out = [];
    for (const l of board.lists) if (isPending("lists", l)) out.push(l);
    for (const t of board.todos) if (isPending("todos", t)) out.push(t);
    if (((board.settings && board.settings.updatedAt) || 0) > (serverSeen.settings || 0)) out.push(board.settings);
    return out;
  }
  const pendingTodoIds = () => new Set(syncConfigured() ? board.todos.filter(t => isPending("todos", t)).map(t => t.id) : []);

  const firstName = (name) => name ? name.charAt(0).toUpperCase() + name.slice(1) : "";
  // Owner boards are named after their TOKEN_<NAME> secret ("nate"). Invited boards
  // have a random id ("b_…") and whatever name the person gave when they joined.
  const isInvited = (id) => /^b_/.test(id || "");
  const boardName = (id = local.board) => firstName(id === local.board && local.boardName ? local.boardName : isInvited(id) ? "" : id);
  // "nate" -> "Nate's board"
  const boardLabel = (id) => {
    const name = boardName(id);
    if (name) return name + "'s board";
    return !id || id === local.board ? "your board" : "another board";
  };
  // Remembers what the Worker says about the board this token opens.
  function noteBoard(res) {
    const id = res.headers.get("X-Board");
    if (!id) return;
    let name = "";
    try { name = decodeURIComponent(res.headers.get("X-Board-Name") || ""); } catch (e) {}
    local.board = id; local.boardName = name;
    local.boardKind = res.headers.get("X-Board-Kind") || (isInvited(id) ? "invited" : "owner");
    local.admin = res.headers.get("X-Board-Admin") === "1";
  }
  // 410: this device's board was deleted (from another device, or by the Worker's
  // owner on request). Turn sync off here and keep the lists that are on screen.
  function boardGone() {
    Object.assign(local, { syncUrl: "", syncToken: "", synced: false, board: "", boardName: "", boardKind: "", admin: false, otherBoard: "", switching: false });
    write(LOCAL_KEY, local);
    rememberServer({ lists: [], todos: [], settings: {} });
    const msg = "This board was deleted from the sync service, so sync is now off on this device. Your lists are still here.";
    setTimeout(() => { toast(msg, 8000); showStatus(); }, 0);
    return new Error(msg);
  }
  const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  function lastSyncedText() {
    if (!local.lastSyncAt) return "Not synced yet";
    const d = new Date(local.lastSyncAt), today = new Date();
    return "Last synced " + (d.toDateString() === today.toDateString() ? "at " + clock(d) :
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ", " + clock(d));
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function syncState() {
    if (!syncConfigured()) return "off";
    if (local.otherBoard || syncError) return "error";
    if (!navigator.onLine || netDown) return "offline";
    if (syncing || pushTimer) return "busy";
    return pendingChanges().length ? "pending" : "ok";
  }
  function showStatus() {
    const s = document.getElementById("syncStatus");
    const state = syncState(), n = pendingChanges().length, who = boardName();
    const unsynced = n ? ` · ${n} unsynced` : "";
    const label = {
      off: "On this device",
      error: "Sync problem" + unsynced,
      offline: "Offline" + unsynced,
      busy: "Syncing…",
      pending: `${n} unsynced`,
      ok: who ? `Synced · ${who}` : "Synced",
    }[state];
    s.dataset.state = state; s.textContent = label;
    document.body.dataset.sync = state;
    const lines = [];
    if (state === "off") lines.push("Lists are kept on this device only. Tap to set up sync.");
    else {
      if (local.board) lines.push(`Syncing with ${boardLabel(local.board)}.`);
      lines.push(lastSyncedText() + ".");
      if (n) lines.push(`${plural(n, "change")} saved here, not yet on the Worker.`);
      if (syncError) lines.push(syncError);
    }
    s.title = lines.join(" ");
    s.setAttribute("aria-label", label + ". " + lines.join(" "));
  }
  // Kept for the call sites that only want the badge refreshed.
  const idleStatus = showStatus;

  // fetch() rejects with a TypeError when the Worker can't be reached at all (no
  // signal, captive Wi-Fi, DNS). That is "offline", not a sync problem.
  function syncFailed(e) {
    if (e instanceof TypeError) { netDown = true; syncError = ""; }
    else { netDown = false; syncError = e.message || String(e); }
    showStatus();
    return syncError || "Couldn't reach the Worker. Check the connection and try again.";
  }
  function syncSucceeded() {
    netDown = false; syncError = "";
    local.lastSyncAt = Date.now(); write(LOCAL_KEY, local);
  }

  // ---------- conflict hints ----------
  // Before merging the Worker's board in, find edits made here that are about to be
  // replaced by a newer edit from another device: the item changed on this device
  // since the last sync, and the Worker's copy also changed since then and is newer.
  function lostEdits(remote) {
    const out = [];
    const check = (kind, mine, theirs) => {
      const byId = new Map(mine.map(i => [i.id, i]));
      for (const r of theirs || []) {
        const m = byId.get(r.id);
        if (!m || !isPending(kind, m)) continue;
        const seen = serverSeen[kind][r.id] || 0;
        if ((r.updatedAt || 0) > seen && (r.updatedAt || 0) > (m.updatedAt || 0)) out.push({ kind, mine: m, theirs: r });
      }
    };
    check("lists", board.lists, remote.lists);
    check("todos", board.todos, remote.todos);
    return out;
  }
  let hintedAt = 0;
  function hintConflicts(lost) {
    if (!lost.length) return;
    hintedAt = Date.now();
    if (lost.length > 1) {
      toast(`${plural(lost.length, "edit")} on this device were replaced by newer changes from another device.`, 6000);
      return;
    }
    const { kind, mine, theirs } = lost[0];
    const name = kind === "lists" ? `The ${theirs.name || mine.name} list` : `“${short(theirs.text || mine.text)}”`;
    let msg;
    if (theirs.deleted) msg = `${name} was deleted on another device.`;
    else if (mine.deleted) msg = `${name} was changed on another device, so it's back.`;
    else msg = `${name} was also changed on another device. The newer version was kept.`;
    toast(msg, 6000);
  }
  const short = (text = "") => text.length > 40 ? text.slice(0, 38).trimEnd() + "…" : text;

  function schedulePush() {
    if (!syncConfigured()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pushTimer = null; sync(); }, 1200);
    showStatus();
  }

  // Send our board; the Worker merges it with what it has and returns the result.
  async function sync() {
    if (!syncConfigured()) return;
    if (syncing) { again = true; return; }
    if (!navigator.onLine) { showStatus(); return "You're offline. Changes are saved on this device and will sync when you're back online."; }
    syncing = true; showStatus();
    try {
      // First sync on a device that still has only the welcome todos, or that is
      // switching from one person's board to another's: take the saved board as is,
      // so this device's lists aren't merged into it.
      if (!local.synced && (local.pristine || local.switching)) {
        const got = await fetch(dataUrl(), { headers: { "Authorization": "Bearer " + local.syncToken } });
        if (got.status === 401) throw new Error("The access token was not accepted.");
        if (got.status === 410) throw boardGone();
        if (got.status === 409) throw new Error(await clashMessage(got));
        if (!got.ok) throw new Error("The Worker answered " + got.status + ".");
        const remote = await got.json();
        if (remote.lists && remote.lists.some(l => !l.deleted)) { board = remote; rememberServer(remote); }
      }
      const headers = { "Authorization": "Bearer " + local.syncToken, "Content-Type": "application/json" };
      if (local.board) headers["X-Expect-Board"] = local.board;
      const res = await fetch(dataUrl(), { method: "PUT", headers, body: JSON.stringify(board) });
      if (res.status === 401) throw new Error("The access token was not accepted.");
      if (res.status === 410) throw boardGone();
      if (res.status === 409) throw new Error(await clashMessage(res));
      if (!res.ok) throw new Error("The Worker answered " + res.status + ".");
      const merged = await res.json();
      noteBoard(res);
      local.switching = false; local.otherBoard = "";
      const lost = local.synced ? lostEdits(merged) : [];
      // Edits made while the request was in flight are newer, so they survive the merge.
      board = mergeBoards(board, merged);
      rememberServer(merged);
      local.synced = true; lastPull = Date.now(); write(LOCAL_KEY, local);
      syncSucceeded();
      repairOrphans();
      write(BOARD_KEY, board);
      if (!isBusyEditing()) render();
      hintConflicts(lost);
      return true;
    } catch (e) {
      return syncFailed(e);
    } finally {
      syncing = false;
      if (again) { again = false; schedulePush(); }
      showStatus();
    }
  }
  // The Worker answers 409 instead of merging when the token opens a different
  // board than this device last synced with, or when two people share a token.
  async function clashMessage(res) {
    let info = {};
    try { info = await res.json(); } catch (e) {}
    if (info.error === "board changed") {
      local.otherBoard = info.board || "?"; write(LOCAL_KEY, local);
      return `This token now opens ${boardLabel(info.board)}, not ${boardLabel(info.expected)}. Nothing was synced. ` +
        `If that's a mistake, fix the token in the Worker. If it's what you want, tap Save and sync to switch this device to ${boardLabel(info.board)}.`;
    }
    if (info.error === "token clash") return `The Worker gives the same token to ${(info.boards || []).join(" and ")}. Nothing was synced. Give each person their own token.`;
    return "The Worker answered 409.";
  }
  // Fetch the saved board without sending ours, so a device that's just sitting open
  // picks up changes made elsewhere. This is a read, which is cheap: the Worker only
  // writes to KV on PUT, and KV's free tier allows far fewer writes than reads.
  // It stands aside whenever a push is due or running (that push returns the merged
  // board anyway) and while the person is typing or dragging, so it never
  // re-renders under their hands. The next poll catches up.
  let lastPull = 0;
  async function pull() {
    if (!syncConfigured() || !local.synced || local.otherBoard) return;
    if (syncing || pushTimer || !navigator.onLine || busyForPull()) return;
    syncing = true; lastPull = Date.now();
    try {
      const res = await fetch(dataUrl(), { headers: { "Authorization": "Bearer " + local.syncToken }, cache: "no-store" });
      if (res.status === 401) throw new Error("The access token was not accepted.");
      if (res.status === 410) throw boardGone();
      if (res.status === 409) throw new Error(await clashMessage(res));
      if (!res.ok) throw new Error("The Worker answered " + res.status + ".");
      // Same board-identity guard as a push: never merge another person's board in.
      const who = res.headers.get("X-Board");
      if (local.board && who && who !== local.board) {
        local.otherBoard = who; write(LOCAL_KEY, local);
        throw new Error(`This token now opens ${boardLabel(who)}, not ${boardLabel(local.board)}. Nothing was synced. ` +
          `If that's a mistake, fix the token in the Worker. If it's what you want, tap Save and sync to switch this device to ${boardLabel(who)}.`);
      }
      const remote = await res.json();
      if (who) noteBoard(res);
      syncSucceeded();
      // Someone may have started typing or dragging while the request was out.
      if (pushTimer || busyForPull()) return;
      const lost = lostEdits(remote);
      const before = JSON.stringify(board);
      board = mergeBoards(board, remote);
      rememberServer(remote);
      repairOrphans();
      const after = JSON.stringify(board);
      if (after !== before) { write(BOARD_KEY, board); render(); }
      hintConflicts(lost);
      // This device had edits the saved board lacks (say a push failed): send them.
      if (hasNewer(board, remote)) schedulePush();
    } catch (e) {
      syncFailed(e);
    } finally {
      syncing = false;
      if (again) { again = false; schedulePush(); }
      showStatus();
    }
  }
  // True when a has a list, todo or settings edit that b doesn't.
  function hasNewer(a, b) {
    const newer = (x = [], y = []) => {
      const seen = new Map(y.map(i => [i.id, i.updatedAt || 0]));
      return x.some(i => !seen.has(i.id) ? !i.deleted : (i.updatedAt || 0) > seen.get(i.id));
    };
    return newer(a.lists, b.lists) || newer(a.todos, b.todos) ||
      ((a.settings && a.settings.updatedAt) || 0) > ((b.settings && b.settings.updatedAt) || 0);
  }
  // An empty, focused add box isn't an edit in progress (render() puts focus back),
  // and on a desktop it can stay focused for hours, so it doesn't hold off a pull.
  function busyForPull() {
    const a = document.activeElement;
    if (!drag && a && a.id && (a.id.startsWith("add-") || a.id === "doneSearch") && !a.value) return false;
    return isBusyEditing();
  }
  function isBusyEditing() {
    const a = document.activeElement;
    return drag || (a && (a.isContentEditable || (a.tagName === "INPUT" && (a.type === "text" || a.type === "search")) || a.classList?.contains("col-title")));
  }

  // ---------- rendering ----------
  const boardEl = document.getElementById("board");
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v; else if (k === "style") n.style.cssText = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
    }
    kids.flat().forEach(c => c != null && n.append(c.nodeType ? c : document.createTextNode(c)));
    return n;
  };

  let openPop = null;
  function closePop() {
    if (!openPop) return;
    openPop.remove(); openPop = null;
    document.querySelectorAll('[aria-expanded="true"]').forEach(b => b.setAttribute("aria-expanded", "false"));
  }
  document.addEventListener("pointerdown", e => { if (openPop && !openPop.contains(e.target) && !e.target.closest("[data-pop-trigger]")) closePop(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closePop(); });
  // Menus float above everything (so the last todo's menu isn't hidden under the add row), so close them if what they point at scrolls away.
  document.addEventListener("scroll", e => { if (openPop && !openPop.contains(e.target)) closePop(); }, true);
  window.addEventListener("resize", () => closePop());

  let unsyncedIds = new Set();
  function render() {
    const scroll = boardEl.scrollLeft;
    const focusedId = document.activeElement?.id;
    const rowFocused = !!document.activeElement?.matches?.(".todo[data-id]");
    closePop();
    document.getElementById("today").textContent = pretty(todayKey());
    const ls = lists();
    unsyncedIds = pendingTodoIds();
    boardEl.replaceChildren();
    ls.forEach(l => boardEl.append(renderList(l)));
    const full = ls.length >= MAX_LISTS;
    boardEl.append(el("button", { class: "new-list", id: "addList", disabled: full, onclick: addList },
      full ? "List limit reached" : "+ New list", el("small", {}, `${ls.length} of ${MAX_LISTS}`)));
    boardEl.append(renderArchive());
    boardEl.scrollLeft = scroll;
    if (focusedId && (focusedId.startsWith("add-") || focusedId === "doneSearch")) document.getElementById(focusedId)?.focus();
    else if (kbSel && (rowFocused || document.activeElement === document.body)) focusTodo(kbSel);
  }

  function renderList(list) {
    const todos = todosIn(list.id);
    const open = todos.filter(t => !t.done).length;
    const col = el("section", { class: "col" + (list.shared ? " shared" : ""), "data-list": list.id, style: `--c:${list.color}` });
    const head = el("div", { class: "col-head" });
    head.append(...[
      el("button", { class: "swatch-btn", title: "Change color", "aria-label": `Change ${list.name} color`, "data-pop-trigger": true, onclick: e => colorPop(e, list, head) }),
      el("input", {
        class: "col-title", value: list.name, "aria-label": "List name", maxlength: 30, id: "name-" + list.id,
        onchange: e => { const v = e.target.value.trim(); if (v && v !== list.name) { touch(list, { name: v }); commit(); } else e.target.value = list.name; },
        onkeydown: e => { if (e.key === "Enter") e.target.blur(); },
      }),
      list.shared ? el("button", { class: "shared-mark", type: "button", title: sharedWith(list), "aria-label": sharedWith(list), "data-pop-trigger": true, onclick: e => listPop(e, list, head) }, PEOPLE()) : null,
      el("span", { class: "count", title: "Unfinished" }, String(open)),
      el("button", { class: "icon-btn", title: "List options", "aria-label": `${list.name} options`, "data-pop-trigger": true, onclick: e => listPop(e, list, head) }, "•••"),
    ].filter(Boolean));
    const body = el("div", { class: "col-body", "data-drop": list.id });
    if (!todos.length) body.append(el("div", { class: "empty" }, list.role === "later" ? "Someday things go here." : "Nothing here yet."));
    todos.forEach(t => body.append(renderTodo(t)));
    const input = el("input", { type: "text", placeholder: `Add to ${list.name}…`, "aria-label": `Add to ${list.name}`, id: "add-" + list.id, enterkeyhint: "done" });
    const form = el("form", { class: "add", onsubmit: e => {
      e.preventDefault(); const v = input.value.trim(); if (!v) return;
      const order = Math.max(0, ...todos.map(t => t.order)) + 1;
      board.todos.push({ id: uid(), text: v, listId: list.id, order, done: false, doneDay: null, archived: false, updatedAt: now() });
      commit();
    } }, input, el("button", { class: "btn", type: "submit" }, "Add"));
    col.append(head, body, form);
    return col;
  }

  function renderTodo(t) {
    const row = el("div", { class: "todo" + (t.done ? " done" : "") + (unsyncedIds.has(t.id) ? " unsynced" : ""), "data-id": t.id });
    const text = el("div", { class: "text", ondblclick: () => editText(text, t) }, t.text);
    row.append(
      el("button", { class: "grip", "aria-label": "Drag to move", title: "Drag to move", onpointerdown: e => startDrag(e, t, row) }, "⋮⋮"),
      el("input", { type: "checkbox", class: "check", checked: t.done, "aria-label": "Done", onchange: e => {
        const checked = e.target.checked;
        const undo = undoable([t], () => {
          touch(t, { done: checked, doneDay: checked ? todayKey() : null });
          if (checked && board.settings.doneNow) archive(t);
          commit();
        });
        if (checked) toast(board.settings.doneNow ? "Nice. Moved to Done." : "Nice. It moves to Done tomorrow morning.", undo);
      } }),
      text,
      el("span", { class: "unsynced-dot", title: "Not synced yet", "aria-label": "Not synced yet" }),
      el("button", { class: "icon-btn more", "aria-label": "Todo options", "aria-expanded": "false", "data-pop-trigger": true, onclick: e => todoPop(e, t, row, text) }, "•••"),
    );
    return row;
  }

  function editText(node, t) {
    node.contentEditable = "true"; node.focus();
    document.getSelection().selectAllChildren(node);
    const finish = () => { const v = node.textContent.trim(); node.contentEditable = "false"; if (v && v !== t.text) { touch(t, { text: v }); commit(); } else render(); };
    node.addEventListener("blur", finish, { once: true });
    node.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); node.blur(); }
      if (e.key === "Escape") { node.textContent = t.text; node.blur(); }
    });
  }

  // Menus live on <body> with fixed positioning, so a list's scroll area can't clip them.
  // They open below the trigger, or above it when there isn't room below.
  function popAt(anchor, trigger, ...kids) {
    closePop();
    openPop = el("div", { class: "pop", role: "menu" }, ...kids);
    document.body.append(openPop);
    trigger.setAttribute("aria-expanded", "true");
    placePop(anchor, trigger, "right");
    return openPop;
  }
  function placePop(anchor, trigger, align) {
    const pop = openPop, gap = 4, pad = 8;
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const a = anchor.getBoundingClientRect(), t = trigger.getBoundingClientRect();
    pop.style.maxHeight = (vh - pad * 2) + "px";
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let left = align === "left" ? a.left + 8 : t.right - w;
    left = Math.max(pad, Math.min(left, vw - w - pad));
    let top = t.bottom + gap;
    if (top + h > vh - pad) top = t.top - gap - h >= pad ? t.top - gap - h : Math.max(pad, vh - pad - h);
    pop.style.left = left + "px"; pop.style.top = top + "px";
  }

  function todoPop(e, t, row, text) {
    popAt(row, e.currentTarget,
      el("div", { class: "lbl" }, "Move to"),
      lists().filter(l => l.id !== t.listId).map(l => el("button", { class: "item", onclick: () => { toast(`Moved to ${l.name}`, undoable([t], () => moveTodo(t, l.id, null))); } },
        el("span", { class: "dot", style: `background:${l.color}` }), l.name)),
      el("div", { class: "lbl" }, "This todo"),
      el("button", { class: "item", onclick: () => { closePop(); editText(text, t); } }, "Edit text"),
      el("button", { class: "item danger", onclick: () => { toast("Deleted", undoable([t], () => { touch(t, { deleted: true }); commit(); })); } }, "Delete"),
    );
  }

  function colorPop(e, list, head) {
    let pending = null;
    const preview = c => { head.closest(".col").style.setProperty("--c", c); pending = c; };
    const apply = c => { touch(list, { color: c }); commit(); };
    popAt(head, e.currentTarget,
      el("div", { class: "lbl" }, "Page color"),
      el("div", { class: "swatches" }, PALETTE.map(c => el("button", {
        style: `background:${c}`, "aria-label": "Color " + c, "aria-pressed": String(c === list.color), onclick: () => apply(c),
      }))),
      el("label", { class: "custom-color" },
        el("input", { type: "color", value: list.color, oninput: ev => preview(ev.target.value), onchange: ev => apply(ev.target.value) }),
        "Custom color"),
    );
    placePop(head, e.currentTarget, "left");
  }

  function listPop(e, list, head) {
    const count = todosIn(list.id).length;
    const ls = lists(), idx = ls.indexOf(list);
    const fallback = ls.find(l => l.id !== list.id && !l.shared);
    const confirmBox = el("div", { hidden: true });
    const leaveBox = el("div", { hidden: true });
    const canShare = !list.shared && list.role !== "now" && list.role !== "tomorrow";
    popAt(head, e.currentTarget,
      list.shared ? el("div", { class: "lbl shared-lbl" }, sharedWith(list)) : null,
      el("button", { class: "item", onclick: () => { closePop(); const i = document.getElementById("name-" + list.id); i.focus(); i.select(); } }, "Rename"),
      el("button", { class: "item", disabled: idx === 0, onclick: () => swapLists(list, ls[idx - 1]) }, "Move list left"),
      el("button", { class: "item", disabled: idx === ls.length - 1, onclick: () => swapLists(list, ls[idx + 1]) }, "Move list right"),
      canShare ? el("button", { class: "item", onclick: () => { closePop(); shareList(list); } }, "Share list…") : null,
      list.shared ? el("button", { class: "item", onclick: () => { closePop(); shareList(list); } }, "Invite someone…") : null,
      list.shared ? el("button", { class: "item danger", onclick: () => { leaveBox.hidden = false; } }, "Leave shared list…") : null,
      !list.shared && fallback ? el("button", { class: "item danger", onclick: () => { confirmBox.hidden = false; } }, "Delete list…") : null,
      confirmBox, leaveBox,
    );
    const others = (list.members || []).length - 1;
    leaveBox.append(
      el("div", { class: "lbl" }, others > 0 ? `It comes off your board and stays on ${others === 1 ? "the other person's" : `${others} other boards`}.` : "You're the only one on it, so it will be deleted."),
      el("button", { class: "item danger", onclick: () => { closePop(); leaveList(list); } }, "Yes, leave " + list.name),
    );
    confirmBox.append(
      el("div", { class: "lbl" }, count ? `${count} todo${count > 1 ? "s" : ""} will move to ${fallback?.name}` : "This list is empty"),
      el("button", { class: "item danger", onclick: () => {
        const undo = undoable([list, ...todosIn(list.id)], () => {
          let o = Math.max(0, ...todosIn(fallback.id).map(t => t.order));
          todosIn(list.id).forEach(t => touch(t, { listId: fallback.id, order: ++o }));
          touch(list, { deleted: true });
          commit();
        });
        toast(`Deleted ${list.name}`, undo);
      } }, "Yes, delete " + list.name),
    );
  }

  function swapLists(a, b) {
    const ao = a.order; touch(a, { order: b.order }); touch(b, { order: ao }); commit();
  }

  function addList() {
    const ls = lists();
    if (ls.length >= MAX_LISTS) return;
    const used = new Set(ls.map(l => l.color));
    const color = PALETTE.find(c => !used.has(c)) || PALETTE[ls.length % PALETTE.length];
    const list = { id: uid(), name: "New list", color, role: null, order: Math.max(0, ...ls.map(l => l.order)) + 1, updatedAt: now() };
    board.lists.push(list); commit();
    const i = document.getElementById("name-" + list.id);
    i.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" }); i.focus(); i.select();
  }

  // ---------- shared lists ----------
  // A shared list lives on its own on the Worker and shows up on the board of
  // everyone on it (see "Shared lists" in worker/worker.js). The Worker marks it
  // with list.shared (its id) and list.members (first names). Name, color and
  // todos are shared; where it sits on the board is each person's own.
  const PEOPLE = () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "16"); svg.setAttribute("height", "16"); svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = '<circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M15.5 5.3a3 3 0 0 1 0 5.4M17.5 14.3c1.8.7 3 2.3 3.5 4.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    return svg;
  };
  function sharedWith(list) {
    const me = boardName();
    const others = (list.members || []).filter((n, i, a) => !(n === me && a.indexOf(n) === i));
    if (!others.length) return "Shared · just you for now";
    const names = others.length <= 3 ? others.join(", ").replace(/, ([^,]*)$/, " and $1") : `${others.slice(0, 2).join(", ")} and ${others.length - 2} more`;
    return "Shared with " + names;
  }
  async function sharedFetch(path, opts = {}) {
    const res = await fetch(workerBase() + "/shared" + path, Object.assign({ cache: "no-store" }, opts, {
      headers: { "Authorization": "Bearer " + local.syncToken, "Content-Type": "application/json" },
    }));
    if (res.status === 401) throw new Error("The access token was not accepted.");
    if (res.status === 410) throw boardGone();
    let body = {};
    try { body = await res.json(); } catch (e) {}
    if (!res.ok) { const err = new Error(body.error || "The Worker answered " + res.status + "."); err.status = res.status; err.code = body.error; throw err; }
    return body;
  }
  const canUseShared = () => syncConfigured() && local.synced && !local.otherBoard;

  // Makes the list shared if it isn't yet, then a one-time link for someone else.
  async function shareList(list) {
    if (!canUseShared()) {
      openSettingsTo("sync");
      toast("Sharing a list needs sync. Turn it on here first.", 5000);
      return;
    }
    if (!navigator.onLine) { toast("You're offline. Sharing needs a connection.", 4000); return; }
    toast(list.shared ? "Making a link…" : `Sharing ${list.name}…`, 8000);
    try {
      let sid = list.shared;
      if (!sid) {
        // The Worker moves the list as it has it, so send any edits here first.
        const first = await sync();
        if (first !== true) throw new Error(first);
        sid = (await sharedFetch("", { method: "POST", body: JSON.stringify({ listId: list.id }) })).sid;
        await sync();
      }
      const inv = await sharedFetch("/" + encodeURIComponent(sid) + "/invites", { method: "POST" });
      const name = (listById(list.id) || list).name;
      const how = await shareLink(appLink({ share: inv.code, sync: workerBase() }), `Join my ${name} list`);
      const until = shortDate(inv.expires);
      if (how === "copied") toast(`Link copied. Send it to the person you're sharing ${name} with. It works once, until ${until}.`, 7000);
      else if (how === "shared") toast(`Link sent. It works once, until ${until}.`, 5000);
      else hideToast();
    } catch (e) {
      const msg = e.code === "full" ? "This sync service has as many shared lists as it allows." :
        e.code === "can't share this list" ? "Now and Tomorrow can't be shared, because each morning moves todos between them. Make a new list to share." :
        e instanceof TypeError ? "Couldn't reach the sync service." : e.message;
      toast("Couldn't share: " + msg, 7000);
    }
  }

  async function leaveList(list) {
    const name = list.name; // the list object is a tombstone after the sync below
    if (!navigator.onLine) { toast("You're offline. Leaving a shared list needs a connection.", 4000); return; }
    try {
      const res = await sharedFetch("/" + encodeURIComponent(list.shared), { method: "DELETE" });
      await sync();
      toast(res.deleted ? `Left ${name}. You were the last one on it, so it's deleted.` : `Left ${name}. It's still on the others' boards.`, 5000);
    } catch (e) {
      if (e.status === 404) { await sync(); return; }
      toast("Couldn't leave: " + (e instanceof TypeError ? "the sync service can't be reached." : e.message), 6000);
    }
  }

  // ---------- Done archive: search, filter, put back ----------
  // The search and filter live outside render() so they survive re-renders and syncs.
  const doneView = { q: "", range: "all", list: "" };
  const RANGES = [["all", "All"], ["today", "Today"], ["week", "This week"], ["month", "This month"]];
  const fold = s => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  function rangeStart(range) {
    const d = dayDate();
    if (range === "today") return keyOf(d);
    if (range === "week") { d.setDate(d.getDate() - d.getDay()); return keyOf(d); } // weeks start on Sunday
    if (range === "month") { d.setDate(1); return keyOf(d); }
    return "";
  }
  function filteredArchive(items) {
    const words = fold(doneView.q).split(/\s+/).filter(Boolean);
    const since = rangeStart(doneView.range);
    return items.filter(a =>
      (!since || (a.archivedDay || "") >= since) &&
      (!doneView.list || a.fromName === doneView.list) &&
      words.every(w => fold(a.text).includes(w) || fold(a.fromName).includes(w)));
  }
  // Wraps each search word found in the text in <mark>, without touching innerHTML.
  function highlight(text) {
    const words = fold(doneView.q).split(/\s+/).filter(Boolean);
    if (!words.length) return text;
    const f = fold(text); // NFD folding can change length, so only highlight when it didn't
    if (f.length !== text.length) return text;
    const hits = [];
    words.forEach(w => { for (let i = f.indexOf(w); i !== -1; i = f.indexOf(w, i + w.length)) hits.push([i, i + w.length]); });
    hits.sort((a, b) => a[0] - b[0]);
    const out = []; let at = 0;
    for (const [s, e] of hits) {
      if (e <= at) continue;
      const from = Math.max(s, at);
      if (from > at) out.push(text.slice(at, from));
      out.push(el("mark", {}, text.slice(from, e))); at = e;
    }
    if (at < text.length) out.push(text.slice(at));
    return out;
  }
  function restoreTarget(a) {
    return listById(a.listId) || lists().find(l => l.name === a.fromName) || lists()[0];
  }

  function renderArchive() {
    const all = archived();
    const col = el("section", { class: "col archive" });
    const count = el("span", { class: "count" });
    col.append(el("div", { class: "col-head" },
      el("span", { class: "swatch-btn", "aria-hidden": "true" }),
      el("div", { class: "col-title" }, "Done"),
      count));
    const body = el("div", { class: "col-body" });
    const summary = el("div", { class: "done-summary", role: "status" });

    const search = el("input", { type: "search", id: "doneSearch", class: "done-search", placeholder: "Search Done…",
      "aria-label": "Search finished todos", autocomplete: "off", spellcheck: "false", enterkeyhint: "search",
      oninput: e => { doneView.q = e.target.value; fill(); },
      onkeydown: e => { if (e.key === "Escape" && search.value) { e.stopPropagation(); search.value = doneView.q = ""; fill(); } } });
    search.value = doneView.q;

    const chips = el("div", { class: "done-chips", role: "group", "aria-label": "When finished" },
      RANGES.map(([v, label]) => el("button", { type: "button", class: "chip", "data-range": v, "aria-pressed": String(doneView.range === v),
        onclick: () => { doneView.range = v; chips.querySelectorAll(".chip").forEach(c => c.setAttribute("aria-pressed", String(c.dataset.range === v))); fill(); } }, label)));

    const names = [...new Set(all.map(a => a.fromName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (doneView.list && !names.includes(doneView.list)) doneView.list = "";
    const pick = el("select", { class: "done-list", "aria-label": "From list", onchange: e => { doneView.list = e.target.value; fill(); } },
      el("option", { value: "" }, "Any list"), names.map(n => el("option", { value: n }, n)));
    pick.value = doneView.list;

    if (all.length) col.append(el("div", { class: "done-tools" }, search, chips, el("div", { class: "done-meta" }, summary, names.length > 1 ? pick : null)));
    col.append(body);

    function fill() {
      const items = filteredArchive(all);
      const filtering = !!(doneView.q.trim() || doneView.range !== "all" || doneView.list);
      count.textContent = filtering ? `${items.length} of ${all.length}` : String(all.length);
      const n = items.length, plural = n === 1 ? "" : "s";
      const when = { today: "today", week: "this week", month: "this month" }[doneView.range];
      summary.textContent = !filtering ? "" : when && !doneView.q.trim() ? `${n} finished ${when}` : `${n} match${n === 1 ? "" : "es"}`;
      summary.hidden = !filtering;
      body.replaceChildren();
      if (!all.length) { body.append(el("div", { class: "empty" }, "Finished todos land here each morning.")); return; }
      if (!items.length) {
        body.append(el("div", { class: "empty" }, doneView.q.trim() ? "Nothing in Done matches that." : "Nothing finished in this stretch yet."),
          el("button", { type: "button", class: "btn clear-filter", onclick: () => { doneView.q = ""; doneView.range = "all"; doneView.list = ""; render(); } }, "Show everything"));
        return;
      }
      let last = null;
      for (const a of items) {
        if (a.archivedDay !== last) { last = a.archivedDay; body.append(el("div", { class: "day-label" }, a.archivedDay ? pretty(a.archivedDay, { weekday: "short", month: "short", day: "numeric" }) : "Earlier")); }
        const target = restoreTarget(a);
        body.append(el("div", { class: "todo done" },
          el("span", { class: "dot", style: `background:${a.fromColor}` }),
          el("div", { class: "text" }, highlight(a.text)),
          el("button", { type: "button", class: "put-back", title: `Put back on ${target ? target.name : "a list"}`, "aria-label": `Put “${a.text}” back on ${target ? target.name : "a list"}`, onclick: () => restore(a) },
            el("span", { "aria-hidden": "true" }, "↩"), " ", target ? target.name : "")));
      }
    }
    fill();
    return col;
  }

  // Puts a finished todo back, unchecked, at the bottom of the list it came from.
  function restore(a) {
    const list = restoreTarget(a);
    const order = Math.max(0, ...todosIn(list.id).map(t => t.order)) + 1;
    const undo = undoable([a], () => {
      touch(a, { archived: false, archivedDay: null, done: false, doneDay: null, listId: list.id, order });
      commit();
    });
    toast(`Put back on ${list.name}`, undo);
  }

  // ---------- moving & drag ----------
  function moveTodo(t, listId, beforeId) {
    const siblings = todosIn(listId).filter(x => x.id !== t.id);
    let order;
    const bi = beforeId ? siblings.findIndex(x => x.id === beforeId) : -1;
    if (bi < 0) order = (siblings.at(-1)?.order ?? 0) + 1;
    else order = ((siblings[bi - 1]?.order ?? siblings[bi].order - 2) + siblings[bi].order) / 2;
    touch(t, { listId, order });
    commit();
  }

  // One finger drags a todo by its grip. While it is held, a second finger can swipe the board
  // sideways to reach another list; holding the todo near the left or right edge also scrolls.
  let drag = null;
  function startDrag(e, t, row) {
    if (e.button !== 0 || drag) return;
    e.preventDefault();
    drag = {
      t, row, id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY,
      started: false, ghost: null, ph: el("div", { class: "placeholder" }), target: null, before: null,
      swipe: null, raf: 0,
    };
    document.body.classList.add("is-holding");
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.addEventListener("selectstart", noSelect);
    document.addEventListener("touchmove", noTouchScroll, { passive: false });
  }
  const noSelect = e => e.preventDefault();
  const noTouchScroll = e => { if (drag && drag.started) e.preventDefault(); };

  function beginDrag() {
    drag.started = true; closePop();
    document.getSelection()?.removeAllRanges();
    drag.ghost = el("div", { class: "ghost" }, drag.t.text); document.body.append(drag.ghost);
    drag.row.classList.add("dragging"); document.body.classList.add("is-dragging");
    haptic("lift");
    drag.raf = requestAnimationFrame(edgeScroll);
  }

  // A second finger (or any other pointer) landing while a todo is held becomes the swipe finger.
  function onDown(e) {
    if (!drag || e.pointerId === drag.id) return;
    e.preventDefault(); e.stopPropagation();
    if (!drag.started) beginDrag();
    drag.swipe = { id: e.pointerId, x: e.clientX, scroll: boardEl.scrollLeft, lastX: e.clientX, v: 0, time: e.timeStamp };
  }

  function onMove(e) {
    if (!drag) return;
    const sw = drag.swipe;
    if (sw && e.pointerId === sw.id) {
      e.preventDefault();
      const dt = Math.max(1, e.timeStamp - sw.time);
      sw.v = (e.clientX - sw.lastX) / dt; sw.lastX = e.clientX; sw.time = e.timeStamp;
      boardEl.scrollLeft = sw.scroll - (e.clientX - sw.x);
      updateDrop();
      return;
    }
    if (e.pointerId !== drag.id) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
      beginDrag();
    }
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    drag.ghost.style.left = (e.clientX - 20) + "px"; drag.ghost.style.top = (e.clientY - 18) + "px";
    updateDrop();
  }

  // Work out which list and position sit under the held todo. Called on every move and whenever the board scrolls under it.
  function updateDrop() {
    if (!drag || !drag.started) return;
    const x = drag.lastX, y = drag.lastY;
    const under = document.elementFromPoint(x, y);
    const col = under && under.closest(".col[data-list]");
    if (!col) { drag.ph.remove(); drag.target = null; return; }
    const body = col.querySelector(".col-body");
    const rows = [...body.querySelectorAll(".todo:not(.dragging)")];
    const before = rows.find(r => y < r.getBoundingClientRect().top + r.offsetHeight / 2) || null;
    if (drag.target !== col.dataset.list) document.querySelectorAll(".empty[hidden]").forEach(n => n.removeAttribute("hidden"));
    body.querySelector(".empty")?.setAttribute("hidden", "");
    if (before ? drag.ph.nextSibling !== before || drag.ph.parentNode !== body : drag.ph.parentNode !== body || drag.ph.nextSibling) {
      before ? body.insertBefore(drag.ph, before) : body.append(drag.ph);
    }
    if (drag.target && drag.target !== col.dataset.list) haptic("tick");
    drag.target = col.dataset.list; drag.before = before ? before.dataset.id : null;
  }

  // Holding the todo near a side of the board keeps scrolling that way, faster the closer it gets.
  function edgeScroll() {
    if (!drag || !drag.started) return;
    if (!drag.swipe) {
      const r = boardEl.getBoundingClientRect(), zone = Math.min(56, r.width / 6);
      const x = drag.lastX;
      let step = 0;
      if (x > r.right - zone) step = Math.ceil(14 * (x - (r.right - zone)) / zone);
      else if (x < r.left + zone) step = -Math.ceil(14 * ((r.left + zone) - x) / zone);
      if (step) {
        const before = boardEl.scrollLeft;
        boardEl.scrollLeft += step;
        if (boardEl.scrollLeft !== before) updateDrop();
      }
    }
    drag.raf = requestAnimationFrame(edgeScroll);
  }

  // When the swipe finger lifts, settle on the nearest list (or the next one if it was flicked).
  function settleBoard(v = 0) {
    const cols = [...boardEl.children];
    if (!cols.length) return;
    const pad = parseFloat(getComputedStyle(boardEl).paddingLeft) || 0;
    const base = boardEl.getBoundingClientRect().left + pad;
    const offsets = cols.map(c => boardEl.scrollLeft + c.getBoundingClientRect().left - base);
    let i = offsets.reduce((best, o, k) => Math.abs(o - boardEl.scrollLeft) < Math.abs(offsets[best] - boardEl.scrollLeft) ? k : best, 0);
    if (Math.abs(v) > 0.4) {
      const cur = offsets[i];
      if (v < 0 && cur <= boardEl.scrollLeft + 1) i = Math.min(cols.length - 1, i + 1);
      if (v > 0 && cur >= boardEl.scrollLeft - 1) i = Math.max(0, i - 1);
    }
    const max = boardEl.scrollWidth - boardEl.clientWidth;
    boardEl.scrollTo({ left: Math.max(0, Math.min(max, offsets[i])), behavior: "smooth" });
  }
  boardEl.addEventListener("scroll", () => updateDrop(), { passive: true });

  function onUp(e) {
    if (!drag) return;
    if (drag.swipe && e.pointerId === drag.swipe.id) {
      const v = drag.swipe.v; drag.swipe = null;
      settleBoard(v);
      return;
    }
    if (e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    document.removeEventListener("selectstart", noSelect);
    document.removeEventListener("touchmove", noTouchScroll);
    document.body.classList.remove("is-dragging", "is-holding");
    cancelAnimationFrame(d.raf);
    document.getSelection()?.removeAllRanges();
    if (!d.started) return;
    d.ghost.remove(); d.ph.remove();
    if (d.target && e.type !== "pointercancel") {
      haptic("drop");
      if (d.t.listId === d.target) moveTodo(d.t, d.target, d.before);
      else toast(`Moved to ${listById(d.target).name}`, undoable([d.t], () => moveTodo(d.t, d.target, d.before)));
    } else render();
  }

  // ---------- undo ----------
  // An undoable action copies the lists and todos it is about to change, makes the
  // change, and hands back what Undo needs. Undo puts the old fields back with a fresh
  // updatedAt, so the restored version is the newest edit and wins the merge on the
  // Worker and on other devices, like any other edit (a deleted todo comes back from
  // its tombstone the same way). If an item has changed again since, here or on
  // another device, Undo leaves that item alone rather than overwrite the newer edit.
  function undoable(items, change) {
    const before = items.map(o => ({ o, kind: board.lists.includes(o) ? "lists" : "todos", snap: JSON.parse(JSON.stringify(o)) }));
    change();
    return before.map(({ o, kind, snap }) => ({ kind, id: o.id, snap, at: o.updatedAt }));
  }
  let undoEntries = null;
  function undo() {
    const entries = undoEntries;
    if (!entries) return;
    undoEntries = null;
    let skipped = 0;
    for (const { kind, id, snap, at } of entries) {
      const o = board[kind].find(x => x.id === id);
      if (!o || (o.updatedAt || 0) !== at) { skipped++; continue; }
      for (const k of Object.keys(o)) if (!(k in snap)) delete o[k];
      Object.assign(o, snap, { updatedAt: now() });
    }
    if (skipped < entries.length) { repairOrphans(); commit(); }
    toast(!skipped ? "Undone" : skipped === entries.length ? "Couldn't undo. It was changed since then." : "Undone, except what was changed since then.");
  }
  // Cmd+Z / Ctrl+Z works while an Undo toast is showing, unless you're typing.
  document.addEventListener("keydown", e => {
    if (!undoEntries || e.key.toLowerCase() !== "z" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    if (isBusyEditing() || dlg.open) return;
    e.preventDefault(); undo();
  });

  // ---------- toast ----------
  // Toasts with an Undo button stay up longer, and don't hide while a finger or mouse is on them.
  const toastEl = document.getElementById("toast");
  let toastTimer;
  // As a popover the toast sits in the top layer, so it shows above an open
  // Settings dialog instead of behind it. Older browsers keep the plain version.
  const toastOnTop = typeof toastEl.showPopover === "function";
  if (toastOnTop) toastEl.popover = "manual";
  function hideToast() { toastEl.hidden = true; undoEntries = null; if (toastOnTop) try { toastEl.hidePopover(); } catch (e) {} }
  // The second argument is either how long to show the toast (ms) or what Undo needs, from undoable().
  let toastMs = 2400;
  function armToast() { clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, toastMs); }
  function toast(msg, extra) {
    const undoInfo = Array.isArray(extra) ? extra : null;
    undoEntries = undoInfo && undoInfo.length ? undoInfo : null;
    toastMs = typeof extra === "number" ? extra : undoEntries ? 6000 : 2400;
    toastEl.replaceChildren(el("span", {}, msg));
    if (undoEntries) toastEl.append(el("button", { class: "toast-undo", type: "button", onclick: () => { clearTimeout(toastTimer); undo(); } }, "Undo"));
    toastEl.hidden = false;
    // Showing it again puts it above a dialog that opened after it.
    if (toastOnTop) try { toastEl.hidePopover(); toastEl.showPopover(); } catch (e) {}
    armToast();
  }
  toastEl.addEventListener("pointerenter", () => clearTimeout(toastTimer));
  toastEl.addEventListener("pointerleave", () => { if (!toastEl.hidden) armToast(); });

  // ---------- settings ----------
  const dlg = document.getElementById("settings");
  document.getElementById("openSettings").addEventListener("click", () => {
    document.getElementById("carry").checked = !!board.settings.carry;
    document.getElementById(board.settings.doneNow ? "doneNow" : "doneLater").checked = true;
    document.getElementById("syncUrl").value = local.syncUrl;
    document.getElementById("syncToken").value = local.syncToken;
    const sm = document.getElementById("syncMsg");
    if (local.otherBoard || syncError) { sm.className = "msg bad"; sm.textContent = syncError || "This device's token now opens a different board. Nothing was synced."; }
    else { sm.className = "msg"; sm.textContent = syncSummary(); }
    showVersion();
    closeRestore(); backupMsg(""); loadSnapshots(); showSyncMore(); inviteMsg("");
    showSyncRow(); showPane("main");
    dlg.showModal();
    checkForUpdate();
  });
  // Settings has a main page and two sub-pages (Sync, Backups) in the same sheet.
  // The header swaps its title for a back button on a sub-page; Esc goes back first.
  const settingsTitle = document.getElementById("settingsTitle"), settingsBack = document.getElementById("settingsBack");
  let pane = "main";
  function showPane(name, from) {
    pane = name;
    dlg.querySelectorAll(".pane").forEach(p => { p.hidden = p.dataset.pane !== name; });
    const sub = dlg.querySelector(`.pane[data-pane="${name}"]`);
    settingsTitle.textContent = name === "main" ? "Settings" : sub.dataset.title;
    settingsBack.hidden = name === "main";
    dlg.classList.toggle("sub", name !== "main");
    dlg.querySelector(".settings-body").scrollTop = 0;
    if (name === "main") { showSyncRow(); if (from) dlg.querySelector(`[data-go="${from}"]`)?.focus(); }
    else if (dlg.open) settingsBack.focus();
  }
  dlg.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => showPane(b.dataset.go)));
  settingsBack.addEventListener("click", () => showPane("main", pane));
  dlg.addEventListener("cancel", e => { if (pane !== "main") { e.preventDefault(); showPane("main", pane); } });
  // Opens Settings straight to a sub-page, e.g. from the sync badge.
  function openSettingsTo(name) { document.getElementById("openSettings").click(); showPane(name); }
  // The Sync row on the main page says where things stand without opening it.
  function showSyncRow() {
    const sub = document.getElementById("syncRowSub"), state = syncState();
    sub.classList.toggle("bad", state === "error");
    if (state === "off") sub.textContent = "Off. Your lists stay on this device.";
    else if (state === "error") sub.textContent = "Needs a look. " + (local.otherBoard ? "This token opens a different board." : "The Worker refused the last sync.");
    else sub.textContent = [local.board ? boardLabel(local.board).replace(/^./, c => c.toUpperCase()) : "", state === "offline" ? "Offline" : lastSyncedText()].filter(Boolean).join(" · ");
    document.getElementById("backupRowSub").textContent = syncConfigured() && local.synced
      ? "Download, restore and nightly copies." : "Download or restore a backup file.";
  }
  function syncSummary() {
    if (!syncConfigured()) return "";
    const n = pendingChanges().length;
    return [local.board ? `Syncing with ${boardLabel(local.board)}.` : "", lastSyncedText() + ".",
      n ? `${plural(n, "change")} on this device ${n === 1 ? "hasn't" : "haven't"} synced yet.` : ""].filter(Boolean).join(" ");
  }
  // Tapping the badge syncs now. On a phone there's no hover, so it also says what's wrong.
  document.getElementById("syncStatus").addEventListener("click", async () => {
    if (!syncConfigured()) { openSettingsTo("sync"); return; }
    const state = syncState(), n = pendingChanges().length;
    if (state === "error" && local.otherBoard) { openSettingsTo("sync"); return; }
    if (state === "offline" && !navigator.onLine) {
      toast(n ? `You're offline. ${plural(n, "change")} saved on this device will sync when you're back online.` : "You're offline. Changes will sync when you're back online.", 5000);
      return;
    }
    const asked = Date.now();
    const result = await sync();
    if (result === true && hintedAt < asked) toast(`Synced with ${boardLabel(local.board)}.`);
    else if (typeof result === "string") toast(result, 6000);
  });
  document.getElementById("carry").addEventListener("change", e => {
    board.settings = Object.assign({}, board.settings, { carry: e.target.checked, updatedAt: now() }); commit();
  });
  document.querySelectorAll('input[name="doneWhen"]').forEach(r => r.addEventListener("change", () => {
    board.settings = Object.assign({}, board.settings, { doneNow: document.getElementById("doneNow").checked, updatedAt: now() });
    const moved = sweepDone(); commit();
    if (moved) toast(`${moved} finished todo${moved === 1 ? "" : "s"} moved to Done.`);
  }));
  document.getElementById("saveSync").addEventListener("click", async () => {
    const msg = document.getElementById("syncMsg");
    const url = document.getElementById("syncUrl").value.trim();
    const token = document.getElementById("syncToken").value.trim();
    if ((url && !token) || (!url && token)) { msg.className = "msg bad"; msg.textContent = "Fill in both the address and the token, or leave both empty."; return; }
    if (url && !/^https:\/\//i.test(url)) { msg.className = "msg bad"; msg.textContent = "The address should start with https://"; return; }
    useSync(url, token);
    if (!url) { msg.className = "msg"; msg.textContent = "Sync is off. Lists stay on this device."; syncError = ""; netDown = false; idleStatus(); showSyncMore(); render(); return; }
    msg.className = "msg"; msg.textContent = "Connecting…";
    const result = await sync();
    if (result === true) { msg.textContent = `Connected to ${boardLabel(local.board)}. Your lists are synced.`; render(); showSyncMore(); setTimeout(() => dlg.close(), 1400); }
    else { msg.className = "msg bad"; msg.textContent = "Couldn't sync: " + result; }
  });
  // A new token (or a confirmed switch after a "board changed" warning) means a
  // different board: load it instead of merging this device's lists into it.
  function useSync(url, token) {
    if (url !== local.syncUrl || token !== local.syncToken || local.otherBoard) {
      local.synced = false;
      if (local.board) { local.switching = true; local.board = ""; }
      Object.assign(local, { boardName: "", boardKind: "", admin: false, otherBoard: "" });
      rememberServer({ lists: [], todos: [], settings: {} });
    }
    local.syncUrl = url; local.syncToken = token; write(LOCAL_KEY, local);
  }
  const workerBase = () => local.syncUrl.replace(/\/+$/, "");
  const appLink = (params) => location.origin + location.pathname + "#" + new URLSearchParams(params).toString();
  // Shares a link with the share sheet on a phone, or copies it on a computer.
  async function shareLink(link, title) {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      try { await navigator.share({ title, url: link }); return "shared"; } catch (e) { if (e.name === "AbortError") return ""; }
    }
    try { await navigator.clipboard.writeText(link); return "copied"; } catch (e) { prompt("Copy this link:", link); return "shown"; }
  }

  // ---- sync extras: device link, invites (Worker admins), deleting the board ----
  function showSyncMore() {
    const on = syncConfigured() && local.synced && !local.otherBoard;
    document.getElementById("syncMore").hidden = !on;
    document.getElementById("deleteZone").hidden = !(on && local.boardKind === "invited");
    document.getElementById("deleteBox").hidden = true;
    deviceMsg.textContent = "";
    document.getElementById("invites").hidden = !(on && local.admin);
    if (on && local.admin) loadInvites();
  }
  // Says what happened right under the button (a toast is easy to miss in
  // Settings) and what to do next with the link.
  const deviceBtn = document.getElementById("deviceLink");
  const deviceMsg = el("p", { class: "msg device-msg", role: "status" });
  deviceBtn.closest(".row").after(deviceMsg);
  let deviceTimer;
  deviceBtn.addEventListener("click", async () => {
    const how = await shareLink(appLink({ connect: local.syncToken, sync: workerBase() }), "Now and Then");
    if (!how) return;
    const next = "Open it on your other device and tap Connect. That device then syncs with " + boardLabel(local.board) + ".";
    deviceMsg.className = "msg device-msg ok";
    deviceMsg.textContent = {
      copied: "Link copied. Send it to your other device (AirDrop, Messages or Mail to yourself, or a note). " + next,
      shared: "Link sent. " + next,
      shown: "Copy the link that was shown and send it to your other device. " + next,
    }[how];
    if (how === "copied") {
      deviceBtn.textContent = "Copied ✓";
      clearTimeout(deviceTimer);
      deviceTimer = setTimeout(() => { deviceBtn.textContent = "Copy link for another device"; }, 2500);
    }
  });

  const inviteMsg = (text, bad) => { const m = document.getElementById("inviteMsg"); m.className = bad ? "msg bad" : "msg"; m.textContent = text; };
  async function adminFetch(path, opts = {}) {
    const res = await fetch(workerBase() + path, Object.assign({ cache: "no-store" }, opts, {
      headers: { "Authorization": "Bearer " + local.syncToken, "Content-Type": "application/json" },
    }));
    if (res.status === 403) throw new Error("Only the Worker's owner can invite people.");
    if (!res.ok) throw new Error("The Worker answered " + res.status + ".");
    return res.json();
  }
  const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  async function loadInvites() {
    const ul = document.getElementById("inviteList");
    try {
      const [inv, boards] = await Promise.all([adminFetch("/invites"), adminFetch("/boards")]);
      ul.replaceChildren(...inv.invites.map(i => el("li", {},
        el("span", {}, `${i.label || "Invite"} · expires ${shortDate(i.expires)}`),
        el("button", { class: "btn", type: "button", onclick: async () => {
          try { await adminFetch("/invites/" + encodeURIComponent(i.code), { method: "DELETE" }); inviteMsg("Invite revoked."); loadInvites(); }
          catch (e) { inviteMsg(e.message, true); }
        } }, "Revoke"))));
      const n = boards.boards.length;
      inviteMsg(n ? `${n} ${n === 1 ? "person has" : "people have"} joined by invite, out of ${boards.max} this Worker allows.` : "Nobody has joined by invite yet.");
    } catch (e) { ul.replaceChildren(); inviteMsg(e.message, true); }
  }
  document.getElementById("inviteMake").addEventListener("click", async () => {
    const label = document.getElementById("inviteLabel").value.trim();
    inviteMsg("Creating…");
    try {
      const inv = await adminFetch("/invites", { method: "POST", body: JSON.stringify({ label }) });
      const how = await shareLink(appLink({ join: inv.code, sync: workerBase() }), "Join me on Now and Then");
      document.getElementById("inviteLabel").value = "";
      await loadInvites();
      if (how === "copied") inviteMsg(`Invite link copied. It works once, until ${shortDate(inv.expires)}.`);
    } catch (e) { inviteMsg("Couldn't create an invite: " + e.message, true); }
  });

  document.getElementById("deleteBoard").addEventListener("click", () => {
    document.getElementById("deleteLocal").checked = false;
    document.getElementById("deleteWhat").textContent = `This permanently deletes ${boardLabel(local.board)}, its nightly copies and its access token from the sync service. Your other devices stop syncing. It can't be undone. Download a backup first if you might want your lists later.`;
    document.getElementById("deleteBox").hidden = false;
    document.getElementById("deleteBox").scrollIntoView({ block: "nearest" });
  });
  document.getElementById("deleteCancel").addEventListener("click", () => { document.getElementById("deleteBox").hidden = true; });
  document.getElementById("deleteGo").addEventListener("click", async () => {
    const msg = document.getElementById("syncMsg");
    msg.className = "msg"; msg.textContent = "Deleting…";
    try {
      const res = await fetch(workerBase() + "/data?confirm=delete", { method: "DELETE", headers: { "Authorization": "Bearer " + local.syncToken, "X-Expect-Board": local.board } });
      if (res.status === 403) throw new Error("This board was set up by the Worker's owner. Ask them to delete it.");
      if (!res.ok && res.status !== 410) throw new Error("The Worker answered " + res.status + ".");
    } catch (e) {
      msg.className = "msg bad"; msg.textContent = "Couldn't delete: " + (e instanceof TypeError ? "the Worker can't be reached." : e.message);
      return;
    }
    clearTimeout(pushTimer); pushTimer = null;
    Object.assign(local, { syncUrl: "", syncToken: "", synced: false, board: "", boardName: "", boardKind: "", admin: false, otherBoard: "", switching: false });
    rememberServer({ lists: [], todos: [], settings: {} });
    syncError = ""; netDown = false;
    if (document.getElementById("deleteLocal").checked) { board = starterBoard(); local.pristine = true; write(BOARD_KEY, board); }
    write(LOCAL_KEY, local);
    document.getElementById("syncUrl").value = ""; document.getElementById("syncToken").value = "";
    msg.textContent = "Your synced board was deleted. Sync is off on this device.";
    showSyncMore(); showStatus(); render();
  });

  // ---- opening an invite, device or shared list link ----
  // #join=<code>&sync=<worker> makes a new board on that Worker (POST /join).
  // #connect=<token>&sync=<worker> connects this device to an existing board.
  // #share=<code>&sync=<worker> adds someone's shared list to this board (POST /shared/join).
  // All live after the #, so the code or token never reaches the web server.
  const joinDlg = document.getElementById("joinDlg");
  let pendingLink = null;
  function readLink() {
    const p = new URLSearchParams(location.hash.slice(1));
    const sync = (p.get("sync") || "").trim(), join = p.get("join"), connect = p.get("connect"), share = p.get("share");
    if (!(join || connect || share)) return;
    history.replaceState(null, "", location.pathname + location.search);
    let host = "";
    try { const u = new URL(sync); if (u.protocol === "https:") host = u.host; } catch (e) {}
    if (!host) { toast("That link is missing its sync address.", 5000); return; }
    pendingLink = { sync: sync.replace(/\/+$/, ""), join, connect, share };
    if (share) { showShareLink(host); return; }
    const had = syncConfigured() && local.synced;
    const what = join
      ? "You've been invited to sync Now and Then. Joining makes a board of your own, so your lists are saved and show up on your other devices."
      : "This link connects this device to an existing board, so it shows the same lists as your other devices.";
    let keep = "";
    if (join) keep = " The lists on this device go onto your new board." + (had ? ` This device stops syncing with ${boardLabel(local.board)}.` : "");
    else if (had) keep = ` This device stops syncing with ${boardLabel(local.board)} and shows that board instead.`;
    else if (!local.pristine) keep = " Lists on this device are added to that board.";
    document.getElementById("joinTitle").textContent = join ? "Join Now and Then sync" : "Connect this device";
    document.getElementById("joinWhat").textContent = what + keep;
    document.getElementById("joinNameRow").hidden = !join;
    document.getElementById("joinName").value = "";
    document.getElementById("joinHost").textContent = `Sync runs through ${host}.`;
    document.getElementById("joinGo").textContent = join ? "Join" : "Connect";
    document.getElementById("joinGo").disabled = false;
    document.getElementById("joinGo").hidden = false;
    document.getElementById("joinMsg").textContent = "";
    joinDlg.showModal();
  }
  // A shared list goes onto the board this device already syncs with, so it needs
  // sync turned on with the same Worker first.
  function showShareLink(host) {
    const same = canUseShared() && workerBase() === pendingLink.sync;
    document.getElementById("joinTitle").textContent = "Add a shared list";
    document.getElementById("joinWhat").textContent = same
      ? `Someone shared a list with you. It goes onto ${boardLabel(local.board)}, and changes either of you make show up for both. The rest of your board stays private.`
      : syncConfigured() && local.synced
        ? `Someone shared a list with you, but it's on a different sync service (${host}) from the one this device uses. Ask them to share it from the same one.`
        : "Someone shared a list with you. To add it, this device needs to sync first, because the list lives on the sync service. Ask the person who sent this for an invite link, or turn on sync in Settings, then open this link again.";
    document.getElementById("joinNameRow").hidden = true;
    document.getElementById("joinHost").textContent = `Sync runs through ${host}.`;
    document.getElementById("joinGo").textContent = "Add list";
    document.getElementById("joinGo").disabled = !same;
    document.getElementById("joinGo").hidden = !same;
    document.getElementById("joinMsg").textContent = "";
    joinDlg.showModal();
  }
  async function addSharedList(link, msg, go) {
    msg.className = "msg"; msg.textContent = "Adding…"; go.disabled = true;
    try {
      const res = await sharedFetch("/join", { method: "POST", body: JSON.stringify({ code: link.share }) });
      const result = await sync();
      if (result !== true) throw new Error(result);
      pendingLink = null;
      msg.textContent = res.already ? `${res.name} is already on your board.` : `Added ${res.name}${res.by ? `, shared by ${res.by}` : ""}.`;
      render();
      const l = board.lists.find(x => x.shared === res.sid);
      setTimeout(() => { joinDlg.close(); if (l) document.getElementById("name-" + l.id)?.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" }); }, 1200);
    } catch (e) {
      go.disabled = false;
      msg.className = "msg bad";
      msg.textContent = e instanceof TypeError ? "Couldn't reach the sync service. Check the connection and try again." :
        e.code === "invite not found" ? "This link has already been used or has expired. Ask for a new one." :
        e.code === "too many lists" ? `Your board already has ${MAX_LISTS} lists. Delete one to make room, then open the link again.` :
        e.code === "list full" ? "This list already has as many people as it can." : e.message;
    }
  }
  document.getElementById("joinGo").addEventListener("click", async () => {
    const link = pendingLink; if (!link) return;
    if (link.share) return addSharedList(link, document.getElementById("joinMsg"), document.getElementById("joinGo"));
    const msg = document.getElementById("joinMsg"), go = document.getElementById("joinGo");
    msg.className = "msg"; msg.textContent = link.join ? "Joining…" : "Connecting…"; go.disabled = true;
    try {
      let token = link.connect;
      if (link.join) {
        const res = await fetch(link.sync + "/join", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: link.join, name: document.getElementById("joinName").value.trim() }) });
        if (res.status === 404) throw new Error("This invite has already been used or has expired. Ask for a new one.");
        if (res.status === 503) throw new Error("This sync service is full right now. Ask whoever invited you.");
        if (!res.ok) throw new Error("The Worker answered " + res.status + ".");
        token = (await res.json()).token;
        // A brand-new board is empty: this device's lists become its first contents.
        useSync(link.sync, token);
        local.switching = false; write(LOCAL_KEY, local);
      } else {
        useSync(link.sync, token);
      }
      const result = await sync();
      if (result !== true) throw new Error(result);
      pendingLink = null;
      msg.textContent = `Connected to ${boardLabel(local.board)}.`;
      render(); showSyncMore();
      setTimeout(() => joinDlg.close(), 1200);
    } catch (e) {
      go.disabled = false;
      msg.className = "msg bad"; msg.textContent = e instanceof TypeError ? "Couldn't reach the sync service. Check the connection and try again." : e.message;
    }
  });
  window.addEventListener("hashchange", readLink);

  // ---------- appearance (per device) ----------
  // Dark mode follows the system unless this device picked Light or Dark in Settings.
  // The colors live in styles.css; index.html applies the choice before first paint.
  const THEME_COLORS = { light: "#eef0f3", dark: "#12161c" };
  const themeMetas = [...document.querySelectorAll('meta[name="theme-color"]')];
  function applyTheme() {
    const t = local.theme === "light" || local.theme === "dark" ? local.theme : "system";
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    // Each meta normally matches its own color scheme; an override paints both.
    themeMetas.forEach(m => {
      const own = (m.getAttribute("media") || "").includes("dark") ? "dark" : "light";
      m.setAttribute("content", THEME_COLORS[t === "system" ? own : t]);
    });
  }
  document.querySelectorAll('input[name="theme"]').forEach(r => r.addEventListener("change", () => {
    local.theme = r.value; write(LOCAL_KEY, local); applyTheme();
  }));

  // ---------- haptics (per device) ----------
  // Android and most non-Apple browsers have the Vibration API. Safari on iPhone
  // doesn't, but iOS 18 plays its own tick when a switch-style checkbox toggles,
  // so a hidden one stands in there. Macs and other desktops simply stay quiet.
  const canVibrate = typeof navigator.vibrate === "function";
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  // Desktop Chrome has navigator.vibrate but no motor, so it only counts on touch screens.
  const hapticsSupported = isIOS || (canVibrate && matchMedia("(pointer: coarse)").matches);
  let hapticSwitch = null;
  function haptic(kind) {
    if (!local.haptics || !hapticsSupported) return;
    if (canVibrate) { try { navigator.vibrate(kind === "drop" ? 18 : kind === "lift" ? 12 : 6); } catch (e) {} return; }
    if (!hapticSwitch) {
      hapticSwitch = el("label", { "aria-hidden": "true", style: "display:none" }, el("input", { type: "checkbox", switch: true, tabindex: "-1" }));
      document.head.append(hapticSwitch);
    }
    hapticSwitch.click();
  }
  document.getElementById("hapticsRow").hidden = !hapticsSupported;
  document.getElementById("haptics").addEventListener("change", e => {
    local.haptics = e.target.checked; write(LOCAL_KEY, local);
    if (local.haptics) haptic("drop");
  });
  document.getElementById("openSettings").addEventListener("click", () => {
    const t = ["light", "dark"].includes(local.theme) ? local.theme : "system";
    document.querySelector(`input[name="theme"][value="${t}"]`).checked = true;
    document.getElementById("haptics").checked = !!local.haptics;
  });

  // ---------- keyboard shortcuts ----------
  // Arrow keys pick a todo (it takes focus, so the browser keeps it in view);
  // letters act on it. Nothing fires while typing in a box or with a dialog open.
  const keysDlg = document.getElementById("keys");
  let kbSel = null; // id of the todo picked with the keyboard
  const rowOf = id => id ? boardEl.querySelector(`.todo[data-id="${CSS.escape(id)}"]`) : null;
  const todoById = id => board.todos.find(t => t.id === id && !t.deleted && !t.archived);
  function focusTodo(id) {
    const r = rowOf(id);
    if (!r) { kbSel = null; return false; }
    kbSel = id; r.tabIndex = -1; r.focus();
    r.scrollIntoView({ block: "nearest", inline: "nearest" });
    return true;
  }
  // The list most in view: the first one whose left edge is on screen.
  function listInView() {
    const ls = lists(), left = boardEl.getBoundingClientRect().left;
    return ls.find(l => boardEl.querySelector(`.col[data-list="${l.id}"]`)?.getBoundingClientRect().right > left + 40) || ls[0];
  }
  function focusAdd(list) {
    const i = list && document.getElementById("add-" + list.id);
    if (!i) return;
    kbSel = null;
    i.scrollIntoView({ block: "nearest", inline: "nearest" }); i.focus();
  }
  // After a todo leaves its list (checked into Done, deleted), pick its neighbor.
  function reselect(listId, idx) {
    if (kbSel && rowOf(kbSel) && todoById(kbSel)?.listId === listId) return focusTodo(kbSel);
    const rest = todosIn(listId);
    if (rest.length) focusTodo(rest[Math.min(idx, rest.length - 1)].id);
    else { kbSel = null; document.activeElement?.blur(); }
  }
  // The nearest list in direction dir (-1 or 1) that has todos.
  function neighborList(fromId, dir, needTodos) {
    const ls = lists();
    for (let i = ls.findIndex(l => l.id === fromId) + dir; i >= 0 && i < ls.length; i += dir) {
      if (!needTodos || todosIn(ls[i].id).length) return ls[i];
    }
    return null;
  }
  const isTyping = a => a && (a.isContentEditable || a.tagName === "TEXTAREA" || a.tagName === "SELECT" ||
    (a.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "color"].includes(a.type)));
  const openSettingsDlg = () => { closePop(); if (keysDlg.open) keysDlg.close(); if (!dlg.open) document.getElementById("openSettings").click(); };
  const showKeys = () => { closePop(); if (dlg.open) dlg.close(); if (!keysDlg.open) keysDlg.showModal(); };
  document.getElementById("showKeys").addEventListener("click", showKeys);
  // A click or tap anywhere ends keyboard selection, so render() won't pull focus back.
  document.addEventListener("pointerdown", () => { kbSel = null; }, true);

  document.addEventListener("keydown", e => {
    if (e.defaultPrevented || e.isComposing || drag) return;
    const k = e.key;
    if ((e.metaKey || e.ctrlKey) && k === ",") { e.preventDefault(); openSettingsDlg(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (dlg.open || keysDlg.open) return; // dialogs close themselves on Esc
    const a = document.activeElement;
    if (isTyping(a)) {
      if (k === "Escape" && a.id && a.id.startsWith("add-")) { a.value = ""; a.blur(); }
      return;
    }
    if (openPop) return; // Esc closes the menu (handled above)
    if (k === "?") { e.preventDefault(); showKeys(); return; }
    if (k === ",") { e.preventDefault(); openSettingsDlg(); return; }
    if (!e.shiftKey && (k === "n" || k === "N")) {
      e.preventDefault(); focusAdd(lists().find(l => l.role === "now") || lists()[0]); return;
    }
    if (/^[1-9]$/.test(k)) {
      const l = lists()[Number(k) - 1];
      if (l) { e.preventDefault(); focusAdd(l); }
      return;
    }

    const row = a && a.matches && a.matches(".todo[data-id]") ? a : null;
    const t = row ? todoById(row.dataset.id) : null;
    const key = { j: "ArrowDown", k: "ArrowUp", h: "ArrowLeft", l: "ArrowRight", J: "ArrowDown", K: "ArrowUp", H: "ArrowLeft", L: "ArrowRight" }[k] || k;
    const arrow = key.startsWith("Arrow");

    if (k === "Escape" && row) { kbSel = null; row.blur(); return; }
    if (arrow && !t) {
      // Nothing picked yet: start at the top of the list in view (or the first list with todos).
      e.preventDefault();
      const start = listInView();
      const l = start && todosIn(start.id).length ? start : lists().find(x => todosIn(x.id).length);
      if (l) focusTodo(todosIn(l.id)[0].id);
      return;
    }
    if (!t) return;
    const sibs = todosIn(t.listId), idx = sibs.findIndex(x => x.id === t.id);

    if (arrow && e.shiftKey) {
      e.preventDefault();
      if (key === "ArrowUp" && idx > 0) { moveTodo(t, t.listId, sibs[idx - 1].id); focusTodo(t.id); }
      else if (key === "ArrowDown" && idx < sibs.length - 1) { moveTodo(t, t.listId, sibs[idx + 2]?.id || null); focusTodo(t.id); }
      else if (key === "ArrowLeft" || key === "ArrowRight") {
        const to = neighborList(t.listId, key === "ArrowLeft" ? -1 : 1, false);
        if (to) { const u = undoable([t], () => moveTodo(t, to.id, null)); focusTodo(t.id); toast(`Moved to ${to.name}`, u); }
      }
      return;
    }
    if (arrow) {
      e.preventDefault();
      if (key === "ArrowUp" && idx > 0) focusTodo(sibs[idx - 1].id);
      else if (key === "ArrowDown" && idx < sibs.length - 1) focusTodo(sibs[idx + 1].id);
      else if (key === "ArrowLeft" || key === "ArrowRight") {
        const to = neighborList(t.listId, key === "ArrowLeft" ? -1 : 1, true);
        if (to) { const ts = todosIn(to.id); focusTodo(ts[Math.min(idx, ts.length - 1)].id); }
      }
      return;
    }
    if (k === "x" || k === "X" || k === " ") {
      e.preventDefault(); kbSel = t.id;
      row.querySelector(".check").click(); // same path as tapping the box, toast included
      reselect(t.listId, idx);
      return;
    }
    if (k === "Enter" || k === "e" || k === "E") {
      e.preventDefault(); kbSel = t.id;
      editText(row.querySelector(".text"), t);
      return;
    }
    if (k === "Backspace" || k === "Delete") {
      e.preventDefault(); kbSel = null;
      toast("Deleted", undoable([t], () => { touch(t, { deleted: true }); commit(); }));
      reselect(t.listId, idx);
    }
  });


  // ---------- backups ----------
  // A backup file is the board itself plus a few labels, so the same code reads a
  // downloaded file and a snapshot from the Worker.
  const backupMsg = (text, bad) => { const m = document.getElementById("backupMsg"); m.className = "msg" + (bad ? " bad" : ""); m.textContent = text; };
  const stampName = () => { const d = new Date(); return keyOf(d) + "-" + String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0"); };
  const live = (xs) => (xs || []).filter(x => x && !x.deleted);

  // On a phone the share sheet ("Save to Files") is the dependable way to keep a
  // file; a computer just downloads it.
  async function saveFile(name, text, type) {
    const blob = new Blob([text], { type });
    let file = null;
    try { file = new File([blob], name, { type }); } catch (e) {}
    if (file && matchMedia("(pointer: coarse)").matches && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); return true; }
      catch (e) { if (e.name === "AbortError") return false; } // otherwise fall back to a download
    }
    const a = el("a", { href: URL.createObjectURL(blob), download: name, style: "display:none" });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    return true;
  }

  function backupJson(b = board, owner = local.board) {
    return JSON.stringify({ app: "Now and Then", exportedAt: new Date().toISOString(), owner: owner || null,
      version: 1, settings: b.settings, lists: b.lists, todos: b.todos }, null, 2);
  }

  // One row per todo: the lists in board order, then everything in Done, newest first.
  function boardCsv() {
    const cell = (v) => {
      let s = v == null ? "" : String(v);
      if (/^[=+@\t]/.test(s)) s = "'" + s; // keep spreadsheets from running it as a formula
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = [["List", "Todo", "Status", "Checked on", "Moved to Done on"]];
    for (const l of lists()) for (const t of todosIn(l.id)) rows.push([l.name, t.text, t.done ? "Checked" : "Open", t.doneDay || "", ""]);
    for (const t of archived()) rows.push([t.fromName || "", t.text, "Done", t.doneDay || "", t.archivedDay || ""]);
    return "﻿" + rows.map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
  }

  document.getElementById("exportJson").addEventListener("click", async () => {
    if (await saveFile(`now-and-then-${stampName()}.json`, backupJson(), "application/json")) backupMsg("Backup saved.");
  });
  document.getElementById("exportCsv").addEventListener("click", async () => {
    if (await saveFile(`now-and-then-${stampName()}.csv`, boardCsv(), "text/csv")) backupMsg("CSV saved.");
  });

  // Checks a parsed file looks like a board and keeps only well-formed lists and todos.
  function readBackup(data) {
    if (!data || !Array.isArray(data.lists) || !Array.isArray(data.todos)) throw new Error("This file isn't a Now and Then backup.");
    const ok = (x) => x && typeof x === "object" && typeof x.id === "string";
    const lists = data.lists.filter(l => ok(l) && typeof l.name === "string");
    const todos = data.todos.filter(t => ok(t) && typeof t.text === "string");
    if (!live(lists).length) throw new Error("This backup has no lists in it.");
    return { owner: typeof data.owner === "string" ? data.owner : null, when: data.exportedAt || null,
      settings: data.settings && typeof data.settings === "object" ? data.settings : null, lists, todos };
  }

  // Restoring puts every list and todo in the backup back the way it was, stamped as
  // the newest edit so sync carries it to the other devices. Things added since the
  // backup stay unless "replace" is on, in which case they're deleted.
  function restoreBoard(bk, replace) {
    const t = now(), keep = new Set();
    const put = (items, into) => {
      for (const item of live(items)) {
        keep.add(item.id);
        const copy = Object.assign({}, item, { updatedAt: t });
        const cur = into.find(x => x.id === item.id);
        if (cur) { for (const k of Object.keys(cur)) if (!(k in copy)) delete cur[k]; Object.assign(cur, copy); }
        else into.push(copy);
      }
    };
    put(bk.lists, board.lists);
    put(bk.todos, board.todos);
    // Shared lists aren't only yours, so "replace" leaves them (and their todos) alone.
    const isShared = (x) => x.shared || (x.listId && listById(x.listId)?.shared);
    if (replace) for (const x of [...board.lists, ...board.todos]) if (!x.deleted && !keep.has(x.id) && !isShared(x)) touch(x, { deleted: true });
    if (bk.settings) board.settings = Object.assign({}, board.settings, bk.settings, { updatedAt: t });
    repairOrphans();
    sweepDone();
    commit();
  }

  let pendingRestore = null;
  function offerRestore(bk, label) {
    pendingRestore = bk;
    const n = live(bk.todos).filter(x => !x.archived).length, d = live(bk.todos).filter(x => x.archived).length;
    let text = `Restore ${label}? It has ${live(bk.lists).length} list${live(bk.lists).length === 1 ? "" : "s"}, ${n} todo${n === 1 ? "" : "s"} and ${d} in Done.`;
    if (bk.owner && local.board && bk.owner !== local.board) text += ` Heads up: it came from ${boardLabel(bk.owner)}, and this device syncs with ${boardLabel(local.board)}.`;
    document.getElementById("restoreWhat").textContent = text;
    document.getElementById("restoreReplace").checked = false;
    const box = document.getElementById("restoreBox");
    box.hidden = false; box.scrollIntoView({ block: "nearest", behavior: "smooth" });
    backupMsg("");
  }
  function closeRestore() { pendingRestore = null; document.getElementById("restoreBox").hidden = true; }
  document.getElementById("restoreCancel").addEventListener("click", closeRestore);
  document.getElementById("restoreGo").addEventListener("click", async () => {
    if (!pendingRestore) return;
    const bk = pendingRestore, replace = document.getElementById("restoreReplace").checked;
    closeRestore();
    // Ask the Worker to keep a copy of the board as it is now, so a restore can itself be undone.
    if (syncConfigured() && local.synced && !local.otherBoard && navigator.onLine) {
      backupMsg("Saving a copy of your lists first…");
      try { await snapFetch("?reason=before%20restore", { method: "POST" }); } catch (e) {}
    }
    restoreBoard(bk, replace);
    backupMsg(syncConfigured() ? "Restored. Your other devices will pick it up on their next sync." : "Restored.");
    toast("Backup restored");
    loadSnapshots();
  });

  const fileInput = document.getElementById("importFile");
  document.getElementById("importJson").addEventListener("click", () => { fileInput.value = ""; fileInput.click(); });
  fileInput.addEventListener("change", async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    try {
      const bk = readBackup(JSON.parse(await f.text()));
      const when = bk.when && !isNaN(new Date(bk.when)) ? new Date(bk.when).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
      offerRestore(bk, when ? `the backup from ${when}` : `“${f.name}”`);
    } catch (e) {
      closeRestore();
      backupMsg(e instanceof SyntaxError ? "That file couldn't be read as a backup." : e.message, true);
    }
  });

  // ---- copies kept by the Worker ----
  function snapUrl() { return local.syncUrl.replace(/\/+$/, "") + "/snapshots"; }
  async function snapFetch(path = "", opts = {}) {
    const res = await fetch(snapUrl() + path, Object.assign({ cache: "no-store" }, opts, { headers: { "Authorization": "Bearer " + local.syncToken } }));
    if (res.status === 404 && !path) throw new Error("This Worker doesn't keep backups yet.");
    if (res.status === 410) throw boardGone();
    if (!res.ok) throw new Error("The Worker answered " + res.status + ".");
    const who = res.headers.get("X-Board");
    if (local.board && who && who !== local.board) throw new Error("This token opens a different board.");
    return res.json();
  }
  const snapLabel = (s) => {
    const when = new Date(s.at || s.id);
    let text = isNaN(when) ? s.id : when.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    if (typeof s.todos === "number") text += ` · ${s.todos} todo${s.todos === 1 ? "" : "s"}`;
    if (s.reason && s.reason !== "daily") text += ` · ${s.reason}`;
    return text;
  };
  let snapshots = [];
  async function loadSnapshots() {
    const box = document.getElementById("cloudBackups");
    if (!syncConfigured() || !local.synced || local.otherBoard || !navigator.onLine) { box.hidden = true; return; }
    try {
      const got = await snapFetch();
      snapshots = got.snapshots || [];
      const sel = document.getElementById("snapList");
      sel.replaceChildren(...snapshots.map(s => el("option", { value: s.id }, snapLabel(s))));
      const none = !snapshots.length;
      if (none) sel.append(el("option", { value: "" }, "No saved copies yet"));
      sel.disabled = none;
      document.getElementById("snapRestore").disabled = none;
      document.getElementById("snapDownload").disabled = none;
      document.getElementById("cloudInfo").textContent =
        `The sync Worker saves a copy of ${boardLabel(got.board || local.board)} every night and keeps it for ${got.days || 30} days.` +
        (none ? " The first one is saved tonight." : "");
      box.hidden = false;
    } catch (e) {
      box.hidden = true; // an older Worker, or offline: the file backups above still work
    }
  }
  async function getSnapshot() {
    const id = document.getElementById("snapList").value;
    const s = snapshots.find(x => x.id === id);
    if (!s) return null;
    const data = await snapFetch("/" + encodeURIComponent(id));
    return { s, data };
  }
  document.getElementById("snapRestore").addEventListener("click", async () => {
    backupMsg("Loading…");
    try {
      const got = await getSnapshot(); if (!got) return backupMsg("");
      offerRestore(Object.assign(readBackup(got.data), { owner: local.board }), `the copy from ${snapLabel(got.s).split(" · ")[0]}`);
    } catch (e) { backupMsg("Couldn't load that copy: " + e.message, true); }
  });
  document.getElementById("snapDownload").addEventListener("click", async () => {
    backupMsg("Loading…");
    try {
      const got = await getSnapshot(); if (!got) return backupMsg("");
      const name = `now-and-then-${(got.s.at || got.s.id).slice(0, 16).replace(/[T:]/g, "-")}.json`;
      if (await saveFile(name, backupJson(got.data, local.board), "application/json")) backupMsg("Copy saved."); else backupMsg("");
    } catch (e) { backupMsg("Couldn't download that copy: " + e.message, true); }
  });

  // ---------- day changes & lifecycle ----------
  function checkDay() {
    if (rollover()) commit(); else render();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { checkDay(); sync(); }
  });
  window.addEventListener("online", () => { idleStatus(); sync(); });
  // A browser window on a Mac stays "visible" behind other windows, so coming back
  // to it only fires focus. Pull then, at most every few seconds.
  window.addEventListener("focus", () => { if (Date.now() - lastPull > 3000) pull(); });
  // While the app is on screen, check for changes from other devices every 20 seconds.
  // Hidden tabs don't poll; they catch up with a full sync when shown again.
  const POLL_MS = 20 * 1000;
  setInterval(() => {
    if (document.visibilityState === "visible" && Date.now() - lastPull >= POLL_MS - 1000) pull();
  }, POLL_MS);
  window.addEventListener("offline", idleStatus);
  setInterval(() => { if (local.lastDay !== todayKey()) checkDay(); }, 60 * 1000);

  // ---------- version & updates ----------
  function showVersion() {
    let text = `Version ${APP_VERSION}`;
    if (STAMPED) {
      const when = new Date(BUILD_DATE);
      text += ` · Build ${BUILD_NUMBER} (${BUILD_SHA})`;
      if (!isNaN(when)) text += ` · ${when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
    } else {
      text += " · Local build";
    }
    document.getElementById("versionInfo").textContent = text;
  }
  // version.json is written at deploy time. If the live build differs from the
  // one running here, offer a reload so the page shows what's actually deployed.
  let liveBuild = null;
  // Remembers which build Reload was pressed for, so a reload that still comes
  // up on the old build doesn't throw the same "new version" toast again.
  const RELOAD_KEY = "nat.reloadFor";
  const reloadedFor = () => { try { return sessionStorage.getItem(RELOAD_KEY); } catch { return null; } };
  async function checkForUpdate() {
    if (!STAMPED || !navigator.onLine) return;
    const msg = document.getElementById("updateMsg"), btn = document.getElementById("reloadApp");
    try {
      const res = await fetch("version.json", { cache: "no-store" });
      if (!res.ok) return;
      const live = await res.json();
      // An older number means version.json itself is behind (a slow cache), not us.
      if (String(live.build) === BUILD_NUMBER || Number(live.build) < Number(BUILD_NUMBER)) {
        try { sessionStorage.removeItem(RELOAD_KEY); } catch {}
        msg.textContent = "This is the latest version."; btn.hidden = true; return;
      }
      const fresh = liveBuild !== live.build;
      liveBuild = live.build;
      btn.hidden = false; btn.disabled = false;
      if (reloadedFor() === String(live.build)) {
        msg.textContent = `Build ${live.build} is out, but this device is still on the old files. Try Reload again in a few minutes.`;
        return;
      }
      msg.textContent = `Build ${live.build} is available.`;
      if (fresh && !dlg.open) toast(`A new version is ready. Open Settings to reload.`);
    } catch { /* offline or blocked: keep what we show */ }
  }
  // "New" on the What's New link until it's opened once after an update.
  function showWhatsNew() { document.getElementById("whatsNewDot").hidden = local.seenVersion === APP_VERSION; }
  document.getElementById("whatsNewLink").addEventListener("click", () => { local.seenVersion = APP_VERSION; write(LOCAL_KEY, local); showWhatsNew(); });
  showWhatsNew();

  // Reloading while the new service worker is still installing let the new page
  // load the old app.js, so it showed the same "new version" toast again. Wait
  // for the new worker to take over first (at most 10 seconds), then reload.
  document.getElementById("reloadApp").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    document.getElementById("updateMsg").textContent = "Updating…";
    try { if (liveBuild) sessionStorage.setItem(RELOAD_KEY, String(liveBuild)); } catch {}
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) {
        await reg.update();
        const sw = reg.installing || reg.waiting;
        if (sw) await new Promise((done) => {
          setTimeout(done, 10000);
          navigator.serviceWorker.addEventListener("controllerchange", done, { once: true });
          sw.addEventListener("statechange", () => { if (sw.state === "activated" || sw.state === "redundant") done(); });
        });
      }
    } catch {}
    location.reload();
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
  }

  // ---------- no zoom ----------
  // iOS ignores user-scalable=no, so stop Safari's pinch gestures here. Two-finger
  // touchmoves are pinches too; one-finger scrolling and drags are untouched.
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, e => e.preventDefault(), { passive: false });
  }
  document.addEventListener("touchmove", e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  // The keyboard can nudge the whole page up on iOS and leave it there after it closes,
  // which lets list scrolling move the page. Put the page back once nothing is being typed in.
  const isField = n => n && (n.matches("input, select, textarea") || n.isContentEditable);
  document.addEventListener("focusout", () => setTimeout(() => {
    if (!isField(document.activeElement) && (window.scrollX || window.scrollY)) window.scrollTo(0, 0);
  }, 150));

  // ---------- boot ----------
  applyTheme();
  repairOrphans();
  rollover();
  write(BOARD_KEY, board);
  idleStatus();
  render();
  sync();
  checkForUpdate();
  readLink();

  // exposed for tests
  window.__nat = { mergeBoards, restoreBoard, readBackup, boardCsv, backupJson, get board() { return board; } };
})();
