/* Service worker — aplikacja ma działać bez internetu.
   Bez ręcznego wersjonowania: nazwa cache'u jest stała, a świeżość
   zapewnia strategia „najpierw sieć". Nic tu nie musisz podbijać
   po zmianie index.html. */
const CACHE = 'trening';
const FILES = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    /* sprzątanie po starym schemacie z ręcznymi wersjami (trening-v1, -v2, -v3) */
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* Najpierw sieć, cache jako zapas.
   `cache:'no-cache'` wymusza sprawdzenie u serwera, czy plik się zmienił —
   bez tego GitHub Pages potrafiłby podać kopię z cache'u HTTP nawet przez 10 minut.
   Odpowiedź 304 jest tania, więc nic to nie kosztuje. */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return;

  /* Dwie poprawki z 26 września:
     1. LIMIT CZASU. Na siłowni zasięg bywa szczątkowy — telefon „ma sieć",
        ale odpowiedź nie przychodzi. Bez limitu aplikacja wisiała na białym
        ekranie, aż fetch się podda (potrafi to trwać kilkadziesiąt sekund).
        Po 4 s pokazujemy kopię z cache'u; sieć dociąga w tle i odświeża
        cache na następne otwarcie.
     2. BŁĘDY NIE IDĄ DO CACHE'U. Wcześniej każda odpowiedź lądowała w cache'u,
        także 404/500 z GitHub Pages w trakcie przebudowy — i nadpisywała
        dobrą kopię. Offline aplikacja pokazywała wtedy stronę błędu. */
  const zSieci = fetch(req, { cache: 'no-cache' }).then(fresh => {
    if (fresh.ok) {
      const kopia = fresh.clone();
      caches.open(CACHE).then(c => c.put(req, kopia)).catch(() => {});
    }
    return fresh;
  });
  e.respondWith((async () => {
    try {
      return await Promise.race([zSieci,
        new Promise((_, nie) => setTimeout(() => nie(new Error('za wolno')), 4000))]);
    } catch (err) {
      const hit = (await caches.match(req)) || (await caches.match('./index.html'));
      if (hit) return hit;
      return zSieci;   /* nic w cache'u — zostaje tylko czekać na sieć */
    }
  })());
});


/* ============================================================
   POWIADOMIENIA

   Sygnał z serwera przychodzi PUSTY — treść service worker dopytuje sam.
   Powód jest w komentarzu w `serwer/worker.js`: doklejenie treści do
   powiadomienia wymaga osobnego szyfrowania dla każdego odbiorcy, a pusty
   sygnał plus jedno zapytanie robi to samo mniejszym kosztem.

   Adres serwera i token leżą w IndexedDB, bo `localStorage` nie istnieje
   w service workerze. Zapisuje je aplikacja przy włączaniu powiadomień.

   iOS wymaga, żeby KAŻDY sygnał skończył się widocznym powiadomieniem —
   po kilku „cichych" system odbiera zgodę. Dlatego pokazujemy coś zawsze,
   nawet gdy nie uda się pobrać tekstu.
   ============================================================ */
function pushUstawienia(klucz) {
  return new Promise(zwroc => {
    let gotowe = false;
    const koniec = v => { if (!gotowe) { gotowe = true; zwroc(v); } };
    try {
      const zad = indexedDB.open('trening-push', 1);
      zad.onupgradeneeded = () => zad.result.createObjectStore('ust');
      zad.onerror = () => koniec(null);
      zad.onsuccess = () => {
        try {
          const db = zad.result;
          const o = db.transaction('ust', 'readonly').objectStore('ust').get(klucz || 'serwer');
          o.onsuccess = () => koniec(o.result || null);
          o.onerror = () => koniec(null);
        } catch (e) { koniec(null); }
      };
    } catch (e) { koniec(null); }
    setTimeout(() => koniec(null), 3000);
  });
}

/* KONIEC PRZERWY BEZ PYTANIA SERWERA (od wersji 101).

   Do 100 każdy sygnał kończył się zapytaniem `/push/tresc`. Na siłowni,
   przy słabym zasięgu, takie zapytanie potrafi wisieć — a iOS daje service
   workerowi mało czasu. Gdy nie zdąży pokazać powiadomienia, system liczy
   to jako „cichy" sygnał, a po kilku takich odbiera zgodę do następnego
   otwarcia aplikacji. Tak mogły ginąć powiadomienia pod koniec treningu
   (Filip, 3 października).

   Aplikacja przy starcie przerwy zapisuje godzinę jej końca w IndexedDB.
   Sygnał, który przychodzi w okolicy tej godziny, JEST końcem przerwy —
   tekst mamy na miejscu i nie potrzebujemy sieci. */
function toKoniecPrzerwy(p, teraz) {
  return !!(p && p.koniec && teraz > p.koniec - 5000 && teraz < p.koniec + 150000);
}

/* Zapytanie z limitem czasu. Bez limitu wiszące połączenie zjadało cały
   czas, jaki system daje na pokazanie powiadomienia. */
function pobierzZLimitem(adres, opcje, ms) {
  return Promise.race([fetch(adres, opcje),
    new Promise((_, nie) => setTimeout(() => nie(new Error('za wolno')), ms))]);
}

self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let tytul = 'Trening', tekst = 'Zajrzyj do aplikacji.', tag = 'trening-dzien';
    try {
      const p = await pushUstawienia('przerwa');
      if (toKoniecPrzerwy(p, Date.now())) {
        tytul = 'Przerwa minęła';
        tekst = p.cw ? 'Czas na kolejną serię: ' + p.cw + '.' : 'Czas na kolejną serię.';
        tag = 'przerwa';
      } else {
      const u = await pushUstawienia();
      if (u && u.adres && u.token) {
        const r = await pobierzZLimitem(u.adres.replace(/\/+$/, '') + '/push/tresc',
          { headers: { Authorization: 'Bearer ' + u.token } }, 6000);
        if (r.ok) {
          const d = await r.json();
          if (d && d.tekst) { tekst = d.tekst; tytul = d.tytul || tytul; }
          /* Koniec przerwy ma własny tag: nie zastępuje planu dnia,
             a kolejna przerwa zastępuje poprzednią zamiast robić stos. */
          if (d && d.tag === 'przerwa') tag = 'przerwa';
        }
      }
      }
    } catch (err) { /* pokażemy tekst zapasowy — byle coś pokazać */ }

    await self.registration.showNotification(tytul, {
      body: tekst,
      /* Bez `icon`: iOS i tak bierze ikonę aplikacji z ekranu głównego,
         a wskazywanie pliku, którego nie ma, dawałoby ciche 404. */
      tag,                       /* nowe zastępuje stare, nie zbiera się stos */
      renotify: tag === 'przerwa',   /* przerwa ma zadzwonić, nawet gdy poprzednia wisi */
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const okna = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const k of okna) {
      if (k.url.indexOf(self.registration.scope) === 0) return k.focus();
    }
    return self.clients.openWindow('./');
  })());
});
