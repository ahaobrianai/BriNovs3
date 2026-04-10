/* ═══════════════════════════════════════════════════════════════
   BriNovs FX Engine — sw.js
   Service Worker v1.0
   ─────────────────────────────────────────────────────────────
   Responsibilities:
   • Cache all core app files on install
   • Serve cached files when offline (cache-first for assets)
   • Network-first for HTML pages (always get fresh content)
   • Skip waiting — activate immediately on update
   • Clean up old caches on activate
═══════════════════════════════════════════════════════════════ */

'use strict';

const CACHE_NAME    = 'brinovs-fx-v1';
const CACHE_PAGES   = 'brinovs-pages-v1';

// ── Assets to cache immediately on install ──
// These are the core files the app needs to function.
// HTML pages are cached separately with a network-first strategy.
const STATIC_ASSETS = [
  '/style.css',
  '/signals.css',
  '/watcher.css',
  '/userpanel.css',
  '/splash.css',
  '/app.js',
  '/manifest.json',
];

const HTML_PAGES = [
  '/index.html',
  '/signals.html',
  '/watcher.html',
  '/userpanel.html',
];

// ─────────────────────────────────────────────
// INSTALL — cache static assets
// ─────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    Promise.all([
      // Cache static assets (CSS, JS, manifest)
      caches.open(CACHE_NAME).then(cache => {
        return cache.addAll(STATIC_ASSETS).catch(err => {
          // Log but don't fail install if one asset is missing
          console.warn('[SW] Some static assets failed to cache:', err);
        });
      }),
      // Cache HTML pages
      caches.open(CACHE_PAGES).then(cache => {
        return cache.addAll(HTML_PAGES).catch(err => {
          console.warn('[SW] Some HTML pages failed to cache:', err);
        });
      }),
    ]).then(() => {
      // Activate immediately without waiting for old SW to finish
      self.skipWaiting();
    })
  );
});

// ─────────────────────────────────────────────
// ACTIVATE — clean up old caches
// ─────────────────────────────────────────────
self.addEventListener('activate', event => {
  const validCaches = [CACHE_NAME, CACHE_PAGES];

  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => !validCaches.includes(name))
          .map(name => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => {
      // Take control of all open pages immediately
      return self.clients.claim();
    })
  );
});

// ─────────────────────────────────────────────
// FETCH — serve from cache with smart strategy
// ─────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // ── Ignore non-GET requests ──
  if (event.request.method !== 'GET') return;

  // ── Ignore external URLs (WebSocket feeds, Deriv API, CDN fonts) ──
  // These must always go to the network — never cache WebSocket or API calls
  if (
    url.protocol === 'wss:' ||
    url.hostname.includes('binaryws.com') ||
    url.hostname.includes('deriv.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('phototourl.com') ||
    url.hostname.includes('cdnjs.cloudflare.com')
  ) {
    return; // Let the browser handle it normally
  }

  // ── HTML pages: network-first, fall back to cache ──
  // Always try to get fresh HTML. If offline, serve cached version.
  if (
    event.request.headers.get('accept') &&
    event.request.headers.get('accept').includes('text/html')
  ) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Cache the fresh response
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_PAGES).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // Network failed — serve from cache
          return caches.match(event.request).then(cached => {
            return cached || caches.match('/index.html');
          });
        })
    );
    return;
  }

  // ── Static assets (CSS, JS): cache-first, fall back to network ──
  // Assets are versioned by cache name — serve instantly from cache.
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      // Not in cache — fetch from network and cache it
      return fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // Both cache and network failed — return nothing (browser handles error)
          console.warn('[SW] Asset unavailable, cache and network failed:', event.request.url);
        });
    })
  );
});

// ─────────────────────────────────────────────
// MESSAGE — handle commands from the app
// ─────────────────────────────────────────────
self.addEventListener('message', event => {
  // Allow the app to force a cache refresh
  if (event.data && event.data.action === 'skipWaiting') {
    self.skipWaiting();
  }

  // Allow the app to clear all caches (e.g. on logout)
  if (event.data && event.data.action === 'clearCache') {
    caches.keys().then(names => {
      return Promise.all(names.map(name => caches.delete(name)));
    }).then(() => {
      event.source && event.source.postMessage({ action: 'cacheCleared' });
    });
  }
});
