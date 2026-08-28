/*
 * OmniStream — Service Worker PWA
 * ------------------------------------------------------------------
 * Deux missions : (1) économiser les Mo, (2) fonctionner sans réseau pour
 * tout ce qui a été visité ou épinglé.
 *
 * Ce qui a été corrigé par rapport à la version précédente :
 *  - les clés de cache des assets ignoraient le « ?v= » des URL : le cache
 *    d'installation ne servait donc JAMAIS. Désormais la correspondance se
 *    fait sans la chaîne de requête ;
 *  - les images TMDB/YouTube, reçues en mode `no-cors` (réponse « opaque »),
 *    étaient écartées du cache par un contrôle trop strict : elles ne
 *    servaient donc jamais hors ligne et étaient re-téléchargées à chaque
 *    page. Elles sont maintenant acceptées et plafonnées ;
 *  - les polices Google n'étaient jamais mises en cache : chaque ouverture
 *    rechargeait ~150 Ko et retarda l'affichage (boutons « mous ») ;
 *  - la liste des fichiers du shell était incomplète (player.js, library.js,
 *    detail.js absents) : l'application était cassée hors ligne ;
 *  - de nouveaux messages permettent à la page de demander une mise en cache
 *    réelle (épinglage hors ligne), de la consulter et de la vider.
 */

const VERSION = "omnistream-v4";
const SHELL_CACHE = `${VERSION}-shell`;
const STATIC_CACHE = `${VERSION}-static`;
const IMAGE_CACHE = `${VERSION}-images`;
const PAGE_CACHE = `${VERSION}-pages`;
const FONT_CACHE = `${VERSION}-fonts`;
const OFFLINE_CACHE = `${VERSION}-offline`;

const IMAGE_CACHE_LIMIT = 140;
const PAGE_CACHE_LIMIT = 60;
const OFFLINE_ITEM_LIMIT = 600;

// Ressources essentielles de l'interface, mises en cache dès l'installation.
// Toute nouvelle page ou script doit être ajouté ici (un test le vérifie).
const SHELL_ASSETS = [
  "/offline",
  "/",
  "/musiques",
  "/bibliotheque",
  "/telechargements",
  "/static/css/style.css",
  "/static/manifest.webmanifest",
  "/static/favicon.svg",
  "/static/images/icon-192.png",
  "/static/images/icon-512.png",
  "/static/js/app-shell.js",
  "/static/js/player.js",
  "/static/js/library.js",
  "/static/js/home.js",
  "/static/js/musique.js",
  "/static/js/detail.js",
  "/static/js/chat.js",
  "/static/js/downloads.js",
  "/static/js/library-page.js",
  "/static/js/notification-cleanup.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(
        SHELL_ASSETS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: "reload" }));
          } catch (_error) {
            /* un asset manquant ne doit pas faire échouer l'installation */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !name.startsWith(VERSION)).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/* ------------------------------------------------------------------ *
   Utilitaires
   ------------------------------------------------------------------ */

// Les URL statiques portent un « ?v=… » de déploiement : on le normalise
// pour qu'une même ressource n'occupe pas dix entrées après dix versions.
function normalizeKey(request) {
  try {
    const url = new URL(request.url);
    if (url.origin === self.location.origin && url.pathname.startsWith("/static/")) {
      return new Request(`${url.origin}${url.pathname}`, {
        method: "GET",
        credentials: request.credentials,
        mode: "same-origin",
      });
    }
  } catch (_error) {
    /* requête déjà simple */
  }
  return request;
}

async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxItems) return;
  await Promise.all(keys.slice(0, keys.length - maxItems).map((key) => cache.delete(key)));
}

async function putSafely(cache, request, response) {
  try {
    await cache.put(request, response.clone());
    return true;
  } catch (_error) {
    /* quota dépassé ou réponse non mettable en cache : on ignore */
    return false;
  }
}

function isImageRequest(request, url) {
  if (request.destination === "image") return true;
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)($|\?)/i.test(url.pathname);
}

function isStaticAsset(url) {
  return url.origin === self.location.origin && url.pathname.startsWith("/static/");
}

function isFontRequest(request, url) {
  if (request.destination === "font") return true;
  try {
    const host = new URL(request.url).hostname;
    return host === "fonts.gstatic.com" || host === "fonts.googleapis.com";
  } catch (_error) {
    return false;
  }
}

