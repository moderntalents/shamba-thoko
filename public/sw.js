// The previous Shamba Soko site installed a service worker that keeps showing the old version to returning visitors.
// This replacement removes itself and the old caches, then reloads open pages so everyone gets the current app.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
  })());
});
