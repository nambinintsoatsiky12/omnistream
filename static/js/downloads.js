/*
 * OmniStream — Page « Hors ligne & Données ».
 * Gère réellement le cache : épingler = mettre en cache l'affiche et la fiche,
 * retirer = effacer proprement (sans lancer de lecture par erreur), vider =
 * supprimer les entrées et remettre les compteurs à zéro.
 */
(function () {
  "use strict";

  const lib = window.OmniLibrary;
  if (!lib) return;

  // Écouteurs liés à la page : supprimés dès qu'on la quitte (voir app-shell.js).
  if (!window.__omniPageAbort) window.__omniPageAbort = new AbortController();
  const signal = window.__omniPageAbort.signal;

  function safeImageUrl(value) {
    if (typeof value !== "string" || !value) return "";
    try {
      const url = new URL(value, window.location.origin);
      if (url.protocol !== "https:" && url.origin !== window.location.origin) return "";
      return url.href;
    } catch (_error) {
      return "";
    }
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} o`;
    const units = ["Ko", "Mo", "Go"];
    let size = value / 1024;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[index]}`;
  }

  function detailHref(item) {
    if (item.type === "music") return "/musiques";
    const mediaType = item.media_type;
    // Les fiches anime/manga (source AniList) s'ouvrent aussi chez nous.
    if (["movie", "tv", "anime", "manga"].includes(mediaType) && item.id) {
      return `/details/${mediaType}/${item.id}?tab=${encodeURIComponent(item.tab || "films")}`;
    }
    return null;
  }

  function makeCard(item) {
    const wrap = document.createElement("div");
    wrap.className = "card lib-card";

    const inner = document.createElement("div");
    inner.className = "poster offline-poster";
    const image = safeImageUrl(item.poster || item.thumbnail);
    if (image) {
      const el = document.createElement("img");
      el.className = "poster-img";
      el.src = image;
      el.alt = item.title || "";
      el.loading = "lazy";
      el.decoding = "async";
      inner.appendChild(el);
    } else {
      inner.classList.add("poster-placeholder");
      inner.textContent = "Image indisponible";
    }

    const badge = document.createElement("span");
    badge.className = "quality-tag";
    badge.textContent = storageLabel(item);
    inner.appendChild(badge);

    // Le bouton « retirer » arrête la propagation : sinon le tap atteignait
    // aussi la zone cliquable du dessous et relançait la musique, donnant
    // l'impression que rien ne s'effaçait.
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "lib-remove-btn";
    remove.setAttribute("aria-label", `Retirer ${item.title || "cet élément"} du hors ligne`);
    remove.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M6 6l1 14h10l1-14"></path></svg>';
    remove.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      lib.removeOffline(item);
      render();
      if (window.OmniUI) window.OmniUI.toast("Élément retiré du hors ligne.", "ok");
    });
    inner.appendChild(remove);

    const info = document.createElement("div");
    info.className = "card-info";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = item.title || "Sans titre";
    const meta = document.createElement("div");
    meta.className = "card-meta-line";
    const label = item.type === "music" ? "MUSIQUE" : (item.media_type || "").toUpperCase() || "TITRE";
    const when = item.offlineAt ? new Date(item.offlineAt) : null;
    const ago = when ? ` · ${when.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" })}` : "";
    meta.innerHTML = `<span class="card-type-tag">${label}</span><span class="card-year">${
      (item.year || item.channel || "hors ligne") + ago
    }</span>`;
    info.append(title, meta);

    if (item.type === "music") {
      inner.classList.add("is-tappable");
      inner.setAttribute("role", "button");
      inner.tabIndex = 0;
      const listen = () => {
        if (!window.OmniPlayer) return;
        // Un MP3 libre épinglé EST un fichier : il sort du cache et se lance
        // même sans réseau. Avertir du contraire — et quand même lancer une
        // lecture promise à l'échec — était une double erreur.
        if (!navigator.onLine && !hasStoredFile(item)) {
          if (window.OmniUI) {
            window.OmniUI.toast(
              "Hors ligne : ce clip a besoin du réseau. Les MP3 libres, eux, se lisent à 0 Mo.",
              "warn",
            );
          }
          return;
        }
        window.OmniPlayer.setQueue([item], 0);
        window.OmniPlayer.play(item, "audio");
      };
      inner.addEventListener("click", listen);
      inner.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          listen();
        }
      });
      wrap.append(inner, info);
    } else {
      const href = detailHref(item);
      if (href) {
        const link = document.createElement("a");
        link.href = href;
        link.appendChild(inner);
        wrap.append(link, info);
      } else {
        wrap.append(inner, info);
      }
    }
    return wrap;
  }

  // Un enregistrement vaut « fichier sur l'appareil » quand l'URL du MP3 a été
  // transmise au worker : c'est ce qui distingue un vrai MP3 libre d'un clip
  // YouTube, dont on ne garde que la fiche.
  function hasStoredFile(item) {
    if (!item || item.type !== "music") return false;
    if (item.kind !== "mp3" && !/\.mp3($|\?)/i.test(String(item.url || ""))) return false;
    return typeof item.url === "string" && item.url.length > 0;
  }

  function storageLabel(item) {
    if (item.type !== "music") return "ENREGISTRÉ";
    if (!hasStoredFile(item)) return "CLIP · RÉSEAU REQUIS";
    return item.cached ? "MP3 · 0 Mo HORS LIGNE" : "MP3 · À RÉCUPÉRER";
  }

  function askWorker(message) {
    if (!window.OmniSW || !window.OmniSW.ask) return Promise.resolve(null);
    return window.OmniSW.ask(message);
  }

  async function updateStats() {
    const offline = lib.getOffline();
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };
    set("stat-offline", String(offline.length));
    set("stat-saved", formatBytes(window.OmniUI ? window.OmniUI.savedBytes() : 0));

    const stats = await askWorker({ type: "stats", sizes: true });
    if (stats && stats.caches) {
      let images = 0;
      let bytes = 0;
      Object.keys(stats.caches).forEach((name) => {
        const entry = stats.caches[name] || {};
        // « Fichiers en cache » compte tout ce qui est réellement stocké :
        // affiches, fiches épinglées et morceaux MP3.
        if (
          name.includes("-images") ||
          name.includes("-offline") ||
          name.includes("-audio")
        ) {
          images += entry.entries || 0;
        }
        bytes += entry.bytes || 0;
      });
      set("stat-imgs", String(images));
      const cacheSize = document.getElementById("stat-cache-size");
      if (cacheSize) cacheSize.textContent = formatBytes(bytes);
    } else {
      try {
        const cache = await caches.open("omnistream-offline");
        set("stat-imgs", String((await cache.keys()).length));
      } catch (_error) {
        set("stat-imgs", "0");
      }
    }

    const note = document.getElementById("storage-note");
    if (note && navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        const used = estimate.usage || 0;
        const quota = estimate.quota || 0;
        const pct = quota ? Math.max(1, Math.round((used / quota) * 100)) : 0;
        // Ce plafond n'est pas fixé par OmniStream : c'est la part d'espace
        // que CE navigateur accorde au site sur CET appareil (en général une
        // fraction du disque libre). L'écrire autrement serait mentir sur la
        // place réellement disponible.
        note.textContent = quota
          ? `${formatBytes(used)} utilisés sur ${formatBytes(quota)} accordés par votre navigateur sur cet appareil (${pct} %).`
          : "";
        const bar = document.getElementById("storage-bar");
        if (bar) bar.style.width = `${Math.min(100, pct)}%`;
        const persist = await navigator.storage.persisted();
        note.dataset.persisted = persist ? "yes" : "no";
        const hint = document.getElementById("persist-hint");
        if (hint) hint.hidden = Boolean(persist);
      } catch (_error) {
        note.textContent = "";
      }
    }
  }

  function render() {
    const grid = document.getElementById("offline-grid");
    const empty = document.getElementById("offline-empty");
    const items = lib.getOffline();
    if (grid) grid.replaceChildren(...items.map(makeCard));
    if (empty) empty.hidden = items.length > 0;
    updateStats();
  }

  /* --- Vider le cache (avec confirmation visuelle) --- */
  const clearCacheBtn = document.getElementById("clear-cache-btn");
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener("click", async () => {
      clearCacheBtn.disabled = true;
      const label = clearCacheBtn.textContent;
      clearCacheBtn.textContent = "Vidage…";
      const answer = await askWorker({ type: "clear-cache" });
      if (window.OmniUI) window.OmniUI.resetSavedBytes();
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        // On redemande une installation propre des fichiers du shell, sinon
        // la page suivante repartirait d'un cache vide et rechargerait tout.
        navigator.serviceWorker.ready
          .then((registration) => registration.active && registration.active.postMessage({ type: "reinstall-shell" }))
          .catch(() => undefined);
      }
      clearCacheBtn.disabled = false;
      clearCacheBtn.textContent = label;
      render();
      if (window.OmniUI) {
        window.OmniUI.toast(
          answer && answer.cleared
            ? `Cache vidé (${answer.cleared} entrée${answer.cleared > 1 ? "s" : ""}).`
            : "Rien à vider : le cache est déjà vide.",
          "ok",
        );
      }
    });
  }

  /* --- Tout retirer de la liste hors ligne --- */
  document.querySelectorAll('[data-clear="offline"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const items = lib.getOffline();
      if (!items.length) {
        if (window.OmniUI) window.OmniUI.toast("Aucun élément à retirer.", "info");
        return;
      }
      items.forEach((item) => lib.removeOffline(item));
      render();
      if (window.OmniUI) window.OmniUI.toast(`${items.length} élément(s) retiré(s).`, "ok");
    });
  });

  /* --- Récupérer un stockage non éjectable --- */
  const persistBtn = document.getElementById("persist-btn");
  if (persistBtn && lib.requestPersistence) {
    persistBtn.addEventListener("click", async () => {
      const ok = await lib.requestPersistence();
      if (window.OmniUI) {
        window.OmniUI.toast(
          ok ? "Stockage protégé : vos données ne seront plus purgées automatiquement." : "Le navigateur refuse encore ce stockage — réessayez depuis l'écran d'accueil.",
          ok ? "ok" : "warn",
        );
      }
      updateStats();
    });
  }

  /* --- Demande de re-téléchargement des éléments épinglés --- */
  const refreshBtn = document.getElementById("refresh-offline-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      const items = lib.getOffline();
      if (!items.length) {
        if (window.OmniUI) window.OmniUI.toast("Rien à recharger.", "info");
        return;
      }
      refreshBtn.disabled = true;
      let done = 0;
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const urls = [item.poster, item.thumbnail, item.backdrop, item.url].filter(Boolean);
        // eslint-disable-next-line no-await-in-loop
        await lib.saveOffline(Object.assign({}, item, { url: item.url || detailHref(item) }));
        if (urls.length) done += 1;
      }
      refreshBtn.disabled = false;
      render();
      if (window.OmniUI) window.OmniUI.toast(`${done} élément(s) remis en cache.`, "ok");
    });
  }

  document.addEventListener("omni:saved-bytes-change", updateStats, { signal });
  document.addEventListener("omni:library-change", render, { signal });
  document.addEventListener("omni:page-loaded", render, { signal });

  // Les listes venant d'IndexedDB, on re-rend dès que la base est prête.
  lib.whenReady(render);
  render();
})();
