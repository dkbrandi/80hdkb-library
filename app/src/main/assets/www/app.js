(() => {
"use strict";
const APP_VERSION = "__VERSION__";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const STATUS = {read: "Read", started: "Started", unread: "Unread"};
const CLOTH = ["#2F4A5E","#6E3838","#3C5B3C","#7A5A2A","#4A3E68","#285A55","#86492A","#57582C","#39404D","#682E50","#3F5468","#5E4632"];
const hash = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const nowISO = () => new Date().toISOString();
const FIELDS = ["id","title","author","isbn","genre","collection","pages","room","shelf","status","notes","subjects","storygraph","wishlist","synopsis","photo","added","updated","deleted"];

/* ================= local storage (IndexedDB) ================= */
const idb = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open("brandi-library", 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("books", {keyPath: "id"}); d.createObjectStore("kv"); d.createObjectStore("photos"); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction(store, mode); const s = t.objectStore(store); let out; const r = fn(s); if (r) r.onsuccess = () => out = r.result; t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };
  return {
    all: store => tx(store, "readonly", s => s.getAll()),
    get: (store, key) => tx(store, "readonly", s => s.get(key)),
    put: (store, val, key) => tx(store, "readwrite", s => key === undefined ? s.put(val) : s.put(val, key)),
    del: (store, key) => tx(store, "readwrite", s => s.delete(key)),
    putMany: async (store, vals) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction(store, "readwrite"); const s = t.objectStore(store); vals.forEach(v => s.put(v)); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
  };
})();

/* ================= state ================= */
let books = new Map();
let house = { rooms: [] };
let roomsDirty = false;
let conn = null;                       // {url, key}
let settings = { eink: false, theme: "system" };
let sync = { state: "off", last: "", error: "" };
let loaded = false;
const st = { tab: "catalogue", q: "", room: "", shelf: "", genre: "", status: "", fix: "", sort: "title", view: "grid", selecting: false, sel: new Set(), limit: 240 };

const live = () => [...books.values()].filter(b => !b.deleted);

function applySettings() {
  document.body.classList.toggle("eink", !!settings.eink);
  const root = document.documentElement;
  if (settings.theme === "light" || settings.theme === "dark") root.setAttribute("data-theme", settings.theme); else root.removeAttribute("data-theme");
  try { window.AndroidApp?.setDark?.(document.body.classList.contains("eink") ? false : (settings.theme === "dark" || (settings.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches))); } catch (e) {}
}
async function saveSettings() { await idb.put("kv", settings, "settings"); applySettings(); }

/* ================= helpers ================= */
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, 2600); }
function roomNames() { const set = new Set(house.rooms.map(r => r.name)); for (const b of live()) if (b.room) set.add(b.room); return [...set]; }
function shelvesFor(room) { const r = house.rooms.find(x => x.name === room); const set = new Set(r ? r.shelves : []); for (const b of live()) if (b.room === room && b.shelf) set.add(b.shelf); return [...set]; }
const byNum = (a, b) => a.localeCompare(b, undefined, {numeric: true});
function abbr(room) { const w = room.trim().split(/\s+/); return (w.length > 1 ? w.map(x => x[0]).join("") : room.slice(0, 3)).toUpperCase(); }
function callNo(b) {
  if (!b.room) return `<span class="callno none">Unplaced</span>`;
  return `<span class="callno" title="${esc(b.room)}${b.shelf ? " · " + esc(b.shelf) : ""}">${esc(abbr(b.room))}${b.shelf ? " · " + esc(b.shelf) : " · no shelf"}</span>`;
}
function photoKey(b) { return b.photoPending || b.photo || ""; }
function coverHTML(b) {
  const key = photoKey(b);
  const c = CLOTH[hash(b.genre || b.title) % CLOTH.length];
  const gen = `<span class="t">${esc(b.title || "Untitled")}</span><span><span class="rule" style="display:block"></span><span class="a">${esc(b.author || "Unknown author")}</span></span>`;
  if (key) {
    const url = photoURLs.get(key);
    if (url) return `<div class="cover"><img src="${url}" alt="Cover of ${esc(b.title)}"></div>`;
    return `<div class="cover gen" data-photo="${esc(key)}" style="background:${c}">${gen}</div>`;
  }
  return `<div class="cover gen" style="background:${c}">${gen}</div>`;
}
const sortKey = s => (s || "").toLowerCase().replace(/^(the|a|an)\s+/, "");
const authorKey = a => { const p = (a || "").split(/,| and /)[0].trim().split(/\s+/); return (p[p.length - 1] || "").toLowerCase(); };

/* ================= photos ================= */
const photoURLs = new Map();      // key -> objectURL
const photoMiss = new Set();      // keys we failed to fetch this session
let photoQueue = [], photoActive = 0;
const io = new IntersectionObserver(entries => {
  entries.forEach(e => { if (e.isIntersecting) { io.unobserve(e.target); hydrate(e.target); } });
}, { rootMargin: "300px" });
function observePhotos(root = document) { root.querySelectorAll(".cover[data-photo]").forEach(el => io.observe(el)); }
async function hydrate(el) {
  const key = el.dataset.photo; if (!key) return;
  if (photoURLs.has(key)) return swapIn(key);
  const blob = await idb.get("photos", key).catch(() => null);
  if (blob) { photoURLs.set(key, URL.createObjectURL(blob)); return swapIn(key); }
  if (key.startsWith("local:") || photoMiss.has(key) || !conn) return;
  if (!photoQueue.includes(key)) photoQueue.push(key);
  pumpPhotos();
}
function swapIn(key) {
  const url = photoURLs.get(key);
  document.querySelectorAll(`.cover[data-photo="${CSS.escape(key)}"]`).forEach(el => {
    el.classList.remove("gen"); el.removeAttribute("style"); el.removeAttribute("data-photo");
    el.innerHTML = `<img src="${url}" alt="">`;
  });
}
async function pumpPhotos() {
  while (photoActive < 3 && photoQueue.length) {
    const key = photoQueue.shift(); photoActive++;
    api("photoGet", { photo: key }, 45000).then(async r => {
      const blob = b64ToBlob(r.data, "image/jpeg");
      await idb.put("photos", blob, key);
      photoURLs.set(key, URL.createObjectURL(blob)); swapIn(key);
    }).catch(() => photoMiss.add(key)).finally(() => { photoActive--; pumpPhotos(); });
  }
}
function b64ToBlob(b64, type) { const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return new Blob([a], {type}); }
function blobToB64(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); }); }
async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const max = 900, k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, "image/jpeg", .84));
  } finally { URL.revokeObjectURL(url); }
}

