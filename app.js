/* =========================================================================
   After-Hours Coverage Board  —  static, browser-editable
   -------------------------------------------------------------------------
   Left panel  : Room Assignments (Room | Attending | Current Staff | 5PM | Dinner)
   Right panel : Rosters
     - Attendings (Role | Attendings | Rooms)
     - Residents  (Role | Residents  | Room)
     - CRNAs      (CRNAs | Room)
   Data is stored per-table in localStorage. Save/Load JSON moves a master
   copy between people/browsers.
   ========================================================================= */

/* ----- Access gate (NOT secure — deters casual viewers only). Change this.
   Set to "" to disable the login entirely.                                  */
const PASSPHRASE = "cornellteamleader";

const UPDATED_KEY = "coverageBoard.updated.v1";

/* Canonical room list — the board always shows exactly these rooms, in this
   order. Edit here to add/remove/reorder rooms. IR sub-rooms and NICU are
   filled from the PDF's person→room directory (see pdf-import.js). */
const ROOMS_CANON = [
  ...Array.from({ length: 23 }, (_, i) => "G" + (i + 1)),
  ...Array.from({ length: 15 }, (_, i) => "A" + (i + 1)),
  "K908", "K910", "K914", "IVF", "M8", "PUPS",
  "Gi 1", "Gi 2.3", "Gi 4", "Gi 5", "Gi Bronch", "Rad Onc", "Burn Tank",
  "EP1", "EP2", "EP3", "Cardioversion", "TEE", "INR 1", "INR 2",
  "IR Angio 1", "IR Angio 2", "IR Angio 3", "IR CT1", "IR CT2",
  "MRI", "NICU", "ECT",
];

/* ------------------------------ Table config --------------------------- */
const TABLES = {
  main: {
    title: "Room Assignments",
    storageKey: "coverageBoard.main.v3",
    columns: [
      { key: "room",      label: "Room",          cls: "col-service" },
      { type: "past8",    label: "Past 8pm?",     cond: "past8" },
      { key: "attending", label: "Attending" },
      { key: "staff",     label: "Current Staff" },
      { type: "arrow",    label: "" },
      { key: "fivepm",    label: "5:00 PM" },
      { key: "eightpm",   label: "8:00 PM",       cond: "show8pm" },
      { key: "dinner",    label: "Dinner" },
      { type: "spacer",   label: "" },
    ],
    seed() {
      return ROOMS_CANON.map((r) => blank(this.columns, { room: r, status: "ongoing" }));
    },
  },
  attendings: {
    title: "Attendings",
    storageKey: "coverageBoard.attendings.v2",
    columns: [
      { key: "role",  label: "Role" },
      { key: "name",  label: "Attendings" },
      { key: "rooms", label: "Rooms" },
    ],
    seed() {
      const roles = ["S1", "S2", "S3 Gen", "S3 Peds", "S3 Neuro", "S3 Pain", "S4", "Liver", "ML"];
      return roles.map((r) => blank(this.columns, { role: r }));
    },
  },
  residents: {
    title: "Residents",
    storageKey: "coverageBoard.residents.v2",
    columns: [
      { key: "role", label: "Role" },
      { key: "name", label: "Residents" },
      { key: "room", label: "Room" },
      { type: "dinner", label: "Dinner", cond: "dinner" },
    ],
    seed() {
      const roles = ["S1", "S2", "S4", "S5", "R1", "R2", "R3", "R4", "R5", "R6/ML"];
      return roles.map((r) => blank(this.columns, { role: r }));
    },
  },
  crnas: {
    title: "CRNAs",
    storageKey: "coverageBoard.crnas.v2",
    columns: [
      { key: "name", label: "CRNAs" },
      { key: "room", label: "Room" },
      { type: "dinner", label: "Dinner", cond: "dinner" },
    ],
    seed() {
      return Array.from({ length: 6 }, () => blank(this.columns));
    },
  },
};
const TABLE_IDS = Object.keys(TABLES);

function blank(columns, overrides = {}) {
  const o = {};
  columns.forEach((c) => { if (c.key) o[c.key] = ""; });
  return Object.assign(o, overrides);
}
function dataCols(cfg) { return cfg.columns.filter((c) => c.key); }

/* ------------------------------ State ---------------------------------- */
const data = {}; // { main: [...], attendings: [...], ... }

function loadTable(id) {
  const cfg = TABLES[id];
  try {
    const raw = localStorage.getItem(cfg.storageKey);
    const arr = raw ? JSON.parse(raw) : cfg.seed();
    data[id] = Array.isArray(arr) ? arr : cfg.seed();
  } catch {
    data[id] = cfg.seed();
  }
}

function saveTable(id) {
  localStorage.setItem(TABLES[id].storageKey, JSON.stringify(data[id]));
  touch();
  if (window.CloudSync) window.CloudSync.save();
  recordHistory();
}

/* Apply a board pulled from the cloud into local state (no re-upload). */
function applyRemote(remote) {
  if (!remote) return;
  suppressHistory = true;
  TABLE_IDS.forEach((id) => {
    if (Array.isArray(remote[id])) {
      data[id] = remote[id].map((r) => blank(TABLES[id].columns, r));
      localStorage.setItem(TABLES[id].storageKey, JSON.stringify(data[id]));
    }
  });
  if (remote.directory) {
    window.DIRECTORY = remote.directory;
    localStorage.setItem("coverageBoard.directory.v1", JSON.stringify(remote.directory));
  }
  if (typeof remote.notes === "string") {
    localStorage.setItem("coverageBoard.notes.v1", remote.notes);
    const ta = document.getElementById("notes");
    if (ta) ta.value = remote.notes;
  }
  ensureRoomDefaults();
  localStorage.setItem(UPDATED_KEY, remote.savedAt || new Date().toISOString());
  renderAll();
  renderStats();
  suppressHistory = false;
  initHistory(); // undo baseline = the board we just loaded
}

