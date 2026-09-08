/**
 * Picapool intent form — backend
 * ================================
 * This script turns a Google Sheet into the database for the intent form.
 * It creates/maintains 3 tabs: Dashboard, Submissions, Slug.
 *
 * ONE-TIME SETUP
 * 1. Create a blank Google Sheet (this becomes the database).
 * 2. Extensions > Apps Script. Delete the default code, paste this whole file.
 * 3. In the function dropdown (top toolbar) pick "setupSheets", click Run.
 *    Approve the permissions prompt. This creates the 3 tabs with headers,
 *    conditional formatting (red = partial, green = complete) and the
 *    Dashboard formulas.
 * 4. Deploy > New deployment > type "Web app".
 *      Execute as: Me
 *      Who has access: Anyone
 *    Click Deploy, copy the "Web app URL" (ends in /exec).
 * 5. Paste that URL into API_BASE near the top of index.html, redeploy the
 *    site. That's it — the form now writes to this sheet.
 *
 * If you ever add new columns to SUBMISSION_HEADERS / SLUG_HEADERS, re-run
 * setupSheets() — it only adds missing headers, it never deletes data.
 */

const SUBMISSIONS_SHEET = 'Submissions';
const SLUG_SHEET = 'Slug';
const DASHBOARD_SHEET = 'Dashboard';

const SUBMISSION_HEADERS = [
  'sessionId', 'firstSeen', 'lastUpdated', 'status', 'slug', 'referredBy', 'myRefCode',
  'name', 'phone', 'categories', 'otherCategoryText', 'categoriesFilled', 'categoriesTotal',
  'commitment', 'currentScreen', 'screensReached', 'totalScreens', 'device', 'userAgent',
  'brandSelJSON', 'eventsJSON',
  // per-user click detail — who clicked what, and when (blank = never clicked)
  'waGroupClickedAt', 'buyingGroupClickedAt', 'appDownloadClickedAt',
  'referralSharedAt', 'referralCopiedAt'
];
// column indexes (1-based) for quick reference
const S_SESSION = 1, S_FIRSTSEEN = 2, S_LASTUPDATED = 3, S_STATUS = 4, S_SLUG = 5;

const SLUG_HEADERS = [
  'slug', 'type', 'destinationOrOwner', 'firstSeen', 'lastSeen',
  'visits', 'clicks', 'formStarts', 'formCompletions'
];
const L_SLUG = 1, L_TYPE = 2, L_DEST = 3, L_FIRSTSEEN = 4, L_LASTSEEN = 5,
      L_VISITS = 6, L_CLICKS = 7, L_STARTS = 8, L_COMPLETIONS = 9;

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
  } finally {
    lock.releaseLock();
  }
  return textOut('ok');
}

function doGet(e) {
  return textOut('Picapool intent backend is live.');
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
function getSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    return sh;
  }
  const lastCol = sh.getLastColumn();
  const existing = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  if (!existing[0]) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    return sh;
  }
  // schema grew since this sheet was first set up (e.g. new tracked
  // columns added later) — append only what's missing, never touch
  // existing columns or data.
  const missing = headers.filter(h => existing.indexOf(h) === -1);
  if (missing.length) {
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
   SUBMISSIONS — one row per visitor session, upserted on
   every screen change. Red while partial, green once the
   'final' screen is reached (see conditional formatting).
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
    epochToDate(body.referralCopiedAt)
  ];

  const wasComplete = row > 0 && sh.getRange(row, S_STATUS).getValue() === 'complete';
  if (row > 0) {
    sh.getRange(row, 1, 1, rowData.length).setValues([rowData]);
  } else {
    sh.appendRow(rowData);
  }

  // only bump the completions counter once per session
  if (body.status === 'complete' && !wasComplete) {
    bumpSlugCounter(body.slug, L_COMPLETIONS);
  }
}

/* =========================================================
   SLUG — one row per trackable link (campaign tag, referral
   code, or a reserved redirect shortlink like /wa or /buy).
   Upserted on every visit/click.
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
    const newRow = [
      body.slug,
      body.redirectType || 'campaign',
      body.dest || '',
      now, now,
      body.kind === 'visit' ? 1 : 0,
      body.kind === 'click' ? 1 : 0,
      0, 0
    ];
    sh.appendRow(newRow);
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

/* pre-registers a referral code with its owner's name, so the
   Dashboard can show "who brought how many people" even before
   that referral link gets its first click. */
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
   ONE-TIME SETUP
========================================================= */
function setupSheets() {
  getSheet(SUBMISSIONS_SHEET, SUBMISSION_HEADERS);
  getSheet(SLUG_SHEET, SLUG_HEADERS);
  applyConditionalFormatting();
  buildDashboard();
  SpreadsheetApp.getActiveSpreadsheet().toast('Setup complete: Dashboard, Submissions, Slug are ready.');
}

