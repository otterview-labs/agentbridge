const SHELL_CACHE = 'asb-shell-v10';

const SHELL_NAVIGATIONS = new Set(['/', '/ui', '/index.html']);

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/app.css',
  '/app.js',
  '/api-token-state.js',
  '/work-status.js',
  '/command-center.js',
  '/manifest.webmanifest',
  '/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('asb-shell-') && key !== SHELL_CACHE)
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname === '/events') {
    return;
  }

  if (request.mode === 'navigate') {
    // A direct browser navigation can target an API route such as /sessions
    // and still have mode=navigate. Only known UI routes may use the offline
    // shell; every other navigation bypasses Cache Storage entirely.
    if (!SHELL_NAVIGATIONS.has(url.pathname)) {
      return;
    }

    event.respondWith(networkFirstNavigation(request, '/index.html'));
    return;
  }

  if (SHELL_ASSETS.includes(url.pathname)) {
    // Do not persist query strings in cache keys; they can contain accidental
    // credentials or other private values even for an otherwise static path.
    if (url.search) {
      return;
    }

    event.respondWith(networkFirstAsset(request, SHELL_CACHE));
    return;
  }

  // API responses can contain workspace paths, prompts, approvals, command
  // output, and machine metadata. Always let them use the network so they are
  // never retained in Cache Storage or replayed across token changes.
});

async function networkFirstAsset(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    // Keep styles and modules fresh alongside network-first HTML after an update.
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function networkFirstNavigation(request, fallbackPath) {
  try {
    // The shell cache is populated during install. Avoid writing navigation
    // responses here so an unexpected content type can never enter it.
    return await fetch(request);
  } catch (error) {
    if (fallbackPath) {
      const fallback = await caches.match(fallbackPath);

      if (fallback) {
        return fallback;
      }
    }

    throw error;
  }
}