function touch() {
  localStorage.setItem(UPDATED_KEY, new Date().toISOString());
  renderUpdated();
  if (typeof renderStats === "function") renderStats();
}

function loadAll() { TABLE_IDS.forEach(loadTable); }

/* Rooms with no status yet default to green (case ongoing). */
function ensureRoomDefaults() {
  let changed = false;
  data.main.forEach((r) => { if (r.status === undefined) { r.status = "ongoing"; changed = true; } });
  if (changed) localStorage.setItem(TABLES.main.storageKey, JSON.stringify(data.main));
}

/* ------------------------------ Rendering ------------------------------ */
function tableEl(id) { return document.querySelector(`table[data-table="${id}"]`); }

function searchValue() {
  const el = document.getElementById("search");
  return el ? el.value.trim().toLowerCase() : "";
}

function renderTable(id) {
  const cfg = TABLES[id];
  const el = tableEl(id);
  if (!el) return;
  const thead = el.querySelector("thead");
  const tbody = el.querySelector("tbody");
  const filter = searchValue();

  // Header
  thead.innerHTML = "";
  const htr = document.createElement("tr");
  cfg.columns.forEach((c) => {
    if (!colVisible(c)) return;
    const th = document.createElement("th");
    th.textContent = c.label;
    if (c.type === "past8" || c.type === "dinner" || c.type === "arrow") th.className = "check-head";
    if (c.type === "spacer") th.className = "spacer-col";
    htr.appendChild(th);
  });
  const actTh = document.createElement("th");
  actTh.className = "row-actions-head";
  htr.appendChild(actTh);
  thead.appendChild(htr);

  // Body
  tbody.innerHTML = "";
  data[id].forEach((row, idx) => {
    if (filter) {
      const hay = dataCols(cfg).map((c) => row[c.key] || "").join(" ").toLowerCase();
      if (!hay.includes(filter)) return;
    }
    const tr = document.createElement("tr");
    cfg.columns.forEach((c) => {
      if (!colVisible(c)) return;
      if (c.type === "spacer") { const td = document.createElement("td"); td.className = "spacer-col"; tr.appendChild(td); return; }
      if (id === "main" && c.key === "room") { tr.appendChild(renderRoomCell(idx, data[id][idx])); return; }
      if (c.type === "arrow") {
        const td = document.createElement("td");
        td.className = "arrow-cell";
        const btn = document.createElement("button");
        btn.className = "arrow-btn";
        btn.type = "button";
        btn.title = "Copy current staff into 5:00 PM";
        btn.textContent = "➡";
        btn.addEventListener("click", () => copyStaffTo5pm(idx));
        td.appendChild(btn);
        tr.appendChild(td);
        return;
      }
      if (c.type === "past8") {
        const td = document.createElement("td");
        td.className = "check-cell";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!data.main[idx].past8;
        cb.title = "Will this room run past 8 PM?";
        cb.addEventListener("change", () => setRoomMeta(idx, "past8", cb.checked));
        td.appendChild(cb);
        tr.appendChild(td);
        return;
      }
      if (c.type === "dinner") {
        const td = document.createElement("td");
        td.className = "check-cell";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!data[id][idx].dinner;
        cb.title = "Getting dinner";
        cb.addEventListener("change", () => { data[id][idx].dinner = cb.checked; saveTable(id); });
        td.appendChild(cb);
        tr.appendChild(td);
        return;
      }
      const td = document.createElement("td");
      td.contentEditable = "true";
      td.dataset.table = id;
      td.dataset.idx = idx;
      td.dataset.key = c.key;
      if (c.cls) td.classList.add(c.cls);
      const val = row[c.key] || "";
      td.textContent = val;
      if (!val) td.classList.add("empty");
      if (id === "main" && (c.key === "attending" || c.key === "fivepm")) {
        const lbl = cellRoleLabel(c.key, val);
        if (lbl) td.dataset.role = lbl;
      }
      if (id === "main" && c.key === "attending" && row.origAttending) {
        td.title = "Originally: " + row.origAttending;
      }
      if (id === "crnas" && c.key === "name" && row.stuck) td.dataset.role = "stuck";
      // Reflect room state into the roster panels:
      // - staff in a closing (yellow) room -> yellow highlight
      // - a room's specialty color -> highlight its room number in the panels
      if ((id === "residents" || id === "crnas") && c.key === "name" && row.room && roomInfo(row.room).status === "closing") {
        td.classList.add("roster-closing");
      }
      if ((id === "residents" || id === "crnas") && c.key === "room" && val) {
        const t = roomInfo(val).tag; if (t) td.classList.add("tag-" + t);
      }
      if (id === "attendings" && c.key === "rooms" && val) {
        for (const rm of cellNames(val)) { const t = roomInfo(rm).tag; if (t) { td.classList.add("tag-" + t); break; } }
      }
      // Attending covering exactly one room -> light green + that room under the name
      if (id === "attendings" && c.key === "name") {
        const rms = cellNames(row.rooms);
        if (rms.length === 1) { td.classList.add("roster-light-green"); td.dataset.role = rms[0]; }
      }
      // Free (unassigned) resident/CRNA -> light green if on call, regular green if not
      if (id === "residents" && c.key === "name" && row.name && !(row.room || "").trim()) {
        td.classList.add(/^R6/i.test((row.role || "").trim()) ? "roster-green" : "roster-light-green");
      }
      if (id === "crnas" && c.key === "name" && row.name && !(row.room || "").trim()) {
        td.classList.add(row.stuck ? "roster-green" : "roster-light-green");
      }
      tr.appendChild(td);
    });
    const act = document.createElement("td");
    act.className = "row-actions";
    const del = document.createElement("button");
    del.className = "del-btn";
    del.type = "button";
    del.title = "Delete row";
    del.textContent = "✕";
    del.addEventListener("click", () => deleteRow(id, idx));
    act.appendChild(del);
    tr.appendChild(act);
    tbody.appendChild(tr);
  });
}

