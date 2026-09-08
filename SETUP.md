# PicaPool intent form — go live

What this is: the original form (`index.html`) untouched in content/design, plus:
branding, resume-where-you-left-off, a device-smart app link, and a full
click/referral/campaign tracking layer that writes into a Google Sheet.

## 1. Create the database (Google Sheet)

1. Create a new blank Google Sheet — this **is** the database (3 tabs:
   Dashboard, Submissions, Slug).
2. Extensions → Apps Script. Delete the placeholder code, paste in the
   contents of [`apps-script/Code.gs`](apps-script/Code.gs).
3. In the function dropdown at the top, select `setupSheets`, click ▶ Run.
   Approve the permissions Google asks for (it's your own script touching
   your own sheet). This builds all 3 tabs, headers, red/green conditional
   formatting, and the Dashboard formulas.
4. Deploy → New deployment → type **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Deploy, then copy the URL ending in `/exec`.

## 2. Point the form at it

Open `index.html` and fill in near the top of the `<script>` block:

```js
const BUYING_GROUP_LINK   = '...';   // WhatsApp/other link for the buying group
const APP_STORE_LINK      = '...';   // iOS App Store link
const PLAY_STORE_LINK     = APP_DOWNLOAD_LINK; // or set your own Play Store link
const API_BASE            = 'https://script.google.com/macros/s/XXXX/exec';
```

The WhatsApp group link is already set to the one you shared
(`https://chat.whatsapp.com/IYjvfNiB0jr24nKAVj6Oqo`). The `LIVE_DEAL_LINK`
constant is the desktop fallback for the "see it on the app" card.

The form works fine with `API_BASE` left blank — it just won't sync to the
sheet (everything else, including local resume, still works).

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
if you want more shortlinks like that (e.g. `/insta` → your Instagram).

**Referral links** — on the final screen, every user gets their own
`intent.picapool.tech/<code>` link with a Copy button, and "Invite a friend"
shares it too. When a friend opens it, it behaves like any other campaign
slug (tagged in `Slug`), except its `type` is `referral` and its owner is
the referrer's name — so the Dashboard's "Top referrers" table can rank
people by how many friends they brought in.

**Progress persistence** — the full form state is saved to `localStorage`
(and synced to the `Submissions` tab) on every screen change, keyed by a
per-device session id. Closing the tab, backgrounding the browser to open
WhatsApp, or coming back a day later all resume on the exact same screen.
This is also why a WhatsApp-group tap and coming back doesn't lose the final
page — the app tab is never unloaded, and even if it were, local storage
would restore it.

**Submissions coloring** — a row is red (`status = partial`) until the user
reaches the final screen, then it flips green (`status = complete`) via
conditional formatting on the `Submissions` tab. Partial rows still capture
whatever was filled in (2 taps, 20 taps — whatever got saved before they
left); complete rows carry every field plus a full JSON event trail
(`eventsJSON` column) of each screen the user touched, in order.

## Known placeholders you still need to fill in

- `BUYING_GROUP_LINK` — no link was provided for this.
- `APP_STORE_LINK` / `PLAY_STORE_LINK` — the app isn't linked yet; the iOS
  link is a placeholder and the Android one reuses the existing
  `APP_DOWNLOAD_LINK` placeholder.
- `API_BASE` — filled in after you deploy the Apps Script (step 1).

None of these block the form from working — they just mean those specific
links won't go anywhere real until you swap them in.
