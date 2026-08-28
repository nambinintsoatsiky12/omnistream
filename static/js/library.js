/*
 * OmniStream — Bibliothèque locale (Ma Liste, Reprendre, Hors ligne)
 * ------------------------------------------------------------------
 * Stockage PRINCIPAL : IndexedDB. Capacité très grande (des milliers
 * d'entrées), écritures asynchrones, et données conservées même après
 * fermeture du navigateur ou coupure réseau. Le quota localStorage (≈ 5 Mo,
 * qui faisait tout silencieusement disparaître) n'est plus la limite.
 *
 * Stockage SECONDAIRE : un miroir compact dans localStorage, lu
 * synchroniquement au démarrage — ainsi les coeurs des cartes sont déjà
 * colorés au premier affichage, sans attendre l'ouverture de la base.
 *
 * Aucun octet n'est envoyé au serveur, aucune compte nécessaire.
 */
(function () {
  "use strict";

  const DB_NAME = "omnistream-library";
  const DB_VERSION = 1;
  const STORE = "buckets";
  const LS_KEYS = {
    favorites: "omni:favorites",
    continue: "omni:continue",
    offline: "omni:offline",
  };
  // Marqueur de migration : v2 = IndexedDB devient la source de vérité.
  const LS_MIGRATED = "omni:storage-v2";
  // Nombre d'entrées gardées dans le miroir rapide (localStorage).
  const MIRROR_LIMIT = 250;
  // 0 = illimité. Seule l'historique de reprise est bornée, par clarté.
  const LIMITS = { favorites: 0, continue: 400, offline: 0 };
  const BUCKETS = ["favorites", "continue", "offline"];

  const mem = { favorites: [], continue: [], offline: [] };
  let dbPromise = null;
  let hydrated = false;

  /* ------------------------------------------------------------------ *
   * IndexedDB
   * ------------------------------------------------------------------ */
  function hasIdb() {
    try {
      return typeof indexedDB !== "undefined" && indexedDB !== null;
    } catch (_error) {
      return false;
    }
  }

  function openDb() {
    if (!hasIdb()) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (_error) {
        resolve(null);
        return;
      }
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        done(db);
      };
      request.onerror = () => done(null);
      request.onblocked = () => done(null);
      // Filet de sécurité : un IDB bloqué (autre onglet) ne doit pas geler l'app.
      window.setTimeout(() => done(null), 2000);
    });
    return dbPromise;
  }

  function idbGet(bucket) {
    return openDb().then((db) => {
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE, "readonly");
          const req = tx.objectStore(STORE).get(bucket);
          req.onsuccess = () => {
            const value = req.result;
            resolve(Array.isArray(value) ? value : null);
          };
          req.onerror = () => resolve(null);
        } catch (_error) {
          resolve(null);
        }
      });
    });
  }

  function idbPut(bucket, list) {
    return openDb().then((db) => {
      if (!db) return false;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).put(list, bucket);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        } catch (_error) {
          resolve(false);
        }
      });
    });
  }

  function idbDelete(bucket) {
    return openDb().then((db) => {
      if (!db) return false;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).delete(bucket);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch (_error) {
          resolve(false);
        }
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Miroir localStorage (lecture synchrone)
   * ------------------------------------------------------------------ */
  function readMirror(key) {
    try {
      const raw = window.localStorage.getItem(LS_KEYS[key]);
      const value = raw ? JSON.parse(raw) : [];
      return Array.isArray(value) ? value : [];
    } catch (_error) {
      return [];
    }
  }

  function writeMirror(key, list) {
    // Le miroir n'est qu'un accélérateur : on le tronque volontairement, et
    // un échec d'écriture (quota, mode privé) n'annule PAS la sauvegarde
    // principale en IndexedDB.
    try {
      const payload = JSON.stringify(list.slice(0, MIRROR_LIMIT));
      window.localStorage.setItem(LS_KEYS[key], payload);
      return true;
    } catch (_error) {
      try {
        window.localStorage.setItem(LS_KEYS[key], JSON.stringify(list.slice(0, 40)));
      } catch (_inner) {
        /* stockage local indisponible : IndexedDB reste la source */
      }
      return false;
    }
  }

  function markMigrated() {
    try {
      window.localStorage.setItem(LS_MIGRATED, "2");
    } catch (_error) {
      /* noop */
    }
  }

  function alreadyMigrated() {
    try {
      return window.localStorage.getItem(LS_MIGRATED) === "2";
    } catch (_error) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Utilitaires
   * ------------------------------------------------------------------ */
  function keyOf(item) {
    if (!item) return "x:";
    return `${item.media_type || item.type || "x"}:${item.id}`;
  }

  function dedupeAppend(target, incoming) {
    const seen = new Set(target.map(keyOf));
    incoming.forEach((item) => {
      const key = keyOf(item);
      if (seen.has(key)) return;
      seen.add(key);
      target.push(item);
    });
    return target;
  }

  function applyLimit(bucket, list) {
    const limit = LIMITS[bucket] || 0;
    return limit > 0 ? list.slice(0, limit) : list.slice();
  }

  function announce(bucket) {
    document.dispatchEvent(new CustomEvent("omni:library-change", { detail: { key: bucket } }));
  }

  function sortNewest(list) {
    return list
      .slice()
      .sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
  }

  /* ------------------------------------------------------------------ *
   * Écriture : mémoire (immédiate) + miroir + IndexedDB (durable)
   * ------------------------------------------------------------------ */
  function save(bucket, list) {
    const next = applyLimit(bucket, list);
    mem[bucket] = next;
    writeMirror(bucket, next);
    idbPut(bucket, next).catch(() => false);
    announce(bucket);
    return next;
  }

  /* ------------------------------------------------------------------ *
   * Hydratation : IndexedDB = vérité, sinon on migre l'ancien localStorage
   * ------------------------------------------------------------------ */
  function hydrate() {
    if (!hasIdb()) {
      hydrated = true;
      announce("ready");
      return Promise.resolve(false);
    }
    const firstRun = !alreadyMigrated();
    return Promise.all(BUCKETS.map((bucket) => idbGet(bucket))).then((stored) => {
      BUCKETS.forEach((bucket, index) => {
        const local = readMirror(bucket);
        const remote = Array.isArray(stored[index]) ? stored[index] : null;
        let list;
        if (firstRun) {
          // Première ouverture depuis la mise à jour : on fusionne l'ancien
          // localStorage avec ce que la base contient déjà, rien ne se perd.
          list = sortNewest(dedupeAppend(local.slice(), remote || []));
        } else {
          list = remote && remote.length ? remote : local.slice();
        }
        const limited = applyLimit(bucket, list);
        mem[bucket] = limited;
        writeMirror(bucket, limited);
        if (firstRun || (remote && remote.length !== limited.length)) {
          idbPut(bucket, limited).catch(() => false);
        }
      });
      if (firstRun) markMigrated();
      hydrated = true;
      announce("ready");
      return true;
    });
  }

  /* ------------------------------------------------------------------ *
   * Favoris (Ma Liste)
   * ------------------------------------------------------------------ */
  function getFavorites() {
    return mem.favorites.slice();
  }

  function isFavorite(item) {
    const key = keyOf(item);
    return mem.favorites.some((entry) => keyOf(entry) === key);
  }

  function toggleFavorite(item) {
    if (!item || !item.id) return false;
    const key = keyOf(item);
    const list = mem.favorites.slice();
    const index = list.findIndex((entry) => keyOf(entry) === key);
    if (index >= 0) {
      list.splice(index, 1);
      save("favorites", list);
      return false;
    }
    list.unshift(Object.assign({}, item, { savedAt: Date.now() }));
    save("favorites", sortNewest(list));
    return true;
  }

  function removeFavorite(item) {
    const key = keyOf(item);
    save(
      "favorites",
      mem.favorites.filter((entry) => keyOf(entry) !== key),
    );
  }

  /* ------------------------------------------------------------------ *
   * Reprendre (historique)
   * ------------------------------------------------------------------ */
  function getContinue() {
    return mem.continue.slice();
  }

  function recordView(item) {
    if (!item || !item.id) return;
    const key = keyOf(item);
    const list = mem.continue.filter((entry) => keyOf(entry) !== key);
    list.unshift(Object.assign({}, item, { viewedAt: Date.now() }));
    save("continue", list);
  }

  function removeContinue(item) {
    const key = keyOf(item);
    save(
      "continue",
      mem.continue.filter((entry) => keyOf(entry) !== key),
    );
  }

  /* ------------------------------------------------------------------ *
   * Hors ligne (métadonnées + cache réel des images et de la page)
   * ------------------------------------------------------------------ */
  function getOffline() {
    return mem.offline.slice();
  }

  function isOffline(item) {
    const key = keyOf(item);
    return mem.offline.some((entry) => keyOf(entry) === key);
  }

  // Demande VRAIE avec réponse du worker : le canal permet de savoir quand le
  // fichier est réellement en cache — utile pour un MP3 de 5 à 10 Mo qui peut
  // mettre une à deux minutes sur un forfait.
  function swRequest(message, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) {
        return done(null);
      }
      try {
        const channel = new MessageChannel();
        const timer = window.setTimeout(() => done(null), timeoutMs || 15000);
        channel.port1.onmessage = (event) => {
          window.clearTimeout(timer);
          done(event.data || null);
        };
        channel.port1.onmessageerror = () => {
          window.clearTimeout(timer);
          done(null);
        };
        navigator.serviceWorker.ready
          .then((registration) => {
            if (!registration.active) {
              window.clearTimeout(timer);
              done(null);
              return;
            }
            registration.active.postMessage(message, [channel.port2]);
          })
          .catch(() => {
            window.clearTimeout(timer);
            done(null);
          });
      } catch (_error) {
        done(null);
      }
    });
  }

  // Le worker a besoin de temps pour un gros fichier : le délai d'attente
   // est calé sur la taille annoncée (60 Ko/s au pire), sans dépasser 8 minutes.
  // d'attente d'après la taille annoncée (60 Ko/s au pire), sans jamais
  // dépasser 8 minutes.
  function waitMsForBytes(bytes) {
    const size = Number(bytes) || 0;
    return Math.min(8 * 60 * 1000, 20000 + (size / 60000) * 1000);
  }

  function swPostMessage(message) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
          return done(false); // première visite : rien à demander au worker
        }
        // `ready` peut ne jamais se résoudre (worker en attente d'activation) :
        // l'épinglage ne doit jamais rester bloqué sur cette promesse.
        const timer = window.setTimeout(() => done(false), 1500);
        navigator.serviceWorker.ready
          .then((registration) => {
            window.clearTimeout(timer);
            if (registration.active) registration.active.postMessage(message);
            done(true);
          })
          .catch(() => {
            window.clearTimeout(timer);
            done(false);
          });
      } catch (_error) {
        done(false);
      }
    });
  }

  function imageUrlsOf(item) {
    return [item.poster, item.thumbnail, item.backdrop].filter(
      (value) => typeof value === "string" && value.startsWith("https://"),
    );
  }

  async function saveOffline(item) {
    if (!item || !item.id) return false;
    const key = keyOf(item);
    const urls = imageUrlsOf(item).concat(item.url ? [item.url] : []);
    const record = Object.assign({}, item, { offlineAt: Date.now(), urls });
    const existing = mem.offline;
    if (!existing.some((entry) => keyOf(entry) === key)) {
      save("offline", sortNewest([record].concat(existing)));
    }
    // Mise en cache réelle : le Service Worker rapatrie affiches, page et —
    // pour un MP3 libre — le fichier lui-même, ce qui rend l'élément vraiment
    // consultable (et écoutable) sans réseau.
    const answer = await swRequest(
      { type: "cache-offline", bucket: key, urls: record.urls },
      waitMsForBytes(record.size),
    );
    if (answer && typeof answer.cached === "number") {
      record.cached = answer.cached;
      save(
        "offline",
        sortNewest(mem.offline.map((entry) => (keyOf(entry) === key ? record : entry))),
      );
      document.dispatchEvent(new CustomEvent("omni:library-change"));
      // Réponse du worker mais rien de stocké = rien d'atteignable : le dire
      // vaut mieux qu'un « enregistré » tranquille qui ne marche pas hors ligne.
      return answer.cached > 0;
    }
    // Aucun worker joignable (première visite, worker en attente) : on cache
    // nous-mêmes, sinon « épingler » n'enregistrerait rien du tout.
    const stored = await precacheImages(record.urls);
    if (stored > 0) {
      record.cached = stored;
      save(
        "offline",
        sortNewest(mem.offline.map((entry) => (keyOf(entry) === key ? record : entry))),
      );
    }
    return stored > 0;
  }

  function removeOffline(item) {
    const key = keyOf(item);
    const removed = mem.offline.find((entry) => keyOf(entry) === key);
    save(
      "offline",
      mem.offline.filter((entry) => keyOf(entry) !== key),
    );
    if (removed && removed.url) {
      swPostMessage({ type: "uncache-offline", bucket: key, urls: [removed.url] });
    }
  }

  async function precacheImages(urls) {
    const list = (Array.isArray(urls) ? urls : []).filter(
      (value) => typeof value === "string" && value.startsWith("https://"),
    );
    if (!list.length) return 0;
    const usedSw = await swPostMessage({ type: "cache-images", urls: list });
    if (usedSw) return list.length;
    // Repli : cache de premier niveau depuis la page (images opaques incluses).
    if (!("caches" in window)) return 0;
    let stored = 0;
    try {
      const cache = await caches.open("omnistream-offline");
      await Promise.all(
        list.map(async (url) => {
          try {
            const request = new Request(url, { mode: "no-cors" });
            const response = await fetch(request);
            await cache.put(request, response);
            stored += 1;
          } catch (_error) {
            /* ressource indisponible : on ne la compte pas */
          }
        }),
      );
    } catch (_error) {
      /* cache indisponible */
    }
    return stored;
  }

  /* ------------------------------------------------------------------ *
   * Nettoyage et diagnostics
   * ------------------------------------------------------------------ */
  async function clearBucket(bucket) {
    if (!BUCKETS.includes(bucket)) return false;
    mem[bucket] = [];
    try {
      window.localStorage.removeItem(LS_KEYS[bucket]);
    } catch (_error) {
      /* noop */
    }
    await idbDelete(bucket);
    announce(bucket);
    return true;
  }

  async function clearAll() {
    for (let index = 0; index < BUCKETS.length; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await clearBucket(BUCKETS[index]);
    }
    try {
      window.localStorage.removeItem("omni:last-track");
      window.localStorage.removeItem("omni:queue");
      window.localStorage.removeItem("omni:resume");
    } catch (_error) {
      /* noop */
    }
    return true;
  }

  async function stats() {
    const info = {
      favorites: mem.favorites.length,
      continue: mem.continue.length,
      offline: mem.offline.length,
      persisted: false,
      usage: 0,
      quota: 0,
      images: 0,
    };
    try {
      if (navigator.storage && navigator.storage.persisted) {
        info.persisted = await navigator.storage.persisted();
      }
      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        info.usage = estimate.usage || 0;
        info.quota = estimate.quota || 0;
      }
    } catch (_error) {
      /* noop */
    }
    try {
      if ("caches" in window) {
        const cache = await caches.open("omnistream-offline");
        info.images = (await cache.keys()).length;
      }
    } catch (_error) {
      /* noop */
    }
    return info;
  }

  // Demande de stockage « persistant » : le navigateur ne pourra pas purger
  // silencieusement la bibliothèque et le cache quand l'espace disque manque.
  async function requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        return await navigator.storage.persist();
      }
    } catch (_error) {
      /* noop */
    }
    return false;
  }

  const api = {
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
    swRequest,
    removeOffline,
    precacheImages,
    clearBucket,
    clearAll,
    stats,
    requestPersistence,
    keyOf,
    counts: () => ({
      favorites: mem.favorites.length,
      continue: mem.continue.length,
      offline: mem.offline.length,
    }),
    isReady: () => hydrated,
    whenReady: (callback) => {
      if (typeof callback !== "function") return Promise.resolve(hydrated);
      if (hydrated) {
        callback();
        return Promise.resolve(true);
      }
      const once = () => {
        document.removeEventListener("omni:library-change", once);
        callback();
      };
      document.addEventListener("omni:library-change", once);
      return Promise.resolve(true);
    },
    // Accès bas niveau (compteur de données économisées, etc.)
    readLocal: (key, fallback) => {
      try {
        const raw = window.localStorage.getItem(key);
        return raw === null ? fallback : raw;
      } catch (_error) {
        return fallback;
      }
    },
    writeLocal: (key, value) => {
      try {
        window.localStorage.setItem(key, value);
        return true;
      } catch (_error) {
        return false;
      }
    },
    removeLocal: (key) => {
      try {
        window.localStorage.removeItem(key);
      } catch (_error) {
        /* noop */
      }
    },
  };

  window.OmniLibrary = api;
  hydrate().catch(() => {
    hydrated = true;
  });
})();
