# After-Hours Coverage Board

A lightweight, browser-editable board for tracking which **attendings, residents, and CRNAs**
are covering which **OR rooms after 5:00 PM**. Modeled on the daily-use grid of the source
Google Sheet (Room · Attending · Current Staff · 5:00 PM · Dinner).

It's a static site — just HTML, CSS, and JavaScript — so it can be hosted for free on
GitHub Pages (or Cloudflare Pages, Netlify, etc.).

## Features

- **Upload schedule PDF** — reads a "Final OR Schedule" PDF and prefills the whole board
  (see below).
- **Editable in the browser** — click any cell to edit; changes save automatically.
- **Two-panel layout** — Room Assignments on the left; Attendings / Residents / CRNAs
  rosters on the right.
- **Add / delete rows** — each table has its own "+ Add" button and a ✕ on each row.
- **Search** — filter every table by name, room, or role.
- **Save / Load (JSON)** — export a master copy and load it in another browser to share.
- **Export CSV** — open the room board in Excel or Google Sheets.
- **Print** — clean print/PDF layout (toolbar and controls hidden).
- **Passphrase gate** — a simple shared password before the board is shown.

## Uploading a schedule PDF (auto-prefill)

Click **⬆ Upload schedule PDF** and pick the day's *Final OR Schedule* PDF. The file is
read **entirely in your browser** — nothing is uploaded anywhere. You get a **preview** of
what was found; click **Apply** to fill the board:

- **Room Assignments** are rebuilt from the schedule's OR grid (Attending + Current Staff).
  Any `5:00 PM` / `Dinner` notes you already typed for a matching room are kept.
- **Attendings** and **Residents** rosters are filled from the schedule's *Roles* section.

A few rooms with several names (OB Lead, OB Call, Breaks) may need a quick manual touch-up
after applying — the preview lets you spot them first.

PDF reading uses **pdf.js** (Mozilla's open-source engine, works in every browser),
vendored in `lib/`. Schedule PDFs are git-ignored (`*.pdf`) so real names never end up in
the repo.

## ⚠️ About the passphrase (read this)

The login is a **basic deterrent, not real security.** This is a static site, so the
passphrase lives in `app.js` and can be read by anyone who views the page source. It keeps
casual passers-by out; it does **not** protect against anyone technical. Because this board
holds **no patient information** (staff assignments only), that trade-off is acceptable here.

If you ever need real access control, host the same code on **Cloudflare Pages + Cloudflare
Access** (free) and gate it by an email allowlist.

## Configuring it

Open **`app.js`** and edit the constants near the top:

- `PASSPHRASE` — change `"changeme"` to your shared password. Set to `""` to remove the login.
- `COLUMNS` — rename, add, or remove columns.
- `seedRows()` — change the default rooms (currently `G1`–`G21`).

## Sharing data between people

This version stores data in **each person's own browser**. To keep everyone in sync:

1. One designated person maintains the board and clicks **Save (JSON)**.
2. Share that `.json` file (Slack, email, shared drive).
3. Others click **Load (JSON)** to see the latest.

For **live shared editing** (everyone sees the same data in real time), the site needs a small
backend — e.g. Supabase, or reading/writing back to the Google Sheet. Ask to set that up as a
next step.

## Local preview

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page structure |
| `styles.css` | Styling (incl. login and print layouts) |
| `app.js` | Board logic, storage, import/export, login gate |
