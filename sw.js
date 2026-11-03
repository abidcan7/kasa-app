/* KASA Mobil — service worker
   Uygulama kabuğunu önbelleğe alır; fabrikada/çevrimdışı da açılsın diye.
   GitHub API istekleri ASLA önbelleğe alınmaz (kimlik doğrulamalı + taze olmalı).

   ⚠️ SURUM her arayüz güncellemesinde artırılmalı. Aksi halde telefonda ESKİ css ile
   YENİ html eşleşip düzen bozulabiliyor (28.07'de bir kez yaşandı). index.html'deki
   `?s=` sorgu parametresi de aynı sayıyla güncellenir. */

const SURUM = 'kasa-v16';   // v16: An gece yarisi tekrar sormuyor (yerel hafiza 8 sa, 05:00 oncesi onceki gun), eski hafta plani uyarisi (04.11); v15: index.html no-cache
const KABUK = [
  './',
  './index.html',
  './app.css?s=13',
  './app.js?s=13',
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

  // HTML her zaman ağdan denenir (sürüm atlamalarını yakalamak için).
  // GitHub Pages index.html'i 10 dk HTTP önbelleğiyle verir; sayfa yüklemesinde
  // (navigate) tarayıcı önbelleğini atlayıp sunucuya sor — yoksa yeni sürüm
  // telefona 10 dk geç düşüyor (03.11'de yaşandı).
  const istek = ev.request.mode === 'navigate' || ev.request.destination === 'document'
    ? new Request(ev.request, { cache: 'no-cache' })
    : ev.request;
  ev.respondWith(
    fetch(istek)
      .then(yanit => {
        const kopya = yanit.clone();
        caches.open(SURUM).then(c => c.put(ev.request, kopya)).catch(() => {});
        return yanit;
      })
      .catch(() => caches.match(ev.request).then(v => v || caches.match('./index.html')))
  );
});
