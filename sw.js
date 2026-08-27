/*
 * Worker de nettoyage : remplace l'ancien service worker publicitaire,
 * désabonne les notifications push puis se supprime lui-même.
 */
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const subscription = await self.registration.pushManager.getSubscription();
        if (subscription) await subscription.unsubscribe();

        const cacheNames = await caches.keys();
        await Promise.all(
          cacheNames
            .filter((name) => /monetag|push|notification|lary/i.test(name))
            .map((name) => caches.delete(name)),
        );
      } finally {
        await self.registration.unregister();
      }
    })(),
  );
});

// Une éventuelle notification reçue pendant la mise à jour est ignorée.
self.addEventListener("push", () => undefined);
self.addEventListener("notificationclick", (event) => event.notification.close());