function renderAll() {
  TABLE_IDS.forEach(renderTable);
  renderUpdated();
}

function renderUpdated() {
  const el = document.getElementById("lastUpdated");
  if (!el) return;
  const iso = localStorage.getItem(UPDATED_KEY);
  if (!iso) { el.textContent = "—"; return; }
  el.textContent = new Date(iso).toLocaleString([], {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

/* ------------------------------ Editing -------------------------------- */
function onEdit(e) {
  const td = e.target;
  if (!(td instanceof HTMLTableCellElement) || !td.dataset.table) return;
  const { table, idx, key } = td.dataset;
  const value = td.textContent.replace(/ /g, " ").trim();
  const arr = data[table];
  if (arr && arr[idx]) {
    arr[idx][key] = value;
    td.classList.toggle("empty", value === "");
    saveTable(table);
    if (table === "main" && (key === "attending" || key === "fivepm")) {
      const lbl = cellRoleLabel(key, value);
      if (lbl) td.dataset.role = lbl; else td.removeAttribute("data-role");
    }
    if (e.type === "blur" && table === "main" && key === "dinner") updateDinnerFlags();
    if (e.type === "blur" && table === "main" && (key === "attending" || key === "fivepm")) autoSync5pm();
  }
}

function addRow(id) {
  data[id].push(blank(TABLES[id].columns));
  saveTable(id);
  renderTable(id);
  const rows = tableEl(id).querySelectorAll("tbody tr");
  const last = rows[rows.length - 1];
  if (last) last.querySelector("td").focus();
}

function deleteRow(id, idx) {
  const row = data[id][idx];
  const label = row && (row.room || row.name) ? ` "${row.room || row.name}"` : "";
  if (!confirm(`Delete this row${label}?`)) return;
  const deletedRoom = id === "main" ? row.room : null;
  data[id].splice(idx, 1);
  saveTable(id);
  renderTable(id);
  if (deletedRoom) removeRoomFromRosters(deletedRoom);
}

/* When a room is deleted, drop it from the attendings' rooms and clear it from
   any resident/CRNA who was assigned there. */
function removeRoomFromRosters(room) {
  const key = normRoomKey(room);
  if (!key) return;
  let a = false, r = false, c = false;
  data.attendings.forEach((row) => {
    const kept = cellNames(row.rooms).filter((rm) => normRoomKey(rm) !== key).join(", ");
    if (kept !== (row.rooms || "")) { row.rooms = kept; a = true; }
  });
  data.residents.forEach((row) => { if (row.room && normRoomKey(row.room) === key) { row.room = ""; r = true; } });
  data.crnas.forEach((row) => { if (row.room && normRoomKey(row.room) === key) { row.room = ""; c = true; } });
  if (a) saveTable("attendings");
  if (r) saveTable("residents");
  if (c) saveTable("crnas");
  renderAll();
  renderStats();
}

/* ------------------------------ Import / Export ------------------------ */
function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function csvEscape(v) {
  v = String(v ?? "");
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function exportCsv() {
  const cols = dataCols(TABLES.main);
  const header = cols.map((c) => csvEscape(c.label)).join(",");
  const body = data.main.map((r) => cols.map((c) => csvEscape(r[c.key])).join(",")).join("\n");
  download(`coverage-board-${stamp()}.csv`, header + "\n" + body, "text/csv");
}

function exportJson() {
  const tables = {};
  TABLE_IDS.forEach((id) => (tables[id] = data[id]));
  const payload = { version: 2, savedAt: new Date().toISOString(), tables };
  download(`coverage-board-${stamp()}.json`, JSON.stringify(payload, null, 2), "application/json");
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const tables = parsed.tables || (Array.isArray(parsed) ? { main: parsed } : (Array.isArray(parsed.rows) ? { main: parsed.rows } : null));
      if (!tables) throw new Error("No table data found");
      if (!confirm("Load this file? It replaces the current board in this browser.")) return;
      TABLE_IDS.forEach((id) => {
        if (Array.isArray(tables[id])) {
          data[id] = tables[id].map((r) => blank(TABLES[id].columns, r));
          saveTable(id);
        }
      });
      renderAll();
    } catch (err) {
      alert("Could not read that file: " + err.message);
    }
  };
  reader.readAsText(file);
}

function coerce(r, columns) {
  const o = {};
  columns.forEach((c) => { if (c.key) o[c.key] = r[c.key] != null ? String(r[c.key]) : ""; });
  return o;
}

function resetBoard() {
  if (!confirm("Reset every table to its defaults? This clears current data in this browser.")) return;
  TABLE_IDS.forEach((id) => {
    data[id] = TABLES[id].seed();
    saveTable(id);
  });
  renderAll();
}

/* ========================= Room indicators ============================ */
const TAGS = ["Pediatric", "Neuro", "Thoracic", "Cardiac"];
const TAG_SWATCH = { Pediatric: "#8ec7ff", Neuro: "#c9a9ee", Thoracic: "#ffc07a", Cardiac: "#ff9a9a" };

function renderRoomCell(idx, row) {
  const td = document.createElement("td");
  td.className = "room-cell col-service";
  if (row.tag) td.classList.add("tag-" + row.tag);
  if (row.status) td.classList.add("status-" + row.status);
  if (row.past8) td.classList.add("past8");

  const top = document.createElement("div");
  top.className = "room-top";

  const dot = document.createElement("button");
  dot.className = "status-dot";
  dot.type = "button";
  dot.title = "Set case status";
  dot.addEventListener("click", (e) => {
    e.stopPropagation();
    openMenu(dot, [
      { label: "Ongoing", swatch: "#2ecc71", onClick: () => setRoomMeta(idx, "status", "ongoing") },
      { label: "Closing", swatch: "#f1c40f", onClick: () => setRoomMeta(idx, "status", "closing") },
      { label: "Clear", onClick: () => setRoomMeta(idx, "status", "") },
    ]);
  });

  const name = document.createElement("span");
  name.className = "room-name";
  name.textContent = row.room;
  name.title = "Set specialty";
  name.addEventListener("click", (e) => {
    e.stopPropagation();
    openMenu(name, TAGS.map((t) => ({ label: t, swatch: TAG_SWATCH[t], onClick: () => setRoomMeta(idx, "tag", t) }))
      .concat([{ label: "Clear", onClick: () => setRoomMeta(idx, "tag", "") }]));
  });

  top.append(dot, name);
  if (row.past8) { const b = document.createElement("span"); b.className = "past8-badge"; b.textContent = "⏰"; b.title = "Past 8 PM"; top.appendChild(b); }
  td.appendChild(top);

  if (row.tag) { const tg = document.createElement("div"); tg.className = "room-tag"; tg.textContent = row.tag; td.appendChild(tg); }
  return td;
}

function setRoomMeta(idx, field, value) {
  if (!data.main[idx]) return;
  data.main[idx][field] = value;
  saveTable("main");
  renderAll(); // rooms + rosters (status/tag highlights reflect into the panels)
  renderStats();
}

function togglePast8Mode() {
  document.body.classList.toggle("past8-mode");
  const b = document.getElementById("past8Btn");
  if (b) b.classList.toggle("active", document.body.classList.contains("past8-mode"));
  renderTable("main");
}

/* ---- Conditional columns ---- */
let show8pm = false;
function colVisible(c) {
  if (c.cond === "past8") return document.body.classList.contains("past8-mode");
  if (c.cond === "show8pm") return show8pm;
  if (c.cond === "dinner") return document.body.classList.contains("dinner-mode");
  return true;
}
function toggleDinnerMode() {
  document.body.classList.toggle("dinner-mode");
  const b = document.getElementById("dinnerBtn");
  if (b) b.classList.toggle("active", document.body.classList.contains("dinner-mode"));
  renderTable("residents");
  renderTable("crnas");
}
function set8pm(v) {
  show8pm = v;
  localStorage.setItem("coverageBoard.show8pm.v1", v ? "1" : "0");
  document.body.classList.toggle("show8pm-on", v);
  const b = document.getElementById("start8pmBtn");
  if (b) { b.textContent = v ? "Hide 8 PM column" : "Start 8 PM column"; b.classList.toggle("active", v); }
  const u8 = document.getElementById("updateFrom8pm");
  if (u8) u8.hidden = !v; // only relevant once the 8 PM column exists
  renderTable("main");
}
function toggle8pm() {
  const turningOn = !show8pm;
  set8pm(!show8pm);
  if (turningOn) fill8pmFromOnCall();
}
/* When the 8 PM column is created, move on-call residents from 5 PM into 8 PM. */
function fill8pmFromOnCall() {
  const onCallRes = data.residents.filter((r) => r.name && !/^R6/i.test((r.role || "").trim())).map((r) => r.name);
  let n = 0;
  data.main.forEach((r) => {
    const keep = cellNames(r.fivepm).filter((name) => onCallRes.some((c) => nameMatch(c, name)));
    if (keep.length) { r.eightpm = keep.join(", "); n++; }
  });
  saveTable("main");
  renderTable("main");
  renderStats();
  toast(`Moved on-call residents into 8 PM for ${n} room${n === 1 ? "" : "s"}.`);
}

/* ---- Dinner: auto-check staff whose room has a dinner giver ---- */
function updateDinnerFlags() {
  const dinnerRooms = data.main.filter((r) => (r.dinner || "").trim());
  const inDinnerRoom = (name) => dinnerRooms.some((r) =>
    cellNames(r.staff).some((n) => nameMatch(n, name)) ||
    cellNames(r.fivepm).some((n) => nameMatch(n, name)) ||
    cellNames(r.eightpm).some((n) => nameMatch(n, name)));
  ["residents", "crnas"].forEach((id) => {
    let changed = false;
    data[id].forEach((row) => { if (row.name && !row.dinner && inDinnerRoom(row.name)) { row.dinner = true; changed = true; } });
    if (changed) { saveTable(id); renderTable(id); }
  });
}

/* ---- Delete rooms with no attending and no staff ---- */
function deleteEmptyRooms() {
  const kept = data.main.filter((r) => (r.attending || "").trim() || (r.staff || "").trim());
  const removed = data.main.length - kept.length;
  if (!removed) { toast("No empty rooms to delete."); return; }
  if (!confirm(`Delete ${removed} empty room${removed === 1 ? "" : "s"} (no attending or staff)?`)) return;
  data.main = kept;
  saveTable("main");
  renderTable("main");
  renderStats();
  toast(`Deleted ${removed} empty room${removed === 1 ? "" : "s"}.`);
}

/* ---- Add residents assigned at 5 PM but not on call, as role R6 ---- */
function syncStuckResidents() {
  const dirRes = (window.DIRECTORY && window.DIRECTORY.residents) || [];
  const inRoster = (name) => data.residents.some((r) => r.name && nameMatch(r.name, name));
  let added = false;
  data.main.forEach((r) => {
    cellNames(r.fivepm).forEach((name) => {
      if (dirRes.some((d) => nameMatch(d, name)) && !inRoster(name)) {
        data.residents.push(blank(TABLES.residents.columns, { role: "R6", name, room: r.room }));
        added = true;
      }
    });
  });
  if (added) { saveTable("residents"); renderTable("residents"); renderStats(); }
}

/* ---- Add non-late CRNAs sitting in a 5 PM slot to the CRNA panel as "stuck" ---- */
function syncStuckCrnas() {
  const dirCrnas = (window.DIRECTORY && window.DIRECTORY.crnas) || [];
  const inPanel = (name) => data.crnas.some((r) => r.name && nameMatch(r.name, name));
  let added = false;
  data.main.forEach((r) => {
    cellNames(r.fivepm).forEach((name) => {
      if (dirCrnas.some((d) => nameMatch(d, name)) && !inPanel(name)) {
        data.crnas.push(blank(TABLES.crnas.columns, { name, room: r.room, stuck: true }));
        added = true;
      }
    });
  });
  if (added) { saveTable("crnas"); renderTable("crnas"); renderStats(); }
}
function syncStuckStaff() { syncStuckResidents(); syncStuckCrnas(); }

/* ---- Add a room via prompt, inserted in canonical order ---- */
function normRoomKey(s) { return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function roomInfo(name) {
  const r = data.main.find((m) => normRoomKey(m.room) === normRoomKey(name));
  return r ? { tag: r.tag || "", status: r.status || "" } : { tag: "", status: "" };
}
function canonIndex(room) {
  const key = normRoomKey(room);
  const i = ROOMS_CANON.findIndex((c) => normRoomKey(c) === key);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}
function insertRoomSorted(room) {
  const idx = canonIndex(room);
  let pos = data.main.findIndex((m) => canonIndex(m.room) > idx);
  if (pos === -1) pos = data.main.length;
  data.main.splice(pos, 0, blank(TABLES.main.columns, { room, status: "ongoing" }));
  saveTable("main");
  renderTable("main");
  renderStats();
}
function addRoomPrompt() {
  const name = prompt("Room number / name (e.g. G10):");
  if (name == null) return;
  const room = name.trim();
  if (room) insertRoomSorted(room);
}

/* ---- Bottom notes area ---- */
function initNotes() {
  const ta = document.getElementById("notes");
  if (!ta) return;
  ta.value = localStorage.getItem("coverageBoard.notes.v1") || "";
  ta.addEventListener("input", () => {
    localStorage.setItem("coverageBoard.notes.v1", ta.value);
    if (window.CloudSync) window.CloudSync.save();
    recordHistory();
  });
}

/* ---- Lightweight popup menu ---- */
function closeMenu() { const m = document.getElementById("popmenu"); if (m) m.remove(); }
function openMenu(anchor, items) {
  closeMenu();
  const m = document.createElement("div");
  m.id = "popmenu";
  m.className = "popmenu";
  items.forEach((it) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "popitem";
    b.innerHTML = `<span class="sw"${it.swatch ? ` style="background:${it.swatch}"` : ' data-clear="1"'}></span><span>${it.label}</span>`;
    b.addEventListener("click", (e) => { e.stopPropagation(); it.onClick(); closeMenu(); });
    m.appendChild(b);
  });
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 170) + "px";
  m.style.top = (r.bottom + 4) + "px";
  setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0);
}

