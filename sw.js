// Service Worker for freeder — offline article + image reading.
//
// LESSONS APPLIED (from kire321/thai-rpg, learned through trial and error):
// 1. BUMP CACHE_NAME ON EVERY DEPLOY. A static cache name means users never get
//    new JS. The version lives in localStorage too so the page can detect a
//    cache mismatch.
// 2. NEVER delete old caches on activate. Old caches serve as the offline
//    fallback until the new cache is populated; hits are migrated in background.
// 3. Strip Vary on write + ignoreVary on read. Vary: Origin makes entries
//    cached via one request kind (img, cache.match, SW Request) invisible to
//    the others — cached images still 503 offline.
// 4. ignoreSearch fallback on SERVING (an image cached under any ?v= stamp
//    still renders), but query-SENSITIVE checks when deciding to fetch.
// 5. Article images are fetched NO-CORS (no crossorigin attr on <img>): most
//    image hosts send no ACAO, so cors-mode fetches fail; opaque responses are
//    Cache-API-cacheable and display fine in <img>.
// 6. CACHE_URLS bulk prefetch: per-URL handling, one retry, progress report.
//    Never trust a prefetch log — the app verifies Cache API membership.
// 7. Navigations are NETWORK-FIRST (fresh app on every visit when online) with
//    cache fallback when offline. Hashed assets and images are cache-first.
//
// BUILD: 2026-11-24-04
const CACHE_NAME = 'freeder-2026-11-24-05';
const VERSION = '2026-11-24-04';
const CONTENT_CACHE_NAME = 'freeder-content-v1';

// Assets cached at install, each INDIVIDUALLY (Promise.allSettled semantics:
// one failure must not block the rest).
const STATIC_ASSETS = [
  './',
  'index.html',
  'manifest.json',
  'icon-192x192.png',
  'icon-512x512.png',
];

const swStats = {
  startedAt: Date.now(),
  cacheHits: 0,
  cacheMisses: 0,
  networkFetches: 0,
  cacheWrites: 0,
  cacheWriteErrors: 0,
  fetchErrors: 0,
  lastError: null,
};

self.addEventListener('install', (event) => {
  console.log('[SW] Install, cache:', CACHE_NAME);
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await Promise.allSettled(STATIC_ASSETS.map(async (url) => {
        try {
          const resp = await fetch(url);
          if (resp.ok || resp.status === 0) await cache.put(url, resp);
        } catch (err) {
          console.warn('[SW] Install skip:', url, err.message);
        }
      }));
    })
  );
});

// Do NOT delete old caches here — they are the offline fallback until the new
// cache is populated, and they hold every previously cached article image.
self.addEventListener('activate', (event) => {
  console.log('[SW] Activate');
  event.waitUntil(self.clients.claim());
});

function stripVaryHeader(response) {
  if (!response || response.type === 'opaque' || response.status === 0) return response;
  if (!response.headers.get('vary')) return response;
  const headers = new Headers(response.headers);
  headers.delete('vary');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function freederCaches(names) {
  return names.filter((n) => n.startsWith('freeder'));
}

// SERVING lookup: current cache first (exact, then ignoreSearch), then legacy
// caches. Any cached variant of an image satisfies the request.
async function findInAnyCache(request) {
  const names = freederCaches(await caches.keys()).filter((n) => n !== CONTENT_CACHE_NAME);
  const current = names.find((n) => n === CACHE_NAME);
  if (current) {
    const cache = await caches.open(current);
    const match = await cache.match(request, { ignoreVary: true })
      || await cache.match(request, { ignoreVary: true, ignoreSearch: true });
    if (match) return { response: match, cacheName: current, isCurrent: true };
  }
  for (const name of names) {
    if (name === CACHE_NAME) continue;
    const cache = await caches.open(name);
    const match = await cache.match(request, { ignoreVary: true })
      || await cache.match(request, { ignoreVary: true, ignoreSearch: true });
    if (match) return { response: match, cacheName: name, isCurrent: false };
  }
  return null;
}

// DECISION lookup: exact URL only (a ?v= change must re-fetch).
async function findExactInAnyCache(url) {
  const names = freederCaches(await caches.keys()).filter((n) => n !== CONTENT_CACHE_NAME);
  for (const name of names) {
    const cache = await caches.open(name);
    const match = await cache.match(url, { ignoreVary: true });
    if (match) return { response: match, cacheName: name };
  }
  return null;
}

async function migrateToCurrentCache(request, response) {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, stripVaryHeader(response.clone()));
    swStats.cacheWrites++;
  } catch (err) {
    console.error('[SW] Migration failed:', request.url, err.message);
  }
}

async function tryCachePut(request, response) {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, stripVaryHeader(response.clone()));
    swStats.cacheWrites++;
    return true;
  } catch (err) {
    swStats.cacheWriteErrors++;
    swStats.lastError = 'cachePut: ' + err.message;
    return false;
  }
}

