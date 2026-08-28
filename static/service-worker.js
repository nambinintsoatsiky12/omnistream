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
 *
 * Correction « l'application installée ne s'ouvre pas » :
 *  - les clés de cache des PAGES conservaient la chaîne de requête : l'URL de
 *    lancement de l'application (et tout lien partagé avec un paramètre de
 *    suivi) cherchait donc une entrée inexistante. Les paramètres de tracking
 *    sont désormais ignorés — la coquille pré-enregistrée est toujours trouvée ;
 *  - une réponse 5xx (instance Render endormie, redéploiement en cours) était
 *    servie telle quelle : la fenêtre de l'application affichait la page
 *    d'erreur du serveur. La dernière copie connue est maintenant préférée ;
 *  - si rien n'est en cache et qu'aucun réseau n'est disponible, une page de
 *    secours autonome est fabriquée par le worker : la fenêtre n'est plus
 *    jamais blanche, elle explique la situation et propose de réessayer ;
 *  - la coquille est revérifiée à l'activation (et sur demande de la page) :
 *    une installation faite hors réseau ne reste pas incomplète.
 */

const VERSION = "omnistream-v5";
const SHELL_CACHE = `${VERSION}-shell`;
const STATIC_CACHE = `${VERSION}-static`;
const IMAGE_CACHE = `${VERSION}-images`;
const PAGE_CACHE = `${VERSION}-pages`;
const FONT_CACHE = `${VERSION}-fonts`;
const OFFLINE_CACHE = `${VERSION}-offline`;
const AUDIO_CACHE = `${VERSION}-audio`;

const IMAGE_CACHE_LIMIT = 140;
const PAGE_CACHE_LIMIT = 60;
const OFFLINE_ITEM_LIMIT = 600;
// Un MP3 pèse 5 à 10 Mo : on n'en garde que quelques-uns, et jamais quand
// l'appareil a demandé d'économiser les données.
const AUDIO_CACHE_LIMIT = 12;

// Ressources essentielles de l'interface, mises en cache dès l'installation.
// Toute nouvelle page ou script doit être ajouté ici (un test le vérifie).
const SHELL_ASSETS = [
  "/offline",
  "/",
  "/musiques",
  "/bibliotheque",
  "/telechargements",
  "/static/css/style.css",
  "/manifest.webmanifest",
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
      // La coquille (page de lancement + CSS + JS) est pré-enregistrée ici :
      // c'est elle qui permet à l'application installée de s'ouvrir, même sans
      // réseau. Un asset manquant ne doit jamais faire échouer l'installation.
      await precacheShell();
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      // On ne purge que les anciennes versions de NOS caches : la page écrit
      // parfois un cache elle-même (première visite, aucun worker aux
      // commandes) et le détruire à chaque activation effacerait les
      // enregistrements de l'utilisateur.
      await Promise.all(
        names
          .filter((name) => /^omnistream-v\d+-/.test(name) && !name.startsWith(VERSION))
          .map((name) => caches.delete(name)),
      );
      // Une installation faite pendant une coupure avait laissé la coquille
      // incomplète : on la complète au premier réveil, sinon l'application
      // installée ne trouve plus rien à ouvrir hors ligne.
      const shell = await caches.open(SHELL_CACHE);
      if (!(await shell.match(new Request(`${self.location.origin}/`, { method: "GET" })))) {
        await precacheShell();
      }
      await self.clients.claim();
    })(),
  );
});

/* ------------------------------------------------------------------ *
   Utilitaires
   ------------------------------------------------------------------ */

// Certaines URL de page portent des paramètres qui ne changent rien au
// contenu : provenance d'une campagne, lien partagé… Ils ne doivent pas
// créer une clé de cache distincte, sinon la page de lancement de
// l'application installée cherche une entrée que personne n'a jamais
// enregistrée — et la fenêtre reste vide dès que le réseau flanchait.
const IGNORED_PAGE_PARAMS = [
  "source",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "igshid",
  "fbclid",
  "gclid",
  "si",
];

function pageUrlWithoutTracking(url) {
  const kept = [];
  url.searchParams.forEach((value, name) => {
    if (IGNORED_PAGE_PARAMS.indexOf(name) === -1) kept.push([name, value]);
  });
  kept.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const query = kept
    .map((pair) => `${encodeURIComponent(pair[0])}=${encodeURIComponent(pair[1])}`)
    .join("&");
  return `${url.origin}${url.pathname}${query ? `?${query}` : ""}`;
}