/* ============================ Undo history ============================ */
const MAX_HISTORY = 11; // current state + up to 10 undos
let history = [];
let historyTimer = null;
let suppressHistory = false;

function serializeState() {
  return JSON.stringify({
    main: data.main, attendings: data.attendings, residents: data.residents, crnas: data.crnas,
    notes: localStorage.getItem("coverageBoard.notes.v1") || "",
  });
}
function initHistory() {
  clearTimeout(historyTimer);
  history = [serializeState()];
  updateUndoButton();
}
function recordHistory() {
  if (suppressHistory) return;
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    const s = serializeState();
    if (history.length && history[history.length - 1] === s) return;
    history.push(s);
    if (history.length > MAX_HISTORY) history.shift();
    updateUndoButton();
  }, 500);
}
function applyState(s) {
  suppressHistory = true;
  TABLE_IDS.forEach((id) => {
    if (Array.isArray(s[id])) { data[id] = s[id].map((r) => blank(TABLES[id].columns, r)); saveTable(id); }
  });
  if (typeof s.notes === "string") {
    localStorage.setItem("coverageBoard.notes.v1", s.notes);
    const ta = document.getElementById("notes"); if (ta) ta.value = s.notes;
  }
  renderAll(); renderStats();
  suppressHistory = false;
}
function undo() {
  clearTimeout(historyTimer);
  const cur = serializeState();
  if (!history.length || history[history.length - 1] !== cur) {
    history.push(cur); if (history.length > MAX_HISTORY) history.shift(); // commit uncommitted edits first
  }
  if (history.length < 2) { toast("Nothing to undo."); return; }
  history.pop();
  applyState(JSON.parse(history[history.length - 1]));
  updateUndoButton();
  toast("Undid last change.");
}
function updateUndoButton() {
  const b = document.getElementById("undoBtn");
  if (b) b.disabled = history.length < 2;
}

