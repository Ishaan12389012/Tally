// Offline support. App files are network-first, so one reload picks up the latest version;
// the cached copy is used when offline or when the network is slow. Fonts are cache-first.
// Database requests are never cached.
const CACHE = 'tally-v4';
const SHELL = ['./', 'index.html', 'config.js', 'sync.js', 'vendor/supabase-2.117.2.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

function put(req, res) {
  if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET') return;

  if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => put(req, res))));
    return;
  }
  if (url.origin !== location.origin) return;

  // network-first: skip the browser's HTTP cache so a merged change shows on the next reload
  e.respondWith(new Promise(resolve => {
    let done = false;
    const fallback = () => caches.match(req, { ignoreSearch: true })
      .then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined))
      .then(hit => hit || Response.error());
    // slow network: use the cached copy if there is one, otherwise keep waiting
    const timer = setTimeout(() => caches.match(req, { ignoreSearch: true }).then(hit => { if (hit && !done) { done = true; resolve(hit); } }), NETWORK_TIMEOUT_MS);
    fetch(req, { cache: 'no-cache' })
      .then(res => { put(req, res); if (!done) { done = true; clearTimeout(timer); resolve(res); } })
      .catch(() => fallback().then(r => { if (!done) { done = true; clearTimeout(timer); resolve(r); } }));
  }));
});
