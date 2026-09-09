/**
 * PicaPool intent form — backend (final)
 * =======================================
 * Turns a Google Sheet into the database for the intent form: 3 tabs —
 * Dashboard, Submissions, Slug.
 *
 * ONE-TIME SETUP
 * 1. Create a blank Google Sheet (this becomes the database).
 * 2. Extensions > Apps Script. Delete the placeholder code, paste this
 *    whole file in.
 * 3. In the function dropdown (top toolbar) pick "setupSheets", click ▶ Run.
 *    Approve the permissions prompt. This builds all 3 tabs, headers,
 *    red/green conditional formatting on Submissions, and the Dashboard.
 * 4. Deploy > New deployment > type "Web app".
 *      Execute as: Me
 *      Who has access: Anyone
 *    Deploy, copy the URL ending in /exec.
 * 5. Paste that URL into API_BASE near the top of index.html, redeploy.
 *
 * Re-run setupSheets() any time after pulling a newer version of this file —
 * it's safe: existing data is never touched, only missing columns get
 * appended and the Dashboard gets rebuilt from the live formulas.
 */

/* Bumped whenever this file changes meaningfully, and reported by doGet.
   A Web App deployment serves a PINNED VERSION of the script: pasting new
   code into the editor does not change what /exec runs until you publish a
   new version (Deploy > Manage deployments > pencil > Version: New version).
   Open the /exec URL and compare this string against the file you pasted —
   if they differ, the live backend is not the code you are reading, and
   nothing you change in the editor is having any effect. */
const CODE_VERSION = '2026-09-09-e';

const SUBMISSIONS_SHEET = 'Submissions';
const SLUG_SHEET = 'Slug';
const DASHBOARD_SHEET = 'Dashboard';
const BRANDS_SHEET = 'Brands';

// NEVER reorder or insert into this list — handleSubmit writes a row
// positionally from column 1, and getSheet() only ever APPENDS newly-added
// headers at the end. New fields go on the end, or old sheets shift.
const SUBMISSION_HEADERS = [
  'sessionId', 'firstSeen', 'lastUpdated', 'status', 'slug', 'referredBy', 'myRefCode',
  'name', 'phone', 'categories', 'otherCategoryText', 'categoriesFilled', 'categoriesTotal',
  'commitment', 'currentScreen', 'screensReached', 'totalScreens', 'device', 'userAgent',
  'brandSelJSON', 'eventsJSON',
  // per-user click detail — who clicked what, and when (blank = never clicked)
  'waGroupClickedAt', 'buyingGroupClickedAt', 'appDownloadClickedAt',
  'referralSharedAt', 'referralCopiedAt',
  // readable brand detail — which exact brands they tapped, and anything
  // they hand-typed into an "Others" box. brandSelJSON above stays as the
  // lossless raw backup; these are what you actually read.
  'brandsPicked', 'brandsTyped', 'brandCount', 'brandRowsJSON',
  // which build of index.html produced this row — a row stamped with an old
  // build (or blank) came from a form Vercel never redeployed
  'clientBuild'
];
// 1-based column indexes, kept in sync with SUBMISSION_HEADERS above
const S_SESSION = 1, S_FIRSTSEEN = 2, S_LASTUPDATED = 3, S_STATUS = 4, S_SLUG = 5;

const SLUG_HEADERS = [
  'slug', 'type', 'destinationOrOwner', 'firstSeen', 'lastSeen',
  'visits', 'clicks', 'formStarts', 'formCompletions'
];
const L_SLUG = 1, L_TYPE = 2, L_DEST = 3, L_FIRSTSEEN = 4, L_LASTSEEN = 5,
      L_VISITS = 6, L_CLICKS = 7, L_STARTS = 8, L_COMPLETIONS = 9;

/* Mirror of CATEGORY_META in index.html: id -> label, and for nested
   categories the group ids -> labels, in the order the form renders them.

   Live submissions don't need this — the form sends brandRowsJSON with the
   labels already resolved. It exists purely for backfillBrandColumns(),
   which has to rebuild that detail out of the raw brandSelJSON on rows
   captured before the form started sending it, and brandSelJSON stores ids
   only. If you add or rename a category/group in index.html and later need
   another backfill, mirror the change here first. */
const CATEGORY_LABELS = [
  { id: 'quickbites', label: 'Quick Bites & Munchies', groups: null },
  { id: 'zomato', label: 'Zomato / Swiggy', groups: null },
  { id: 'supplements', label: 'Supplements', groups: [
    ['protein', 'Protein'], ['creatine', 'Creatine'], ['oats', 'Oats'],
    ['peanutbutter', 'Peanut Butter']] },
  { id: 'skincare', label: 'Skincare', groups: [
    ['facewash', 'Face Wash'], ['moisturizer', 'Moisturizer'],
    ['sunscreen', 'Sunscreen'], ['serum', 'Face Serum']] },
  { id: 'stationery', label: 'Stationery', groups: [
    ['pencils', 'Pencils'], ['pens', 'Pens'], ['notebooks', 'Notebooks']] },
  { id: 'haircare', label: 'Hair Care', groups: [
    ['shampoo', 'Shampoo'], ['conditioner', 'Conditioner'],
    ['hairserum', 'Hair Serum']] },
  { id: 'drinks', label: 'Drinks', groups: [
    ['coffeetea', 'Coffee/Tea'], ['sodas', 'Soda Drinks'],
    ['cafes', 'Cafés / Tea Shops']] }
];

