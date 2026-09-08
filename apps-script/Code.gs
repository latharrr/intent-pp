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
// 1-based column indexes, kept in sync with SUBMISSION_HEADERS above
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
  // schema grew since this sheet was first set up — append only what's
  // missing, at the end, never touching existing columns or data.
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
    epochToDate(body.referralCopiedAt)
  ];

  const wasComplete = row > 0 && sh.getRange(row, S_STATUS).getValue() === 'complete';
  if (row > 0) {
    sh.getRange(row, 1, 1, rowData.length).setValues([rowData]);
  } else {
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
