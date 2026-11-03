// Now and Then: a notebook-style todo board.
// Lists live on this device (localStorage) and, when configured, sync through a
// small Cloudflare Worker that merges changes todo by todo (see /worker).
(() => {
  "use strict";

  const BOARD_KEY = "nat.board.v1";
  const LOCAL_KEY = "nat.local.v1"; // per-device: lastDay, dayOffset, sync settings
  const MAX_LISTS = 10;
  const TOMBSTONE_DAYS = 60;
  const PALETTE = ["#f2b84b", "#7b9cff", "#9b8cf0", "#5cc6a7", "#f28b82", "#f6a6cf", "#8ecae6", "#b5d16b", "#c9a27e", "#ff9f5a", "#7fd1d8", "#a3a9b5"];
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const now = () => Date.now();

  // ---------- storage ----------
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  let local = Object.assign({ lastDay: null, dayOffset: 0, syncUrl: "", syncToken: "", pristine: false, synced: false }, read(LOCAL_KEY) || {});
  let board = read(BOARD_KEY);
  if (!board) { board = starterBoard(); local.pristine = true; write(LOCAL_KEY, local); }

  function starterBoard() {
    const t = now();
    const ids = { now: uid(), tom: uid(), later: uid() };
    const todo = (text, listId, order) => ({ id: uid(), text, listId, order, done: false, doneDay: null, archived: false, updatedAt: t });
    return {
      version: 1,
      settings: { carry: true, updatedAt: t },
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
  function mergeBoards(a, b) {
    const cutoff = now() - TOMBSTONE_DAYS * 864e5;
    const mergeById = (x = [], y = []) => {
      const m = new Map();
      for (const item of [...x, ...y]) {
        const prev = m.get(item.id);
        if (!prev || (item.updatedAt || 0) >= (prev.updatedAt || 0)) m.set(item.id, item);
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
  function dayDate(offset = local.dayOffset) { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offset); return d; }
  const keyOf = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const todayKey = () => keyOf(dayDate());
  function pretty(key, opts = { weekday: "long", month: "long", day: "numeric" }) {
    const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, opts);
  }

  // The morning ritual: yesterday's checked todos go to Done, and (optionally)
  // unfinished Tomorrow todos move into Now.
  function rollover() {
    const today = todayKey();
    if (!local.lastDay) { local.lastDay = today; write(LOCAL_KEY, local); return 0; }
    if (local.lastDay >= today) return 0;
    let moved = 0;
    for (const t of board.todos) {
      if (!t.deleted && !t.archived && t.done && t.doneDay && t.doneDay < today) {
        const l = listById(t.listId);
        touch(t, { archived: true, archivedDay: t.doneDay, fromName: l ? l.name : "", fromColor: l ? l.color : "#a3a9b5" });
        moved++;
      }
    }
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
      // First sync on a device that still has only the welcome todos: take the
      // saved board as is, so the welcome todos aren't added to it a second time.
      if (!local.synced && local.pristine) {
        const got = await fetch(dataUrl(), { headers: { "Authorization": "Bearer " + local.syncToken } });
        if (got.status === 401) throw new Error("The access token was not accepted.");
        if (!got.ok) throw new Error("The Worker answered " + got.status + ".");
        const remote = await got.json();
        if (remote.lists && remote.lists.some(l => !l.deleted)) board = remote;
      }
      const res = await fetch(dataUrl(), {
        method: "PUT",
        headers: { "Authorization": "Bearer " + local.syncToken, "Content-Type": "application/json" },
        body: JSON.stringify(board),
      });
      if (res.status === 401) throw new Error("The access token was not accepted.");
      if (!res.ok) throw new Error("The Worker answered " + res.status + ".");
      const merged = await res.json();
      // Edits made while the request was in flight are newer, so they survive the merge.
      board = mergeBoards(board, merged);
      if (!local.synced) { local.synced = true; write(LOCAL_KEY, local); }
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
        touch(t, { done: e.target.checked, doneDay: e.target.checked ? todayKey() : null }); commit();
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

  function popAt(anchor, trigger, ...kids) {
    closePop();
    openPop = el("div", { class: "pop", role: "menu" }, ...kids);
    anchor.append(openPop);
    trigger.setAttribute("aria-expanded", "true");
    return openPop;
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
    const pop = popAt(head, e.currentTarget,
      el("div", { class: "lbl" }, "Page color"),
      el("div", { class: "swatches" }, PALETTE.map(c => el("button", {
        style: `background:${c}`, "aria-label": "Color " + c, "aria-pressed": String(c === list.color), onclick: () => apply(c),
      }))),
      el("label", { class: "custom-color" },
        el("input", { type: "color", value: list.color, oninput: ev => preview(ev.target.value), onchange: ev => apply(ev.target.value) }),
        "Custom color"),
    );
    pop.style.left = "8px"; pop.style.right = "auto";
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

  let drag = null;
  function startDrag(e, t, row) {
    if (e.button !== 0) return;
    e.preventDefault();
    drag = { t, row, x: e.clientX, y: e.clientY, started: false, ghost: null, ph: el("div", { class: "placeholder" }), target: null, before: null };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onUp, { once: true });
  }
  function onMove(e) {
    if (!drag) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
      drag.started = true; closePop();
      drag.ghost = el("div", { class: "ghost" }, drag.t.text); document.body.append(drag.ghost);
      drag.row.classList.add("dragging"); document.body.classList.add("is-dragging");
    }
    drag.ghost.style.left = (e.clientX - 20) + "px"; drag.ghost.style.top = (e.clientY - 18) + "px";
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const col = under && under.closest(".col[data-list]");
    if (!col) { drag.ph.remove(); drag.target = null; return; }
    const body = col.querySelector(".col-body");
    const rows = [...body.querySelectorAll(".todo:not(.dragging)")];
    const before = rows.find(r => e.clientY < r.getBoundingClientRect().top + r.offsetHeight / 2) || null;
    body.querySelector(".empty")?.setAttribute("hidden", "");
    before ? body.insertBefore(drag.ph, before) : body.append(drag.ph);
    drag.target = col.dataset.list; drag.before = before ? before.dataset.id : null;
    const r = boardEl.getBoundingClientRect();
    if (e.clientX > r.right - 40) boardEl.scrollLeft += 12; else if (e.clientX < r.left + 40) boardEl.scrollLeft -= 12;
  }
  function onUp() {
    window.removeEventListener("pointermove", onMove);
    const d = drag; drag = null;
    document.body.classList.remove("is-dragging");
    if (!d || !d.started) return;
    d.ghost.remove(); d.ph.remove();
    if (d.target) {
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
    document.getElementById("syncUrl").value = local.syncUrl;
    document.getElementById("syncToken").value = local.syncToken;
    document.getElementById("syncMsg").textContent = "";
    dlg.showModal();
  });
  document.getElementById("syncStatus").addEventListener("click", () => {
    if (syncConfigured()) sync(); else document.getElementById("openSettings").click();
  });
  document.getElementById("carry").addEventListener("change", e => {
    board.settings = { carry: e.target.checked, updatedAt: now() }; commit();
  });
  document.getElementById("saveSync").addEventListener("click", async () => {
    const msg = document.getElementById("syncMsg");
    const url = document.getElementById("syncUrl").value.trim();
    const token = document.getElementById("syncToken").value.trim();
    if ((url && !token) || (!url && token)) { msg.className = "msg bad"; msg.textContent = "Fill in both the address and the token, or leave both empty."; return; }
    if (url && !/^https:\/\//i.test(url)) { msg.className = "msg bad"; msg.textContent = "The address should start with https://"; return; }
    if (url !== local.syncUrl || token !== local.syncToken) local.synced = false;
    local.syncUrl = url; local.syncToken = token; write(LOCAL_KEY, local);
    if (!url) { msg.className = "msg"; msg.textContent = "Sync is off. Lists stay on this device."; idleStatus(); return; }
    msg.className = "msg"; msg.textContent = "Connecting…";
    const result = await sync();
    if (result === true) { msg.textContent = "Connected. Your lists are synced."; setTimeout(() => dlg.close(), 900); }
    else { msg.className = "msg bad"; msg.textContent = "Couldn't sync: " + result; }
  });
  document.getElementById("nextDay").addEventListener("click", () => {
    local.dayOffset++; write(LOCAL_KEY, local);
    const moved = rollover(); commit(); dlg.close();
    toast(`Good morning! ${moved} finished todo${moved === 1 ? "" : "s"} moved to Done.`);
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

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // ---------- boot ----------
  repairOrphans();
  rollover();
  write(BOARD_KEY, board);
  idleStatus();
  render();
  sync();

  // exposed for tests
  window.__nat = { mergeBoards, get board() { return board; } };
})();
