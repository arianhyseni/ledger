# Ledger

Personal finance + store price tracker. Runs as an installable web app (PWA).
All data stays in the browser on your device (IndexedDB). No server, no account,
works with no signal.

## Files

    index.html               app shell, all four screens
    app.css                  styles
    manifest.webmanifest     install metadata
    sw.js                    service worker (offline cache)
    js/db.js                 schema, seed, money/date helpers, backup
    js/expenses.js           income, expense entry, budget strip
    js/prices.js             products, store prices, averages
    js/insights.js           analytics, trends, saving advice
    js/settings.js           preferences, categories, stores, backup
    vendor/dexie.min.js      IndexedDB wrapper (bundled, no CDN)
    icons/                   app icons

## Run it

### 1. Quick test on your PC

    cd finance-app
    python3 -m http.server 8080

Open http://localhost:8080 — everything works, including install.

`file://` will not work: service workers and the install prompt require
`http://localhost` or HTTPS.

### 2. Put it on your phone (recommended: GitHub Pages)

1. Create a repository, e.g. `ledger`.
2. Upload the **contents** of this folder to the repository root.
3. Repository → Settings → Pages → Source: `Deploy from a branch`,
   branch `main`, folder `/ (root)`. Save.
4. Wait a minute, then open `https://<username>.github.io/ledger/` in Chrome
   on your Android phone.
5. Chrome menu (⋮) → **Add to Home screen** / **Install app**.

It now opens fullscreen with its own icon and works offline.

Alternative with no repository: drag the folder onto https://app.netlify.com/drop
and use the HTTPS URL it gives you.

## First run

1. **Settings** — set your currency symbol and savings target (default 20%).
2. **Settings** — add the stores you shop at.
3. **Expenses** — enter your monthly income at the top.
4. Start adding expenses. Attach a receipt photo when useful.
5. **Prices** — add products, then record what each costs per store.
   The cheapest store is marked with a tick as soon as there are two prices.
6. **Insights** — category breakdown, six-month trend, averages, advice.

## Backup

Data lives only in this browser. Clearing site data or uninstalling erases it.
Settings → **Export JSON** regularly and keep the file somewhere safe.
Receipt photos are not included in the export — they would make it enormous.

## Notes

- All money is stored as integer cents. Never switch to floats.
- All dates are `YYYY-MM-DD`; `month` is the first 7 characters.
- Averages are never stored, only computed at render time.
- After editing any file, bump `CACHE` in `sw.js` (e.g. `ledger-v3`) or the
  old version will keep being served from cache.
