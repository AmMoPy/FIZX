// Offline shell for the FIZX studio (a single self-contained HTML file, deployed as index.html).
const CACHE_NAME = 'FIZX-v1';                                  // bump by hand on every release
const CACHE_TTL = 86400 * 30;                                  // seconds; past this, a cached entry is revalidated in the background (safety net if a bump is forgotten)
const ASSETS = ['./', './index.html', './manifest.json', './assets/icons/arrow.png'];
const STAMP = 'x-sw-cached-at';

// Store a response together with the time it was cached, so the TTL can be checked later.
async function putStamped(cache, request, response) {
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');                        // the body is already decoded; keeping these would make the browser decode it twice
    headers.delete('content-length');
    headers.set(STAMP, String(Date.now()));
    await cache.put(request, new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers }));
}
const isStale = (response) => Date.now() - Number(response.headers.get(STAMP) || 0) > CACHE_TTL * 1000;

// 'no-cache' = always ask the server (a cheap 304 when unchanged) instead of trusting the HTTP cache
async function revalidate(cache, request) {
    const response = await fetch(request, { cache: 'no-cache' });
    if (response.ok && response.status !== 206 && response.type === 'basic') await putStamped(cache, request, response);
    return response;
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        const results = await Promise.all(ASSETS.map(async (asset) => {
            try {
                const response = await fetch(new Request(asset, { cache: 'reload' }));           // bypass the HTTP cache on install
                if (!response.ok) return { asset, status: 'failed', reason: `HTTP ${response.status}` };
                await putStamped(cache, asset, response);
                return { asset, status: 'cached' };
            } catch (err) { return { asset, status: 'failed', reason: err.message }; }
        }));
        console.table(results);
        await self.skipWaiting();                                                                // activate immediately
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => key !== CACHE_NAME && caches.delete(key)));
        await self.clients.claim();                                                              // control open pages immediately
        console.log(`Service Worker ${CACHE_NAME} activated`);
    })());
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request, { ignoreSearch: true });
        if (cached) {                                                                            // cache-first
            if (isStale(cached)) event.waitUntil(revalidate(cache, request).catch(() => {}));    // past the TTL: refresh in the background, serve the cached copy now
            return cached;
        }
        try {
            const response = await fetch(request);
            if (response.ok && response.status !== 206 && response.type === 'basic') event.waitUntil(putStamped(cache, request, response.clone()));
            return response;
        } catch (err) {                                                                          // offline and not cached
            if (request.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();   // serve the app shell
            return new Response(null, { status: 503, headers: { 'Retry-After': '10', 'Content-Type': 'text/plain' } });
        }
    })());
});