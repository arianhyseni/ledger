// Vite replaces both placeholders in the built service worker. The generated
// list contains every output file, including modules loaded later with import().
const BUILD_ID = '__TILLROLL_BUILD_ID__';
const CACHE_PREFIX = 'tillroll-';
const CACHE = `${CACHE_PREFIX}${BUILD_ID}`;
const PRECACHE_ASSETS = /* __TILLROLL_PRECACHE_ASSETS__ */ [];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);

    try {
      // Atomic precaching keeps the active worker in place when a deployment is
      // incomplete, instead of activating a worker with missing lazy modules.
      const requests = PRECACHE_ASSETS.map(asset => new Request(asset, { cache: 'reload' }));
      await cache.addAll(requests);
    } catch (error) {
      await caches.delete(CACHE);
      throw error;
    }

    // Do not call skipWaiting(). Existing tabs may still reference the previous
    // build's hashed chunks; activate this worker after those tabs are closed.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Cache first: the app must work with no signal inside a store.
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  // Only same-origin traffic is cacheable here. Supabase calls must go
  // straight to the network so sync never reads a stale response.
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request);
    if (hit) return hit;

    try {
      const response = await fetch(request);
      // Only store real, complete responses.
      if (response && response.ok && response.type === 'basic') {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch (error) {
      // Offline and uncached: a navigation still gets the app shell so
      // TillRoll opens instead of showing the browser's error page.
      if (request.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw error;
    }
  })());
});