/* =========================================================
   ENTRY POINTS
========================================================= */
function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return textOut('bad json'); }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (body.action === 'submit') handleSubmit(body);
    else if (body.action === 'track') handleTrack(body);
    else if (body.action === 'createLink') handleCreateLink(body);
  } catch (err) {
    // The form posts with sendBeacon, which throws the response away — an
    // uncaught error here is a write that vanishes with nothing to see on
    // either side. Record it so a failure is something you can look at.
    logError(err, body);
    return textOut('error: ' + (err && err.message ? err.message : err));
  } finally {
    lock.releaseLock();
  }
  return textOut('ok');
}

const ERROR_SHEET = 'Errors';
const ERROR_HEADERS = ['at', 'action', 'sessionId', 'message', 'payload'];

function logError(err, body) {
  try {
    const sh = getSheet(ERROR_SHEET, ERROR_HEADERS);
    ensureGrid(sh, sh.getLastRow() + 1, ERROR_HEADERS.length);
    sh.appendRow([
      new Date(),
      (body && body.action) || '',
      (body && body.sessionId) || '',
      String((err && err.message) || err).slice(0, 500),
      JSON.stringify(body || {}).slice(0, 2000)
    ]);
  } catch (ignored) {
    // the error sheet itself is broken — the Apps Script execution log is
    // the last resort, don't mask the original failure by throwing here
    console.error('logError failed', ignored, err);
  }
}

/* Open the /exec URL in a browser to see whether the backend is actually
   receiving anything — counts, the newest submission, and the last error.
   Beats guessing when a row "doesn't show up". */
