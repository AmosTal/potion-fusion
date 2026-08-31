/* Offline cache for the web build. The game ships no runtime downloads, so
 * every asset can be precached on install and served cache-first afterwards;
 * a version bump in CACHE retires the old one. */
const CACHE = 'potion-fusion-v3.6';
const ASSETS = [
  './', './index.html', './font.js', './core.js', './levels.js', './fish.js',
  './pixi.min.js', './aquarium2.js', './config.js', './analytics.js',
  './auth.js', './liveops.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;   // analytics etc. go to the network
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