/* ================= sync with Google Sheet ================= */
function parseCode(code) {
  const m = String(code).trim().match(/BLIB1:([A-Za-z0-9_\-=]+)/);
  if (!m) throw new Error("That doesn't look like a connection code. It starts with BLIB1:");
  let b = m[1].replace(/-/g, "+").replace(/_/g, "/"); while (b.length % 4) b += "=";
  const [url, key] = atob(b).split("\n");
  if (!/^https:\/\/script\.google\.com\//.test(url) || !key) throw new Error("That connection code is incomplete. Copy the whole line from the email.");
  return { url, key };
}
async function api(action, payload = {}, timeout = 30000, c = conn) {
  if (!c) throw new Error("not_connected");
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(c.url, { method: "POST", headers: {"Content-Type": "text/plain;charset=utf-8"}, body: JSON.stringify({ key: c.key, action, ...payload }), signal: ac.signal, redirect: "follow" });
    const j = await r.json();
    if (!j.ok) { const e = new Error(j.message || j.error); e.code = j.error; throw e; }
    return j;
  } finally { clearTimeout(t); }
}
const toServer = b => { const o = {}; FIELDS.forEach(f => o[f] = b[f]); return o; };
let syncTimer = null, syncing = false, syncAgain = false;
function scheduleSync(ms = 3000) { if (!conn) return renderSync(); clearTimeout(syncTimer); syncTimer = setTimeout(() => runSync(), ms); renderSync(); }
async function runSync(manual) {
  if (!conn) { if (manual) toast("Connect your Google Sheet in Settings first"); return; }
  if (syncing) { syncAgain = true; return; }
  if (!navigator.onLine) { sync.state = "off"; sync.error = "No connection. Changes are saved on this device and will sync later."; renderSync(); return; }
  syncing = true; sync.state = "busy"; sync.error = ""; renderSync();
  try {
    // 1. upload new cover photos
    for (const b of live().filter(b => b.photoPending)) {
      const blob = await idb.get("photos", b.photoPending);
      if (!blob) { b.photoPending = ""; await idb.put("books", b); continue; }
      const r = await api("photoUp", { bookId: b.id, data: await blobToB64(blob), replaces: b.photo || "" }, 90000);
      await idb.put("photos", blob, r.photo); await idb.del("photos", b.photoPending);
      const url = photoURLs.get(b.photoPending); if (url) { photoURLs.set(r.photo, url); photoURLs.delete(b.photoPending); }
      const cur = books.get(b.id);
      cur.photo = r.photo; cur.photoPending = ""; cur.updated = nowISO(); cur.dirty = true;
      await idb.put("books", cur);
    }
    // 2. push changes
    const dirty = [...books.values()].filter(b => b.dirty);
    if (dirty.length || roomsDirty) {
      const sent = new Map(dirty.map(b => [b.id, b.updated]));
      const r = await api("push", { books: dirty.map(toServer), rooms: roomsDirty ? house.rooms : undefined }, 60000);
      const changed = [];
      for (const id of r.accepted || []) { const b = books.get(id); if (b && b.updated === sent.get(id)) { b.dirty = false; changed.push(b); } }
      // anything the sheet rejected was older than the sheet's copy: drop the dirty flag and let the pull win
      for (const [id] of sent) { const b = books.get(id); if (b && b.dirty && !(r.accepted || []).includes(id) && b.updated === sent.get(id)) { b.dirty = false; changed.push(b); } }
      if (changed.length) await idb.putMany("books", changed);
      if (roomsDirty) { roomsDirty = false; await idb.put("kv", false, "roomsDirty"); }
    }
    // 3. pull everything and merge
    const p = await api("pull", {}, 60000);
    const upd = [];
    for (const sb of p.books) {
      const lb = books.get(sb.id);
      if (!lb) { books.set(sb.id, sb); upd.push(sb); continue; }
      if (lb.dirty) continue;
      if ((sb.updated || "") >= (lb.updated || "") && JSON.stringify(toServer(lb)) !== JSON.stringify(toServer(sb))) {
        const nb = { ...sb, photoPending: lb.photoPending || "" }; books.set(sb.id, nb); upd.push(nb);
      }
    }
    if (upd.length) await idb.putMany("books", upd);
    if (!roomsDirty && JSON.stringify(p.rooms) !== JSON.stringify(house.rooms)) { house.rooms = p.rooms; await idb.put("kv", house, "house"); }
    sync.state = "ok"; sync.last = nowISO(); await idb.put("kv", sync.last, "lastSync");
    if (upd.length || !loaded) { loaded = true; render(); }
  } catch (e) {
    sync.state = "err";
    sync.error = e.code === "bad_key" ? "The sheet rejected this device's connection code. Paste a fresh code in Settings."
      : e.name === "AbortError" ? "The sheet took too long to answer. Will retry."
      : e.message === "Failed to fetch" ? "Couldn't reach Google. Check your connection; changes are saved on this device."
      : "Sync problem: " + (e.message || "unknown error");
  } finally {
    syncing = false; if (!loaded) { loaded = true; render(); } renderSync();
    if (st.tab === "settings") render();
    if (syncAgain) { syncAgain = false; scheduleSync(1500); }
  }
}
function pendingCount() { return [...books.values()].filter(b => b.dirty || b.photoPending).length + (roomsDirty ? 1 : 0); }
function renderSync() {
  const p = $("#syncPill"), n = pendingCount();
  let cls = "", txt = "Not synced";
  if (!conn) { txt = "This device only"; }
  else if (sync.state === "busy") { cls = "busy"; txt = "Syncing"; }
  else if (sync.state === "err") { cls = "err"; txt = "Sync problem"; }
  else if (n) { cls = "pending"; txt = `${n} to sync`; }
  else if (sync.last) { cls = "ok"; txt = "Synced " + ago(sync.last); }
  p.className = "syncpill " + cls; p.querySelector("span").textContent = txt;
}
function ago(iso) { const s = (Date.now() - new Date(iso)) / 1000; if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + "m ago"; if (s < 86400) return Math.floor(s / 3600) + "h ago"; return new Date(iso).toLocaleDateString(); }
setInterval(renderSync, 30000);