function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // codeVersion is the first thing to check: if it isn't the version in the
  // file you pasted, /exec is serving an older deployment and your edits are
  // not live. Deploy > Manage deployments > pencil > Version: New version.
  const status = { ok: true, codeVersion: CODE_VERSION, now: new Date() };
  try {
    const sub = ss.getSheetByName(SUBMISSIONS_SHEET);
    status.submissions = sub ? Math.max(0, sub.getLastRow() - 1) : 0;
    status.columns = sub ? sub.getLastColumn() : 0;
    status.expectedColumns = SUBMISSION_HEADERS.length;
    if (sub && sub.getLastRow() > 1) {
      const c = colMap(sub);
      const n = sub.getLastRow() - 1;
      const rows = sub.getRange(2, 1, n, sub.getLastColumn()).getValues();
      let newest = null, withDetail = 0, rawOnly = 0;
      const builds = {};
      rows.forEach(r => {
        const t = c.lastUpdated ? r[c.lastUpdated - 1] : null;
        if (t && (!newest || t > newest)) newest = t;
        const detail = c.brandRowsJSON ? r[c.brandRowsJSON - 1] : '';
        const raw = c.brandSelJSON ? r[c.brandSelJSON - 1] : '';
        if (detail && detail !== '[]') withDetail++;
        else if (raw && raw !== '{}') rawOnly++;
        const b = c.clientBuild ? (r[c.clientBuild - 1] || '(none)') : '(no column)';
        builds[b] = (builds[b] || 0) + 1;
      });
      // which builds of index.html these rows came from; if the newest rows
      // aren't stamped with the current BUILD, Vercel never redeployed
      status.clientBuilds = builds;
      status.lastSubmissionAt = newest;
      // withBrandDetail 0 while rawOnly > 0 means the sheet is fine and the
      // backfill hasn't run; both 0 means nobody has picked a brand at all,
      // which on a live form means index.html was never redeployed
      status.withBrandDetail = withDetail;
      status.rawBlobOnly = rawOnly;
      status.hasBrandColumns = !!c.brandRowsJSON;
    }
    const brands = ss.getSheetByName(BRANDS_SHEET);
    status.brandRows = brands ? Math.max(0, brands.getLastRow() - 1) : 0;
    const errs = ss.getSheetByName(ERROR_SHEET);
    status.errors = errs ? Math.max(0, errs.getLastRow() - 1) : 0;
    if (errs && errs.getLastRow() > 1) {
      const last = errs.getRange(errs.getLastRow(), 1, 1, 4).getValues()[0];
      status.lastError = { at: last[0], action: last[1], message: last[3] };
    }
  } catch (err) {
    status.ok = false;
    status.message = String((err && err.message) || err);
  }
  return ContentService.createTextOutput(JSON.stringify(status, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
}

function textOut(msg) {
  return ContentService.createTextOutput(msg).setMimeType(ContentService.MimeType.TEXT);
}

function epochToDate(ms) {
  return ms ? new Date(Number(ms)) : '';
}

/* =========================================================
   SHEET HELPERS
========================================================= */
/* A Google Sheet tab is created 1000 rows x 26 columns and does NOT grow
   on its own: getRange() past those bounds throws, it doesn't widen the
   grid. The original 26-column schema fit that default exactly, so this
   never came up — the moment the schema passed 26 columns, every single
   getSheet() call started throwing, and since doPost had no catch, every
   write failed silently behind a discarded 500. Same trap on rows once
   the Brands tab passes 1000. Call this before any range that could sit
   outside what the sheet currently has. */
function ensureGrid(sheet, minRows, minCols) {
  const rows = sheet.getMaxRows(), cols = sheet.getMaxColumns();
  if (minCols > cols) sheet.insertColumnsAfter(cols, minCols - cols);
  if (minRows > rows) sheet.insertRowsAfter(rows, minRows - rows);
}

function getSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    ensureGrid(sh, 2, headers.length);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    return sh;
  }
  const lastCol = sh.getLastColumn();
  const existing = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  if (!existing[0]) {
    ensureGrid(sh, 2, headers.length);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    return sh;
  }
  // schema grew since this sheet was first set up — append only what's
  // missing, at the end, never touching existing columns or data.
  const missing = headers.filter(h => existing.indexOf(h) === -1);
  if (missing.length) {
    ensureGrid(sh, 2, existing.length + missing.length);
    sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

function findRow(sheet, keyCol, key) {
  const last = sheet.getLastRow();
  if (last < 2 || !key) return -1;
  const values = sheet.getRange(2, keyCol, last - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (values[i][0] === key) return i + 2;
  }
  return -1;
}

/* =========================================================
   SUBMISSIONS — one row per visitor session, upserted on every
   screen change. Red while partial, green once the 'final' screen
   is reached (conditional formatting). Click columns record which
   named user tapped which outbound link, and when.
========================================================= */
function handleSubmit(body) {
  const sh = getSheet(SUBMISSIONS_SHEET, SUBMISSION_HEADERS);
  const row = findRow(sh, S_SESSION, body.sessionId);
  const now = new Date();
  const firstSeen = row > 0 ? sh.getRange(row, S_FIRSTSEEN).getValue() : now;

  const rowData = [
    body.sessionId, firstSeen, now, body.status || 'partial',
    body.slug || '', body.referredBy || '', body.myRefCode || '',
    body.name || '', body.phone || '', body.categories || '', body.otherCategoryText || '',
    body.categoriesFilled || 0, body.categoriesTotal || 0, body.commitment || '',
    body.currentScreen || '', body.screensReached || 0, body.totalScreens || 0,
    body.device || '', body.userAgent || '', body.brandSelJSON || '', body.eventsJSON || '',
    epochToDate(body.waGroupClickedAt), epochToDate(body.buyingGroupClickedAt),
    epochToDate(body.appDownloadClickedAt), epochToDate(body.referralSharedAt),
    epochToDate(body.referralCopiedAt),
    body.brandsPicked || '', body.brandsTyped || '', body.brandCount || 0,
    body.brandRowsJSON || '', body.clientBuild || '(pre-build-stamp)'
  ];

  const wasComplete = row > 0 && sh.getRange(row, S_STATUS).getValue() === 'complete';
  if (row > 0) {
    ensureGrid(sh, row, rowData.length);
    sh.getRange(row, 1, 1, rowData.length).setValues([rowData]);
  } else {
    ensureGrid(sh, sh.getLastRow() + 1, rowData.length);
    sh.appendRow(rowData);
  }

  if (body.status === 'complete' && !wasComplete) {
    bumpSlugCounter(body.slug, L_COMPLETIONS);
  }
}

/* =========================================================
   SLUG — one row per trackable link (campaign tag, referral code,
   or a reserved redirect shortlink like /wa or /buy). Upserted on
   every visit/click.
========================================================= */
function handleTrack(body) {
  if (!body.slug) return;
  const sh = getSheet(SLUG_SHEET, SLUG_HEADERS);
  const row = findRow(sh, L_SLUG, body.slug);
  const now = new Date();

  if (row > 0) {
    const col = body.kind === 'visit' ? L_VISITS : L_CLICKS;
    const current = sh.getRange(row, col).getValue() || 0;
    sh.getRange(row, col).setValue(current + 1);
    sh.getRange(row, L_LASTSEEN).setValue(now);
  } else {
    sh.appendRow([
      body.slug,
      body.redirectType || 'campaign',
      body.dest || '',
      now, now,
      body.kind === 'visit' ? 1 : 0,
      body.kind === 'click' ? 1 : 0,
      0, 0
    ]);
  }

  if (body.kind === 'visit') bumpSlugCounter(body.slug, L_STARTS);
}

function bumpSlugCounter(slug, col) {
  if (!slug) return;
  const sh = getSheet(SLUG_SHEET, SLUG_HEADERS);
  const row = findRow(sh, L_SLUG, slug);
  if (row > 0) {
    const current = sh.getRange(row, col).getValue() || 0;
    sh.getRange(row, col).setValue(current + 1);
  }
}

/* pre-registers a referral code with its owner's name, so the Dashboard
   can show "who brought how many people" even before that link's first
   click. */
function handleCreateLink(body) {
  const sh = getSheet(SLUG_SHEET, SLUG_HEADERS);
  const row = findRow(sh, L_SLUG, body.slug);
  const now = new Date();
  if (row < 0) {
    sh.appendRow([body.slug, body.type || 'referral', body.owner || '', now, now, 0, 0, 0, 0]);
  } else if (body.owner) {
    sh.getRange(row, L_DEST).setValue(body.owner);
  }
}

/* =========================================================
   BRANDS — one row per (person, brand). Submissions holds one row per
   person with all their brands crammed into a couple of cells; that's
   fine for reading a single respondent but useless for "which brands
   are people actually asking for". This tab explodes brandRowsJSON into
   a tidy long table, which the Dashboard then just QUERYs.

   Rebuilt wholesale (it's derived data — Submissions is the source of
   truth) on a 5-minute trigger and from the PicaPool menu.
========================================================= */
const BRAND_HEADERS = [
  'sessionId', 'name', 'phone', 'status', 'lastUpdated',
  'category', 'subCategory', 'brand', 'source'
];

/* header name -> 1-based column, so this keeps working no matter what
   order getSheet() happened to append new columns in */
function colMap(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return {};
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  headers.forEach((h, i) => { if (h) map[h] = i + 1; });
  return map;
}

function rebuildBrands() {
  // getSheet, NOT getSheetByName: if the brand columns were never added —
  // script pasted but setupSheets never finished, say — this adds them and
  // carries on, instead of the old behaviour of returning silently and
  // leaving an empty tab with nothing to explain why.
  const sub = getSheet(SUBMISSIONS_SHEET, SUBMISSION_HEADERS);
  const sh = getSheet(BRANDS_SHEET, BRAND_HEADERS);

  // wipe everything below the header — this table is fully derived
  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(sh.getLastColumn(), BRAND_HEADERS.length)).clearContent();
  }
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, BRAND_HEADERS.length)
    .setBackground('#FFF4EB').setFontWeight('bold');

  const summary = { people: 0, withBrandDetail: 0, rawOnly: 0, brandRows: 0, note: '' };
  if (sub.getLastRow() < 2) {
    summary.note = 'No submissions yet — nothing to build from.';
    return brandsToast(summary);
  }

  let c = colMap(sub);
  let values = sub.getRange(2, 1, sub.getLastRow() - 1, sub.getLastColumn()).getValues();
  summary.people = values.length;

  // Rows written before the form started sending labelled brand detail hold
  // only the raw brandSelJSON blob. Recover them here rather than producing
  // an empty tab: this is the single most common reason Brands looks stuck.
  const needsBackfill = values.some(
    row => !row[c.brandRowsJSON - 1] && row[c.brandSelJSON - 1]);
  if (needsBackfill) {
    backfillBrandColumns();
    c = colMap(sub);
    values = sub.getRange(2, 1, sub.getLastRow() - 1, sub.getLastColumn()).getValues();
  }

  const out = [];
  values.forEach(row => {
    const raw = row[c.brandRowsJSON - 1];
    if (!raw) {
      if (row[c.brandSelJSON - 1]) summary.rawOnly++;
      return;
    }
    let picks;
    try { picks = JSON.parse(raw); } catch (err) { return; }
    if (!Array.isArray(picks)) return;
    if (picks.length) summary.withBrandDetail++;
    picks.forEach(p => {
      // p is [category, subCategory, brand, 'preset'|'typed']
      if (!p || !p[2]) return;
      out.push([
        row[c.sessionId - 1], row[c.name - 1], row[c.phone - 1],
        row[c.status - 1], row[c.lastUpdated - 1],
        p[0] || '', p[1] || '', p[2], p[3] || 'preset'
      ]);
    });
  });

  if (out.length) {
    // one row per person per brand — this passes the default 1000-row grid
    // far sooner than Submissions does
    ensureGrid(sh, out.length + 1, BRAND_HEADERS.length);
    sh.getRange(2, 1, out.length, BRAND_HEADERS.length).setValues(out);
  }
  summary.brandRows = out.length;

  if (!out.length) {
    summary.note = summary.rawOnly
      ? summary.rawOnly + ' row(s) still hold only the raw brandSelJSON and could not be ' +
        'decoded — check that CATEGORY_LABELS matches CATEGORY_META in index.html.'
      : 'No submission has any brand picked yet. If people ARE picking brands on the ' +
        'live form, index.html has not been redeployed — the old build never sends them.';
  }
  return brandsToast(summary);
}