/* ============================ Workflow tools =========================== */
/* ---- Name matching across sources (grid initials vs directory surnames) */
function normName(s) { return String(s || "").toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z]/g, ""); }
function nameMatch(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Allow a short leading initial prefix, e.g. "Vu" ≈ "DVu", "Scarpa" ≈ "JuScarpa".
  if (na.endsWith(nb) && na.length - nb.length <= 2) return true;
  if (nb.endsWith(na) && nb.length - na.length <= 2) return true;
  return false;
}
function cellNames(cell) {
  return String(cell || "").split(",").map((s) => s.replace(/\([^)]*\)/g, "").trim()).filter(Boolean);
}
function rosterNames(id) { return data[id].map((r) => r.name).filter(Boolean); }

/* ---- Role sub-labels shown in italics under a name ---- */
function lookupRole(tableId, name) {
  const row = data[tableId].find((r) => r.name && nameMatch(r.name, name));
  return row ? (row.role || "") : "";
}
function staffRoleLabel(name) {
  const res = data.residents.find((r) => r.name && nameMatch(r.name, name));
  if (res) return /^R6/i.test((res.role || "").trim()) ? "stuck" : (res.role || "");
  const crn = data.crnas.find((r) => r.name && nameMatch(r.name, name));
  if (crn) return crn.stuck ? "CRNA-stuck" : "CRNA - 8pm";
  const dirC = (window.DIRECTORY && window.DIRECTORY.crnas) || [];
  if (dirC.some((c) => nameMatch(c, name))) return "CRNA";
  return "";
}
function cellRoleLabel(key, cellValue) {
  const names = cellNames(cellValue);
  if (!names.length) return "";
  const labels = names.map((n) => (key === "attending" ? lookupRole("attendings", n) : staffRoleLabel(n)));
  return [...new Set(labels.filter(Boolean))].join(", ");
}
function uniqNames(list) { const out = []; list.forEach((n) => { if (!out.some((o) => nameMatch(o, n))) out.push(n); }); return out; }