/* ================= local writes ================= */
async function saveBook(b) { b.updated = nowISO(); b.dirty = true; books.set(b.id, b); await idb.put("books", b); scheduleSync(); }
async function patchBooks(ids, patch, label) {
  const t = nowISO(), list = [];
  for (const id of ids) { const b = books.get(id); if (!b) continue; Object.assign(b, patch, { updated: t, dirty: true }); list.push(b); }
  await idb.putMany("books", list); scheduleSync();
  if (label) toast(`${label} ${list.length} book${list.length === 1 ? "" : "s"}`);
}
async function saveHouse() { roomsDirty = true; await idb.put("kv", house, "house"); await idb.put("kv", true, "roomsDirty"); scheduleSync(); }
function ensureRoom(name) { if (name && !house.rooms.find(r => r.name === name)) house.rooms.push({ name, shelves: [] }); }

/* ================= filters ================= */
function matches(b) {
  if (b.deleted) return false;
  if (st.tab === "wishlist" ? !b.wishlist : b.wishlist) return false;
  if (st.room === "__none") { if (b.room) return false; } else if (st.room && b.room !== st.room) return false;
  if (st.shelf === "__none") { if (b.shelf) return false; } else if (st.shelf && b.shelf !== st.shelf) return false;
  if (st.genre === "__none") { if (b.genre) return false; } else if (st.genre && b.genre !== st.genre) return false;
  if (st.status === "none") { if (b.status) return false; } else if (st.status && b.status !== st.status) return false;
  if (st.fix === "noroom" && b.room) return false;
  if (st.fix === "noshelf" && b.shelf) return false;
  if (st.fix === "nophoto" && photoKey(b)) return false;
  if (st.fix === "nopages" && b.pages) return false;
  if (st.fix === "nogenre" && b.genre) return false;
  if (st.q) {
    const hay = [b.title, b.author, b.isbn, b.notes, b.genre, b.room, b.shelf, (b.subjects || []).join(" ")].join(" ").toLowerCase();
    if (!st.q.toLowerCase().split(/\s+/).every(w => hay.includes(w))) return false;
  }
  return true;
}
function sorted(list) {
  const by = {
    title: (a, b) => sortKey(a[1].title).localeCompare(sortKey(b[1].title)),
    author: (a, b) => authorKey(a[1].author).localeCompare(authorKey(b[1].author)) || sortKey(a[1].title).localeCompare(sortKey(b[1].title)),
    pages: (a, b) => (b[1].pages || 0) - (a[1].pages || 0),
    location: (a, b) => (a[1].room || "~").localeCompare(b[1].room || "~") || byNum(a[1].shelf || "~", b[1].shelf || "~") || sortKey(a[1].title).localeCompare(sortKey(b[1].title)),
    recent: (a, b) => (b[1].added || "").localeCompare(a[1].added || "") || b[0].localeCompare(a[0])
  }[st.sort];
  return list.sort(by);
}
function fillSelect(el, opts, val) {
  el.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
  el.value = opts.some(o => o[0] === val) ? val : "";
  el.classList.toggle("on", !!el.value);
}
function refreshFilters() {
  const pool = live().filter(b => st.tab === "wishlist" ? b.wishlist : !b.wishlist);
  const rc = {}; pool.forEach(b => rc[b.room || ""] = (rc[b.room || ""] || 0) + 1);
  fillSelect($("#fRoom"), [["", "All rooms"], ...roomNames().sort().map(r => [r, `${r} (${rc[r] || 0})`]), ["__none", `No room (${rc[""] || 0})`]], st.room);
  st.room = $("#fRoom").value;
  const realRoom = st.room && st.room !== "__none";
  const shelves = realRoom ? shelvesFor(st.room).sort(byNum) : [];
  fillSelect($("#fShelf"), [["", realRoom ? "All shelves" : "Shelf"], ...shelves.map(s => [s, s]), ...(realRoom ? [["__none", "Not on a shelf"]] : [])], st.shelf);
  $("#fShelf").disabled = !realRoom; st.shelf = $("#fShelf").value;
  const gc = {}; pool.forEach(b => { if (b.genre) gc[b.genre] = (gc[b.genre] || 0) + 1; });
  fillSelect($("#fGenre"), [["", "All genres"], ...Object.keys(gc).sort().map(g => [g, `${g} (${gc[g]})`]), ["__none", "No genre"]], st.genre);
  st.genre = $("#fGenre").value;
  $("#fStatus").classList.toggle("on", !!st.status);
  $("#fFix").classList.toggle("on", !!st.fix);
  const nf = [st.room, st.genre, st.status, st.fix].filter(Boolean).length;
  $("#filtBtn").textContent = nf ? `Filters (${nf})` : "Filters";
  $("#filtBtn").classList.toggle("on", !!nf);
  const all = live();
  $("#dlAuthors").innerHTML = [...new Set(all.map(b => b.author).filter(Boolean))].sort().map(a => `<option value="${esc(a)}">`).join("");
  $("#dlGenres").innerHTML = [...new Set(all.map(b => b.genre).filter(Boolean))].sort().map(a => `<option value="${esc(a)}">`).join("");
  $("#dlColls").innerHTML = [...new Set(all.map(b => b.collection).filter(Boolean))].sort().map(a => `<option value="${esc(a)}">`).join("");
}

/* ================= render ================= */
function render() {
  document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === st.tab));
  $("#toolbar").hidden = st.tab === "shelves" || st.tab === "settings";
  $("#vGrid").setAttribute("aria-pressed", st.view === "grid");
  $("#vList").setAttribute("aria-pressed", st.view === "list");
  const owned = live().filter(b => !b.wishlist);
  $("#exl").textContent = `Ex libris · ${owned.length} volumes`;
  renderSync();
  if (st.tab === "settings") return renderSettings();
  if (!loaded) { $("#main").innerHTML = `<div class="empty"><h2>Pulling the books off the shelves…</h2></div>`; return; }
  if (!books.size && !conn && !st.skipWelcome) return renderWelcome();
  refreshFilters();
  if (st.tab === "shelves") return renderShelves();
  renderCatalogue();
}