/* say what happened — a rebuild that produces nothing should explain
   itself rather than look like it didn't run */
function brandsToast(summary) {
  const msg = summary.brandRows + ' brand rows from ' + summary.withBrandDetail +
    '/' + summary.people + ' submissions. ' + (summary.note || '');
  console.log('rebuildBrands: ' + JSON.stringify(summary));
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'Brands rebuilt', 15); } catch (e) {}
  return summary;
}

/* =========================================================
   BACKFILL — reconstructs the readable brand columns for rows captured
   before the form started sending them. Everything needed is already in
   brandSelJSON (it was always being written, just as an unreadable blob
   in one cell); this walks it through CATEGORY_LABELS to recover the
   category/group names and produces byte-identical output to what the
   form now sends live.

   Safe to run more than once: it only touches rows whose brandRowsJSON is
   still blank, so live data is never overwritten.
========================================================= */

/* the Apps Script twin of brandRows() in index.html — same iteration
   order, same shape ([category, subCategory, brand, source]) */
function brandRowsFromSel(sel) {
  const rows = [];
  CATEGORY_LABELS.forEach(cat => {
    const s = sel[cat.id];
    if (!s || typeof s !== 'object') return;
    const collect = (groupLabel, sub) => {
      if (!sub || typeof sub !== 'object') return;
      const picks = sub.picks || [];
      for (let i = 0; i < picks.length; i++) {
        if (picks[i]) rows.push([cat.label, groupLabel, String(picks[i]), 'preset']);
      }
      const typed = String(sub.other || '').trim();
      if (typed) rows.push([cat.label, groupLabel, typed, 'typed']);
    };
    if (!cat.groups) collect('', s);
    else cat.groups.forEach(g => collect(g[1], s[g[0]]));
  });
  return rows;
}

function brandRowLabel(r) { return r[1] ? r[0] + ' > ' + r[1] : r[0]; }

function brandsPickedFrom(rows) {
  const order = [], byLabel = {};
  rows.forEach(r => {
    const k = brandRowLabel(r);
    if (!byLabel[k]) { byLabel[k] = []; order.push(k); }
    byLabel[k].push(r[3] === 'typed' ? r[2] + ' (typed)' : r[2]);
  });
  return order.map(k => k + ': ' + byLabel[k].join(', ')).join(' | ');
}