async function responseBytes(response) {
  try {
    const length = Number(response.headers.get("content-length"));
    if (length > 0) return length;
  } catch (_error) {
    /* en-tête absent (réponse opaque) */
  }
  try {
    const blob = await response.clone().blob();
    return blob.size || 0;
  } catch (_error) {
    return 0;
  }
}

async function reportSaved(bytes) {
  if (!bytes) return;
  try {
    const clients = await self.clients.matchAll({ type: "window" });
    clients.forEach((client) => client.postMessage({ type: "omni-saved-bytes", bytes }));
  } catch (_error) {
    /* noop */
  }
}

/* ------------------------------------------------------------------ *
   Stratégies
   ------------------------------------------------------------------ */

// Cache d'abord : ce qui n'a pas de raison de changer (images, icônes).
async function cacheFirst(request, cacheName, limit) {
  const cache = await caches.open(cacheName);
  const key = normalizeKey(request);
  const cached = await cache.match(key);
  if (cached) {
    reportSaved(await responseBytes(cached));
    return cached;
  }
  const response = await fetch(request);
  // Une réponse opaque (image cross-origin en no-cors) est parfaitement
  // mémoïsable : c'est justement le cas des affiches TMDB et des miniatures
  // YouTube, les plus grosses économies de la page.
  if (response && (response.ok || response.type === "opaque")) {
    await putSafely(cache, key, response);
    if (limit) await trimCache(cacheName, limit);
  }
  return response;
}

// Fresque : on sert le cache immédiatement (réaction instantanée, 0 Mo), puis
// on revalide en arrière-plan. Les fichiers sont de toute façon revalidés par
// le serveur (ETag / 304), donc aucun code périmé ne reste en place.
async function staleWhileRevalidate(request, cacheName, limit) {
  const cache = await caches.open(cacheName);
  const key = normalizeKey(request);
  const cached = await cache.match(key);
  const network = fetch(request)
    .then(async (response) => {
      if (response && (response.ok || response.type === "opaque")) {
        await putSafely(cache, key, response);
        if (limit) await trimCache(cacheName, limit);
      }
      return response;
    })
    .catch(() => null);
  if (cached) {
    reportSaved(await responseBytes(cached));
    return cached;
  }
  const fresh = await network;
  if (fresh) return fresh;
  throw new Error("hors ligne et absent du cache");
}

// Réseau d'abord, cache en secours : le HTML doit être frais, mais doit aussi
// rester lisible quand il n'y a plus de réseau du tout.
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const key = normalizeKey(request);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await putSafely(cache, key, response);
      await trimCache(cacheName, PAGE_CACHE_LIMIT);
    }
    return response;
  } catch (error) {
    const cached = await cache.match(key);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const offline = await caches.match("/offline");
      if (offline) return offline;
    }
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_error) {
    return;
  }

  // Jamais de cache pour les POST (chat) ni pour les flux média : YouTube
  // reste servi directement, l'URL de flux ne peut pas être mémoïsée.
  if (url.hostname.endsWith("googlevideo.com") || url.hostname.includes("youtube.com/embed")) {
    return;
  }

  if (isFontRequest(request, url)) {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE, 24));
    return;
  }

  if (isImageRequest(request, url)) {
    event.respondWith(
      cacheFirst(request, IMAGE_CACHE, IMAGE_CACHE_LIMIT).catch(() => Response.error()),
    );
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(
      staleWhileRevalidate(request, STATIC_CACHE, 60).catch(() => caches.match(normalizeKey(request))),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(request, PAGE_CACHE));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, PAGE_CACHE));
    return;
  }
});

/* ------------------------------------------------------------------ *
   Messages de la page : cache réel, statistiques, purge
   ------------------------------------------------------------------ */
async function cacheUrls(requests, cacheName) {
  const cache = await caches.open(cacheName);
  let count = 0;
  for (let index = 0; index < requests.length; index += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(requests[index]);
      if (response && (response.ok || response.type === "opaque")) {
        // eslint-disable-next-line no-await-in-loop
        await putSafely(cache, requests[index], response);
        count += 1;
      }
    } catch (_error) {
      /* ressource injoignable : l'épinglage reste valable sans elle */
    }
  }
  await trimCache(cacheName, OFFLINE_ITEM_LIMIT);
  return count;
}

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(
    SHELL_ASSETS.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: "reload" }));
      } catch (_error) {
        /* asset optionnel */
      }
    }),
  );
  return SHELL_ASSETS.length;
}