function renderWelcome() {
  $("#toolbar").hidden = true;
  $("#main").innerHTML = `<div class="panel">
    <h2>Connect your library</h2>
    <p>Your catalogue lives in your Home Library Google Sheet. Paste the connection code from the email the sheet sent you, and every book, room and shelf comes down to this device.</p>
    <label class="sr" for="codeIn">Connection code</label><textarea id="codeIn" placeholder="BLIB1:…"></textarea>
    <div class="row"><button class="btn primary" id="connectBtn">Connect and download</button><span class="err-text" id="connErr"></span></div>
    <p style="font-size:13px">No code yet? In the sheet, open the <strong>Library App</strong> menu and choose <strong>Email me the connection code</strong>.</p>
    <div class="row"><button class="linkish" id="skipBtn">Start an empty library on this device instead</button></div>
  </div>`;
  $("#connectBtn").addEventListener("click", connectFromInput);
  $("#skipBtn").addEventListener("click", () => { st.skipWelcome = true; loaded = true; renderCatalogueShell(); });
}
function renderCatalogueShell() { $("#toolbar").hidden = false; refreshFilters(); renderCatalogue(); }

async function connectFromInput() {
  const err = $("#connErr"); err.textContent = "";
  let c;
  try { c = parseCode($("#codeIn").value); } catch (e) { err.textContent = e.message; return; }
  const btn = $("#connectBtn"); btn.disabled = true; btn.textContent = "Connecting…";
  try {
    await api("pull", {}, 60000, c);
    conn = c; await idb.put("kv", conn, "conn");
    toast("Connected. Downloading your catalogue…");
    await runSync(true);
    st.tab = "catalogue"; render();
  } catch (e) {
    err.textContent = e.code === "bad_key" ? "The sheet didn't accept that code. Email yourself a fresh one and try again."
      : e.message === "Failed to fetch" ? "Couldn't reach Google. Check this device's internet connection."
      : "Couldn't connect: " + (e.message || "unknown error");
  } finally { btn.disabled = false; btn.textContent = conn ? "Reconnect" : "Connect and download"; }
}

