# PicaPool intent form — go live

What this is: the original form (`index.html`) untouched in content/design, plus:
branding, resume-where-you-left-off, the real Instally app link, and a full
click/referral/campaign tracking layer that writes into a Google Sheet with a
proper Dashboard (KPI tiles, funnel, device/commitment breakdowns, and
bordered tables — not raw formula dumps).

## 1. Create the database (Google Sheet)

1. Create a new blank Google Sheet — this **is** the database (3 tabs:
   Dashboard, Submissions, Slug).
2. Extensions → Apps Script. Delete the placeholder code, paste in the
   contents of [`apps-script/Code.gs`](apps-script/Code.gs).
3. In the function dropdown at the top, select `setupSheets`, click ▶ Run.
   Approve the permissions Google asks for (it's your own script touching
   your own sheet). This builds all 3 tabs, headers, red/green conditional
   formatting on Submissions, and the full Dashboard.
4. Deploy → New deployment → type **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Deploy, then copy the URL ending in `/exec`.

Already deployed once and just pulled a newer `Code.gs`? Paste the new file
in over the old one and re-run `setupSheets()` — it's safe: existing rows are
never touched, only missing columns get appended and the Dashboard rebuilds
from the live formulas. You do **not** need a new deployment/URL for that.

## 2. Point the form at it

Open `index.html` and fill in near the top of the `<script>` block:

```js
const BUYING_GROUP_LINK   = '...';   // still a placeholder — no link given yet
const API_BASE            = 'https://script.google.com/macros/s/XXXX/exec';
```

Already filled in: `WHATSAPP_GROUP_LINK` (the group you shared) and
`APP_SMART_LINK` (your Instally smart link — it already detects iOS/Android/
desktop and routes to the right store on its own, so there's no separate App
Store/Play Store constant to fill in).

## 3. Deploy to Vercel + connect the domain

```bash
npm i -g vercel
vercel login
vercel --prod
```

Then in the Vercel project settings, add the domain `intent.picapool.tech`
and point your DNS (a CNAME to `cname.vercel-dns.com`, or whatever Vercel's
domain screen instructs) — that part happens in your own domain registrar,
so do it yourself rather than handing over registrar access.

`vercel.json` already rewrites every path to `index.html`, so
`intent.picapool.tech/abc` loads the form with `abc` captured as a slug.

## How the tracking model works

**Any URL path is automatically a trackable link.** `intent.picapool.tech/abc`
tags that visit with slug `abc` — no setup needed, it shows up in the `Slug`
tab on first visit. Use different slugs for different placements (Instagram
bio, a poster QR code, a specific WhatsApp broadcast, etc.) to compare them
on the Dashboard.

**Reserved redirect slugs** — `wa`, `whatsapp`, `buy`, `buying` — don't show
the form at all, they log a click then bounce straight to the WhatsApp group
/ buying group link. Add more in the `REDIRECT_SLUGS` object in `index.html`
if you want more shortlinks like that (e.g. `/insta` → your Instagram). The
`/buy` shortlink works today even though there's no Buying Group card on the
form itself anymore — it just needs `BUYING_GROUP_LINK` filled in to go
somewhere real.

**Invite a friend** — the final screen has one share CTA. It shares each
user's own `intent.picapool.tech/<code>` link (generated silently, no UI
promise attached since there's no reward mechanism behind it yet). When a
friend opens it, it's tracked like any other campaign slug, tagged
`type: referral` with the referrer's name as owner — so the Dashboard's "Top
referrers" table can still rank people by how many friends they brought in,
even with no visible incentive shown to the user.

**Progress persistence** — the full form state is saved to `localStorage`
(and synced to the `Submissions` tab) on every screen change, keyed by a
per-device session id, using `navigator.sendBeacon` so the sync survives the
tab closing or backgrounding mid-send. Closing the tab, backgrounding the
browser to open WhatsApp, or coming back a day later all resume on the exact
same screen.

**Submissions coloring** — a row is red (`status = partial`) until the user
reaches the final screen, then it flips green (`status = complete`) via
conditional formatting on the `Submissions` tab. Partial rows still capture
whatever was filled in (2 taps, 20 taps — whatever got saved before they
left); every row also carries per-click timestamps (`waGroupClickedAt`,
`appDownloadClickedAt`, `referralSharedAt`, etc.) so you can see exactly
which links a specific named person tapped, plus a full JSON event trail
(`eventsJSON`) of every screen they touched, in order.

**Dashboard** — KPI tiles (sessions, completions, completion rate, referral
signups), a text-bar funnel (visits → starts → completions), device and
commitment breakdowns, an engagement-links table (clicks + unique users per
link), and bordered/striped tables for top campaign links, top referrers,
who-clicked-what, and recent completions. All formula-driven off Submissions
+ Slug — nothing to maintain by hand.

## Known placeholder you still need to fill in

- `BUYING_GROUP_LINK` in `index.html` — no link was provided for this yet.
  It only affects the `/buy` and `/buying` shortlinks; nothing else depends
  on it.

`API_BASE` is already filled in and live.