/* ---- Per-row arrow: copy Current Staff -> 5:00 PM ---- */
function copyStaffTo5pm(idx) {
  const r = data.main[idx];
  if (!r) return;
  r.fivepm = r.staff || "";
  saveTable("main");
  renderTable("main");
  renderStats();
  autoSync5pm();
}

/* ---- Auto-fill 5 PM from on-call residents/CRNAs already in the room ---- */
function fill5pmFromOnCall() {
  const onCall = [...rosterNames("residents"), ...rosterNames("crnas")];
  let n = 0;
  data.main.forEach((r) => {
    const cont = cellNames(r.staff).filter((name) => onCall.some((c) => nameMatch(c, name)));
    if (cont.length) { r.fivepm = cont.join(", "); n++; }
  });
  saveTable("main");
  renderTable("main");
  renderStats();
  autoSync5pm();
  toast(`Filled 5 PM for ${n} room${n === 1 ? "" : "s"} (on-call staff).`);
}

/* ---- Transfer stuck residents into 5 PM: residents who are NOT on call but
   are currently in a room. Merged into the 5 PM cell and pulled into the
   Residents panel as R6 (never overwrites who's already in 5 PM). */
function transferStuckResidents() {
  const dirRes = (window.DIRECTORY && window.DIRECTORY.residents) || [];
  const onCall = data.residents.filter((r) => r.name && !/^R6/i.test((r.role || "").trim())).map((r) => r.name);
  let n = 0;
  data.main.forEach((r) => {
    const stuck = cellNames(r.staff).filter((name) =>
      dirRes.some((d) => nameMatch(d, name)) && !onCall.some((c) => nameMatch(c, name))
    );
    if (!stuck.length) return;
    const merged = cellNames(r.fivepm);
    let added = false;
    stuck.forEach((name) => { if (!merged.some((m) => nameMatch(m, name))) { merged.push(name); added = true; } });
    if (added) { r.fivepm = merged.join(", "); n++; }
  });
  saveTable("main");
  renderTable("main");
  renderStats();
  autoSync5pm();
  toast(`Transferred stuck residents into 5 PM for ${n} room${n === 1 ? "" : "s"}.`);
}

/* ---- Transfer on-call staff into 5 PM: on-call residents (S1/S2/S4/S5/R1-R5,
   i.e. every roster resident that isn't an R6 pull-in) plus the late CRNAs. */
function transferOnCallStaff() {
  const onCallRes = data.residents.filter((r) => r.name && !/^R6/i.test((r.role || "").trim())).map((r) => r.name);
  const pool = [...onCallRes, ...rosterNames("crnas")];
  let n = 0;
  data.main.forEach((r) => {
    const keep = cellNames(r.staff).filter((name) => pool.some((c) => nameMatch(c, name)));
    if (keep.length) { r.fivepm = keep.join(", "); n++; }
  });
  saveTable("main");
  renderTable("main");
  renderStats();
  autoSync5pm();
  toast(`Transferred on-call staff into 5 PM for ${n} room${n === 1 ? "" : "s"}.`);
}

/* ---- Remove attendings not on the Attendings (call) roster ---- */
function removeNonCallAttendings() {
  const call = rosterNames("attendings");
  let removed = 0;
  data.main.forEach((r) => {
    const kept = cellNames(r.attending).filter((name) => call.some((c) => nameMatch(c, name)));
    if (kept.length !== cellNames(r.attending).length) removed++;
    r.attending = kept.join(", ");
  });
  saveTable("main");
  renderTable("main");
  renderStats();
  toast(`Removed non-call attendings from ${removed} room${removed === 1 ? "" : "s"}.`);
}

