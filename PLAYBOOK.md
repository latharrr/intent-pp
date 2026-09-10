# HTML → Tracked Website Playbook

**What this is:** a single, self-contained spec for turning *any* static
HTML page (a form, a landing page, a quiz, a waitlist — anything with
screens and taps) into a live website with:

- branding, resume-where-you-left-off, and device-smart outbound links
- a full click/visit/referral tracking layer
- a Google Sheet as the database — no server, no hosting bill for the
  backend, and the *client* (whoever owns the product) can read/query/pivot
  it themselves with zero technical help

It is the distilled, hard-won result of building exactly this for the
PicaPool intent form (this repo). Every pattern in here exists because a
simpler version of it broke in production first — each one says why.

**How to use it:** hand this file + a target `.html` file to an agent (or
follow it yourself) with an instruction like *"apply PLAYBOOK.md to
`landing.html`."* Do **Step 0** first, always — nothing else can be decided
correctly until you know what's actually on the page.

**The one rule above all others:** never touch the target HTML's existing
markup, copy, styling, or structure. Everything here is additive — a
`<script>` block, a few DOM nodes injected at runtime, a header bar. If a
change requires rewriting what's already there, it doesn't belong in this
playbook.

---

## Step 0 — Inventory the target page (do this first, always)

Before writing a line of code, answer these by reading the HTML:

1. **What are the "screens"?** A single-page form usually shows one
   `<div>` at a time via JS (`state.pos` / `currentId()`-style routing). If
   the page is a single static scroll instead, there's one screen and
   "resume where you left off" degrades to "scroll position" or is skipped
   entirely — say so rather than forcing the pattern.
2. **What identifies a person?** Name + phone, email, just a phone, nothing
   at all (anonymous quiz)? This becomes the columns you sort/search the
   Sheet by, and what "Who clicked what" and "Recent completions" key off.
3. **What counts as "complete"?** The last screen reached, a specific
   button pressed, a specific field filled? This drives the
   partial/complete split (red/green rows) and the completion-rate KPI.
