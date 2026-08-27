(function () {
  "use strict";

  const cleanupMarker = "omnistream-monetag-notifications-removed-v1";
  try {
    if (window.localStorage.getItem(cleanupMarker) === "1") return;
  } catch (_error) {
    // Le nettoyage reste possible lorsque le stockage local est désactivé.
  }

  async function removeOldNotificationAds() {
    if (
      "serviceWorker" in navigator &&
      typeof navigator.serviceWorker.getRegistrations === "function"
    ) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        registrations.map(async (registration) => {
          const workers = [
            registration.active,
            registration.waiting,
            registration.installing,
          ].filter(Boolean);
          const isOldMonetagWorker = workers.some((worker) => {
            try {
              const scriptUrl = new URL(worker.scriptURL);
              return (
                scriptUrl.origin === window.location.origin &&
                scriptUrl.pathname === "/sw.js"
              );
            } catch (_error) {
              return false;
            }
          });
          if (!isOldMonetagWorker) return;

          try {
            const subscription = await registration.pushManager?.getSubscription();
            if (subscription) await subscription.unsubscribe();
          } finally {
            await registration.unregister();
          }
        }),
      );
    }

    if ("caches" in window) {
      const cacheNames = await window.caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => /monetag|push|notification|lary/i.test(name))
          .map((name) => window.caches.delete(name)),
      );
    }

    try {
      window.localStorage.setItem(cleanupMarker, "1");
    } catch (_error) {
      // Rien d'autre à faire si le navigateur bloque le stockage local.
    }
  }

  removeOldNotificationAds().catch((error) => {
    console.warn("Nettoyage des anciennes notifications impossible :", error);
  });
})();
