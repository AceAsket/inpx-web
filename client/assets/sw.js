const BUILD_ID = '__INPX_WEB_BUILD_ID__';
const CACHE_NAME = `inpx-web-shell-${BUILD_ID}`;
const CACHE_MAX_ENTRIES = 96;
const CACHE_MAX_BYTES = 16 * 1024 * 1024;
const CACHE_MAX_ASSET_BYTES = 4 * 1024 * 1024;
let cacheWrites = Promise.resolve();
const BASE_PATH = new URL(self.registration.scope).pathname.replace(/\/$/, '');
const withBase = (path) => `${BASE_PATH}${path}`;
const APP_SHELL = [
  '/index.html',
  '/pwa-icon.svg',
  '/pwa-icon-192.png',
  '/pwa-icon-512.png',
  '/reader-icon.svg',
  '/reader-icon-192.png',
  '/reader-icon-512.png',
  '/favicon.ico',
  '/reader-favicon.ico'
].map(withBase);

function noStoreRequest(request) {
  return new Request(request, {cache: 'no-store'});
}

function isFreshShellPath(pathname) {
  return [
    withBase('/'),
    withBase('/index.html'),
    withBase('/sw.js'),
    withBase('/manifest.webmanifest'),
    withBase('/reader.webmanifest'),
    withBase('/build-id.txt'),
    withBase('/version.txt')
  ].includes(pathname);
}

function isShellDocument(pathname) {
  return [withBase('/'), withBase('/index.html')].includes(pathname);
}

function isStaticAsset(url) {
  if (!url.pathname.startsWith(withBase('/'))) return false;
  const relative = url.pathname.slice(BASE_PATH.length);
  return APP_SHELL.includes(url.pathname)
    || /^\/app[a-f0-9]+\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.(?:js|css|woff2?|ttf|eot|png|jpe?g|svg|ico)$/i.test(relative);
}

function canStore(response) {
  return response.status === 200 && !response.redirected
    && !/(?:^|,)\s*(?:no-store|private)(?:\s|,|=|$)/i.test(response.headers.get('cache-control') || '');
}

function storeBounded(request, response) {
  const write = cacheWrites.then(async() => {
    if (!canStore(response)) return;
    if (Number(response.headers.get('content-length')) > CACHE_MAX_ASSET_BYTES) return;
    const body = await response.arrayBuffer();
    if (body.byteLength > CACHE_MAX_ASSET_BYTES) return;
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.set('content-length', String(body.byteLength));
    headers.set('x-inpx-cache-bytes', String(body.byteLength));
    const cache = await caches.open(CACHE_NAME);
    // Insertion order provides bounded FIFO retention without another index.
    await cache.delete(request);
    await cache.put(request, new Response(body, {status: 200, headers}));
    const keys = await cache.keys();
    let bytes = 0;
    const sizes = [];
    for (const key of keys) {
      const stored = await cache.match(key);
      const size = Number(stored.headers.get('x-inpx-cache-bytes')) || (await stored.arrayBuffer()).byteLength;
      sizes.push(size); bytes += size;
    }
    let remaining = keys.length;
    for (let index = 0; index < keys.length && (remaining > CACHE_MAX_ENTRIES || bytes > CACHE_MAX_BYTES); index++) {
      if (APP_SHELL.includes(new URL(keys[index].url).pathname)) continue;
      await cache.delete(keys[index]); bytes -= sizes[index]; remaining--;
    }
  }).catch(() => {});
  cacheWrites = write;
  return write;
}

async function shellFallback() {
  const cache = await caches.open(CACHE_NAME);
  return await cache.match(withBase('/index.html')) || Response.error();
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all(APP_SHELL.map(async(url) => {
      try {await storeBounded(url, await fetch(noStoreRequest(url)));} catch { /* Retry assets on demand. */ }
    }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('inpx-web-') && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET')
    return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin)
    return;

  // Only the actual app document can replace the offline shell. Downloads,
  // signed audio, backgrounds, backups and APIs always go to the network.
  if (request.mode === 'navigate' && isShellDocument(url.pathname)) {
    event.respondWith(
      fetch(noStoreRequest(request))
        .then((response) => {
          if (canStore(response) && /text\/html/i.test(response.headers.get('content-type') || ''))
            event.waitUntil(storeBounded(withBase('/index.html'), response.clone()));
          return response;
        })
        .catch(shellFallback)
    );
    return;
  }

  if (isFreshShellPath(url.pathname)) {
    event.respondWith(
      fetch(noStoreRequest(request))
        .catch(() => (
          [withBase('/'), withBase('/index.html')].includes(url.pathname)
            ? shellFallback()
            : Response.error()
        ))
    );
    return;
  }

  if (!isStaticAsset(url) || request.headers.has('range') || request.headers.has('authorization'))
    return;

  const cacheKey = new URL(url);
  cacheKey.search = '';
  event.respondWith(
    caches.open(CACHE_NAME).then(cache => cache.match(cacheKey.href)).then((cached) => cached || fetch(request).then((response) => {
      if (canStore(response)) event.waitUntil(storeBounded(cacheKey.href, response.clone()));
      return response;
    }))
  );
});