/* ---- Autofill roster room columns from the Room Assignments ---- */
function updateRostersFromRooms(source, silent) {
  source = source === "eightpm" ? "eightpm" : "fivepm";
  syncStuckStaff(); // pull in any non-call residents/CRNAs sitting in a 5 PM slot
  data.attendings.forEach((row) => {
    if (!row.name) return;
    const rooms = data.main.filter((m) => cellNames(m.attending).some((n) => nameMatch(n, row.name))).map((m) => m.room);
    row.rooms = [...new Set(rooms)].join(", ");
  });
  // A resident/CRNA's room = where they are in the chosen column (5 PM or 8 PM).
  const findRoom = (name) => {
    const m = data.main.find((mm) => cellNames(mm[source]).some((n) => nameMatch(n, name)));
    return m ? m.room : "";
  };
  data.residents.forEach((row) => { if (row.name) row.room = findRoom(row.name); });
  data.crnas.forEach((row) => { if (row.name) { const r = findRoom(row.name); if (r) row.room = r; } });
  saveTable("attendings"); saveTable("residents"); saveTable("crnas");
  updateDinnerFlags();
  renderAll(); renderStats();
  if (!silent) toast(source === "eightpm" ? "Rosters updated from 8 PM." : "Rosters updated from 5 PM.");
}
function autoSync5pm() { updateRostersFromRooms("fivepm", true); }

/* ---- Copy assignments to clipboard ---- */
function copyText(text, label) {
  const done = () => toast((label || "Copied") + " — paste anywhere.");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); done(); } catch { alert(text); }
  ta.remove();
}
function copyAttendingAssignments() {
  const lines = data.attendings.filter((r) => r.name).map((r) => [r.role, r.name, r.rooms].filter(Boolean).join(" "));
  copyText(lines.join("\n"), `Copied ${lines.length} attending assignments`);
}
function copyStaffAssignments() {
  const res = data.residents.filter((r) => r.name).map((r) => [r.role, r.name, r.room].filter(Boolean).join(" "));
  const crn = data.crnas.filter((r) => r.name).map((r) => [r.name, r.room].filter(Boolean).join(" "));
  const lines = [...res, ...crn];
  copyText(lines.join("\n"), `Copied ${lines.length} staff assignments`);
}

/* ---- Stat bar ---- */
function renderStats() {
  const bar = document.getElementById("statsBar");
  if (!bar) return;
  const dir = (window.DIRECTORY) || { residents: [] };

  const roomsGoing = data.main.filter((r) => (r.attending || "").trim() || (r.staff || "").trim()).length;
  const attOnCall = rosterNames("attendings").length;
  const crnaRows = data.crnas.filter((r) => r.name);
  const crnaStuck = crnaRows.filter((r) => r.stuck).length;
  const crnaLate = crnaRows.length - crnaStuck;

  // Residents panel: R6 rows are the "stuck" (not-on-call) residents pulled in.
  const resRows = data.residents.filter((r) => r.name);
  const stuck = resRows.filter((r) => /^R6/i.test((r.role || "").trim())).length;
  const resOnCall = resRows.length - stuck;
  const resTotal = resRows.length;

  const tile = (label, value, sub) =>
    `<div class="stat"><div class="stat-val">${value}</div><div class="stat-label">${label}${sub ? ` <span class="stat-sub">${sub}</span>` : ""}</div></div>`;
  const tileList = (label, rooms) =>
    `<div class="stat stat-wide"><div class="stat-val">${rooms.length}</div><div class="stat-label">${label} ` +
    `<span class="stat-sub">${rooms.length ? escHtml(rooms.join(", ")) : "all filled"}</span></div></div>`;

  const past8 = data.main.filter((r) => r.past8).length;
  // Green (ongoing) rooms missing an attending / missing a 5 PM staff member.
  const needAtt = data.main.filter((r) => r.status === "ongoing" && !(r.attending || "").trim()).map((r) => r.room);
  const needStaff = data.main.filter((r) => r.status === "ongoing" && !(r.fivepm || "").trim()).map((r) => r.room);

  bar.innerHTML =
    tile("Rooms going", roomsGoing) +
    tileList("Need attending", needAtt) +
    tileList("Need staff", needStaff) +
    tile("Attendings on call", attOnCall) +
    tile("Residents", resTotal, `${resOnCall} on call · ${stuck} stuck`) +
    tile("CRNAs", crnaRows.length, `${crnaLate} late · ${crnaStuck} stuck`) +
    tile("Rooms past 8 PM", past8);
}