// Les URL statiques portent un « ?v=… » de déploiement : on le normalise
// pour qu'une même ressource n'occupe pas dix entrées après dix versions.
function normalizeKey(request) {
  try {
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return request;
    if (url.pathname.startsWith("/static/")) {
      return new Request(`${url.origin}${url.pathname}`, {
        method: "GET",
        credentials: request.credentials,
        mode: "same-origin",
      });
    }
    const cleaned = pageUrlWithoutTracking(url);
    if (cleaned !== `${url.origin}${url.pathname}${url.search}`) {
      return new Request(cleaned, {
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

// Un MP3 est un fichier : seul média que l'on ait le droit de mettre en cache
// (YouTube l'interdit), donc le seul qui sache jouer sans un octet de forfait.
function isAudioFile(request, url) {
  if (request.destination === "audio") return true;
  return /\.(mp3|m4a|aac|ogg|opus|flac)($|\?)/i.test(url.pathname);
}

function saveDataRequested() {
  try {
    const connection = self.navigator && self.navigator.connection;
    return Boolean(connection && connection.saveData);
  } catch (_error) {
    return false;
  }
}

// L'élément <audio> réclame des plages (« Range: bytes=… ») : sans réponse
// 206 fabriquée depuis le fichier enregistré, la lecture s'arrête au premier
// segment et le bouton « suivre » ne fait plus rien hors ligne.
async function sliceFromCache(cached, rangeHeader) {
  const match = /bytes=(\d*)-(\d*)?/.exec(String(rangeHeader || ""));
  if (!cached || !match) return null;
  try {
    const blob = await cached.blob();
    if (!blob || !blob.size) return null;
    const start = match[1] ? Number(match[1]) : 0;
    const rawEnd = match[2] ? Number(match[2]) : blob.size - 1;
    const end = Math.min(Number.isFinite(rawEnd) ? rawEnd : blob.size - 1, blob.size - 1);
    if (start >= blob.size || end < start) return null;
    const slice = blob.slice(start, end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${blob.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(slice.size),
        "Content-Type": blob.type || "audio/mpeg",
      },
    });
  } catch (_error) {
    // Réponse opaque (fichier cross-origin) : corps indécoupable, mais le
    // fichier complet reste jouable tel quel.
    return null;
  }
}

async function audioFileFirst(request, url) {
  const rangeHeader = request.headers.get("range");
  const sameOrigin = url.origin === self.location.origin;
  const full = new Request(`${url.origin}${url.pathname}`, {
    method: "GET",
    credentials: sameOrigin ? "same-origin" : "omit",
    mode: sameOrigin ? "same-origin" : "no-cors",
  });
  // « caches.match » cherche partout : cache d'épinglage du worker, cache de
  // lecture, mais aussi celui écrit par la page quand aucun worker répondait.
  const cached = await caches.match(full).catch(() => undefined);
  if (cached) {
    if (rangeHeader) {
      const sliced = await sliceFromCache(cached, rangeHeader);
      if (sliced) return sliced;
    }
    reportSaved(await responseBytes(cached));
    return cached;
  }
  const response = await fetch(request);
  if (response && response.ok && !rangeHeader && !saveDataRequested()) {
    const cache = await caches.open(AUDIO_CACHE);
    await putSafely(cache, full, response);
    await trimCache(AUDIO_CACHE, AUDIO_CACHE_LIMIT);
  }
  return response;
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

// Page de secours fabriquée par le worker : elle ne dépend d'aucun fichier,
// donc elle s'affiche même si le cache d'installation est vide. Sans elle, une
// ouverture de l'application sans réseau donnait… un écran noir.
const RESCUE_HTML = [
  '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  "<title>OmniStream — connexion impossible</title><style>",
  "html{background:#090b10;color:#e2e5ed;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}",
  "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center}",
  "h1{font-size:1.3rem;margin:0 0 10px}p{margin:0 0 22px;color:#949db2;font-size:.9rem;line-height:1.6;max-width:34ch}",
  "b{display:block;font-size:.72rem;letter-spacing:1.4px;color:#ff7a2e;margin-bottom:14px}",
  "a,button{display:inline-block;font:inherit;font-weight:700;font-size:.9rem;color:#fff;background:#ff7a2e;border:0;border-radius:9999px;padding:13px 22px;margin:4px;text-decoration:none;cursor:pointer}",
  "</style></head><body><div><b>OMNISTREAM</b><h1>Le réseau ne répond pas</h1>",
  "<p>L'application ne trouve rien à afficher pour l'instant. Vos éléments enregistrés",
  'restent consultables dès que la connexion revient.</p>',
  '<button type="button" onclick="location.reload()">Réessayer</button>',
  '<a href="/telechargements">Mes enregistrements</a></div></body></html>',
].join("");

function rescueResponse() {
  return new Response(RESCUE_HTML, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Dernier recours d'une navigation : la page « hors ligne » pré-enregistrée,
// sinon la page de secours fabriquée ici.
async function navigationRescue() {
  try {
    const offline = await caches.match("/offline");
    if (offline) return offline;
  } catch (_error) {
    /* cache indisponible */
  }
  return rescueResponse();
}

// Dernière copie connue d'une page : la page exacte si on l'a déjà vue,
// à défaut la coquille pré-enregistrée (l'accueil + toute l'interface).
async function lastKnownCopy(cache, key, originalUrl) {
  try {
    const exact = await cache.match(key);
    if (exact) return exact;
    // La coquille d'installation contient l'accueil et toute l'interface : elle
    // sert de seconde chance quand la page exacte n'a jamais été visitée.
    return await caches.match(new Request(`${originalUrl.origin}${originalUrl.pathname}`, { method: "GET" }));
  } catch (_error) {
    return null;
  }
}

// Réseau d'abord, cache en secours : le HTML doit rester frais, mais il
// doit aussi s'afficher sans réseau — c'est la porte d'entrée de
// l'application installée.
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const key = normalizeKey(request);
  const isNavigation = request.mode === "navigate";
  let url = null;
  try {
    url = new URL(request.url);
  } catch (_error) {
    url = null;
  }
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await putSafely(cache, key, response);
      await trimCache(cacheName, PAGE_CACHE_LIMIT);
      return response;
    }
    // Une réponse 5xx veut dire « serveur momentanément KO » (instance free en
    // sommeil, redéploiement en cours) : dans la fenêtre de l'application, elle
    // donnait une page d'erreur grise que l'on prenait pour un plantage.
    if (isNavigation && response && response.status >= 500 && url) {
      const lastKnown = await lastKnownCopy(cache, key, url);
      if (lastKnown) return lastKnown;
      return await navigationRescue();
    }
    return response;
  } catch (error) {
    if (url) {
      const cached = await lastKnownCopy(cache, key, url);
      if (cached) return cached;
    }
    if (isNavigation) return await navigationRescue();
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

  if (isAudioFile(request, url)) {
    event.respondWith(audioFileFirst(request, url).catch(() => Response.error()));
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
    audio: (name) => name.includes("-audio"),
    static: (name) => name.includes("-static") || name.includes("-shell"),
  };
  const picked = target && wanted[target]
    ? names.filter(wanted[target])
    : names.filter((name) => name.startsWith(VERSION) && !name.includes("-offline"));
  await Promise.all(picked.map((name) => caches.delete(name)));
  return picked;
}

async function removeOfflineBucket(bucket, urls) {
  const names = await caches.keys();
  const cachesToClean = names.filter((name) => name.includes("-offline") || name.includes("-audio"));
  if (!cachesToClean.length) return 0;
  const wanted = (Array.isArray(urls) ? urls : []).map((value) => {
    try {
      return new URL(value, self.location.origin).href;
    } catch (_error) {
      return String(value || "");
    }
  });
  let removed = 0;
  for (const name of cachesToClean) {
    // eslint-disable-next-line no-await-in-loop
    const cache = await caches.open(name);
    // eslint-disable-next-line no-await-in-loop
    const keys = await cache.keys();
    for (let index = 0; index < keys.length; index += 1) {
      const url = keys[index].url;
      const bare = url.split("?")[0];
      const mine =
        wanted.indexOf(url) !== -1 ||
        wanted.indexOf(bare) !== -1 ||
        (bucket && url.includes(`/details/${bucket}`));
      // On ne touche qu'aux ressources de CET épinglage : une affiche partagée
      // par deux films doit rester en cache pour l'autre.
      if (mine) {
        // eslint-disable-next-line no-await-in-loop
        if (await cache.delete(keys[index])) removed += 1;
      }
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
      reply({ removed: await removeOfflineBucket(data.bucket, data.urls) });
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