function renderSettings() {
  const n = pendingCount();
  $("#main").innerHTML = `<div class="settings">
    <section class="panel">
      <h2>Google Sheet sync</h2>
      ${conn ? `<dl class="kv"><dt>Status</dt><dd>${sync.state === "err" ? "Problem" : sync.state === "busy" ? "Syncing now" : "Connected"}</dd>
        <dt>Last synced</dt><dd>${sync.last ? new Date(sync.last).toLocaleString() : "Not yet"}</dd>
        <dt>Waiting to sync</dt><dd>${n ? n + " change" + (n === 1 ? "" : "s") : "Nothing"}</dd></dl>
        ${sync.error ? `<p class="err-text">${esc(sync.error)}</p>` : ""}
        <div class="row"><button class="btn primary" id="syncNow">Sync now</button><button class="btn" id="showConn">Use a different code</button></div>`
      : `<p>This device isn't connected yet, so books you add stay on this device only.</p>`}
      <div id="connBox" ${conn ? "hidden" : ""} class="settings" style="gap:10px">
        <label class="sr" for="codeIn">Connection code</label><textarea id="codeIn" placeholder="BLIB1:…"></textarea>
        <div class="row"><button class="btn primary" id="connectBtn">${conn ? "Reconnect" : "Connect and download"}</button><span class="err-text" id="connErr"></span></div>
        <p style="font-size:13px">In the sheet: <strong>Library App → Email me the connection code</strong>, then copy the code from that email.</p>
      </div>
    </section>
    <section class="panel">
      <h2>Screen</h2>
      <p>E-ink mode is tuned for the Boox: black text on white, no shadows or motion, slightly larger type. Covers keep their color.</p>
      <div class="opt" role="group" aria-label="E-ink mode"><button data-eink="0" aria-pressed="${!settings.eink}">Standard</button><button data-eink="1" aria-pressed="${!!settings.eink}">E-ink mode</button></div>
      <div class="opt" role="group" aria-label="Theme" ${settings.eink ? "hidden" : ""}>${["system", "light", "dark"].map(t => `<button data-theme-set="${t}" aria-pressed="${settings.theme === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>
    </section>
    <section class="panel">
      <h2>About</h2>
      <dl class="kv"><dt>Books</dt><dd>${live().filter(b => !b.wishlist).length} owned, ${live().filter(b => b.wishlist).length} on the wishlist</dd><dt>Rooms</dt><dd>${roomNames().length}</dd><dt>Version</dt><dd>${esc(APP_VERSION)}</dd></dl>
    </section>
  </div>`;
  $("#syncNow")?.addEventListener("click", () => runSync(true));
  $("#showConn")?.addEventListener("click", () => { $("#connBox").hidden = false; $("#codeIn").focus(); });
  $("#connectBtn").addEventListener("click", connectFromInput);
  document.querySelectorAll("[data-eink]").forEach(b => b.addEventListener("click", async () => { settings.eink = b.dataset.eink === "1"; await saveSettings(); render(); }));
  document.querySelectorAll("[data-theme-set]").forEach(b => b.addEventListener("click", async () => { settings.theme = b.dataset.themeSet; await saveSettings(); render(); }));
}

function renderCatalogue() {
  const list = sorted([...books.entries()].filter(([, b]) => matches(b)));
  const pool = live().filter(b => st.tab === "wishlist" ? b.wishlist : !b.wishlist);
  const unplaced = pool.filter(b => !b.room).length, noshelf = pool.filter(b => b.room && !b.shelf).length, nophoto = pool.filter(b => !photoKey(b)).length;
  const filtered = st.q || st.room || st.shelf || st.genre || st.status || st.fix;
  let h = `<div class="summary"><span><span class="count">${list.length}</span> ${st.tab === "wishlist" ? "on the wishlist" : list.length === 1 ? "book" : "books"}${filtered ? ` of ${pool.length}` : ""}</span>`;
  if (filtered) h += `<button class="linkish" id="clearF">Clear filters</button>`;
  if (st.tab === "catalogue" && !filtered && pool.length) {
    if (unplaced) h += `<button class="chip warn" data-fix="noroom"><b>${unplaced}</b> without a room</button>`;
    if (noshelf) h += `<button class="chip warn" data-fix="noshelf"><b>${noshelf}</b> without a shelf</button>`;
    h += `<button class="chip" data-fix="nophoto"><b>${nophoto}</b> without a photo</button>`;
  }
  h += `</div>`;
  if (!list.length) {
    h += pool.length ? `<div class="empty"><h2>Nothing on these shelves</h2><p>No books match. Try clearing a filter.</p></div>`
      : st.tab === "wishlist" ? `<div class="empty"><h2>The wishlist is empty</h2><p>Add a book and tick “On wishlist” to track it here.</p></div>`
      : `<div class="empty"><h2>No books yet</h2><p>Use “Add book” to catalogue your first one.</p></div>`;
    $("#main").innerHTML = h; bindSummary(); return;
  }
  const shown = list.slice(0, st.limit);
  if (st.view === "grid") {
    h += `<div class="grid">` + shown.map(([id, b]) => `<button class="card${st.sel.has(id) ? " sel" : ""}" data-id="${esc(id)}" aria-label="${esc(b.title || "Untitled")}">
      <div style="position:relative">${coverHTML(b)}<span class="sel-box"></span>${b.status && !b.wishlist ? `<span class="status-dot ${b.status}" title="${STATUS[b.status]}">${b.status === "read" ? "✓" : b.status === "started" ? "½" : "·"}</span>` : ""}</div>
      <div class="meta"><div class="title">${esc(b.title || "Untitled")}</div><div class="author">${esc(b.author || "Unknown author")}</div>${b.wishlist ? (b.notes ? `<span class="callno">${esc(b.notes)}</span>` : "") : callNo(b)}</div></button>`).join("") + `</div>`;
  } else {
    h += `<div class="list-wrap"><table class="list"><thead><tr>${st.selecting ? "<th></th>" : ""}<th></th><th>Title</th><th>Author</th><th>Genre</th><th>Room</th><th>Shelf</th><th>Status</th><th style="text-align:right">Pages</th></tr></thead><tbody>` +
      shown.map(([id, b]) => `<tr data-id="${esc(id)}" class="${st.sel.has(id) ? "sel" : ""}">${st.selecting ? `<td class="ck"><input type="checkbox" aria-label="Select" ${st.sel.has(id) ? "checked" : ""} tabindex="-1"></td>` : ""}
      <td><span class="thumb">${coverHTML(b)}</span></td><td><strong>${esc(b.title || "Untitled")}</strong></td><td>${esc(b.author)}</td><td>${esc(b.genre)}</td>
      <td>${b.room ? esc(b.room) : `<span style="color:var(--gilt)">Unplaced</span>`}</td><td>${esc(b.shelf)}</td><td>${esc(STATUS[b.status] || "")}</td><td class="num">${b.pages || ""}</td></tr>`).join("") + `</tbody></table></div>`;
  }
  if (list.length > st.limit) h += `<div class="more"><button class="btn" id="moreBtn">Show ${Math.min(240, list.length - st.limit)} more (${list.length - st.limit} left)</button></div>`;
  $("#main").innerHTML = h;
  bindSummary(); observePhotos($("#main"));
  $("#moreBtn")?.addEventListener("click", () => { st.limit += 240; render(); });
  st.lastList = list.map(x => x[0]);
}
function bindSummary() {
  $("#clearF")?.addEventListener("click", () => { Object.assign(st, {q: "", room: "", shelf: "", genre: "", status: "", fix: ""}); $("#q").value = ""; $("#fStatus").value = ""; $("#fFix").value = ""; render(); });
  document.querySelectorAll("[data-fix]").forEach(b => b.addEventListener("click", () => { st.fix = b.dataset.fix; $("#fFix").value = st.fix; render(); }));
}

function renderShelves() {
  const owned = live().filter(b => !b.wishlist);
  const rooms = roomNames().sort((a, b) => owned.filter(x => x.room === b).length - owned.filter(x => x.room === a).length);
  const unplaced = owned.filter(b => !b.room).length;
  let h = `<div class="summary"><span><span class="count">${rooms.length}</span> rooms</span><span><strong>${owned.filter(b => b.shelf).length}</strong> of ${owned.length} books are on a named shelf</span>`;
  if (unplaced) h += `<button class="chip warn" id="goUnplaced"><b>${unplaced}</b> without a room</button>`;
  h += `</div><div class="rooms">`;
  for (const r of rooms) {
    const inRoom = owned.filter(b => b.room === r);
    const shelves = shelvesFor(r).sort(byNum);
    const loose = inRoom.filter(b => !b.shelf).length;
    h += `<section class="room" data-room="${esc(r)}"><div class="room-head"><h2>${esc(r)}</h2><span class="n">${inRoom.length} books · ${shelves.length} shelves</span>
      <span class="act"><button class="btn ghost" data-act="rename-room">Rename</button><button class="btn ghost danger" data-act="del-room">Remove</button></span></div>
      <div class="shelves">${shelves.map(s => {
        const n = inRoom.filter(b => b.shelf === s);
        return `<div style="display:flex;gap:4px;align-items:center"><button class="shelf" data-go-shelf="${esc(s)}">${spineBar(n)}<span class="nm">${esc(s)}</span><span class="ct">${n.length}</span></button><button class="btn ghost" data-act="rename-shelf" data-shelf="${esc(s)}" aria-label="Edit ${esc(s)}">✎</button></div>`;
      }).join("")}
      ${loose ? `<button class="shelf unshelved" data-go-shelf="__none">${spineBar(inRoom.filter(b => !b.shelf))}<span class="nm">Not on a shelf yet</span><span class="ct">${loose}</span></button>` : ""}</div>
      <form class="inline-form" data-act="add-shelves"><label class="sr" for="ns-${hash(r)}">New shelf name or count</label><input id="ns-${hash(r)}" placeholder="Shelf name, or a number like 6"><button class="btn" type="submit">Add shelf</button></form>
      <div class="inline-form" data-edit hidden></div></section>`;
  }
  h += `<section class="room add-room"><form class="inline-form" id="addRoom"><label class="sr" for="newRoom">New room</label><input id="newRoom" placeholder="New room, e.g. Guest Room"><button class="btn primary" type="submit">Add room</button></form>
    <p style="margin:0;font-size:13px;color:var(--muted)">Type a number in “Add shelf” to create Shelf 1, Shelf 2 and so on at once. Then tap a shelf, choose Select, and move books onto it in bulk.</p></section></div>`;
  $("#main").innerHTML = h;
  $("#goUnplaced")?.addEventListener("click", () => { st.tab = "catalogue"; st.fix = "noroom"; $("#fFix").value = "noroom"; render(); });
}
function spineBar(list) {
  const n = Math.min(list.length, 14);
  if (!n) return `<span class="bar"></span>`;
  return `<span class="bar" aria-hidden="true">${list.slice(0, n).map(b => `<i style="height:${10 + hash(b.title) % 11}px;background:${CLOTH[hash(b.genre || b.title) % CLOTH.length]}"></i>`).join("")}</span>`;
}

/* ================= drawer ================= */
let editing = null, pendingPhoto, delArmed = false;
function roomOptions(sel, val) { const rooms = roomNames().sort(); sel.innerHTML = `<option value="">No room</option>` + rooms.map(r => `<option>${esc(r)}</option>`).join("") + `<option value="__new">+ New room…</option>`; sel.value = val || ""; }
function shelfOptions(sel, room, val) { const s = room ? shelvesFor(room).sort(byNum) : []; sel.innerHTML = `<option value="">No shelf</option>` + s.map(x => `<option>${esc(x)}</option>`).join("") + (room ? `<option value="__new">+ New shelf…</option>` : ""); sel.value = val || ""; sel.disabled = !room; }
function openBook(id) {
  editing = id; pendingPhoto = undefined; delArmed = false;
  const realRoom = st.room && st.room !== "__none";
  const b = id ? books.get(id) : { title: "", author: "", genre: "", pages: null, room: realRoom ? st.room : "", shelf: realRoom && st.shelf && st.shelf !== "__none" ? st.shelf : "", status: "", collection: "General Library", isbn: "", storygraph: false, wishlist: st.tab === "wishlist", notes: "", subjects: [], synopsis: "" };
  $("#dTitle").textContent = id ? "Catalogue card" : "New catalogue card";
  $("#iTitle").value = b.title; $("#iAuthor").value = b.author || ""; $("#iGenre").value = b.genre || ""; $("#iPages").value = b.pages || "";
  roomOptions($("#iRoom"), b.room); shelfOptions($("#iShelf"), b.room, b.shelf);
  $("#iStatus").value = b.status || ""; $("#iColl").value = b.collection || ""; $("#iIsbn").value = b.isbn || "";
  $("#iSg").checked = !!b.storygraph; $("#iWish").checked = !!b.wishlist; $("#iNotes").value = b.notes || "";
  $("#synWrap").hidden = !b.synopsis; $("#iSyn").textContent = b.synopsis || "";
  $("#subWrap").hidden = !(b.subjects || []).length; $("#iSubs").innerHTML = (b.subjects || []).map(s => `<span>${esc(s)}</span>`).join("");
  $("#delBtn").hidden = !id; $("#delBtn").classList.remove("armed"); $("#delBtn").textContent = "Delete";
  $("#photoHint").textContent = "Photos are resized before saving, so a quick snapshot is fine.";
  drawCover(b);
  $("#drawer").showModal();
}
function drawCover(b) {
  if (pendingPhoto && pendingPhoto.url) { $("#dCover").innerHTML = `<div class="cover"><img src="${pendingPhoto.url}" alt="New cover photo"></div>`; $("#rmPhoto").hidden = false; return; }
  const t = { ...b, title: $("#iTitle").value || b.title, author: $("#iAuthor").value || b.author };
  if (pendingPhoto === null) { t.photo = ""; t.photoPending = ""; }
  $("#dCover").innerHTML = coverHTML(t); observePhotos($("#dCover"));
  $("#rmPhoto").hidden = !photoKey(t);
}
$("#iRoom").addEventListener("change", e => { if (e.target.value === "__new") return askInline("Name the new room"); shelfOptions($("#iShelf"), e.target.value, ""); });
$("#iShelf").addEventListener("change", e => { if (e.target.value === "__new") askInline("Name the new shelf", true); });
function askInline(label, shelf) {
  const sel = shelf ? $("#iShelf") : $("#iRoom");
  const inp = document.createElement("input"); inp.placeholder = label; inp.setAttribute("aria-label", label);
  sel.hidden = true; sel.after(inp); inp.focus();
  let done = false;
  const finish = keep => {
    if (done) return; done = true;
    const v = inp.value.trim(); inp.remove(); sel.hidden = false;
    if (keep && v) {
      if (shelf) { const room = $("#iRoom").value; ensureRoom(room); const r = house.rooms.find(x => x.name === room); if (!r.shelves.includes(v)) r.shelves.push(v); saveHouse(); shelfOptions(sel, room, v); }
      else { ensureRoom(v); saveHouse(); roomOptions(sel, v); shelfOptions($("#iShelf"), v, ""); }
    } else { sel.value = ""; if (!shelf) shelfOptions($("#iShelf"), "", ""); }
  };
  inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); finish(true); } if (e.key === "Escape") { e.preventDefault(); finish(false); } });
  inp.addEventListener("blur", () => finish(true));
}
["#iTitle", "#iAuthor"].forEach(s => $(s).addEventListener("input", () => { const b = books.get(editing) || {}; if (!photoKey(b) && !pendingPhoto) drawCover(b); }));

