/*
 * OmniStream — Service Worker PWA
 * Objectif : économiser les données (cache agressif du shell et des images)
 * et permettre une utilisation hors ligne. Pensé pour les forfaits mobiles
 * réduits à Madagascar.
 */
const VERSION = "omnistream-v1";
const SHELL_CACHE = `${VERSION}-shell`;
const STATIC_CACHE = `${VERSION}-static`;
const IMAGE_CACHE = `${VERSION}-images`;
const PAGE_CACHE = `${VERSION}-pages`;

const IMAGE_CACHE_LIMIT = 160;
const PAGE_CACHE_LIMIT = 40;

// Ressources essentielles de l'interface (mises en cache dès l'installation).
const SHELL_ASSETS = [
  "/offline",
  "/static/css/style.css",
  "/static/js/home.js",
  "/static/js/musique.js",
  "/static/js/chat.js",
  "/static/js/downloads.js",
  "/static/js/app-shell.js",
  "/static/favicon.svg",
  "/static/images/icon-192.png",
  "/static/images/icon-512.png",
  "/static/images/univ-cinema.jpg",
  "/static/images/univ-manga.jpg",
  "/static/images/univ-music.jpg",
  "/static/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // On ignore les échecs unitaires : un asset manquant ne doit pas
      // faire échouer toute l'installation.
      await Promise.all(
        SHELL_ASSETS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: "reload" }));
          } catch (_error) {
            /* asset optionnel */
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
        names
          .filter((name) => !name.startsWith(VERSION))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxItems) return;
  for (let i = 0; i < keys.length - maxItems; i += 1) {
    await cache.delete(keys[i]);
  }
}

function isImageRequest(request, url) {
  if (request.destination === "image") return true;
  return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(url.pathname);
}

function isStaticAsset(url) {
  return url.pathname.startsWith("/static/");
}

// Stratégie « cache d'abord » : idéal pour les fichiers qui changent rarement
// et pour économiser au maximum les données.
async function cacheFirst(request, cacheName, limit) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    // Chaque ressource servie depuis le cache = données NON re-téléchargées.
    reportSaved(cached);
    return cached;
  }
  const response = await fetch(request);
  if (response && response.ok && response.type !== "opaque") {
    cache.put(request, response.clone());
    if (limit) trimCache(cacheName, limit);
  }
  return response;
}

// Estime les octets économisés (taille du contenu servi depuis le cache) et
// prévient les pages ouvertes pour mettre à jour le compteur.
async function reportSaved(response) {
  try {
    const len = Number(response.headers.get("content-length")) || 0;
    if (!len) return;
    const clients = await self.clients.matchAll({ type: "window" });
    clients.forEach((client) =>
      client.postMessage({ type: "omni-saved-bytes", bytes: len }),
    );
  } catch (_e) {
    /* noop */
  }
}

// Stratégie « réseau d'abord, cache en secours » : pour les pages HTML afin
// d'avoir le contenu à jour tout en restant consultable hors connexion.
async function networkFirst(request, cacheName, limit) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
      if (limit) trimCache(cacheName, limit);
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
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

  // On ne touche jamais aux flux média externes (YouTube, etc.) ni aux
  // requêtes vers d'autres origines sensibles : laissées au navigateur.
  const sameOrigin = url.origin === self.location.origin;

  // Images (TMDB, MangaDex proxy, statiques) : cache d'abord, plafonné.
  if (isImageRequest(request, url)) {
    event.respondWith(
      cacheFirst(request, IMAGE_CACHE, IMAGE_CACHE_LIMIT).catch(
        () => caches.match(request),
      ),
    );
    return;
  }

  if (!sameOrigin) return;

  // Assets statiques de l'app : cache d'abord.
  if (isStaticAsset(url)) {
    event.respondWith(
      cacheFirst(request, STATIC_CACHE).catch(() => caches.match(request)),
    );
    return;
  }

  // Les API JSON restent en réseau d'abord mais sans blocage hors ligne.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(request, PAGE_CACHE, PAGE_CACHE_LIMIT));
    return;
  }

  // Navigation (pages HTML) : réseau d'abord, secours hors ligne.
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, PAGE_CACHE, PAGE_CACHE_LIMIT));
    return;
  }
});

// Permet à la page de forcer l'activation immédiate d'une mise à jour.
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});
