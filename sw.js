/* Service worker — cache'uje aplikację, żeby działała bez internetu.
   Po każdej zmianie index.html PODNIEŚ numer wersji, inaczej telefon
   będzie serwował starą wersję z cache'u. */
const V = 'trening-v3';
const FILES = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Strategia: najpierw sieć (żeby łapać aktualizacje), w razie braku — cache.
   Dane treningowe siedzą w localStorage, więc cache dotyczy wyłącznie kodu. */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const copy = r.clone();
        caches.open(V).then(c => c.put(e.request, copy)).catch(() => {});
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
