/* KASA Mobil — service worker
   Uygulama kabuğunu önbelleğe alır; fabrikada/çevrimdışı da açılsın diye.
   GitHub API istekleri ASLA önbelleğe alınmaz (kimlik doğrulamalı + taze olmalı). */

const SURUM  = 'kasa-v1';
const KABUK = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.webmanifest',
  './ikon/icon.svg'
];

self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(SURUM)
      .then(c => c.addAll(KABUK))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(adlar => Promise.all(adlar.filter(a => a !== SURUM).map(a => caches.delete(a))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', ev => {
  const url = new URL(ev.request.url);

  // GitHub API'ye dokunma — her zaman ağdan, önbelleksiz
  if (url.hostname === 'api.github.com') return;
  if (ev.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // kabuk: önce ağ, olmazsa önbellek (güncel kalsın ama çevrimdışı da açılsın)
  ev.respondWith(
    fetch(ev.request)
      .then(yanit => {
        const kopya = yanit.clone();
        caches.open(SURUM).then(c => c.put(ev.request, kopya)).catch(() => {});
        return yanit;
      })
      .catch(() => caches.match(ev.request).then(v => v || caches.match('./index.html')))
  );
});
