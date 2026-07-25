/* =========================================================================
   Cloud sync via Supabase (optional).
   -------------------------------------------------------------------------
   Stores the whole board as one shared row so any computer that opens the
   site loads the latest board and edits save back to the cloud.

   TO ENABLE: paste your Supabase project URL and public anon key below.
   Leave them blank to run purely local (browser-only), as before.
   ========================================================================= */
(function () {
  "use strict";

  // ---- Fill these two in (Supabase → Project Settings → API) ----
  const SUPABASE_URL = "";       // e.g. "https://abcdefgh.supabase.co"
  const SUPABASE_ANON_KEY = "";  // the long "anon public" key
  // ---------------------------------------------------------------

  const TABLE = "board";
  const ROW_ID = "shared";
  const enabled = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

  let applyRemoteFn = null;
  let saveTimer = null;
  let suppress = false; // don't echo a remote apply back up to the cloud

  function headers(extra) {
    return Object.assign({ apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY }, extra || {});
  }
  function status(text, cls) {
    const el = document.getElementById("syncStatus");
    if (!el) return;
    el.hidden = false;
    el.textContent = text;
    el.className = "sync-status " + (cls || "");
  }

  function collect() {
    return {
      main: data.main,
      attendings: data.attendings,
      residents: data.residents,
      crnas: data.crnas,
      directory: window.DIRECTORY || null,
      notes: localStorage.getItem("coverageBoard.notes.v1") || "",
      savedAt: new Date().toISOString(),
    };
  }

  async function pull() {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${ROW_ID}&select=data`, { headers: headers() });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const rows = await res.json();
    return rows[0] ? rows[0].data : null;
  }
  async function push(payload) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ id: ROW_ID, data: payload, updated_at: payload.savedAt }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
  }

  const CloudSync = {
    async init(applyFn) {
      applyRemoteFn = applyFn;
      if (!enabled()) return;
      status("☁ Connecting…");
      try {
        const remote = await pull();
        if (remote) {
          suppress = true;
          try { applyRemoteFn(remote); } finally { suppress = false; }
        } else {
          await push(collect()); // first run: seed the cloud from this device
        }
        status("☁ Synced");
      } catch (e) {
        status("☁ Offline", "err");
      }
    },
    save() {
      if (!enabled() || suppress) return;
      status("☁ Saving…");
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try { await push(collect()); status("☁ Synced"); }
        catch (e) { status("☁ Offline", "err"); }
      }, 1200);
    },
    async refresh() {
      if (!enabled()) { alert("Cloud sync isn't set up yet."); return; }
      status("☁ Refreshing…");
      try {
        const remote = await pull();
        if (remote) { suppress = true; try { applyRemoteFn(remote); } finally { suppress = false; } }
        status("☁ Synced");
      } catch (e) { status("☁ Offline", "err"); }
    },
  };
  window.CloudSync = CloudSync;
})();
