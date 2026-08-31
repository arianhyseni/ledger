# TillRoll

TillRoll is an installable personal-finance and store-price PWA. Local data is
stored in IndexedDB through Dexie, and optional account sync uses Supabase.

## Requirements

- Node.js 22 or newer
- npm 10 or newer

## Development

```sh
npm install
npm run dev
```

Open the local URL printed by Vite (normally <http://127.0.0.1:5173>).

## Production build

```sh
npm run build
npm run preview
```

The deployable site is generated in `dist/`. Cloudflare's asset configuration
also points to this directory.

## Project layout

```text
.
|-- src/
|   |-- main.js              Application entry point
|   `-- styles/              Application styles
|-- public/
|   |-- icons/               PWA icons
|   |-- legacy/
|   |   |-- core/            Database, auth, sync, and configuration
|   |   `-- features/        Expenses, prices, insights, and settings
|   |-- vendor/              Browser-ready third-party libraries
|   |-- manifest.webmanifest
|   `-- sw.js                Offline service worker
|-- docs/                    Design/reference artifacts
|-- supabase/migrations/     Database migrations
|-- index.html               Vite HTML entry
`-- vite.config.js           Development and build configuration
```

The existing feature scripts deliberately remain classic browser scripts so
the app continues to behave exactly as before. New module-based JavaScript can
go in `src/`; a future TypeScript migration can begin by renaming `main.js` to
`main.ts` and then migrating one legacy feature at a time.

## Data notes

- Money values are stored as integer cents.
- Dates use `YYYY-MM-DD`; a month is the first seven characters.
- Averages are computed at render time rather than persisted.
- Export a JSON backup from Settings before clearing browser storage.