async function onPhoto(e) {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  $("#photoHint").textContent = "Preparing photo…";
  try {
    const blob = await shrink(f);
    if (pendingPhoto?.url) URL.revokeObjectURL(pendingPhoto.url);
    pendingPhoto = { blob, url: URL.createObjectURL(blob) };
    $("#photoHint").textContent = "Looks good. Save the card to keep it.";
    drawCover(books.get(editing) || {});
  } catch (err) { $("#photoHint").textContent = "Couldn't read that image. Try another."; }
}
$("#fCam").addEventListener("change", onPhoto);
$("#fUp").addEventListener("change", onPhoto);
$("#rmPhoto").addEventListener("click", () => { if (pendingPhoto?.url) URL.revokeObjectURL(pendingPhoto.url); pendingPhoto = null; drawCover(books.get(editing) || {}); $("#photoHint").textContent = "Photo will be removed when you save."; });

$("#bookForm").addEventListener("submit", async e => {
  e.preventDefault();
  const title = $("#iTitle").value.trim(); if (!title) { $("#iTitle").focus(); return; }
  const room = $("#iRoom").value === "__new" ? "" : $("#iRoom").value, shelf = $("#iShelf").value === "__new" ? "" : $("#iShelf").value;
  const pages = parseInt($("#iPages").value, 10);
  const old = editing ? books.get(editing) : null;
  const b = old ? { ...old } : { id: "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), subjects: [], synopsis: "", photo: "", photoPending: "", added: nowISO().slice(0, 10), deleted: false };
  Object.assign(b, { title, author: $("#iAuthor").value.trim(), genre: $("#iGenre").value.trim(), pages: pages > 0 ? pages : null, room, shelf: room ? shelf : "",
    status: $("#iStatus").value, collection: $("#iColl").value.trim(), isbn: $("#iIsbn").value.replace(/[^0-9Xx]/g, ""), storygraph: $("#iSg").checked,
    wishlist: $("#iWish").checked, notes: $("#iNotes").value.trim() });
  if (pendingPhoto) {
    const key = "local:" + b.id + ":" + Date.now();
    await idb.put("photos", pendingPhoto.blob, key);
    photoURLs.set(key, pendingPhoto.url);
    if (b.photoPending) { idb.del("photos", b.photoPending); }
    b.photoPending = key; pendingPhoto = undefined;
  } else if (pendingPhoto === null) { if (b.photoPending) idb.del("photos", b.photoPending); b.photoPending = ""; b.photo = ""; }
  if (room && shelf) { ensureRoom(room); const r = house.rooms.find(x => x.name === room); if (!r.shelves.includes(shelf)) { r.shelves.push(shelf); saveHouse(); } }
  await saveBook(b);
  $("#drawer").close(); toast(old ? "Saved" : "Added to the catalogue"); render();
});
$("#delBtn").addEventListener("click", async () => {
  if (!delArmed) { delArmed = true; $("#delBtn").classList.add("armed"); $("#delBtn").textContent = "Tap again to delete"; return; }
  const b = { ...books.get(editing), deleted: true };
  await saveBook(b); $("#drawer").close(); toast("Deleted"); render();
});
const closeDrawer = () => { if (pendingPhoto?.url) URL.revokeObjectURL(pendingPhoto.url); pendingPhoto = undefined; $("#drawer").close(); };
$("#dClose").addEventListener("click", closeDrawer);
$("#cancelBtn").addEventListener("click", closeDrawer);
$("#drawer").addEventListener("cancel", e => { e.preventDefault(); closeDrawer(); });
$("#drawer").addEventListener("click", e => { if (e.target === $("#drawer")) closeDrawer(); });

/* ================= selection / bulk ================= */
function setSelecting(on) {
  st.selecting = on; if (!on) st.sel.clear();
  document.body.classList.toggle("selecting", on);
  $("#selBtn").textContent = on ? "Cancel" : "Select";
  $("#bulk").hidden = !on; updateBulk(); render();
}
function updateBulk() {
  $("#bulkN").textContent = st.sel.size;
  const rooms = roomNames().sort(), cur = $("#bRoom").value;
  $("#bRoom").innerHTML = `<option value="">Move to room…</option>` + rooms.map(r => `<option>${esc(r)}</option>`).join("");
  $("#bRoom").value = rooms.includes(cur) ? cur : (st.room && st.room !== "__none" ? st.room : "");
  bulkShelves();
}
function bulkShelves() {
  const r = $("#bRoom").value, cur = $("#bShelf").value;
  const s = r ? shelvesFor(r).sort(byNum) : [];
  $("#bShelf").innerHTML = `<option value="">${r ? "No shelf" : "Shelf…"}</option>` + s.map(x => `<option>${esc(x)}</option>`).join("");
  $("#bShelf").value = s.includes(cur) ? cur : (st.shelf && st.shelf !== "__none" && s.includes(st.shelf) ? st.shelf : "");
  $("#bShelf").disabled = !r;
}
$("#bRoom").addEventListener("change", bulkShelves);
$("#bMove").addEventListener("click", async () => {
  const room = $("#bRoom").value; if (!room) { toast("Pick a room first"); return; }
  if (!st.sel.size) { toast("Tap books to select them"); return; }
  await patchBooks([...st.sel], { room, shelf: $("#bShelf").value }, "Moved");
  st.sel.clear(); updateBulk(); render();
});
$("#bStatus").addEventListener("change", async e => {
  const v = e.target.value; e.target.value = ""; if (!v || !st.sel.size) return;
  await patchBooks([...st.sel], { status: v }, "Updated"); st.sel.clear(); updateBulk(); render();
});
$("#bAll").addEventListener("click", () => { (st.lastList || []).slice(0, st.limit).forEach(id => st.sel.add(id)); updateBulk(); render(); });
$("#bDone").addEventListener("click", () => setSelecting(false));
$("#selBtn").addEventListener("click", () => setSelecting(!st.selecting));

/* ================= events ================= */
$("#main").addEventListener("click", async e => {
  const card = e.target.closest("[data-id]");
  if (card) {
    const id = card.dataset.id;
    if (st.selecting) { st.sel.has(id) ? st.sel.delete(id) : st.sel.add(id); card.classList.toggle("sel"); const cb = card.querySelector("input[type=checkbox]"); if (cb) cb.checked = st.sel.has(id); updateBulk(); return; }
    return openBook(id);
  }
  const roomEl = e.target.closest("[data-room]"); if (!roomEl) return;
  const room = roomEl.dataset.room;
  const go = e.target.closest("[data-go-shelf]");
  if (go) { Object.assign(st, { tab: "catalogue", room, shelf: go.dataset.goShelf, fix: "", q: "", genre: "", status: "", sort: "title" }); $("#q").value = ""; $("#fFix").value = ""; $("#fStatus").value = ""; $("#sort").value = "title"; render(); scrollTo(0, 0); return; }
  const act = e.target.closest("[data-act]")?.dataset.act;
  const edit = roomEl.querySelector("[data-edit]");
  const idsWhere = fn => [...books].filter(([, b]) => !b.deleted && fn(b)).map(([id]) => id);
  if (act === "rename-room" || act === "rename-shelf") {
    const shelf = e.target.closest("[data-shelf]")?.dataset.shelf;
    edit.hidden = false;
    edit.innerHTML = `<label class="sr" for="ren">New name</label><input id="ren" value="${esc(shelf || room)}"><button class="btn primary" type="button" data-act="do-rename">Rename</button>${shelf ? `<button class="btn danger" type="button" data-act="do-del-shelf">Remove shelf</button>` : ""}<button class="btn ghost" type="button" data-act="cancel-edit">Cancel</button>`;
    edit.dataset.shelf = shelf || ""; edit.querySelector("input").select(); return;
  }
  if (act === "cancel-edit") { edit.hidden = true; return; }
  if (act === "do-rename") {
    const v = edit.querySelector("input").value.trim(), shelf = edit.dataset.shelf; if (!v) return;
    ensureRoom(room); const r = house.rooms.find(x => x.name === room);
    if (shelf) { r.shelves = [...new Set(shelvesFor(room).map(s => s === shelf ? v : s))]; await saveHouse(); await patchBooks(idsWhere(b => b.room === room && b.shelf === shelf), { shelf: v }); }
    else { r.shelves = shelvesFor(room); r.name = v; house.rooms = house.rooms.filter((x, i, a) => a.findIndex(y => y.name === x.name) === i); await saveHouse(); await patchBooks(idsWhere(b => b.room === room), { room: v }); }
    toast("Renamed"); render(); return;
  }
  if (act === "do-del-shelf") {
    const shelf = edit.dataset.shelf; const r = house.rooms.find(x => x.name === room);
    if (r) r.shelves = r.shelves.filter(s => s !== shelf); await saveHouse();
    await patchBooks(idsWhere(b => b.room === room && b.shelf === shelf), { shelf: "" });
    toast("Shelf removed. Its books stay in the room."); render(); return;
  }
  if (act === "del-room") {
    const n = idsWhere(b => b.room === room).length;
    edit.hidden = false;
    edit.innerHTML = `<span style="font-size:14px">${n ? `Remove ${esc(room)}? Its ${n} books become unplaced.` : `Remove ${esc(room)}?`}</span><button class="btn danger armed" type="button" data-act="do-del-room">Remove room</button><button class="btn ghost" type="button" data-act="cancel-edit">Keep it</button>`; return;
  }
  if (act === "do-del-room") {
    house.rooms = house.rooms.filter(x => x.name !== room); await saveHouse();
    await patchBooks(idsWhere(b => b.room === room), { room: "", shelf: "" });
    toast("Room removed"); render(); return;
  }
});
$("#main").addEventListener("submit", async e => {
  e.preventDefault();
  if (e.target.id === "addRoom") { const v = $("#newRoom").value.trim(); if (!v) return; ensureRoom(v); await saveHouse(); toast(`Added ${v}`); render(); return; }
  const roomEl = e.target.closest("[data-room]"); if (!roomEl) return;
  const room = roomEl.dataset.room, v = e.target.querySelector("input").value.trim(); if (!v) return;
  ensureRoom(room); const r = house.rooms.find(x => x.name === room); r.shelves = shelvesFor(room);
  if (/^\d{1,2}$/.test(v)) { const n = Math.min(+v, 40); for (let i = 1; i <= n; i++) if (!r.shelves.includes("Shelf " + i)) r.shelves.push("Shelf " + i); }
  else if (!r.shelves.includes(v)) r.shelves.push(v);
  await saveHouse(); render();
});
function goTab(t) {
  st.tab = t; st.limit = 240; Object.assign(st, { room: "", shelf: "", genre: "", status: "", fix: "" }); $("#fFix").value = ""; $("#fStatus").value = "";
  if (st.selecting) setSelecting(false); render(); scrollTo(0, 0);
}
document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => goTab(b.dataset.tab)));
$("#setBtn").addEventListener("click", () => goTab("settings"));
$("#syncPill").addEventListener("click", () => conn ? runSync(true) : goTab("settings"));
let qT; $("#q").addEventListener("input", e => { clearTimeout(qT); qT = setTimeout(() => { st.q = e.target.value.trim(); st.limit = 240; render(); }, 150); });
$("#fRoom").addEventListener("change", e => { st.room = e.target.value; st.shelf = ""; st.limit = 240; render(); });
$("#fShelf").addEventListener("change", e => { st.shelf = e.target.value; render(); });
$("#fGenre").addEventListener("change", e => { st.genre = e.target.value; render(); });
$("#fStatus").addEventListener("change", e => { st.status = e.target.value; render(); });
$("#fFix").addEventListener("change", e => { st.fix = e.target.value; render(); });
$("#sort").addEventListener("change", e => { st.sort = e.target.value; render(); });
const setView = v => { st.view = v; idb.put("kv", v, "view"); render(); };
$("#vGrid").addEventListener("click", () => setView("grid"));
$("#vList").addEventListener("click", () => setView("list"));
$("#addBtn").addEventListener("click", () => openBook(null));
$("#filtBtn").addEventListener("click", () => { const f = $("#filters"), open = !f.classList.contains("open"); f.classList.toggle("open", open); $("#filtBtn").setAttribute("aria-expanded", open); });
window.addEventListener("online", () => scheduleSync(500));
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", applySettings);

