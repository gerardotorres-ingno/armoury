/* Service worker mínimo: guarda la app y el catálogo para usarla sin conexión.
 *
 * Estrategia: red primero, caché como respaldo. Así el catálogo se actualiza
 * solo cuando hay señal, y en la mesa de juego (donde el wifi del club nunca
 * anda) sigue abriendo con la última copia.
 *
 * El nombre del caché lleva versión: al cambiarlo, se borran los viejos.
 */
const CACHE = 'armoury-v1';
const ASSETS = ['./', './index.html', './collection-data.json', './manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