4. **What repeatable/multi-select data exists?** Checkboxes, chip-pickers,
   multi-category selectors, "type your own" free-text boxes. If a field
   can hold *multiple* values per person (like PicaPool's brand picks),
   plan for a derived long-format detail tab (see **Brands tab pattern**
   below) — don't try to cram it into one Submissions cell and call it
   done, that's unreadable and unqueryable.
5. **What outbound links/CTAs exist?** WhatsApp/Telegram groups, app store
   links, "invite a friend," external deals — anything with an `<a href>`
   or button that leaves the page. Each becomes a `data-track-cta` +
   Dashboard row.
6. **Is there an app to link to?** Check if a smart-link service already
   exists for it (Branch, Instally, AppsFlyer, a plain "download page" URL
   that itself detects device) — if so, use that single link and skip
   writing your own UA-sniffing branch entirely. Only hand-roll iOS/Android
   detection if no such link exists.
7. **Any incentive actually attached to sharing/referring?** If the answer
   is "not yet," track referrals internally (still useful data) but do
   **not** put a promise on the page you can't back ("every friend who
   fills this counts toward you") — that erodes trust for nothing. Surface
   it later once there's a real mechanism.

Write the answers down (even just as a comment block at the top of the new
`<script>` section) — they're what every placeholder below gets filled in
with.

---

## Step 1 — Frontend additions

All of this goes inside the existing HTML's `<head>`/`<body>`, additive
only. Sections marked **[COPY VERBATIM]** are page-agnostic utility code —
paste them as-is. Sections marked **[DERIVE FROM STEP 0]** need field names
specific to the target page.

### 1.1 Branding header **[DERIVE FROM STEP 0]**

Use whatever header space the existing layout has. If the user supplies an
actual logo file, use it as a real asset (inline it as a base64 `data:`
URI if the page is a single self-contained HTML file, so nothing external
has to load) — do not hand-draw an approximation when a real file exists.

```html
<div class="brand-header">
  <span class="brand-mark"><img src="data:image/png;base64,{{LOGO_BASE64}}" alt="{{BRAND_NAME}}" style="width:100%;height:100%;object-fit:contain;"></span>
  <span class="brand-word">{{BRAND_NAME}}</span>
</div>
```

### 1.2 Config block **[DERIVE FROM STEP 0 for the link values; COPY the structure]**

```js
/* ---- links this page cares about ---- */
const PRIMARY_GROUP_LINK = 'https://chat.whatsapp.com/XXXX'; // or Telegram, Discord, etc.
const APP_SMART_LINK     = 'https://your-app.example/smart-link'; // Instally/Branch/etc if one exists

/* ---- backend ---- */
const API_BASE = 'https://script.google.com/macros/s/XXXX/exec'; // filled in after Step 2 deploy

/* Which build of this file is live. Rides along on every submission as
   `clientBuild`, so the Sheet itself answers "did the redeploy happen" —
   a row stamped with an old build came from a page that never got
   redeployed, and no backend work fixes that. Bump on every meaningful
   change to this file. */
const BUILD = '{{YYYY-MM-DD}}-a';

/* ?debug=1 pins a readout to the screen: build, session id, and the
   result of every beacon as it fires. It is the ONLY way to see whether
   the page is even trying to talk to the backend — sendBeacon reports
   nothing and deliberately survives the tab closing, so a silent failure
   is otherwise invisible. Wire debugLog() (1.5) into every beacon call. */
const DEBUG = (function(){
  try{ return new URLSearchParams(window.location.search).has('debug'); }
  catch(e){ return false; }
})();

/* Reserved slugs that act as trackable REDIRECT shortlinks rather than
   page-entry tags — e.g. yoursite.com/wa bounces straight to the group
   after logging a click, never showing the page at all. Add more any
   time, no backend change needed. */
const REDIRECT_SLUGS = {
  'wa': { dest: PRIMARY_GROUP_LINK, type: 'group' }
  // 'insta': { dest: 'https://instagram.com/...', type: 'social' },
};
```

### 1.3 Session, slug, device, referral bootstrapping **[COPY VERBATIM]**

```js
const STORAGE_KEY = '{{project}}_intent_state_v1';
const SESSION_KEY = '{{project}}_intent_session_v1';

function newSessionId(){
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2,10);
}

/* The session id lives in localStorage and deliberately NEVER rotates —
   that's what makes "come back tomorrow, resume on the same screen" work,
   and it's why the backend UPSERTS on sessionId rather than appending.
   ?new=1 / ?fresh=1 wipes it for testing or a shared/demo device. */
function isFreshRequest(){
  try{
    const q = new URLSearchParams(window.location.search);
    return q.has('new') || q.has('fresh');
  }catch(e){ return false; }
}
function getSessionId(){
  try{
    if(isFreshRequest()){
      localStorage.removeItem(STORAGE_KEY);
      const fresh = newSessionId();
      localStorage.setItem(SESSION_KEY, fresh);
      return fresh;
    }
    let id = localStorage.getItem(SESSION_KEY);
    if(!id){ id = newSessionId(); localStorage.setItem(SESSION_KEY, id); }
    return id;
  }catch(e){ return newSessionId(); }
}
const SESSION_ID = getSessionId();

function makeCode(len){
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — avoids misreads
  let out = '';
  for(let i=0;i<len;i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
}

function getUrlSlug(){
  const path = window.location.pathname.replace(/^\/+|\/+$/g, '');
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}
function getUrlParam(name){
  try{ return new URLSearchParams(window.location.search).get(name) || ''; }catch(e){ return ''; }
}
const urlSlug = getUrlSlug();
const entrySlug = urlSlug && !REDIRECT_SLUGS[urlSlug.toLowerCase()] ? urlSlug : (getUrlParam('s') || getUrlParam('slug') || 'direct');
const incomingRef = getUrlParam('ref') || getUrlParam('r') || '';

function detectDevice(){
  const ua = navigator.userAgent || '';
  if(/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if(/Android/i.test(ua)) return 'android';
  return 'desktop';
}
const DEVICE = detectDevice();
```

### 1.4 Redirect shortlinks resolve before anything renders **[COPY VERBATIM]**

Must run before the page draws its first screen — this is what makes
`yoursite.com/wa` behave as a pure redirect instead of flashing the page.

```js
let REDIRECTING = false;
(function resolveRedirectSlug(){
  const key = urlSlug.toLowerCase();
  const target = REDIRECT_SLUGS[key];
  if(target){
    REDIRECTING = true;
    trackSlugEvent(key, 'click', { redirectType: target.type });
    window.location.replace(target.dest);
  }
})();
```

### 1.5 Debug overlay **[COPY VERBATIM]**

```js
let debugBox = null;
const debugLines = [];
function debugLog(msg){
  if(!DEBUG) return;
  debugLines.push(new Date().toLocaleTimeString() + '  ' + msg);
  while(debugLines.length > 14) debugLines.shift();
  try{
    if(!debugBox){
      debugBox = document.createElement('div');
      debugBox.setAttribute('style',
        'position:fixed;left:0;right:0;bottom:0;z-index:99999;max-height:45vh;overflow:auto;' +
        'background:#15130F;color:#8CE0B4;font:11px/1.45 ui-monospace,Menlo,monospace;' +
        'padding:8px 10px;white-space:pre-wrap;word-break:break-all;border-top:2px solid #FF4B18');
      document.body.appendChild(debugBox);
    }
    debugBox.textContent =
      'build ' + BUILD + '\nsession ' + SESSION_ID + '\napi ' + API_BASE.slice(0, 62) + '…\n\n' +
      debugLines.join('\n');
  }catch(e){}
}
```

### 1.6 The beacon — reliable fire-and-forget POST **[COPY VERBATIM]**

This is the single most important piece of plumbing in the whole system.
`fetch()` alone silently drops requests the instant a tab closes or
navigates away — and a *lot* of taps happen right before someone leaves
(closing the tab, switching to WhatsApp). `sendBeacon` is the browser's
guarantee that the request is still attempted after the page is gone.

```js
function beacon(payload){
  if(!API_BASE || API_BASE.indexOf('REPLACE_WITH') === 0){ debugLog('no API_BASE set'); return; }
  const body = JSON.stringify(payload);
  try{
    if(navigator.sendBeacon){
      const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
      const ok = navigator.sendBeacon(API_BASE, blob);
      debugLog((ok ? 'beacon ok  ' : 'beacon REFUSED ') + payload.action + ' ' + body.length + 'b');
      if(ok) return;
    } else {
      debugLog('no sendBeacon, using fetch');
    }
  }catch(e){ debugLog('beacon threw: ' + e.message); }
  try{
    debugLog('fetch fallback ' + payload.action);
    fetch(API_BASE, {
      method: 'POST', mode: 'no-cors', keepalive: true,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body
    }).catch(()=>{});
  }catch(e){}
}

function trackSlugEvent(slug, kind, extra){
  beacon(Object.assign({
    action: 'track', slug: slug, kind: kind, // kind: 'visit' | 'click'
    sessionId: SESSION_ID, device: DEVICE, ts: Date.now(), ua: navigator.userAgent || ''
  }, extra || {}));
}

function logEvent(screenId, action){
  state.events.push({ t: Date.now(), screen: screenId, action: action || 'view' });
  if(state.events.length > 300) state.events = state.events.slice(-300); // cap, don't grow unbounded
}

/* records a click on a specific outbound link (group, app download, invite,
   etc.) against THIS user's own row — not just an aggregate counter — so
   opening their row shows exactly what they did and when. */
function logClick(type){
  state.clicks[type] = Date.now();
  logEvent(currentId(), 'click_' + type);
  flushProgress();
}
```

Wire it to every outbound CTA found in Step 0:

```html
<a href="{{DEST}}" target="_blank" rel="noopener" data-track-cta="{{cta_key}}">…</a>
```
```js
document.querySelectorAll('[data-track-cta]').forEach(el => {
  el.addEventListener('click', () => {
    trackSlugEvent(el.dataset.trackCta, 'click', { redirectType: el.dataset.trackCta });
    logClick(el.dataset.trackCta);
  });
});
```

### 1.7 State + progress persistence **[DERIVE the field list, COPY the mechanism]**

```js
const state = {
  pos: 0, order: [/* {{screen ids in order, from Step 0}} */],
  // {{...whatever fields Step 0 identified: name, phone, picks, etc.}}
  events: [],
  myRefCode: null,
  clicks: { /* one key per data-track-cta value, e.g. */ group: 0, app_download: 0, referral_share: 0 }
};

function saveLocal(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      pos: state.pos, order: state.order, /* ...same field list as above... */,
      events: state.events, myRefCode: state.myRefCode, clicks: state.clicks
    }));
  }catch(e){}
}
function restoreLocal(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return false;
    Object.assign(state, JSON.parse(raw));
    return true;
  }catch(e){ return false; }
}
```

Call `restoreLocal()` before the first render, and jump straight to
`state.pos` instead of screen 0 — that's the entire "resume where you left
off" feature; no special-case UI needed.

### 1.8 The submission payload **[DERIVE FROM STEP 0]**

One function that assembles everything the Sheet needs to know about this
person, called on every screen change and on every click.

```js
function buildSubmissionPayload(status){ // status: 'partial' | 'complete'
  return {
    action: 'submit',
    sessionId: SESSION_ID, ts: Date.now(), status: status,
    slug: entrySlug, referredBy: incomingRef, myRefCode: state.myRefCode || '',
    // {{...identity + answer fields from Step 0, e.g. name, phone, picks...}}
    currentScreen: currentId(), screensReached: state.pos, totalScreens: state.order.length - 1,
    // {{...one *ClickedAt field per data-track-cta key, from state.clicks...}}
    device: DEVICE, userAgent: navigator.userAgent || '',
    eventsJSON: JSON.stringify(state.events.slice(-100)),
    clientBuild: BUILD
  };
}
```

### 1.9 Debounced sync + unload-safe flush **[COPY VERBATIM]**

```js
let syncTimer = null;
function flushProgress(){
  if(syncTimer){ clearTimeout(syncTimer); syncTimer = null; }
  const status = currentId() === '{{final_screen_id}}' ? 'complete' : 'partial';
  beacon(buildSubmissionPayload(status));
}
function syncProgress(){ // call this on every screen change / meaningful input
  saveLocal();
  if(syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(flushProgress, 700); // debounced so rapid taps don't spam the backend
}

/* The debounce above is fine while someone's actively tapping through, but
   if they close the tab / switch apps before it fires, that setTimeout
   never runs and the latest state is lost. Force an immediate flush the
   moment the tab is hidden or about to unload — this is also exactly what
   makes "tap a WhatsApp link, come back, land on the same screen" work:
   the flush on hide fires before the OS switches apps. */
window.addEventListener('pagehide', flushProgress);
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'hidden') flushProgress();
});
```

### 1.10 Referral link (internal tracking, no UI promise unless there's a real incentive)

```js
function ensureReferralCode(){
  if(state.myRefCode) return state.myRefCode;
  state.myRefCode = makeCode(6);
  beacon({ action: 'createLink', slug: state.myRefCode, type: 'referral',
    owner: /* {{identity field, e.g. state.name}} */ '' || state.phone || 'anonymous',
    sessionId: SESSION_ID, ts: Date.now() });
  saveLocal();
  return state.myRefCode;
}
function referralUrl(){ return window.location.origin + '/' + ensureReferralCode(); }
```

Use it inside a normal "invite a friend" share action (`navigator.share` or
a `wa.me/?text=` link). Do **not** build a standalone "here's your referral
link, copy it, every friend counts toward you" card unless there's an
actual reward mechanism behind it — see Step 0, point 7.

### 1.11 Guard every optional browser API the same way

This is a general pattern, not just for audio. **Any** browser API that
might not exist — Web Audio, `navigator.share`, `navigator.vibrate`,
`navigator.clipboard` — must never be able to throw and kill the rest of
the page. In-app WhatsApp/Instagram webviews and locked-down Android
WebViews (how most people open a shared link) refuse to construct a lot of
these, and an uncaught error at the top level of a `<script>` block stops
*every* line after it: rendering, event binding, and every tracking
beacon. The page sits there dead and the Sheet never sees a row.

```js
let audioContext = null, audioUnavailable = false;
function audio(){
  if(audioUnavailable) return null;
  if(!audioContext){
    try{
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if(!Ctx){ audioUnavailable = true; return null; }
      audioContext = new Ctx();
    }catch(e){ audioUnavailable = true; return null; }
  }
  if(audioContext.state === 'suspended'){ try{ audioContext.resume(); }catch(e){} }
  return audioContext;
}
function withAudio(play){ const ctx = audio(); if(!ctx) return; try{ play(ctx); }catch(e){} }
```

Apply the same shape — lazy construction inside a `try`, a "this doesn't
exist here" flag, every call site wrapped — to anything decorative. Nothing
optional should ever be able to take down something load-bearing.

### 1.12 Initial visit log **[COPY VERBATIM]**

```js
const RESUMED = restoreLocal();
trackSlugEvent(entrySlug, 'visit', { resumed: RESUMED, ref: incomingRef });
if(!REDIRECTING){
  if(RESUMED) /* jump straight to state.pos instead of screen 0 */;
  render();
}
```

---

## Step 2 — Backend: Google Apps Script + Sheet

One Google Sheet is the database. One Apps Script project (bound to that
Sheet) is the API. No server, no hosting cost, the sheet owner can read
everything with zero technical help.

### 2.1 Tabs

| Tab | Purpose |
|---|---|
| **Dashboard** | Human-facing: KPI tiles, funnel, breakdowns, tables. Fully formula-driven — nothing written here directly, only rebuilt. |
| **Submissions** | One row per person, upserted on every screen change. Red while partial, green once complete. |
| **Slug** | One row per trackable link (campaign tag, referral code, or a reserved redirect shortlink). Upserted on every visit/click. |
| **{{Detail}}** *(only if Step 0 found repeatable/multi-select data)* | One row per (person, item) — see **Brands tab pattern** below. |
| **Errors** | Every uncaught backend exception, since `sendBeacon` throws the response away — without this, a broken backend fails completely silently. |

### 2.2 Skeleton — **[COPY VERBATIM]**, page-agnostic

```js
/* Bumped whenever this file changes meaningfully, reported by doGet(). A
   Web App deployment serves a PINNED VERSION: pasting new code into the
   editor does not change what /exec runs until you publish a new version
   (Deploy > Manage deployments > pencil > Version: New version). Compare
   this against the file you pasted — if they differ, the live backend is
   not the code you're reading and nothing you change is having any effect. */
const CODE_VERSION = '{{YYYY-MM-DD}}-a';

const SUBMISSIONS_SHEET = 'Submissions';
const SLUG_SHEET = 'Slug';
const DASHBOARD_SHEET = 'Dashboard';

// NEVER reorder or insert into this list — handleSubmit writes a row
// positionally from column 1, and getSheet() only ever APPENDS newly-added
// headers at the end. New fields go on the end, or old sheets shift.
const SUBMISSION_HEADERS = [
  'sessionId', 'firstSeen', 'lastUpdated', 'status', 'slug', 'referredBy', 'myRefCode',
  /* {{...identity + answer fields, same order as buildSubmissionPayload...}} */
  'currentScreen', 'screensReached', 'totalScreens', 'device', 'userAgent', 'eventsJSON',
  /* {{...one *ClickedAt column per CTA...}} */
  'clientBuild'
];
const S_SESSION = 1, S_FIRSTSEEN = 2, S_LASTUPDATED = 3, S_STATUS = 4, S_SLUG = 5;

const SLUG_HEADERS = [
  'slug', 'type', 'destinationOrOwner', 'firstSeen', 'lastSeen',
  'visits', 'clicks', 'formStarts', 'formCompletions'
];
const L_SLUG = 1, L_TYPE = 2, L_DEST = 3, L_FIRSTSEEN = 4, L_LASTSEEN = 5,
      L_VISITS = 6, L_CLICKS = 7, L_STARTS = 8, L_COMPLETIONS = 9;

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
    // sendBeacon throws the response away — an uncaught error here is a
    // write that vanishes with nothing to see on either side. Log it.
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
    sh.appendRow([new Date(), (body && body.action) || '', (body && body.sessionId) || '',
      String((err && err.message) || err).slice(0, 500), JSON.stringify(body || {}).slice(0, 2000)]);
  } catch (ignored) { console.error('logError failed', ignored, err); }
}

/* Open the /exec URL in a browser: counts, newest submission, build-stamp
   breakdown, last error. Beats guessing when "a row doesn't show up". */
function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const status = { ok: true, codeVersion: CODE_VERSION, now: new Date() };
  try {
    const sub = ss.getSheetByName(SUBMISSIONS_SHEET);
    status.submissions = sub ? Math.max(0, sub.getLastRow() - 1) : 0;
    status.columns = sub ? sub.getLastColumn() : 0;
    status.expectedColumns = SUBMISSION_HEADERS.length;
    if (sub && sub.getLastRow() > 1) {
      const c = colMap(sub);
      const rows = sub.getRange(2, 1, sub.getLastRow() - 1, sub.getLastColumn()).getValues();
      let newest = null; const builds = {};
      rows.forEach(r => {
        const t = c.lastUpdated ? r[c.lastUpdated - 1] : null;
        if (t && (!newest || t > newest)) newest = t;
        const b = c.clientBuild ? (r[c.clientBuild - 1] || '(none)') : '(no column)';
        builds[b] = (builds[b] || 0) + 1;
      });
      status.clientBuilds = builds; // if the newest rows aren't the current BUILD, the page never redeployed
      status.lastSubmissionAt = newest;
    }
    const errs = ss.getSheetByName(ERROR_SHEET);
    status.errors = errs ? Math.max(0, errs.getLastRow() - 1) : 0;
    if (errs && errs.getLastRow() > 1) {
      const last = errs.getRange(errs.getLastRow(), 1, 1, 4).getValues()[0];
      status.lastError = { at: last[0], action: last[1], message: last[3] };
    }
  } catch (err) { status.ok = false; status.message = String((err && err.message) || err); }
  return ContentService.createTextOutput(JSON.stringify(status, null, 2)).setMimeType(ContentService.MimeType.JSON);
}

function textOut(msg) { return ContentService.createTextOutput(msg).setMimeType(ContentService.MimeType.TEXT); }
function epochToDate(ms) { return ms ? new Date(Number(ms)) : ''; }

/* A Sheet tab is created 1000 rows x 26 columns and does NOT grow on its
   own: getRange() past those bounds THROWS, it doesn't widen the grid. A
   schema that fits 26 columns never hits this — the moment it grows past
   26, every single getSheet() call starts throwing, and since a bare
   doPost has no catch, every write fails silently behind a discarded
   sendBeacon response. Call this before any range that could sit outside
   what the sheet currently has (rows OR columns). */
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
  for (let i = 0; i < values.length; i++) { if (values[i][0] === key) return i + 2; }
  return -1;
}

/* header name -> 1-based column. Use this instead of hardcoded column
   letters anywhere you're reading a sheet that getSheet() might have
   appended columns to since the code doing the reading was last touched. */
function colMap(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return {};
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  headers.forEach((h, i) => { if (h) map[h] = i + 1; });
  return map;
}

function handleSubmit(body) {
  const sh = getSheet(SUBMISSIONS_SHEET, SUBMISSION_HEADERS);
  const row = findRow(sh, S_SESSION, body.sessionId);
  const now = new Date();
  const firstSeen = row > 0 ? sh.getRange(row, S_FIRSTSEEN).getValue() : now;

  const rowData = [
    body.sessionId, firstSeen, now, body.status || 'partial',
    body.slug || '', body.referredBy || '', body.myRefCode || '',
    /* {{...same fields, same order as SUBMISSION_HEADERS...}} */
    body.clientBuild || '(pre-build-stamp)'
  ];

  const wasComplete = row > 0 && sh.getRange(row, S_STATUS).getValue() === 'complete';
  if (row > 0) {
    ensureGrid(sh, row, rowData.length);
    sh.getRange(row, 1, 1, rowData.length).setValues([rowData]);
  } else {
    ensureGrid(sh, sh.getLastRow() + 1, rowData.length);
    sh.appendRow(rowData);
  }
  if (body.status === 'complete' && !wasComplete) bumpSlugCounter(body.slug, L_COMPLETIONS);
}

function handleTrack(body) {
  if (!body.slug) return;
  const sh = getSheet(SLUG_SHEET, SLUG_HEADERS);
  const row = findRow(sh, L_SLUG, body.slug);
  const now = new Date();
  if (row > 0) {
    const col = body.kind === 'visit' ? L_VISITS : L_CLICKS;
    sh.getRange(row, col).setValue((sh.getRange(row, col).getValue() || 0) + 1);
    sh.getRange(row, L_LASTSEEN).setValue(now);
  } else {
    sh.appendRow([body.slug, body.redirectType || 'campaign', body.dest || '', now, now,
      body.kind === 'visit' ? 1 : 0, body.kind === 'click' ? 1 : 0, 0, 0]);
  }
  if (body.kind === 'visit') bumpSlugCounter(body.slug, L_STARTS);
}

function bumpSlugCounter(slug, col) {
  if (!slug) return;
  const sh = getSheet(SLUG_SHEET, SLUG_HEADERS);
  const row = findRow(sh, L_SLUG, slug);
  if (row > 0) sh.getRange(row, col).setValue((sh.getRange(row, col).getValue() || 0) + 1);
}

function handleCreateLink(body) {
  const sh = getSheet(SLUG_SHEET, SLUG_HEADERS);
  const row = findRow(sh, L_SLUG, body.slug);
  const now = new Date();
  if (row < 0) sh.appendRow([body.slug, body.type || 'referral', body.owner || '', now, now, 0, 0, 0, 0]);
  else if (body.owner) sh.getRange(row, L_DEST).setValue(body.owner);
}

function applyConditionalFormatting() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SUBMISSIONS_SHEET);
  ensureGrid(sh, 2001, SUBMISSION_HEADERS.length);
  const range = sh.getRange(2, 1, 2000, SUBMISSION_HEADERS.length);
  const partial = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$D2="partial"').setBackground('#FDE2DD').setRanges([range]).build();
  const complete = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$D2="complete"').setBackground('#DCF4E3').setRanges([range]).build();
  sh.setConditionalFormatRules([partial, complete]);
}
```

### 2.3 Detail tab pattern **[include only if Step 0 found repeatable/multi-select data]**

When one field can hold multiple values per person (chip-pickers,
checkboxes, "add another"), don't cram it into one Submissions cell as an
unreadable blob and stop there. Do both:

1. Keep the raw JSON blob on the Submissions row (`{{field}}JSON`) as the
   lossless backup.
2. Also send a **flattened, human-readable array** alongside it — e.g.
   `[[groupLabel, itemLabel, source], ...]` where `source` is `'preset'`
   (picked from the UI) or `'typed'` (hand-entered free text) — plus a
   plain-text summary string for the Submissions cell itself
   (`"Group: item1, item2 | Other group: item3"`).
3. On the backend, explode that array into a **separate long-format tab**
   (one row per person per item) with a `rebuild{{Detail}}()` function that
   wipes and rebuilds it wholesale from Submissions (it's derived data,
   Submissions is the source of truth — never hand-edit it).
4. Refresh that tab **both** on a time-based trigger *and* opportunistically
   right after a completion (throttled to something like once a minute) —
   a trigger-only refresh means anyone who hasn't (re-)run setup sees a
   tab that's just silently stale, and stale-vs-missing looks identical
   from the outside.
5. Write a **backfill function**: rows captured before this tab existed
   still have the raw blob, just not the flattened version — recover it by
   running the same explode-logic against the old blob. Keep an explicit
   comment tying the Apps Script transform to its JS twin, so a future
   category/field rename doesn't quietly desync them.

This is exactly the PicaPool "Brands" tab: `brandSelJSON` (raw blob) +
`brandRowsJSON`/`brandsPicked`/`brandsTyped`/`brandCount` (flattened) on
Submissions, exploded into a `Brands` tab keyed by category/sub-category/
brand/source, refreshed on trigger + on completion, with
`backfillBrandColumns()` recovering old rows. See this repo's
`apps-script/Code.gs` for the full worked implementation if you want it
verbatim rather than re-derived.

### 2.4 Self-test + menu **[COPY VERBATIM, adapt the sample payload]**

Distinguishes "the script is broken" from "nothing is reaching the
script" — the single most useful debugging tool in this whole system,
because from the Sheet alone those two failure modes look identical.

```js
function runSelfTest() {
  const lines = []; const say = m => { lines.push(m); console.log(m); };
  say('code version: ' + CODE_VERSION);
  const sub = getSheet(SUBMISSIONS_SHEET, SUBMISSION_HEADERS);
  const before = sub.getLastRow();
  const payload = {
    action: 'submit', sessionId: 'SELFTEST', status: 'complete',
    slug: 'selftest', /* {{...minimal valid fields for this page...}} */
    clientBuild: 'self-test'
  };
  let reply;
  try { reply = doPost({ postData: { contents: JSON.stringify(payload) } }).getContent(); }
  catch (err) { reply = 'THREW: ' + (err && err.message ? err.message : err); }
  say('doPost said: ' + reply);
  say('rows ' + before + ' -> ' + sub.getLastRow());
  const row = findRow(sub, S_SESSION, 'SELFTEST');
  say(row > 0 ? ('SELFTEST row is at row ' + row) : 'NO ROW WAS WRITTEN — see the Errors tab.');
  const errs = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ERROR_SHEET);
  say(errs && errs.getLastRow() > 1 ? ('last error: ' + errs.getRange(errs.getLastRow(), 4).getValue()) : 'no errors recorded');
  const report = lines.join('\n');
  try { SpreadsheetApp.getUi().alert('Self test', report, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return report;
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('{{Project}}')
    .addItem('Run self test', 'runSelfTest')
    .addItem('Rebuild dashboard', 'buildDashboard')
    // .addItem('Rebuild {{detail}} report', 'rebuild{{Detail}}')     // if 2.3 applies
    // .addItem('Backfill old rows', 'backfill{{Detail}}Columns')     // if 2.3 applies
    .addItem('Run full setup', 'setupSheets')
    .addToUi();
}

function setupSheets() {
  getSheet(SUBMISSIONS_SHEET, SUBMISSION_HEADERS);
  getSheet(SLUG_SHEET, SLUG_HEADERS);
  applyConditionalFormatting();
  buildDashboard();
  SpreadsheetApp.getActiveSpreadsheet().toast('Setup complete.');
}
```

### 2.5 Dashboard — **[DERIVE the metrics from Step 0, COPY the builder pattern]**

Not a flat list of formula rows with raw `QUERY` dumps underneath — that's
unreadable. Build it with a running row-cursor and small helper closures so
nothing needs hand-counted row numbers:

```js
function buildDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(DASHBOARD_SHEET);
  if (!sh) sh = ss.insertSheet(DASHBOARD_SHEET, 0);
  sh.clear(); sh.clearFormats();
  sh.getCharts().forEach(c => sh.removeChart(c));
  // a prior run may have left merges/banding behind — clear() doesn't
  // remove those, and re-applying over an overlapping range throws.
  if (sh.getMaxRows() > 0 && sh.getMaxColumns() > 0) {
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  }
  sh.getBandings().forEach(b => b.remove());
  sh.setTabColor('{{BRAND_COLOR}}'); sh.setHiddenGridlines(true);

  const INK = '#15130F', ACCENT = '{{BRAND_COLOR}}', CREAM = '#FFF4EB'; // {{...your palette...}}
  const COLS = 9;
  let r = 1;
  sh.getRange(r, 1, 1, COLS).merge().setValue('{{Title}}').setBackground(ACCENT)
    .setFontColor('#FFFFFF').setFontSize(18).setFontWeight('bold').setVerticalAlignment('middle');
  r += 3;

  const section = (label) => {
    sh.getRange(r, 1, 1, COLS).merge().setValue(label).setBackground(INK)
      .setFontColor('#FFFFFF').setFontWeight('bold').setVerticalAlignment('middle');
    r++;
  };
  const blank = (h) => { sh.setRowHeight(r, h || 8); r++; };
  const barRow = (label, valueExpr, denomExpr, color) => {
    sh.getRange(r, 1).setValue(label).setFontWeight('bold');
    sh.getRange(r, 8, 1, 2).merge().setFormula('=' + valueExpr).setFontWeight('bold').setFontColor(color);
    sh.getRange(r, 2, 1, 6).merge()
      .setFormula('=REPT("█", MIN(34, ROUND(IFERROR((' + valueExpr + ')/MAX(1,' + denomExpr + ')*34,0),0)))')
      .setFontColor(color).setFontFamily('Courier New');
    r++;
  };
  const tableHeader = (labels) => {
    sh.getRange(r, 1, 1, labels.length).setValues([labels]).setBackground(CREAM).setFontWeight('bold')
      .setBorder(true, true, true, true, false, false, '#E3DCD0', SpreadsheetApp.BorderStyle.SOLID);
    r++;
  };
  const tableBody = (formula, rows, cols) => {
    // formula goes ONLY in the anchor cell — QUERY's array result spills
    // into the rest of this (empty) range on its own. Calling setFormula()
    // on the whole multi-cell range instead repeats the SAME formula into
    // every cell, which throws ("array result was not expanded") or
    // duplicates content. This bug is easy to write and easy to miss.
    sh.getRange(r, 1).setFormula(formula);
    const range = sh.getRange(r, 1, rows, cols);
    range.setBorder(true, true, true, true, true, true, '#E3DCD0', SpreadsheetApp.BorderStyle.SOLID);
    try { range.applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false); } catch (e) {}
    r += rows;
  };

  // {{ KPI tiles: sessions started, completed, completion rate, + whatever
  //    else Step 0 says matters for this page }}
  // {{ FUNNEL: visits -> starts -> completions, via barRow() }}
  // {{ one barRow() breakdown block per categorical field Step 0 found
  //    (device, a single-select answer, etc.) }}
  // {{ ENGAGEMENT LINKS table: one row per CTA from 1.6, clicks + unique users }}
  // {{ TOP CAMPAIGN/SLUG LINKS table — reusable as-is, not page-specific: }}
  section('TOP CAMPAIGN / SLUG LINKS (by visits)');
  tableHeader(['Slug', 'Type', 'Destination / owner', 'Visits', 'Clicks', 'Starts', 'Completions']);
  tableBody('=IFERROR(QUERY(Slug!A2:I500,"select A, B, C, F, G, H, I where A is not null order by F desc limit 15", 0), "No data yet")', 15, 7);
  blank();
  // {{ WHO CLICKED WHAT + RECENT COMPLETIONS — QUERY off Submissions, keyed
  //    to whatever identity fields Step 0 found }}

  sh.setColumnWidth(1, 190);
  for (let c = 2; c <= COLS; c++) sh.setColumnWidth(c, 105);
  sh.setFrozenRows(2);
}
```

**A `QUERY` with `group by` quirk worth knowing:** it always emits a label
row (e.g. `count`) ahead of its actual results, which throws off manual
header rows drawn above it. Wrap it: `QUERY(QUERY(range, "<your group-by
select>", 0), "select * offset 1", 0)` — the outer query drops that label
row so results line up under a header you drew yourself.

---

## Step 3 — Hard-won fixes checklist

Verify every one of these before calling the backend done. Each was a real,
silent production failure the first time — "silent" is the theme: because
`sendBeacon` discards its response, almost every one of these failure modes
produces *zero* visible symptom on the frontend. The Sheet just quietly
stops getting rows, or a tab quietly goes stale, and there is nothing in
the browser console to notice.

- [ ] **`ensureGrid()` before every range access that could exceed 1000
      rows or 26 columns.** A default Sheet tab does not auto-grow;
      `getRange()` past its current bounds throws. The moment a schema
      passes 26 columns (very easy once you're tracking clicks + detail
      fields), every write fails unless this guard is in place everywhere.
- [ ] **`doPost` wraps its handlers in try/catch and logs to an Errors
      sheet.** `sendBeacon` throws the response away — an uncaught
      exception here is a write that vanishes with nothing to see on
      either side. Without this, "is the backend broken" is unanswerable.
- [ ] **`SUBMISSION_HEADERS` is append-only, forever.** Never reorder or
      insert a field into the middle of that list — `handleSubmit` writes
      positionally from column 1, so doing so silently shifts every
      existing row's data into the wrong columns.
- [ ] **`tableBody()`-style helpers put a `QUERY` formula in exactly one
      anchor cell, never across a multi-cell range.** Calling
      `.setFormula()` on a whole range repeats the same formula into every
      cell instead of letting the array result spill.
- [ ] **`buildDashboard()` breaks apart merges and removes bandings before
      rebuilding.** `sh.clear()` does not undo either, so re-running setup
      throws the moment a `.merge()` call lands on a still-merged range
      from the previous run.
- [ ] **Every optional/decorative browser API (audio, share, vibrate,
      clipboard) is wrapped in the lazy-construct-inside-try-with-a-
      flag pattern from 1.11.** An uncaught error at a `<script>` block's
      top level in a restrictive webview (WhatsApp/Instagram in-app
      browsers, locked-down Android WebViews) kills every line after it —
      including all tracking. This is how "the form just doesn't work for
      some people" bugs happen with no error anyone sees.
- [ ] **`flushProgress()` runs on both `pagehide` and `visibilitychange`
      (hidden), not just a debounced timer.** The debounce alone loses the
      latest state the instant someone closes the tab or switches apps
      before it fires — which is exactly when it matters most (tapping an
      outbound link).
- [ ] **`CODE_VERSION` (backend) and `BUILD` (frontend) are bumped on every
      meaningful change, and both are checkable from the outside** —
      `CODE_VERSION` via the `/exec` URL's `doGet` JSON, `BUILD` via the
      `clientBuild` column on every row. A Web App deployment pins a
      version at deploy time; pasting new code into the editor does
      nothing to `/exec` until you explicitly publish a new version. Both
      stamps exist to answer "is the live thing actually the thing I'm
      looking at" without guessing.
- [ ] **A derived/detail tab (2.3) refreshes on completion, not only on a
      time trigger.** A trigger-only refresh means anyone who hasn't
      (re-)run setup sees a tab that's silently stale — indistinguishable
      from "the data isn't there" without checking timestamps.
- [ ] **`doGet` returns a real health-check payload**, not just "ok" —
      row counts vs. expected column count, newest submission timestamp,
      a build-stamp breakdown, last error. This is the fastest way to
      answer "is anything reaching the backend at all" for a non-technical
      sheet owner: they open one URL.

---

## Step 4 — Deploy

### Google Sheet + Apps Script
1. Create a blank Sheet — it *is* the database.
2. Extensions → Apps Script → paste the Step 2 file.
3. Run `setupSheets()` from the function dropdown, approve permissions.
4. Deploy → New deployment → **Web app** → Execute as **Me** → Who has
   access **Anyone** → copy the `/exec` URL.
5. Paste that URL into `API_BASE` in the frontend (1.2).

### The site itself (Vercel)
```json
// vercel.json — rewrite every path to index.html so
// yoursite.com/anything becomes a trackable slug, no server needed
{
  "rewrites": [{ "source": "/((?!index.html).*)", "destination": "/index.html" }],
  "headers": [{ "source": "/(.*)", "headers": [{ "key": "X-Content-Type-Options", "value": "nosniff" }] }]
}
```
```bash
npm i -g vercel
vercel login
vercel --prod
```
Then add the custom domain in the Vercel project's settings and point DNS
at it from the domain registrar.

### Re-deploying after a code change
- **Frontend:** bump `BUILD`, push, Vercel redeploys automatically on a
  connected git repo (or `vercel --prod` again).
- **Backend:** paste the new file over the old one in the Apps Script
  editor, re-run `setupSheets()` (safe — additive only), then **Deploy →
  Manage deployments → pencil → Version: New version** — pasting code
  alone does not update what `/exec` serves.

---

## Worked example

This repo (`intent-pp`) is the reference implementation this playbook was
extracted from — `index.html` for every Step-1 pattern in full, and
`apps-script/Code.gs` for every Step-2/3 pattern in full, including the
`Brands` detail-tab pattern (2.3), the self-test/menu (2.4), and every item
in the fixes checklist actually applied. When in doubt about how a
placeholder resolves in practice, that's the answer key.
