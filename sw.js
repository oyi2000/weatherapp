// ── Service Worker — Tiempo App ────────────────────────────────────────────────
// Estrategia:
//   • Shell (HTML, CSS, JS, fuentes): Cache-first con actualización en background
//   • APIs meteorológicas: Network-first con fallback a caché (hasta 1h)
//   • Recursos de terceros (tiles, mapas): Stale-while-revalidate
// ──────────────────────────────────────────────────────────────────────────────

const CACHE_VERSION = 'v1';
const SHELL_CACHE   = `tiempo-shell-${CACHE_VERSION}`;
const API_CACHE     = `tiempo-api-${CACHE_VERSION}`;
const TILE_CACHE    = `tiempo-tiles-${CACHE_VERSION}`;

// Recursos del shell (interfaz) que se precachean al instalar
const SHELL_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './weatherlogo.png',
    'https://fonts.googleapis.com/css2?family=Google+Sans:wght@300;400;500;700&family=Google+Sans+Display:wght@300;400;500&display=swap',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// Dominios de APIs meteorológicas (network-first)
const API_HOSTS = [
    'api.open-meteo.com',
    'geocoding-api.open-meteo.com',
    'api.rainviewer.com',
    'air-quality-api.open-meteo.com',
];

// Dominios de tiles de mapa (stale-while-revalidate, límite de caché)
const TILE_HOSTS = [
    'tile.openweathermap.org',
    'tiles.aqicn.org',
    'rainviewer.com',
    'a.tile.openstreetmap.org',
    'b.tile.openstreetmap.org',
    'c.tile.openstreetmap.org',
];

const MAX_TILE_CACHE_ENTRIES = 500;
const API_CACHE_MAX_AGE_MS   = 60 * 60 * 1000; // 1 hora

// ── INSTALL — precachear el shell ─────────────────────────────────────────────
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(SHELL_CACHE).then(cache => {
            return Promise.allSettled(
                SHELL_ASSETS.map(url =>
                    cache.add(url).catch(err => console.warn('[SW] No se pudo cachear:', url, err))
                )
            );
        }).then(() => self.skipWaiting())
    );
});

// ── ACTIVATE — limpiar cachés antiguas ────────────────────────────────────────
self.addEventListener('activate', event => {
    const validCaches = [SHELL_CACHE, API_CACHE, TILE_CACHE];
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(k => !validCaches.includes(k)).map(k => {
                    console.log('[SW] Eliminando caché antigua:', k);
                    return caches.delete(k);
                })
            )
        ).then(() => self.clients.claim())
    );
});

// ── FETCH — estrategia por tipo de recurso ────────────────────────────────────
self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);

    // Ignorar peticiones que no son GET
    if (request.method !== 'GET') return;

    // Ignorar extensiones de Chrome y peticiones opacas problemáticas
    if (url.protocol === 'chrome-extension:') return;

    // ── APIs meteorológicas: Network-first con caché de respaldo ──────────────
    if (API_HOSTS.includes(url.hostname)) {
        event.respondWith(networkFirstWithCache(request, API_CACHE, API_CACHE_MAX_AGE_MS));
        return;
    }

    // ── Tiles de mapa: Stale-while-revalidate ─────────────────────────────────
    if (TILE_HOSTS.some(h => url.hostname.includes(h))) {
        event.respondWith(staleWhileRevalidate(request, TILE_CACHE));
        return;
    }

    // ── Shell / resto: Cache-first ────────────────────────────────────────────
    event.respondWith(cacheFirst(request, SHELL_CACHE));
});

// ── Estrategia: Cache-first (devuelve caché, si no red) ──────────────────────
async function cacheFirst(request, cacheName) {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
        const response = await fetch(request);
        if (response && response.status === 200 && response.type !== 'opaque') {
            cache.put(request, response.clone());
        }
        return response;
    } catch (err) {
        // Si no hay red ni caché, devolver página offline básica
        return offlineFallback(request);
    }
}

// ── Estrategia: Network-first con fallback a caché (para APIs) ───────────────
async function networkFirstWithCache(request, cacheName, maxAgeMs) {
    const cache = await caches.open(cacheName);
    try {
        const response = await fetch(request, { signal: AbortSignal.timeout(8000) });
        if (response && response.status === 200) {
            // Guardar con timestamp en cabecera personalizada
            const headers = new Headers(response.headers);
            headers.set('sw-cached-at', Date.now().toString());
            const augmented = new Response(await response.clone().blob(), {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
            cache.put(request, augmented);
            return response;
        }
        return response;
    } catch (_) {
        // Sin red: intentar caché si no es demasiado antigua
        const cached = await cache.match(request);
        if (cached) {
            const cachedAt = parseInt(cached.headers.get('sw-cached-at') || '0', 10);
            if (Date.now() - cachedAt < maxAgeMs) return cached;
        }
        return new Response(JSON.stringify({ error: 'offline', cached: false }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

// ── Estrategia: Stale-while-revalidate (tiles, fuentes) ──────────────────────
async function staleWhileRevalidate(request, cacheName) {
    const cache  = await caches.open(cacheName);
    const cached = await cache.match(request);

    const fetchPromise = fetch(request).then(async response => {
        if (response && response.status === 200 && response.type !== 'opaque') {
            await trimCache(cache, MAX_TILE_CACHE_ENTRIES);
            cache.put(request, response.clone());
        }
        return response;
    }).catch(() => null);

    return cached || (await fetchPromise) || offlineFallback(request);
}

// ── Limpiar caché de tiles cuando supera el límite ───────────────────────────
async function trimCache(cache, maxEntries) {
    const keys = await cache.keys();
    if (keys.length >= maxEntries) {
        const toDelete = keys.slice(0, keys.length - maxEntries + 1);
        await Promise.all(toDelete.map(k => cache.delete(k)));
    }
}

// ── Fallback offline ──────────────────────────────────────────────────────────
async function offlineFallback(request) {
    if (request.destination === 'document') {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match('./index.html')) ||
               (await cache.match('./')) ||
               new Response('<h1>Sin conexión</h1><p>La app necesita conexión para cargar por primera vez.</p>', {
                   headers: { 'Content-Type': 'text/html; charset=utf-8' }
               });
    }
    return new Response('', { status: 408 });
}