async function clearCaches(target) {
  const names = await caches.keys();
  const wanted = {
    images: (name) => name.includes("-images"),
    pages: (name) => name.includes("-pages"),
    offline: (name) => name.includes("-offline"),
    fonts: (name) => name.includes("-fonts"),
    static: (name) => name.includes("-static") || name.includes("-shell"),
  };
  const picked = target && wanted[target]
    ? names.filter(wanted[target])
    : names.filter((name) => name.startsWith(VERSION) && !name.includes("-offline"));
  await Promise.all(picked.map((name) => caches.delete(name)));
  return picked;
}

async function removeOfflineBucket(bucket) {
  const names = await caches.keys();
  const offline = names.find((name) => name.includes("-offline"));
  if (!offline) return 0;
  const cache = await caches.open(offline);
  const keys = await cache.keys();
  let removed = 0;
  for (let index = 0; index < keys.length; index += 1) {
    const url = keys[index].url;
    // On ne supprime que ce qui est propre à cet épinglage (et pas une image
    // partagée avec le cache d'images).
    if (bucket && url.includes("/details/")) {
      // eslint-disable-next-line no-await-in-loop
      if (await cache.delete(keys[index])) removed += 1;
    }
  }
  return removed;
}

self.addEventListener("message", async (event) => {
  const data = event.data || {};
  if (data === "skipWaiting" || data.type === "skipWaiting") {
    await self.skipWaiting();
    return;
  }

  const source = event.source || null;
  const reply = (payload) => {
    if (source && source.postMessage) source.postMessage(Object.assign({ type: data.type }, payload));
  };

  try {
    if (data.type === "cache-images") {
      const requests = (data.urls || []).map((u) => new Request(u, { mode: "no-cors" }));
      const done = await cacheUrls(requests, IMAGE_CACHE);
      await trimCache(IMAGE_CACHE, IMAGE_CACHE_LIMIT);
      reply({ cached: done });
      return;
    }

    if (data.type === "cache-offline") {
      const requests = (data.urls || []).map((u) =>
        new Request(u, { mode: u.startsWith("http") && !u.startsWith(self.location.origin) ? "no-cors" : "same-origin" }),
      );
      const done = await cacheUrls(requests, OFFLINE_CACHE);
      reply({ cached: done, bucket: data.bucket });
      return;
    }

    if (data.type === "uncache-offline") {
      reply({ removed: await removeOfflineBucket(data.bucket) });
      return;
    }

    if (data.type === "clear-cache") {
      const cleared = await clearCaches(data.target);
      reply({ cleared: cleared.length, target: data.target || "all" });
      return;
    }

    if (data.type === "reinstall-shell") {
      reply({ restored: await precacheShell() });
      return;
    }

    if (data.type === "stats") {
      const names = await caches.keys();
      const stats = { caches: {}, total: 0 };
      for (let index = 0; index < names.length; index += 1) {
        const name = names[index];
        // eslint-disable-next-line no-await-in-loop
        const cache = await caches.open(name);
        // eslint-disable-next-line no-await-in-loop
        const keys = await cache.keys();
        let bytes = 0;
        // Le calcul des tailles lit les réponses : on ne le fait que si la
        // page le demande explicitement et pour un cache de taille raisonnable.
        if (data.sizes && keys.length <= 400) {
          for (let j = 0; j < keys.length; j += 1) {
            try {
              // eslint-disable-next-line no-await-in-loop
              const response = await cache.match(keys[j]);
              if (response) {
                // eslint-disable-next-line no-await-in-loop
                const blob = await response.blob();
                bytes += blob.size;
              }
            } catch (_error) {
              /* noop */
            }
          }
        }
        stats.caches[name] = { entries: keys.length, bytes };
        stats.total += keys.length;
      }
      reply(stats);
      return;
    }
  } catch (error) {
    reply({ error: String((error && error.message) || error) });
  }
});
