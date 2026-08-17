/* =========================================================================
   PDF prefill  —  reads a "Final OR Schedule" PDF and fills the board.
   -------------------------------------------------------------------------
   Runs entirely in the browser (nothing is uploaded). Uses pdf.js, lazily
   loaded from ./lib the first time the user picks a file.

   Sources inside the PDF:
   - Page 1, OR grid  : room -> attending / resident-fellow-CRNA (3 panels).
   - Page 1, Roles    : the Attendings & Residents call rosters.
   - Pages 2-4        : person -> room directory (attendings / residents /
                        CRNAs). Used to (a) resolve grouped IR rooms into the
                        specific room per person, and (b) find CRNAs staying
                        late (a "12.5" in their Assignments cell).

   The board only ever shows the canonical rooms in ROOMS_CANON (app.js).
   ========================================================================= */
(function () {
  "use strict";

  /* ---- Page-1 OR grid: 12 column anchors (3 panels x 4 cols) ---- */
  const ANCH  = [19, 61, 145, 187, 271, 313, 397, 439, 523, 565, 649, 691];
  const ROLE  = ["roomA", "att", "roomR", "res", "roomA", "att", "roomR", "res", "roomA", "att", "roomR", "res"];
  const PANEL = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2];
  function nearestIdx(x) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < ANCH.length; i++) { const d = Math.abs(x - ANCH[i]); if (d < bd) { bd = d; bi = i; } }
    return bi;
  }

  /* ---- Pages 2-4 person->room directory: column x per page (2 blocks) ---- */
  const DIR_CFG = {
    2: { cols: [[86, 189, 293], [397, 500, 604]], split: 360 },
    3: { cols: [[84, 158, 278], [397, 472, 591]], split: 365 },
    4: { cols: [[60, 172, 284], [397, 509, 622]], split: 360 },
  };

  /* ---- Map a PDF room label to a canonical board room (or null) ---- */
  const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const EXPLICIT = { "CRNA PUPS": "PUPS", "EPS1": "EP1", "EPS2": "EP2", "EPS3": "EP3", "Burn Unit": "Burn Tank", "ECT NYP": "ECT" };
  let CANON_BY_NORM = null;
  function mapGridRoom(label) {
    if (!label) return null;
    if (EXPLICIT[label]) return EXPLICIT[label];
    if (!CANON_BY_NORM) { CANON_BY_NORM = {}; ROOMS_CANON.forEach((c) => (CANON_BY_NORM[norm(c)] = c)); }
    return CANON_BY_NORM[norm(label)] || null;
  }

  /* ---- Canonicalize a directory room token (handles IR/NICU + aliases) ---- */
  function canonRoom(tok) {
    const t = String(tok || "").trim();
    if (!t) return "";
    const s = t.replace(/^IR\s+/i, "").replace(/\s+/g, " ");
    let m;
    if ((m = s.match(/^Angio\s*0?([123])\b/i))) return "IR Angio " + m[1];
    if ((m = s.match(/^CT\s*0?([12])\b/i))) return "IR CT" + m[1];
    if (/^L-?5-?IR$/i.test(s)) return "L-5-IR";
    if (/NICU/i.test(s)) return "NICU";
    return mapGridRoom(t) || t;
  }

  const surname = (n) => String(n).split(",")[0].trim();
  const isDirRoom = (R) => /^IR /.test(R) || R === "NICU";

  /* ================= pdf.js loading & extraction ================= */
  let pdfjsPromise = null;
  function ensurePdfjs() {
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "lib/pdf.min.js";
      s.onload = () => {
        const lib = window["pdfjs-dist/build/pdf"] || window.pdfjsLib;
        if (!lib) return reject(new Error("pdf.js failed to load"));
        lib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";
        resolve(lib);
      };
      s.onerror = () => reject(new Error("Could not load lib/pdf.min.js"));
      document.head.appendChild(s);
    });
    return pdfjsPromise;
  }

  async function extractPages(file) {
    const lib = await ensurePdfjs();
    const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = {};
    const n = Math.min(pdf.numPages, 4);
    for (let p = 1; p <= n; p++) {
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      pages[p] = tc.items
        .filter((i) => i.str.trim())
        .map((i) => ({ x: Math.round(i.transform[4]), y: Math.round(vp.height - i.transform[5]), s: i.str.trim() }));
    }
    return pages;
  }

  /* ---- Attach each text item to the nearest record by y ---- */
  function attachNearest(records, items, field) {
    for (const it of items) {
      let best = null, bd = Infinity;
      for (const r of records) { const d = Math.abs(r.y - it.y); if (d < bd) { bd = d; best = r; } }
      if (best) best[field].push(it.s);
    }
  }

  /* ================= Page 1: OR grid ================= */
  function parseGrid(items) {
    const rooms = [[], [], []], atts = [[], [], []], ress = [[], [], []];
    for (const it of items) {
      const idx = nearestIdx(it.x), p = PANEL[idx], role = ROLE[idx];
      if (role === "roomA") rooms[p].push({ y: it.y, room: it.s, att: [], res: [] });
      else if (role === "att") atts[p].push(it);
      else if (role === "res") ress[p].push(it);
    }
    const out = [];
    for (let p = 0; p < 3; p++) {
      const recs = rooms[p].sort((a, b) => a.y - b.y);
      attachNearest(recs, atts[p], "att");
      attachNearest(recs, ress[p], "res");
      for (const r of recs) out.push({ room: r.room, attending: r.att.join(" "), staff: r.res.join(" ") });
    }
    return out;
  }

  /* ================= Page 1: Roles rosters ================= */
  function parsePair(items, roleLo, roleHi, nameLo, nameHi) {
    const recs = items.filter((i) => i.x >= roleLo && i.x < roleHi).sort((a, b) => a.y - b.y)
      .map((i) => ({ y: i.y, role: i.s, name: [] }));
    attachNearest(recs, items.filter((i) => i.x >= nameLo && i.x < nameHi), "name");
    return recs.filter((r) => r.role).map((r) => ({ role: r.role, name: r.name.join(" ") }));
  }
  // Residents & CRNAs get one name per row, so split comma-separated rosters.
  function splitNames(pairs) {
    const out = [];
    for (const p of pairs) {
      const parts = String(p.name).split(",").map((s) => s.trim()).filter(Boolean);
      if (!parts.length) out.push({ role: p.role, name: "" });
      else parts.forEach((n) => out.push({ role: p.role, name: n }));
    }
    return out;
  }

  /* ================= Pages 2-4: person->room directory ================= */
  function parseDir(items, cfg) {
    const people = [];
    cfg.cols.forEach((block, bi) => {
      const [nx, rx, ax] = block;
      const inBlock = items.filter((i) => (bi === 0 ? i.x < cfg.split : i.x >= cfg.split));
      const which = (x) => { const a = [nx, rx, ax]; let bj = 0, bd = Infinity; a.forEach((v, j) => { const d = Math.abs(x - v); if (d < bd) { bd = d; bj = j; } }); return bj; };
      const names = [], rooms = [], assigns = [];
      for (const it of inBlock) { const k = which(it.x); if (k === 0) names.push(it); else if (k === 1) rooms.push(it); else assigns.push(it); }
      const recs = names.sort((a, b) => a.y - b.y).map((i) => ({ y: i.y, name: i.s, rooms: [], assign: [] }));
      attachNearest(recs, rooms, "rooms");
      attachNearest(recs, assigns, "assign");
      for (const r of recs) people.push({ name: r.name, rooms: r.rooms.join(" "), assign: r.assign.join(" ") });
    });
    return people;
  }

  /* ================= Orchestration ================= */
  function parse(pages) {
    const p1 = pages[1] || [];
    const dateItem = p1.find((i) => /\d{1,2}\/\d{1,2}\/\d{4}/.test(i.s));
    const dayItem = p1.find((i) => /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day$/.test(i.s));
    const date = [dayItem && dayItem.s, dateItem && (dateItem.s.match(/\d{1,2}\/\d{1,2}\/\d{4}/) || [])[0]].filter(Boolean).join(" ");

    const rolesY = Math.min(...p1.filter((i) => i.s === "Roles").map((i) => i.y), Infinity);
    const rolesItems = p1.filter((i) => i.y > rolesY);
    const rawAttendings = splitNames(parsePair(rolesItems, 0, 45, 45, 150));
    const rawResidents = splitNames(parsePair(rolesItems, 170, 215, 240, 430));

    // Person->room directory across pages 2-4 (authoritative for room membership)
    const dir = [];
    if (pages[2]) parseDir(pages[2], DIR_CFG[2]).forEach((p) => dir.push(tag(p, "att")));
    if (pages[3]) parseDir(pages[3], DIR_CFG[3]).forEach((p) => dir.push(tag(p, "res")));
    if (pages[4]) parseDir(pages[4], DIR_CFG[4]).forEach((p) => dir.push(tag(p, "crna")));

    // Display name: surname, prefixed with first initial only when a surname is shared.
    const surCount = {};
    dir.forEach((p) => { const s = surname(p.name); surCount[s] = (surCount[s] || 0) + 1; });
    const disp = (p) => {
      const s = surname(p.name);
      const first = (p.name.split(",")[1] || "").trim();
      return surCount[s] > 1 && first ? first[0] + s : s;
    };

    // Canonicalize a roster name (e.g. "JuScarpa") to the directory's display
    // form (e.g. "JScarpa") so every source uses identical names.
    const canonName = (token) => {
      const tk = String(token).trim();
      if (!tk) return tk;
      const nl = tk.toLowerCase().replace(/[^a-z]/g, "");
      let cands = dir.filter((p) => { const s = surname(p.name).toLowerCase().replace(/[^a-z]/g, ""); return s && nl.endsWith(s); });
      if (!cands.length) return tk;
      const topLen = Math.max(...cands.map((p) => surname(p.name).length));
      cands = cands.filter((p) => surname(p.name).length === topLen);
      let pick = cands[0];
      if (cands.length > 1) {
        const sfx = surname(pick.name).toLowerCase().replace(/[^a-z]/g, "");
        const init = nl.slice(0, nl.length - sfx.length)[0] || "";
        const byInit = cands.find((p) => ((p.name.split(",")[1] || "").trim()[0] || "").toLowerCase() === init);
        if (byInit) pick = byInit;
      }
      return disp(pick);
    };
    const attendings = rawAttendings.map((r) => ({ role: r.role, name: canonName(r.name) }));
    const residents = rawResidents
      .filter((r) => !/^TL$/i.test((r.role || "").trim())) // Team Lead isn't a staffing resident
      .map((r) => ({ role: r.role, name: canonName(r.name) }));

    // Build the board from the canonical room list, entirely from the directory.
    const rooms = ROOMS_CANON.map((R) => {
      const attP = dir.filter((p) => p.kind === "att" && p.roomsC.includes(R));
      const stfP = dir.filter((p) => p.kind !== "att" && p.roomsC.includes(R));
      return {
        room: R,
        attending: unique(attP.map(disp)).join(", "),
        staff: unique(stfP.map((p) => disp(p) + (p.late ? " (late)" : ""))).join(", "),
      };
    });

    // Directory classification (surnames) for runtime buttons/stats,
    // plus full names (Last, First) so search can surface first names.
    const directory = {
      attendings: unique(dir.filter((p) => p.kind === "att").map((p) => surname(p.name))),
      residents: unique(dir.filter((p) => p.kind === "res").map((p) => surname(p.name))),
      crnas: unique(dir.filter((p) => p.kind === "crna").map((p) => surname(p.name))),
      people: dir.filter((p) => p.name.includes(",")).map((p) => ({ name: p.name, disp: disp(p), kind: p.kind })),
    };

    // CRNAs staying late (12.5), excluding the DHK campus. "Breaks" is the break
    // rotation, not a room, so leave that room blank.
    const crnas = dir.filter((p) => p.kind === "crna" && p.late && !/DHK/i.test(p.rooms)).map((p) => {
      const tokens = p.rooms.split(",").map((s) => s.trim());
      let room = canonRoom(tokens.find((t) => !/^L-?5-?IR$/i.test(t)) || "");
      if (/^breaks$/i.test(room)) room = "";
      return { name: disp(p), room, role: "8pm" };
    });

    return { date, rooms, attendings, residents, crnas, directory };
  }

  function tag(p, kind) {
    return { name: p.name, rooms: p.rooms, assign: p.assign, kind, roomsC: p.rooms.split(",").map(canonRoom), late: /(^|\D)12\.5(\D|$)/.test(p.assign) };
  }
  function unique(a) { return a.filter((v, i) => v && a.indexOf(v) === i); }

  /* ================= Apply to the board ================= */
  const normRoom = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, " ");
  function apply(parsed) {
    const prev = {};
    data.main.forEach((r) => (prev[normRoom(r.room)] = r));
    data.main = parsed.rooms.map((pr) => {
      const old = prev[normRoom(pr.room)];
      return blank(TABLES.main.columns, {
        room: pr.room, attending: pr.attending, staff: pr.staff,
        origAttending: pr.attending, // the attending originally in this room per the PDF
        fivepm: old ? old.fivepm : "",
        dinner: old ? old.dinner : "",
        tag: old ? old.tag : "",
        status: old ? old.status : "ongoing",
        past8: old ? old.past8 : false,
      });
    });
    saveTable("main");
    data.attendings = parsed.attendings.map((a) => blank(TABLES.attendings.columns, { role: a.role, name: a.name }));
    saveTable("attendings");
    data.residents = parsed.residents.map((a) => blank(TABLES.residents.columns, { role: a.role, name: a.name }));
    saveTable("residents");
    data.crnas = parsed.crnas.length
      ? parsed.crnas.map((c) => blank(TABLES.crnas.columns, { role: c.role, name: c.name, room: c.room }))
      : TABLES.crnas.seed();
    saveTable("crnas");
    if (parsed.directory) {
      localStorage.setItem("coverageBoard.directory.v1", JSON.stringify(parsed.directory));
      window.DIRECTORY = parsed.directory;
    }
    // Initial roster rooms: attendings from the Attending column; residents and
    // CRNAs from where they currently are (Current Staff column).
    data.attendings.forEach((row) => {
      if (!row.name) return;
      const rooms = data.main.filter((m) => cellNames(m.attending).some((n) => nameMatch(n, row.name))).map((m) => m.room);
      row.rooms = [...new Set(rooms)].join(", ");
    });
    const roomOfStaff = (nm) => { const rooms = data.main.filter((mm) => cellNames(mm.staff).some((n) => nameMatch(n, nm))).map((mm) => mm.room); return [...new Set(rooms)].join(", "); };
    data.residents.forEach((row) => { if (row.name && !(row.room || "").trim()) row.room = roomOfStaff(row.name); });
    data.crnas.forEach((row) => { if (row.name && !(row.room || "").trim()) row.room = roomOfStaff(row.name); });
    saveTable("attendings"); saveTable("residents"); saveTable("crnas");
    renderAll();
    if (typeof renderStats === "function") renderStats();
  }

  /* ================= Preview modal ================= */
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function pvTable(title, cols, rows) {
    const head = cols.map((c) => `<th>${esc(c.label)}</th>`).join("");
    const body = rows.map((r) => "<tr>" + cols.map((c) => `<td>${esc(r[c.key] || "")}</td>`).join("") + "</tr>").join("");
    return `<div class="pv-block"><h4>${esc(title)} <span class="pv-count">${rows.length}</span></h4>
      <table class="pv-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }
  function showPreview(parsed) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-head">
          <h3>Prefill from schedule${parsed.date ? " — " + esc(parsed.date) : ""}</h3>
          <button class="modal-close" type="button" aria-label="Close">✕</button>
        </div>
        <div class="modal-note">
          Fills <strong>Room Assignments</strong> for your ${parsed.rooms.length} rooms (IR rooms resolved to the specific room per person),
          replaces the <strong>Attendings</strong> and <strong>Residents</strong> rosters, and lists <strong>CRNAs staying late</strong> (12.5).
          Your <em>5:00 PM</em> / <em>Dinner</em> notes for matching rooms are kept. Review, then Apply.
        </div>
        <div class="modal-body">
          ${pvTable("Room Assignments", [{ key: "room", label: "Room" }, { key: "attending", label: "Attending" }, { key: "staff", label: "Current Staff" }], parsed.rooms)}
          <div class="pv-rosters">
            ${pvTable("Attendings", [{ key: "role", label: "Role" }, { key: "name", label: "Name" }], parsed.attendings)}
            ${pvTable("Residents", [{ key: "role", label: "Role" }, { key: "name", label: "Name" }], parsed.residents)}
            ${pvTable("CRNAs staying late", [{ key: "name", label: "CRNA" }, { key: "room", label: "Room" }], parsed.crnas)}
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn modal-cancel" type="button">Cancel</button>
          <button class="btn btn-primary modal-apply" type="button">Apply to board</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector(".modal-close").addEventListener("click", close);
    overlay.querySelector(".modal-cancel").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector(".modal-apply").addEventListener("click", () => { apply(parsed); close(); });
  }

  /* ================= Wire up the Upload PDF button ================= */
  function initPdfImport() {
    const btn = document.getElementById("importPdf");
    const input = document.getElementById("pdfInput");
    if (!btn || !input) return;
    btn.addEventListener("click", () => input.click());
    input.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = "Reading…";
      try {
        const pages = await extractPages(file);
        const parsed = parse(pages);
        if (!parsed.rooms.some((r) => r.attending || r.staff)) throw new Error("No assignments found — is this the Final OR Schedule PDF?");
        showPreview(parsed);
      } catch (err) {
        alert("Could not read that PDF: " + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", initPdfImport);
})();
