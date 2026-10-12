// Offline support: the app shell is cached on install; fonts are cached the first time they load.
// Database requests are never cached.
const CACHE = 'tally-v3';
const SHELL = ['./', 'index.html', 'config.js', 'sync.js', 'vendor/supabase-2.117.2.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin && !FONT_HOSTS.includes(url.hostname)) return;
  // serve from cache instantly, refresh the cache in the background
  e.respondWith(caches.match(e.request, { ignoreSearch: url.origin === location.origin }).then(hit => {
    const net = fetch(e.request).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => hit || caches.match('index.html'));
    return hit || net;
  }));
});