function brandsTypedFrom(rows) {
  return rows.filter(r => r[3] === 'typed')
    .map(r => brandRowLabel(r) + ': ' + r[2]).join(' | ');
}

function filledCategoriesFrom(rows) {
  const seen = {};
  rows.forEach(r => { seen[r[0]] = true; });
  return Object.keys(seen).length;
}

function backfillBrandColumns() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sub = getSheet(SUBMISSIONS_SHEET, SUBMISSION_HEADERS); // ensures the 4 new columns exist
  if (sub.getLastRow() < 2) return 0;

  const c = colMap(sub);
  const n = sub.getLastRow() - 1;
  const values = sub.getRange(2, 1, n, sub.getLastColumn()).getValues();

  // one column-shaped array per column we touch, written back in a single
  // setValues each — a per-row write would be thousands of API calls
  const picked = [], typed = [], counts = [], json = [], filled = [];
  let changed = 0;

  values.forEach(row => {
    const existing = row[c.brandRowsJSON - 1];
    const raw = row[c.brandSelJSON - 1];
    // already has live brand detail, or never had anything to recover
    if (existing || !raw) {
      picked.push([row[c.brandsPicked - 1]]);
      typed.push([row[c.brandsTyped - 1]]);
      counts.push([row[c.brandCount - 1]]);
      json.push([existing]);
      filled.push([row[c.categoriesFilled - 1]]);
      return;
    }
    let sel;
    try { sel = JSON.parse(raw); } catch (err) { sel = null; }
    if (!sel || typeof sel !== 'object') {
      picked.push([row[c.brandsPicked - 1]]);
      typed.push([row[c.brandsTyped - 1]]);
      counts.push([row[c.brandCount - 1]]);
      json.push(['']);
      filled.push([row[c.categoriesFilled - 1]]);
      return;
    }
    const rows = brandRowsFromSel(sel);
    picked.push([brandsPickedFrom(rows)]);
    typed.push([brandsTypedFrom(rows)]);
    counts.push([rows.length]);
    json.push([JSON.stringify(rows)]);
    // these rows were written by the old client, which under-counted every
    // nested category — recompute it from the same source while we're here
    filled.push([filledCategoriesFrom(rows)]);
    changed++;
  });

  sub.getRange(2, c.brandsPicked, n, 1).setValues(picked);
  sub.getRange(2, c.brandsTyped, n, 1).setValues(typed);
  sub.getRange(2, c.brandCount, n, 1).setValues(counts);
  sub.getRange(2, c.brandRowsJSON, n, 1).setValues(json);
  sub.getRange(2, c.categoriesFilled, n, 1).setValues(filled);

  ss.toast('Backfilled brand detail on ' + changed + ' row(s).');
  return changed;
}

/* =========================================================
   ONE-TIME SETUP
========================================================= */
/* =========================================================
   SELF TEST — pushes a synthetic submission through the real doPost and
   reports what happened. Run it from the editor (or the PicaPool menu) to
   settle the one question the Sheet alone can't answer: is the SCRIPT
   broken, or is nothing reaching it?

   It bypasses the web app entirely, so it tests the code you just pasted
   rather than whatever version /exec is pinned to. If this writes a row
   and your live form doesn't, the script is fine and the problem is the
   deployment or the form — not this file.

   Leaves a row with sessionId SELFTEST behind; delete it when done, or run
   the menu item again, which overwrites the same row.
========================================================= */
function runSelfTest() {
  const lines = [];
  const say = m => { lines.push(m); console.log(m); };
  say('code version: ' + CODE_VERSION);

  const sub = getSheet(SUBMISSIONS_SHEET, SUBMISSION_HEADERS);
  say('Submissions grid: ' + sub.getMaxRows() + ' rows x ' + sub.getMaxColumns() +
      ' cols; headers ' + sub.getLastColumn() + ', schema expects ' + SUBMISSION_HEADERS.length);

  const before = sub.getLastRow();
  const payload = {
    action: 'submit', sessionId: 'SELFTEST', status: 'complete',
    slug: 'selftest', name: 'Self Test', phone: '0000000000',
    categories: 'quickbites', otherCategoryText: '', categoriesFilled: 1,
    categoriesTotal: 1, commitment: 'yes', currentScreen: 'final',
    device: 'desktop', userAgent: 'self-test', clientBuild: 'self-test',
    brandSelJSON: JSON.stringify({ quickbites: { picks: ['Lays'], other: 'Doritos', otherOn: true } }),
    brandsPicked: 'Quick Bites & Munchies: Lays, Doritos (typed)',
    brandsTyped: 'Quick Bites & Munchies: Doritos',
    brandCount: 2,
    brandRowsJSON: JSON.stringify([
      ['Quick Bites & Munchies', '', 'Lays', 'preset'],
      ['Quick Bites & Munchies', '', 'Doritos', 'typed']]),
    eventsJSON: '[]'
  };

  let reply;
  try {
    reply = doPost({ postData: { contents: JSON.stringify(payload) } }).getContent();
  } catch (err) {
    reply = 'THREW: ' + (err && err.message ? err.message : err);
  }
  say('doPost said: ' + reply);
  say('rows ' + before + ' -> ' + sub.getLastRow());

  const c = colMap(sub);
  const row = findRow(sub, S_SESSION, 'SELFTEST');
  if (row > 0) {
    say('SELFTEST row is at row ' + row +
        '; brandsPicked = "' + sub.getRange(row, c.brandsPicked).getValue() + '"');
  } else {
    say('NO SELFTEST ROW WAS WRITTEN — the script itself is failing, see the Errors tab.');
  }

  const summary = rebuildBrands();
  say('rebuildBrands: ' + JSON.stringify(summary));

  const errs = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ERROR_SHEET);
  if (errs && errs.getLastRow() > 1) {
    say('last error: ' + errs.getRange(errs.getLastRow(), 4).getValue());
  } else {
    say('no errors recorded');
  }

  const report = lines.join('\n');
  try { SpreadsheetApp.getUi().alert('PicaPool self test', report, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { /* not run from the UI — the execution log has it */ }
  return report;
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('PicaPool')
    .addItem('Run self test', 'runSelfTest')
    .addItem('Rebuild brand report', 'rebuildBrands')
    .addItem('Rebuild dashboard', 'buildDashboard')
    .addItem('Backfill old rows', 'backfillBrandColumns')
    .addItem('Run full setup', 'setupSheets')
    .addToUi();
}

function installBrandTrigger() {
  const already = ScriptApp.getProjectTriggers()
    .some(t => t.getHandlerFunction() === 'rebuildBrands');
  if (already) return;
  ScriptApp.newTrigger('rebuildBrands').timeBased().everyMinutes(5).create();
}

function setupSheets() {
  getSheet(SUBMISSIONS_SHEET, SUBMISSION_HEADERS);
  getSheet(SLUG_SHEET, SLUG_HEADERS);
  getSheet(BRANDS_SHEET, BRAND_HEADERS);
  applyConditionalFormatting();
  backfillBrandColumns(); // recover brand detail on rows written before this update
  rebuildBrands();
  installBrandTrigger();
  buildDashboard();
  SpreadsheetApp.getActiveSpreadsheet().toast('Setup complete: Dashboard, Submissions, Slug, Brands are ready.');
}

function applyConditionalFormatting() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SUBMISSIONS_SHEET);
  ensureGrid(sh, 2001, SUBMISSION_HEADERS.length);
  const range = sh.getRange(2, 1, 2000, SUBMISSION_HEADERS.length);
  const partial = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$D2="partial"')
    .setBackground('#FDE2DD')
    .setRanges([range]).build();
  const complete = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$D2="complete"')
    .setBackground('#DCF4E3')
    .setRanges([range]).build();
  sh.setConditionalFormatRules([partial, complete]);
}

