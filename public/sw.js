const CACHE = 'tillroll-v26';

const SHELL = [
  './',
  './index.html',
  './legacy/core/config.js',
  './vendor/supabase.js',
  './legacy/core/auth.js',
  './legacy/core/sync.js',
  './legacy/core/db.js',
  './legacy/features/expenses.js',
  './legacy/features/prices.js',
  './legacy/features/insights.js',
  './legacy/features/settings.js',
  './legacy/features/year.js',
  './vendor/dexie.min.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png'
];

// Vite emits the real stylesheet and entry module under hashed names
// (assets/index-<hash>.css/.js), so they cannot be listed above. They
// are read out of the built index.html at install time instead —
// without them an offline cold start renders unstyled HTML with no app.
async function hashedAssets() {
  try {
    const html = await (await fetch('./index.html', { cache: 'reload' })).text();
    const urls = [];
    const re = /(?:href|src)="(\.?\/?assets\/[^"]+)"/g;
    let m;
    while ((m = re.exec(html))) urls.push(m[1]);
    return urls;
  } catch (_) {
    return [];   // offline at install time — the fetch handler still fills the cache
  }
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const urls = SHELL.concat(await hashedAssets());
    // Cache entries individually: addAll() is atomic, so one 404 (an
    // optional vendor file, say) would silently leave the app with no
    // offline cache at all.
    await Promise.all(urls.map(u => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache first: the app must work with no signal inside a store.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // Only same-origin traffic is cacheable here. Supabase calls must go
  // straight to the network so sync never reads a stale response.
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;

    try {
      const res = await fetch(req);
      // Only store real, complete responses.
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      // Offline and uncached: a navigation still gets the app shell so
      // TillRoll opens instead of showing the browser's error page.
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