function applyConditionalFormatting() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SUBMISSIONS_SHEET);
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

function buildDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(DASHBOARD_SHEET);
  if (!sh) sh = ss.insertSheet(DASHBOARD_SHEET, 0);
  sh.clear();
  sh.setTabColor('#FF4B18');

  sh.getRange('A1').setValue('Picapool — Intent Form Dashboard')
    .setFontSize(16).setFontWeight('bold');
  sh.getRange('A2').setValue('Auto-updates from Submissions + Slug. Do not edit formula cells.')
    .setFontStyle('italic').setFontColor('#666666');

  // build top-to-bottom with a running cursor so section positions never
  // have to be hand-counted again when rows are added/removed above.
  let r = 3;
  const bold = (row, cols) => sh.getRange(row, 1, 1, cols || 1).setFontWeight('bold');
  const put = (label, formula) => { sh.getRange(r, 1, 1, 2).setValues([[label, formula || '']]); r++; };
  const section = (label) => { put(label); bold(r - 1); };
  const blank = () => { r++; };
  const queryBlock = (formula, reserve) => {
    sh.getRange(r, 1).setFormula(formula);
    r += reserve; // leave room for however many result rows the query can return
  };

  section('OVERVIEW');
  put('Total sessions started', '=COUNTA(Submissions!A2:A)');
  put('Completed submissions', '=COUNTIF(Submissions!D2:D,"complete")');
  put('Partial / dropped off', '=COUNTIF(Submissions!D2:D,"partial")');
  put('Completion rate', '=IFERROR(COUNTIF(Submissions!D2:D,"complete")/COUNTA(Submissions!A2:A),0)');
  put('Avg categories filled (completed)', '=IFERROR(AVERAGEIF(Submissions!D2:D,"complete",Submissions!L2:L),0)');
  blank();

  section('ENGAGEMENT LINKS (total clicks, all visitors)');
  put('WhatsApp group — clicks', '=SUMPRODUCT(((Slug!A2:A500="wa")+(Slug!A2:A500="wa_group")+(Slug!A2:A500="whatsapp"))*Slug!G2:G500)');
  put('Buying group — clicks', '=SUMPRODUCT(((Slug!A2:A500="buy")+(Slug!A2:A500="buying_group")+(Slug!A2:A500="buying"))*Slug!G2:G500)');
  put('App download — clicks', '=IFERROR(SUMIF(Slug!A2:A500,"app_download",Slug!G2:G500),0)');
  put('Referral link shares (tap)', '=IFERROR(SUMIF(Slug!A2:A500,"referral_share",Slug!G2:G500),0)');
  blank();

  section('ENGAGEMENT LINKS (unique named users, from Submissions)');
  put('Users who clicked WA group', '=COUNTIF(Submissions!V2:V2000,"<>")');
  put('Users who clicked buying group', '=COUNTIF(Submissions!W2:W2000,"<>")');
  put('Users who clicked app download', '=COUNTIF(Submissions!X2:X2000,"<>")');
  put('Users who shared their referral link', '=COUNTIF(Submissions!Y2:Y2000,"<>")');
  blank();

  section('REFERRALS');
  put('Total referral codes created', '=COUNTIF(Slug!B2:B500,"referral")');
  put('Total signups via referral', '=SUMIF(Slug!B2:B500,"referral",Slug!I2:I500)');
  blank();

  section('TOP CAMPAIGN / SLUG LINKS (by visits)');
  queryBlock(
    '=IFERROR(QUERY(Slug!A2:I500,' +
    '"select A, B, C, F, G, H, I where A is not null order by F desc limit 15", 0), "No data yet")',
    16
  );

  section('TOP REFERRERS (by signups)');
  queryBlock(
    '=IFERROR(QUERY(Slug!A2:I500,' +
    '"select A, C, F, H, I where B = \'referral\' order by I desc, H desc limit 15", 0), "No referrals yet")',
    16
  );

  section('WHO CLICKED WHAT (name, phone, and every link they tapped)');
  queryBlock(
    '=IFERROR(QUERY(Submissions!A2:Z2000,' +
    '"select H, I, D, V, W, X, Y where H <> \'\' order by C desc limit 25", 0), "No submissions yet")',
    26
  );

  section('RECENT COMPLETED SUBMISSIONS');
  queryBlock(
    '=IFERROR(QUERY(Submissions!A2:Z2000,' +
    '"select H, I, E, F, J, N, C where D = \'complete\' order by C desc limit 20", 0), "No completions yet")',
    21
  );

  sh.autoResizeColumns(1, 9);
  sh.setColumnWidth(1, 260);
}
