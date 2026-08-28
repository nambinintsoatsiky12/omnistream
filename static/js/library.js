/*
 * OmniStream — Bibliothèque locale (Ma Liste, Continuer, Hors ligne)
 * ------------------------------------------------------------------
 * Tout est stocké dans le navigateur (localStorage) : aucune donnée
 * n'est envoyée au serveur, et tout fonctionne sans connexion. Aucun
 * Mo dépensé pour gérer ses favoris et son historique.
 */
(function () {
  "use strict";

  const KEYS = {
    favorites: "omni:favorites",
    continue: "omni:continue",
    offline: "omni:offline",
  };
  const LIMIT_CONTINUE = 30;
  const LIMIT_OFFLINE = 120;

  function read(key) {
    try {
      const raw = localStorage.getItem(key);
      const val = raw ? JSON.parse(raw) : [];
      return Array.isArray(val) ? val : [];
    } catch (_e) {
      return [];
    }
  }

  function write(key, list) {
    try {
      localStorage.setItem(key, JSON.stringify(list));
    } catch (_e) {
      /* stockage plein ou désactivé */
    }
    document.dispatchEvent(
      new CustomEvent("omni:library-change", { detail: { key } }),
    );
  }

  function keyOf(item) {
    return `${item.media_type || item.type || "x"}:${item.id}`;
  }

  // --- Favoris (Ma Liste) --------------------------------------------------
  function getFavorites() {
    return read(KEYS.favorites);
  }
  function isFavorite(item) {
    const k = keyOf(item);
    return getFavorites().some((x) => keyOf(x) === k);
  }
  function toggleFavorite(item) {
    const list = getFavorites();
    const k = keyOf(item);
    const idx = list.findIndex((x) => keyOf(x) === k);
    if (idx >= 0) {
      list.splice(idx, 1);
      write(KEYS.favorites, list);
      return false;
    }
    list.unshift({ ...item, savedAt: Date.now() });
    write(KEYS.favorites, list);
    return true;
  }
  function removeFavorite(item) {
    const k = keyOf(item);
    write(KEYS.favorites, getFavorites().filter((x) => keyOf(x) !== k));
  }

  // --- Continuer à regarder ------------------------------------------------
  function getContinue() {
    return read(KEYS.continue);
  }
  function recordView(item) {
    if (!item || !item.id) return;
    const list = getContinue().filter((x) => keyOf(x) !== keyOf(item));
    list.unshift({ ...item, viewedAt: Date.now() });
    write(KEYS.continue, list.slice(0, LIMIT_CONTINUE));
  }
  function removeContinue(item) {
    const k = keyOf(item);
    write(KEYS.continue, getContinue().filter((x) => keyOf(x) !== k));
  }

  // --- Hors ligne (métadonnées + mise en cache des images) -----------------
  function getOffline() {
    return read(KEYS.offline);
  }
  function isOffline(item) {
    const k = keyOf(item);
    return getOffline().some((x) => keyOf(x) === k);
  }
  async function saveOffline(item) {
    if (!item || !item.id) return false;
    const list = getOffline();
    if (list.some((x) => keyOf(x) === keyOf(item))) return true;
    list.unshift({ ...item, offlineAt: Date.now() });
    write(KEYS.offline, list.slice(0, LIMIT_OFFLINE));
    // Pré-cache l'affiche/miniature pour un affichage hors connexion.
    await precacheImages([item.poster, item.thumbnail, item.backdrop].filter(Boolean));
    return true;
  }
  function removeOffline(item) {
    const k = keyOf(item);
    write(KEYS.offline, getOffline().filter((x) => keyOf(x) !== k));
  }

  async function precacheImages(urls) {
    if (!("caches" in window) || !urls.length) return;
    try {
      const cache = await caches.open("omnistream-v1-images");
      await Promise.all(
        urls.map(async (u) => {
          try {
            const req = new Request(u, { mode: "no-cors" });
            const res = await fetch(req);
            await cache.put(req, res);
          } catch (_e) {
            /* image non mise en cache */
          }
        }),
      );
    } catch (_e) {
      /* cache indisponible */
    }
  }

  window.OmniLibrary = {
    getFavorites,
    isFavorite,
    toggleFavorite,
    removeFavorite,
    getContinue,
    recordView,
    removeContinue,
    getOffline,
    isOffline,
    saveOffline,
    removeOffline,
    keyOf,
  };
})();
