/**
 * MediFlow service worker.
 *
 * Offline strategy, in order of preference:
 *   1. App shell (HTML, JS, CSS, manifest, icons): cache-first, populated at
 *      install and on every successful network fetch. Navigations fall back to
 *      the cached shell so the app opens with no connectivity.
 *   2. API GETs: network-first with a cache fallback, so lists opened before
 *      stay readable offline and refresh when back online.
 *   3. API writes: never cached and never intercepted. The app itself queues
 *      mutations in localStorage and replays them (see src/api.ts), because a
 *      service worker cannot show which queued write belongs to which screen.
 */

const VERSION = 'mediflow-v3';
const SHELL_CACHE = `${VERSION}-shell`;
const API_CACHE = `${VERSION}-api`;

const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== API_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

const API_PREFIXES = [
  '/auth/',
  '/patients',
  '/appointments',
  '/schedule/',
  '/waitlist',
  '/threads',
  '/messages',
  '/outbox',
  '/follow-ups',
  '/vitals',
  '/alerts',
  '/visits',
  '/records/',
  '/documents',
  '/invoices',
  '/payments',
  '/finance/',
  '/dashboard/',
  '/notifications',
  '/clinic',
  '/staff',
  '/public/',
  '/health',
  '/ready',
];

function isApiRequest(url) {
  return API_PREFIXES.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix));
}

self.addEventListener('push', (event) => {
  // FCM / server push lands here when configured; local reminders use
  // showNotification directly from the page via serviceWorker.ready.
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'MediFlow';
  const options = {
    body: data.body || '',
    icon: '/icons/icon.svg',
    badge: '/icons/icon.svg',
    data: { url: data.url || '/#/my/appointments' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/#/my/appointments';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Only handle same-origin traffic plus API calls (which may be cross-origin
  // in development). Everything else belongs to the browser.
  const api = isApiRequest(url);
  if (url.origin !== self.location.origin && !api) return;

  // Navigations always resolve to the shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }

  // Same-origin static assets: cache-first.
  if (url.origin === self.location.origin && !api) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
    return;
  }

  // API GETs: network-first, cache fallback.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(API_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request)),
  );
});
