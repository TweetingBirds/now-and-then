// Now and Then: a notebook-style todo board.
// Lists live on this device (localStorage) and, when configured, sync through a
// small Cloudflare Worker that merges changes todo by todo (see /worker).
(() => {
  "use strict";

  // APP_VERSION is bumped by hand for notable releases. The BUILD_* values are
  // stamped by the GitHub Pages workflow on every deploy (left as-is locally).
  const APP_VERSION = "1.2.0";
  const BUILD_NUMBER = "__BUILD_NUMBER__";
  const BUILD_SHA = "__BUILD_SHA__";
  const BUILD_DATE = "__BUILD_DATE__";
  const STAMPED = !BUILD_NUMBER.startsWith("__");

  const BOARD_KEY = "nat.board.v1";
  const LOCAL_KEY = "nat.local.v1"; // per-device: lastDay, sync settings
  const MAX_LISTS = 10;
  const TOMBSTONE_DAYS = 60;
  const PALETTE = ["#f2b84b", "#7b9cff", "#9b8cf0", "#5cc6a7", "#f28b82", "#f6a6cf", "#8ecae6", "#b5d16b", "#c9a27e", "#ff9f5a", "#7fd1d8", "#a3a9b5"];
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const now = () => Date.now();

  // ---------- storage ----------
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  let local = Object.assign({ lastDay: null, syncUrl: "", syncToken: "", pristine: false, synced: false, board: "", switching: false, otherBoard: "" }, read(LOCAL_KEY) || {});
  let board = read(BOARD_KEY);
  if (!board) { board = starterBoard(); local.pristine = true; write(LOCAL_KEY, local); }

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

  function setStatus(state, label) {
    const s = document.getElementById("syncStatus");
    s.dataset.state = state; s.textContent = label;
  }
  function idleStatus() {
    if (!syncConfigured()) setStatus("off", "On this device");
    else if (!navigator.onLine) setStatus("error", "Offline, will sync later");
    else setStatus("ok", "Synced");
  }

  // "nate" -> "Nate's board"
  const boardLabel = (name) => name ? name.charAt(0).toUpperCase() + name.slice(1) + "'s board" : "your board";

  function schedulePush() {
    if (!syncConfigured()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(sync, 1200);
  }

  // Send our board; the Worker merges it with what it has and returns the result.
  async function sync() {
    if (!syncConfigured()) return;
    if (syncing) { again = true; return; }
    if (!navigator.onLine) { idleStatus(); return; }
    syncing = true; setStatus("busy", "Syncing…");
    try {
      // First sync on a device that still has only the welcome todos, or that is
      // switching from one person's board to another's: take the saved board as is,
      // so this device's lists aren't merged into it.
      if (!local.synced && (local.pristine || local.switching)) {
        const got = await fetch(dataUrl(), { headers: { "Authorization": "Bearer " + local.syncToken } });
        if (got.status === 401) throw new Error("The access token was not accepted.");
        if (got.status === 409) throw new Error(await clashMessage(got));
        if (!got.ok) throw new Error("The Worker answered " + got.status + ".");
        const remote = await got.json();
        if (remote.lists && remote.lists.some(l => !l.deleted)) board = remote;
      }
      const headers = { "Authorization": "Bearer " + local.syncToken, "Content-Type": "application/json" };
      if (local.board) headers["X-Expect-Board"] = local.board;
      const res = await fetch(dataUrl(), { method: "PUT", headers, body: JSON.stringify(board) });
      if (res.status === 401) throw new Error("The access token was not accepted.");
      if (res.status === 409) throw new Error(await clashMessage(res));
      if (!res.ok) throw new Error("The Worker answered " + res.status + ".");
      const merged = await res.json();
      local.board = res.headers.get("X-Board") || local.board;
      local.switching = false; local.otherBoard = "";
      // Edits made while the request was in flight are newer, so they survive the merge.
      board = mergeBoards(board, merged);
      local.synced = true; write(LOCAL_KEY, local);
      repairOrphans();
      write(BOARD_KEY, board);
      if (!isBusyEditing()) render();
      idleStatus();
      return true;
    } catch (e) {
      setStatus("error", "Sync problem");
      document.getElementById("syncStatus").title = e.message || String(e);
      return e.message || String(e);
    } finally {
      syncing = false;
      if (again) { again = false; schedulePush(); }
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
  function isBusyEditing() {
    const a = document.activeElement;
    return drag || (a && (a.isContentEditable || (a.tagName === "INPUT" && a.type === "text") || a.classList?.contains("col-title")));
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

  function render() {
    const scroll = boardEl.scrollLeft;
    const focusedId = document.activeElement?.id;
    closePop();
    document.getElementById("today").textContent = pretty(todayKey());
    const ls = lists();
    boardEl.replaceChildren();
    ls.forEach(l => boardEl.append(renderList(l)));
    const full = ls.length >= MAX_LISTS;
    boardEl.append(el("button", { class: "new-list", id: "addList", disabled: full, onclick: addList },
      full ? "List limit reached" : "+ New list", el("small", {}, `${ls.length} of ${MAX_LISTS}`)));
    boardEl.append(renderArchive());
    boardEl.scrollLeft = scroll;
    if (focusedId && focusedId.startsWith("add-")) document.getElementById(focusedId)?.focus();
  }

  function renderList(list) {
    const todos = todosIn(list.id);
    const open = todos.filter(t => !t.done).length;
    const col = el("section", { class: "col", "data-list": list.id, style: `--c:${list.color}` });
    const head = el("div", { class: "col-head" });
    head.append(
      el("button", { class: "swatch-btn", title: "Change color", "aria-label": `Change ${list.name} color`, "data-pop-trigger": true, onclick: e => colorPop(e, list, head) }),
      el("input", {
        class: "col-title", value: list.name, "aria-label": "List name", maxlength: 30, id: "name-" + list.id,
        onchange: e => { const v = e.target.value.trim(); if (v && v !== list.name) { touch(list, { name: v }); commit(); } else e.target.value = list.name; },
        onkeydown: e => { if (e.key === "Enter") e.target.blur(); },
      }),
      el("span", { class: "count", title: "Unfinished" }, String(open)),
      el("button", { class: "icon-btn", title: "List options", "aria-label": `${list.name} options`, "data-pop-trigger": true, onclick: e => listPop(e, list, head) }, "•••"),
    );
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
    const row = el("div", { class: "todo" + (t.done ? " done" : ""), "data-id": t.id });
    const text = el("div", { class: "text", ondblclick: () => editText(text, t) }, t.text);
    row.append(
      el("button", { class: "grip", "aria-label": "Drag to move", title: "Drag to move", onpointerdown: e => startDrag(e, t, row) }, "⋮⋮"),
      el("input", { type: "checkbox", class: "check", checked: t.done, "aria-label": "Done", onchange: e => {
        touch(t, { done: e.target.checked, doneDay: e.target.checked ? todayKey() : null });
        if (t.done && board.settings.doneNow) { archive(t); commit(); toast("Nice. Moved to Done."); return; }
        commit();
        if (t.done) toast("Nice. It moves to Done tomorrow morning.");
      } }),
      text,
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
      lists().filter(l => l.id !== t.listId).map(l => el("button", { class: "item", onclick: () => { moveTodo(t, l.id, null); toast(`Moved to ${l.name}`); } },
        el("span", { class: "dot", style: `background:${l.color}` }), l.name)),
      el("div", { class: "lbl" }, "This todo"),
      el("button", { class: "item", onclick: () => { closePop(); editText(text, t); } }, "Edit text"),
      el("button", { class: "item danger", onclick: () => { touch(t, { deleted: true }); commit(); toast("Deleted"); } }, "Delete"),
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
    const fallback = ls.find(l => l.id !== list.id);
    const confirmBox = el("div", { hidden: true });
    popAt(head, e.currentTarget,
      el("button", { class: "item", onclick: () => { closePop(); const i = document.getElementById("name-" + list.id); i.focus(); i.select(); } }, "Rename"),
      el("button", { class: "item", disabled: idx === 0, onclick: () => swapLists(list, ls[idx - 1]) }, "Move list left"),
      el("button", { class: "item", disabled: idx === ls.length - 1, onclick: () => swapLists(list, ls[idx + 1]) }, "Move list right"),
      ls.length > 1 ? el("button", { class: "item danger", onclick: () => { confirmBox.hidden = false; } }, "Delete list…") : null,
      confirmBox,
    );
    confirmBox.append(
      el("div", { class: "lbl" }, count ? `${count} todo${count > 1 ? "s" : ""} will move to ${fallback?.name}` : "This list is empty"),
      el("button", { class: "item danger", onclick: () => {
        let o = Math.max(0, ...todosIn(fallback.id).map(t => t.order));
        todosIn(list.id).forEach(t => touch(t, { listId: fallback.id, order: ++o }));
        touch(list, { deleted: true });
        commit(); toast(`Deleted ${list.name}`);
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

  function renderArchive() {
    const items = archived();
    const col = el("section", { class: "col archive" });
    col.append(el("div", { class: "col-head" },
      el("span", { class: "swatch-btn", "aria-hidden": "true" }),
      el("div", { class: "col-title" }, "Done"),
      el("span", { class: "count" }, String(items.length))));
    const body = el("div", { class: "col-body" });
    if (!items.length) body.append(el("div", { class: "empty" }, "Finished todos land here each morning."));
    let last = null;
    for (const a of items) {
      if (a.archivedDay !== last) { last = a.archivedDay; body.append(el("div", { class: "day-label" }, a.archivedDay ? pretty(a.archivedDay, { weekday: "short", month: "short", day: "numeric" }) : "Earlier")); }
      body.append(el("div", { class: "todo done" },
        el("span", { class: "dot", style: `width:8px;height:8px;border-radius:50%;margin-top:7px;flex:none;background:${a.fromColor}` }),
        el("div", { class: "text" }, a.text),
        el("span", { class: "from" }, a.fromName),
        el("button", { class: "icon-btn", title: "Put back", "aria-label": "Put back on a list", onclick: () => restore(a) }, "↩")));
    }
    col.append(body);
    return col;
  }

  function restore(a) {
    const list = lists().find(l => l.name === a.fromName) || lists()[0];
    const order = Math.max(0, ...todosIn(list.id).map(t => t.order)) + 1;
    touch(a, { archived: false, archivedDay: null, done: false, doneDay: null, listId: list.id, order });
    commit(); toast(`Put back on ${list.name}`);
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
      const from = d.t.listId;
      moveTodo(d.t, d.target, d.before);
      if (from !== d.target) toast(`Moved to ${listById(d.target).name}`);
    } else render();
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(msg) {
    const t = document.getElementById("toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
  }

  // ---------- settings ----------
  const dlg = document.getElementById("settings");
  document.getElementById("openSettings").addEventListener("click", () => {
    document.getElementById("carry").checked = !!board.settings.carry;
    document.getElementById(board.settings.doneNow ? "doneNow" : "doneLater").checked = true;
    document.getElementById("syncUrl").value = local.syncUrl;
    document.getElementById("syncToken").value = local.syncToken;
    const sm = document.getElementById("syncMsg");
    if (local.otherBoard) { sm.className = "msg bad"; sm.textContent = document.getElementById("syncStatus").title; }
    else { sm.className = "msg"; sm.textContent = syncConfigured() && local.board ? `Syncing with ${boardLabel(local.board)}.` : ""; }
    showVersion();
    dlg.showModal();
    dlg.querySelector(".settings-body").scrollTop = 0;
    checkForUpdate();
  });
  document.getElementById("syncStatus").addEventListener("click", () => {
    if (syncConfigured()) sync(); else document.getElementById("openSettings").click();
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
    // A new token (or a confirmed switch after a "board changed" warning) means a
    // different board: load it instead of merging this device's lists into it.
    if (url !== local.syncUrl || token !== local.syncToken || local.otherBoard) {
      local.synced = false;
      if (local.board) { local.switching = true; local.board = ""; }
      local.otherBoard = "";
    }
    local.syncUrl = url; local.syncToken = token; write(LOCAL_KEY, local);
    if (!url) { msg.className = "msg"; msg.textContent = "Sync is off. Lists stay on this device."; idleStatus(); return; }
    msg.className = "msg"; msg.textContent = "Connecting…";
    const result = await sync();
    if (result === true) { msg.textContent = `Connected to ${boardLabel(local.board)}. Your lists are synced.`; render(); setTimeout(() => dlg.close(), 1400); }
    else { msg.className = "msg bad"; msg.textContent = "Couldn't sync: " + result; }
  });

  // ---------- day changes & lifecycle ----------
  function checkDay() {
    if (rollover()) commit(); else render();
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { checkDay(); sync(); }
  });
  window.addEventListener("online", () => { idleStatus(); sync(); });
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
  async function checkForUpdate() {
    if (!STAMPED || !navigator.onLine) return;
    const msg = document.getElementById("updateMsg"), btn = document.getElementById("reloadApp");
    try {
      const res = await fetch("version.json", { cache: "no-store" });
      if (!res.ok) return;
      const live = await res.json();
      if (String(live.build) === BUILD_NUMBER) { msg.textContent = "This is the latest version."; btn.hidden = true; return; }
      const fresh = liveBuild !== live.build;
      liveBuild = live.build;
      msg.textContent = `Build ${live.build} is available.`; btn.hidden = false;
      if (fresh && !dlg.open) toast(`A new version is ready. Open Settings to reload.`);
    } catch { /* offline or blocked: keep what we show */ }
  }
  document.getElementById("reloadApp").addEventListener("click", async () => {
    try { const reg = await navigator.serviceWorker?.getRegistration(); await reg?.update(); } catch {}
    location.reload();
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
  }

  // ---------- boot ----------
  repairOrphans();
  rollover();
  write(BOARD_KEY, board);
  idleStatus();
  render();
  sync();
  checkForUpdate();

  // exposed for tests
  window.__nat = { mergeBoards, get board() { return board; } };
})();