function isCacheable(response) {
  return !!response && (response.status === 0 || response.status === 200);
}

function isNavigation(request) {
  return request.mode === 'navigate'
    || (request.method === 'GET' && request.headers.get('accept') || '').includes('text/html');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Navigations: NETWORK-FIRST so an online tablet always picks up a new
  // deploy immediately; cached shell when offline.
  if (isNavigation(request) && url.origin === self.location.origin) {
    event.respondWith((async () => {
      try {
        const resp = await fetch(request);
        swStats.networkFetches++;
        if (isCacheable(resp)) await tryCachePut('./', resp.clone());
        return resp;
      } catch (err) {
        const found = await findInAnyCache(request);
        if (found) { swStats.cacheHits++; return found.response; }
        const cache = await caches.open(CACHE_NAME);
        const idx = await cache.match('./', { ignoreVary: true })
          || await cache.match('index.html', { ignoreVary: true });
        if (idx) { swStats.cacheHits++; return idx; }
        swStats.fetchErrors++;
        return new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // Everything else (images above all): cache-first across ALL freeder caches,
  // background-migrate legacy hits, then network with on-the-fly caching.
  event.respondWith(
    findInAnyCache(request).then(async (found) => {
      if (found) {
        swStats.cacheHits++;
        if (!found.isCurrent) migrateToCurrentCache(request, found.response).catch(() => {});
        return found.response;
      }
      swStats.cacheMisses++;
      swStats.networkFetches++;
      try {
        const networkResponse = await fetch(request);
        if (isCacheable(networkResponse)) await tryCachePut(request, networkResponse.clone());
        return networkResponse;
      } catch (err) {
        swStats.fetchErrors++;
        return new Response('Offline', { status: 503, headers: { 'X-Freeder-Offline': '1' } });
      }
    })
  );
});

// Bulk image prefetch. NO-CORS on purpose (lesson #5): opaque responses cache
// fine and display in <img>. Small worker pool — sequential fetching of
// hundreds of images per sync stalls onSyncDone for minutes otherwise.
// Per-URL retry, exact-version skip, progress reported back to the page.
async function cacheUrls(urls, client, id) {
  const unique = [...new Set(urls)];
  const results = { total: unique.length, alreadyCached: 0, cached: [], failed: [] };
  const queue = [...unique];
  const worker = async () => {
    while (queue.length > 0) {
      const url = queue.shift();
      if (url === undefined) break;
      try {
        const existing = await findExactInAnyCache(url);
        if (existing) { results.alreadyCached++; continue; }
        let ok = false;
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
          try {
            // Cache under a NO-CORS request: an opaque cross-origin response
            // cannot be stored under a cors-mode request, and <img> lookups
            // arrive as no-cors anyway (must match the cache key kind).
            const req = new Request(url, { mode: 'no-cors' });
            const resp = await fetch(req);
            swStats.networkFetches++;
            if (isCacheable(resp)) ok = await tryCachePut(req, resp);
          } catch (err) {
            swStats.fetchErrors++;
          }
        }
        if (ok) results.cached.push(url);
        else results.failed.push(url);
      } catch {
        results.failed.push(url);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, unique.length) }, worker));
  console.log('[SW] CACHE_URLS done:', results.cached.length, 'cached,', results.alreadyCached, 'already,', results.failed.length, 'failed');
  if (client) client.postMessage({ type: 'CACHE_URLS_DONE', results, id });
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (data === 'GET_SW_VERSION') {
    event.source?.postMessage({ type: 'SW_VERSION', version: VERSION, cacheName: CACHE_NAME });
    return;
  }
  if (data === 'GET_SW_STATS') {
    event.source?.postMessage({ type: 'SW_STATS', stats: swStats });
    return;
  }
  if (data && data.type === 'CACHE_URLS' && Array.isArray(data.urls)) {
    event.waitUntil(cacheUrls(data.urls, event.source, data.id));
    return;
  }
  if (data === 'GET_SW_CACHE_LIST') {
    caches.keys().then(async (names) => {
      const result = {};
      for (const name of freederCaches(names)) {
        const cache = await caches.open(name);
        result[name] = (await cache.keys()).map((r) => r.url);
      }
      event.source?.postMessage({ type: 'SW_CACHE_LIST', caches: result });
    });
    return;
  }
  if (data === 'PURGE_OLD_CACHES') {
    caches.keys().then((names) => Promise.all(
      freederCaches(names)
        .filter((n) => n !== CACHE_NAME && n !== CONTENT_CACHE_NAME)
        .map((n) => caches.delete(n))
    )).then(() => event.source?.postMessage({ type: 'PURGE_DONE' }));
    return;
  }
});