/* =========================================================
   DASHBOARD — brand-colored KPI tiles, text-bar mini charts for
   the funnel/device/commitment breakdowns, and bordered, banded,
   properly-headed tables for the link and submission detail.
   Built with a running row cursor so nothing needs hand-counted
   row numbers, and safe to re-run any time (sh.clear() first).
========================================================= */
function buildDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(DASHBOARD_SHEET);
  if (!sh) sh = ss.insertSheet(DASHBOARD_SHEET, 0);
  sh.clear();
  sh.clearFormats();
  sh.getCharts().forEach(c => sh.removeChart(c));
  // a prior run may have left merges/banding behind — clear() doesn't
  // remove those, and re-applying over an overlapping range would throw.
  if (sh.getMaxRows() > 0 && sh.getMaxColumns() > 0) {
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  }
  sh.getBandings().forEach(b => b.remove());
  sh.setTabColor('#FF4B18');
  sh.setHiddenGridlines(true);

  const INK = '#15130F', ORANGE = '#FF4B18', CREAM = '#FFF4EB', CREAM_DEEP = '#FFE7D6',
        TEAL = '#0FAE86', VIOLET = '#6C4CF1', GOLD = '#FFC94D', SOFT = '#5B5449', FAINT = '#A69C90';
  const COLS = 9;

  // ---- title banner ----
  sh.getRange(1, 1, 1, COLS).merge().setValue('🟠  PicaPool — Intent Form Dashboard')
    .setBackground(ORANGE).setFontColor('#FFFFFF').setFontSize(18).setFontWeight('bold')
    .setVerticalAlignment('middle');
  sh.setRowHeight(1, 44);
  sh.getRange(2, 1, 1, COLS).merge()
    .setValue("Live view of Submissions + Slug — updates automatically, don't edit formula cells.")
    .setBackground(CREAM_DEEP).setFontColor(SOFT).setFontStyle('italic').setVerticalAlignment('middle');
  sh.setRowHeight(2, 22);

  let r = 4;
  const section = (label) => {
    sh.getRange(r, 1, 1, COLS).merge().setValue(label)
      .setBackground(INK).setFontColor('#FFFFFF').setFontWeight('bold').setFontSize(11)
      .setVerticalAlignment('middle');
    sh.setRowHeight(r, 24);
    r++;
  };
  const blank = (h) => { sh.setRowHeight(r, h || 8); r++; };
  const put = (label, formula, color) => {
    sh.getRange(r, 1, 1, 4).merge().setValue(label).setFontWeight('bold').setVerticalAlignment('middle');
    const v = sh.getRange(r, 5, 1, 5).merge();
    v.setFormula(formula).setFontWeight('bold').setHorizontalAlignment('right')
      .setVerticalAlignment('middle').setFontColor(color || INK);
    r++;
  };
  const barRow = (label, valueExpr, denomExpr, color) => {
    sh.getRange(r, 1).setValue(label).setFontWeight('bold').setFontSize(11).setVerticalAlignment('middle');
    const val = sh.getRange(r, 8, 1, 2).merge();
    val.setFormula('=' + valueExpr).setFontWeight('bold').setHorizontalAlignment('right')
      .setFontColor(color).setVerticalAlignment('middle').setNumberFormat('#,##0');
    sh.getRange(r, 2, 1, 6).merge()
      .setFormula('=REPT("█", MIN(34, ROUND(IFERROR((' + valueExpr + ')/MAX(1,' + denomExpr + ')*34,0),0)))')
      .setFontColor(color).setFontFamily('Courier New').setVerticalAlignment('middle');
    r++;
  };
  const tableHeader = (labels) => {
    sh.getRange(r, 1, 1, labels.length).setValues([labels])
      .setBackground(CREAM).setFontColor(INK).setFontWeight('bold')
      .setBorder(true, true, true, true, false, false, '#E3DCD0', SpreadsheetApp.BorderStyle.SOLID);
    r++;
  };
  const tableBody = (formula, rows, cols) => {
    // formula goes only in the anchor cell — QUERY's array result spills
    // into the rest of this (empty) range on its own. The reserved
    // rows/cols just get the border + banding so the block looks like a
    // table even before/regardless of how many rows the query returns.
    sh.getRange(r, 1).setFormula(formula);
    const range = sh.getRange(r, 1, rows, cols);
    range.setBorder(true, true, true, true, true, true, '#E3DCD0', SpreadsheetApp.BorderStyle.SOLID);
    try { range.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false); } catch (e) {}
    r += rows;
  };

  // ---- KPI tiles ----
  const tiles = [
    { label: 'SESSIONS STARTED', formula: '=COUNTA(Submissions!A2:A)', color: INK, percent: false },
    { label: 'COMPLETED', formula: '=COUNTIF(Submissions!D2:D,"complete")', color: TEAL, percent: false },
    { label: 'COMPLETION RATE', formula: '=IFERROR(COUNTIF(Submissions!D2:D,"complete")/COUNTA(Submissions!A2:A),0)', color: ORANGE, percent: true },
    { label: 'REFERRAL SIGNUPS', formula: '=IFERROR(SUMIF(Slug!B2:B500,"referral",Slug!I2:I500),0)', color: VIOLET, percent: false }
  ];
  const tileCols = [1, 3, 5, 7];
  tiles.forEach((t, i) => {
    const c = tileCols[i];
    sh.getRange(r, c, 1, 2).merge().setValue(t.label)
      .setBackground(t.color).setFontColor('#FFFFFF').setFontSize(9).setFontWeight('bold')
      .setHorizontalAlignment('center').setVerticalAlignment('middle');
    const val = sh.getRange(r + 1, c, 2, 2).merge();
    val.setFormula(t.formula).setBackground('#FFF8F2').setFontColor(t.color)
      .setFontSize(26).setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle')
      .setNumberFormat(t.percent ? '0.0%' : '#,##0');
  });
  sh.setRowHeight(r, 20); sh.setRowHeight(r + 1, 26); sh.setRowHeight(r + 2, 26);
  r += 3;
  blank(14);

  // ---- funnel ----
  section('FUNNEL');
  barRow('Visits (all links)', 'SUMPRODUCT(Slug!F2:F500)', 'SUMPRODUCT(Slug!F2:F500)', SOFT);
  barRow('Form starts', 'COUNTA(Submissions!A2:A)', 'SUMPRODUCT(Slug!F2:F500)', ORANGE);
  barRow('Completed', 'COUNTIF(Submissions!D2:D,"complete")', 'SUMPRODUCT(Slug!F2:F500)', TEAL);
  blank();

  // ---- device breakdown ----
  section('DEVICE BREAKDOWN');
  barRow('iOS', 'COUNTIF(Submissions!R2:R2000,"ios")', 'COUNTA(Submissions!A2:A)', VIOLET);
  barRow('Android', 'COUNTIF(Submissions!R2:R2000,"android")', 'COUNTA(Submissions!A2:A)', TEAL);
  barRow('Desktop', 'COUNTIF(Submissions!R2:R2000,"desktop")', 'COUNTA(Submissions!A2:A)', ORANGE);
  blank();

  // ---- commitment breakdown ----
  section('COMMITMENT (of those who reached that screen)');
  barRow('Count me in', 'COUNTIF(Submissions!N2:N2000,"yes")', 'COUNTIF(Submissions!N2:N2000,"<>")', TEAL);
  barRow('Depends on price', 'COUNTIF(Submissions!N2:N2000,"depends")', 'COUNTIF(Submissions!N2:N2000,"<>")', GOLD);
  barRow('Just curious', 'COUNTIF(Submissions!N2:N2000,"curious")', 'COUNTIF(Submissions!N2:N2000,"<>")', FAINT);
  blank();

  // ---- brands ----
  // Everything here reads the Brands tab (one row per person per brand),
  // which rebuildBrands() derives from Submissions every 5 minutes.
  section('BRANDS — WHAT PEOPLE ACTUALLY NAMED');
  put('Distinct brands named', '=IFERROR(COUNTA(UNIQUE(FILTER(Brands!H2:H,Brands!H2:H<>""))),0)', ORANGE);
  put('Total brand picks', '=COUNTA(Brands!H2:H)', INK);
  put('Hand-typed ("Others") picks', '=COUNTIF(Brands!I2:I,"typed")', VIOLET);
  blank();

  // a QUERY with `group by` always emits a label row ("count") ahead of its
  // results, which the plain selects elsewhere on this sheet don't. Wrapping
  // it in an outer `select * offset 1` drops that row so the results line up
  // under the header we drew ourselves.
  const grouped = (range, select, fallback) =>
    '=IFERROR(QUERY(QUERY(' + range + ',"' + select + '", 0), "select * offset 1", 0), "' + fallback + '")';

  section('TOP BRANDS (by number of people)');
  tableHeader(['Brand', 'Category', 'Sub-category', 'People']);
  tableBody(
    grouped('Brands!A2:I20000',
      'select H, F, G, count(A) where H is not null group by H, F, G order by count(A) desc limit 25',
      'No brand picks yet'),
    25, 4
  );
  blank();

  // the demand signal that isn't on any chip yet — read this before the
  // next round to decide which brands to promote into the options list
  section('TYPED INTO THE "OTHERS" BOX — BRANDS');
  tableHeader(['Brand typed', 'Category', 'Sub-category', 'People']);
  tableBody(
    grouped('Brands!A2:I20000',
      'select H, F, G, count(A) where I = \'typed\' group by H, F, G order by count(A) desc limit 25',
      'Nobody has typed a brand yet'),
    25, 4
  );
  blank();

  section('TYPED INTO THE "OTHERS" BOX — CATEGORIES');
  tableHeader(['Category typed', 'People']);
  tableBody(
    grouped('Submissions!A2:AD20000',
      'select K, count(A) where K <> \'\' group by K order by count(A) desc limit 15',
      'Nobody has typed a category yet'),
    15, 2
  );
  blank();

  section('BRANDS PER PERSON (most recent)');
  tableHeader(['Name', 'Phone', 'Status', '# brands', 'Brands they picked', 'Typed in "Others"']);
  tableBody(
    '=IFERROR(QUERY(Submissions!A2:AD20000,' +
    '"select H, I, D, AC, AA, AB where H <> \'\' order by C desc limit 25", 0), "No submissions yet")',
    25, 6
  );
  blank();

  // ---- engagement links table ----
  section('ENGAGEMENT LINKS');
  tableHeader(['Link', 'Total clicks (all visitors)', 'Unique users (named)']);
  const engRows = [
    ['WhatsApp group', '=SUMPRODUCT(((Slug!A2:A500="wa")+(Slug!A2:A500="wa_group")+(Slug!A2:A500="whatsapp"))*Slug!G2:G500)', '=COUNTIF(Submissions!V2:V2000,"<>")'],
    ['Buying group', '=SUMPRODUCT(((Slug!A2:A500="buy")+(Slug!A2:A500="buying_group")+(Slug!A2:A500="buying"))*Slug!G2:G500)', '=COUNTIF(Submissions!W2:W2000,"<>")'],
    ['App download', '=IFERROR(SUMIF(Slug!A2:A500,"app_download",Slug!G2:G500),0)', '=COUNTIF(Submissions!X2:X2000,"<>")'],
    ['Referral shares', '=IFERROR(SUMIF(Slug!A2:A500,"referral_share",Slug!G2:G500),0)', '=COUNTIF(Submissions!Y2:Y2000,"<>")']
  ];
  const engRange = sh.getRange(r, 1, engRows.length, 3);
  engRange.setValues(engRows);
  engRange.setBorder(true, true, true, true, true, true, '#E3DCD0', SpreadsheetApp.BorderStyle.SOLID);
  try { engRange.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false); } catch (e) {}
  r += engRows.length;
  blank();

  // ---- referrals ----
  section('REFERRALS');
  put('Total referral codes created', '=COUNTIF(Slug!B2:B500,"referral")', VIOLET);
  put('Total signups via referral', '=IFERROR(SUMIF(Slug!B2:B500,"referral",Slug!I2:I500),0)', VIOLET);
  blank();

  // ---- top campaign / slug links ----
  section('TOP CAMPAIGN / SLUG LINKS (by visits)');
  tableHeader(['Slug', 'Type', 'Destination / owner', 'Visits', 'Clicks', 'Form starts', 'Completions']);
  tableBody(
    '=IFERROR(QUERY(Slug!A2:I500,' +
    '"select A, B, C, F, G, H, I where A is not null order by F desc limit 15", 0), "No data yet")',
    15, 7
  );
  blank();

  // ---- top referrers ----
  section('TOP REFERRERS (by signups)');
  tableHeader(['Referral code', 'Referrer', 'Visits', 'Form starts', 'Completions']);
  tableBody(
    '=IFERROR(QUERY(Slug!A2:I500,' +
    '"select A, C, F, H, I where B = \'referral\' order by I desc, H desc limit 15", 0), "No referrals yet")',
    15, 5
  );
  blank();

  // ---- who clicked what ----
  section('WHO CLICKED WHAT (name, phone, every link they tapped)');
  tableHeader(['Name', 'Phone', 'Status', 'WA group', 'Buying group', 'App download', 'Referral share']);
  tableBody(
    '=IFERROR(QUERY(Submissions!A2:Z2000,' +
    '"select H, I, D, V, W, X, Y where H <> \'\' order by C desc limit 25", 0), "No submissions yet")',
    25, 7
  );
  blank();

  // ---- recent completions ----
  section('RECENT COMPLETED SUBMISSIONS');
  tableHeader(['Name', 'Phone', 'Slug', 'Referred by', 'Categories', 'Commitment', 'Completed at']);
  tableBody(
    '=IFERROR(QUERY(Submissions!A2:Z2000,' +
    '"select H, I, E, F, J, N, C where D = \'complete\' order by C desc limit 20", 0), "No completions yet")',
    20, 7
  );

  sh.setColumnWidth(1, 190);
  for (let c = 2; c <= COLS; c++) sh.setColumnWidth(c, 105);
  sh.setFrozenRows(2);
}