/* Hooks the Android shell calls */
window.__back = () => {
  if ($("#drawer").open) { closeDrawer(); return true; }
  if (st.selecting) { setSelecting(false); return true; }
  if (st.q || st.room || st.genre || st.status || st.fix) { Object.assign(st, {q: "", room: "", shelf: "", genre: "", status: "", fix: ""}); $("#q").value = ""; $("#fStatus").value = ""; $("#fFix").value = ""; render(); return true; }
  if (st.tab !== "catalogue") { goTab("catalogue"); return true; }
  return false;
};
window.__resume = () => { renderSync(); scheduleSync(800); };

/* ================= boot ================= */
(async () => {
  try {
    const [all, h, c, s, last, rd, view] = await Promise.all([idb.all("books"), idb.get("kv", "house"), idb.get("kv", "conn"), idb.get("kv", "settings"), idb.get("kv", "lastSync"), idb.get("kv", "roomsDirty"), idb.get("kv", "view")]);
    all.forEach(b => books.set(b.id, b));
    if (h) house = h; if (c) conn = c; if (s) settings = { ...settings, ...s }; if (last) sync.last = last; roomsDirty = !!rd;
    if (view === "list" || view === "grid") st.view = view;
  } catch (e) { toast("Couldn't open this device's saved catalogue."); }
  applySettings();
  loaded = !conn || books.size > 0;
  render();
  if (conn) runSync();
})();
})();
