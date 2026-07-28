/* KASA Mobil — service worker
   Uygulama kabuğunu önbelleğe alır; fabrikada/çevrimdışı da açılsın diye.
   GitHub API istekleri ASLA önbelleğe alınmaz (kimlik doğrulamalı + taze olmalı).

   ⚠️ SURUM her arayüz güncellemesinde artırılmalı. Aksi halde telefonda ESKİ css ile
   YENİ html eşleşip düzen bozulabiliyor (28.07'de bir kez yaşandı). index.html'deki
   `?s=` sorgu parametresi de aynı sayıyla güncellenir. */

const SURUM = 'kasa-v7';
const KABUK = [
  './',
  './index.html',
  './app.css?s=7',
  './app.js?s=7',
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

  if (url.hostname === 'api.github.com') return;      // API'ye dokunma
  if (ev.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // HTML her zaman ağdan denenir (sürüm atlamalarını yakalamak için)
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