/* ---- Search dropdown: show full names (first + last) for matches ---- */
function escHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function renderSearchResults() {
  const box = document.getElementById("searchResults");
  if (!box) return;
  const q = document.getElementById("search").value.trim().toLowerCase();
  const people = (window.DIRECTORY && window.DIRECTORY.people) || [];
  if (!q || q.length < 2 || !people.length) { box.hidden = true; box.innerHTML = ""; return; }
  const kindLabel = { att: "Attending", res: "Resident", crna: "CRNA" };
  const seen = new Set();
  const matches = [];
  for (const p of people) {
    const last = (p.name.split(",")[0] || "").trim();
    const first = (p.name.split(",")[1] || "").trim();
    const full = `${first} ${last}`.trim();
    const nl = last.toLowerCase();
    let score;
    if (nl.startsWith(q)) score = 0;
    else if (nl.includes(q) || String(p.disp).toLowerCase().includes(q)) score = 1;
    else if (full.toLowerCase().includes(q)) score = 2;
    else continue;
    const key = full.toLowerCase() + "|" + p.kind;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ full, disp: p.disp, kind: kindLabel[p.kind] || "", score, last });
  }
  if (!matches.length) { box.hidden = true; box.innerHTML = ""; return; }
  matches.sort((a, b) => a.score - b.score || a.last.localeCompare(b.last));
  matches.length = Math.min(matches.length, 10);
  box.innerHTML = matches.map((m) =>
    `<button type="button" class="sr-item" data-copy="${escHtml(m.full)}">` +
    `<span class="sr-name">${escHtml(m.full)}</span>` +
    `<span class="sr-meta">${escHtml(m.disp)} · ${escHtml(m.kind)}</span></button>`).join("");
  box.hidden = false;
  box.querySelectorAll(".sr-item").forEach((b) => b.addEventListener("mousedown", (e) => {
    e.preventDefault();
    copyText(b.dataset.copy, `Copied "${b.dataset.copy}"`);
  }));
}
function onSearchInput() { renderAll(); renderSearchResults(); }

function toast(msg) {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2200);
}

/* ------------------------------ Access gate ---------------------------- */
function isUnlocked() {
  return !PASSPHRASE || sessionStorage.getItem("coverageBoard.unlocked") === "1";
}

function showGate(onUnlock) {
  const overlay = document.createElement("div");
  overlay.id = "gate";
  overlay.innerHTML =
    '<form id="gateForm" class="gate-card" autocomplete="off">' +
    '<div class="gate-icon">🔒</div>' +
    '<h2>Restricted board</h2>' +
    '<p>Enter the shared passphrase to continue.</p>' +
    '<input id="gateInput" type="password" placeholder="Passphrase" aria-label="Passphrase" />' +
    '<button type="submit" class="btn btn-primary">Unlock</button>' +
    '<p id="gateErr" class="gate-err" hidden>Incorrect passphrase — try again.</p>' +
    "</form>";
  document.body.appendChild(overlay);
  const input = overlay.querySelector("#gateInput");
  const err = overlay.querySelector("#gateErr");
  input.focus();
  overlay.querySelector("#gateForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (input.value === PASSPHRASE) {
      sessionStorage.setItem("coverageBoard.unlocked", "1");
      overlay.remove();
      onUnlock();
    } else {
      err.hidden = false;
      input.value = "";
      input.focus();
    }
  });
}

/* ------------------------------ Wire up -------------------------------- */
function start() {
  loadAll();
  ensureRoomDefaults();
  // Team Lead isn't a staffing resident — keep it out of the panel.
  const beforeTL = data.residents.length;
  data.residents = data.residents.filter((r) => !/^TL$/i.test((r.role || "").trim()));
  if (data.residents.length !== beforeTL) saveTable("residents");
  try { window.DIRECTORY = JSON.parse(localStorage.getItem("coverageBoard.directory.v1")) || null; } catch { window.DIRECTORY = null; }
  show8pm = localStorage.getItem("coverageBoard.show8pm.v1") === "1" || new Date().getHours() >= 19;
  renderAll();
  renderStats();
  initNotes();

  // Workflow action buttons
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); };
  bind("past8Btn", togglePast8Mode);
  bind("dinnerBtn", toggleDinnerMode);
  bind("start8pmBtn", toggle8pm);
  bind("deleteEmpty", deleteEmptyRooms);
  bind("removeNonCall", removeNonCallAttendings);
  bind("transferOnCall", transferOnCallStaff);
  bind("transferStuck", transferStuckResidents);
  bind("fill5pm", fill5pmFromOnCall);
  bind("updateRosters", () => updateRostersFromRooms("fivepm"));
  bind("updateFrom8pm", () => updateRostersFromRooms("eightpm"));
  bind("copyAtt", copyAttendingAssignments);
  bind("copyStaff", copyStaffAssignments);
  set8pm(show8pm); // sync button label / column

  document.getElementById("exportCsv").addEventListener("click", exportCsv);
  document.getElementById("exportJson").addEventListener("click", exportJson);
  document.getElementById("printBtn").addEventListener("click", () => window.print());
  document.getElementById("resetBtn").addEventListener("click", resetBoard);
  const searchEl = document.getElementById("search");
  searchEl.addEventListener("input", onSearchInput);
  searchEl.addEventListener("blur", () => setTimeout(() => { const b = document.getElementById("searchResults"); if (b) b.hidden = true; }, 150));
  searchEl.addEventListener("focus", renderSearchResults);
  searchEl.addEventListener("keydown", (e) => { if (e.key === "Escape") { const b = document.getElementById("searchResults"); if (b) b.hidden = true; } });

  document.querySelectorAll(".add-btn").forEach((btn) => {
    btn.addEventListener("click", () => (btn.dataset.table === "main" ? addRoomPrompt() : addRow(btn.dataset.table)));
  });

  const fileInput = document.getElementById("fileInput");
  document.getElementById("importJson").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => {
    if (e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = "";
  });

  document.addEventListener("input", onEdit);
  document.addEventListener("blur", onEdit, true);

  bind("syncNow", () => window.CloudSync && window.CloudSync.refresh());
  bind("undoBtn", undo);
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
      const t = e.target;
      if (t && (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return; // let the field handle its own undo
      e.preventDefault();
      undo();
    }
  });

  initHistory();
  if (window.CloudSync) window.CloudSync.init(applyRemote);
}

function init() {
  if (isUnlocked()) start();
  else showGate(start);
}

document.addEventListener("DOMContentLoaded", init);
