const SCOPE = new URL(self.registration.scope);
const PREFIX = `ventilab-shell:${SCOPE.pathname}:`;
const VERSION = `${PREFIX}v1`;
const SHELL = [
  'index.html',
  'styles.css',
  'sw.js',
  'manifest.webmanifest',
  'favicon.svg',
  'icon-192.png',
  'icon-512.png',
  'src/app.js',
  'src/brief.js',
  'src/engine.js',
  'src/plan.js',
  'src/retrofit.js',
  'src/roomcodec.js',
  'src/schoolday.js',
  'src/selftest.js',
  'src/sha256.js',
  'src/viz.js',
];

function assetUrl(name) {
  return new URL(name === 'index.html' ? './' : name, SCOPE);
}

function cacheKey(name) {
  return assetUrl(name).href;
}

async function cleanResponse(response) {
  if (!response.redirected) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function refresh(cache, key, request) {
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    if (!response.ok) return response;
    const clean = await cleanResponse(response);
    await cache.put(key, clean.clone());
    return clean;
  } catch {
    return null;
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL.map(name => new Request(assetUrl(name), { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(PREFIX) && key !== VERSION) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(SCOPE.pathname)) return;
  const rel = url.pathname.slice(SCOPE.pathname.length);
  const asset = request.mode === 'navigate'
    ? (rel === '' || rel === 'index.html' ? 'index.html' : null)
    : (SHELL.includes(rel) ? rel : null);
  if (!asset) return;
  const key = cacheKey(asset);
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(key);
    const updating = refresh(cache, key, request);
    if (hit) {
      event.waitUntil(updating);
      return hit;
    }
    const fresh = await updating;
    if (fresh) return fresh;
    return new Response('VentiLab is offline and this shell file is not cached yet.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  })());
});
