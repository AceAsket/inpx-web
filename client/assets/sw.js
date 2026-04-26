const BUILD_ID = '__INPX_WEB_BUILD_ID__';
const CACHE_NAME = `inpx-web-shell-${BUILD_ID}`;
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
  '/favicon.ico'
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
    withBase('/version.txt')
  ].includes(pathname);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
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

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(noStoreRequest(request))
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(withBase('/index.html'), copy));
          return response;
        })
        .catch(() => caches.match(withBase('/index.html')))
    );
    return;
  }

  if (isFreshShellPath(url.pathname)) {
    event.respondWith(
      fetch(noStoreRequest(request))
        .catch(() => caches.match(withBase('/index.html')))
    );
    return;
  }

  if (url.pathname.startsWith(withBase('/book')) || url.pathname.startsWith(withBase('/cover/')))
    return;

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    }))
  );
});
