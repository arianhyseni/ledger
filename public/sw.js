const CACHE = 'tillroll-v22';

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

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit =>
      hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => hit)
    )
  );
});
