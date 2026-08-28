/*
 * OmniStream — Page Hors ligne & Données.
 * Affiche les éléments épinglés, l'estimation du cache, et permet de vider.
 */
(function () {
  "use strict";

  const lib = window.OmniLibrary;
  if (!lib) return;

  function safeImageUrl(value) {
    if (typeof value !== "string" || !value) return "";
    try {
      const url = new URL(value, window.location.origin);
      if (url.protocol !== "https:" && url.origin !== window.location.origin) return "";
      return url.href;
    } catch (_e) {
      return "";
    }
  }

  function detailHref(item) {
    if (item.type === "music") return "/musiques";
    const mt = item.media_type;
    if ((mt === "movie" || mt === "tv") && item.id) {
      return `/details/${mt}/${item.id}?tab=${encodeURIComponent(item.tab || "films")}`;
    }
    return null;
  }

  function makeCard(item) {
    const wrap = document.createElement("div");
    wrap.className = "card lib-card";
    const inner = document.createElement("div");
    inner.className = "poster";
    const img = safeImageUrl(item.poster || item.thumbnail);
    if (img) {
      const el = document.createElement("img");
      el.className = "poster-img";
      el.src = img;
      el.alt = item.title || "";
      el.loading = "lazy";
      inner.appendChild(el);
    } else {
      inner.classList.add("poster-placeholder");
      inner.textContent = "Image indisponible";
    }

    const badge = document.createElement("span");
    badge.className = "quality-tag";
    badge.textContent = "HORS LIGNE";
    inner.appendChild(badge);

    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "lib-remove-btn";
    rm.setAttribute("aria-label", "Retirer");
    rm.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    rm.addEventListener("click", (e) => {
      e.preventDefault();
      lib.removeOffline(item);
      render();
    });
    inner.appendChild(rm);

    const info = document.createElement("div");
    info.className = "card-info";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = item.title || "Sans titre";
    const meta = document.createElement("div");
    meta.className = "card-meta-line";
    meta.innerHTML = `<span class="card-type-tag">${
      item.type === "music" ? "MUSIQUE" : (item.media_type || "").toUpperCase() || "TITRE"
    }</span>`;
    info.append(title, meta);

    const href = detailHref(item);
    if (href && item.type !== "music") {
      const a = document.createElement("a");
      a.href = href;
      a.appendChild(inner);
      wrap.append(a, info);
    } else {
      if (item.type === "music") {
        inner.style.cursor = "pointer";
        inner.addEventListener("click", () => {
          if (window.OmniPlayer) window.OmniPlayer.play(item, "audio");
        });
      }
      wrap.append(inner, info);
    }
    return wrap;
  }

  async function updateStats() {
    const offline = lib.getOffline();
    const statOffline = document.getElementById("stat-offline");
    if (statOffline) statOffline.textContent = String(offline.length);

    // Estimation du stockage
    const statCache = document.getElementById("stat-cache");
    if (statCache && navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        const used = est.usage || 0;
        statCache.textContent = formatBytes(used);
      } catch (_e) {
        statCache.textContent = "—";
      }
    }

    // Nombre d'images en cache
    const statImgs = document.getElementById("stat-imgs");
    if (statImgs && "caches" in window) {
      try {
        const cache = await caches.open("omnistream-v1-images");
        const keys = await cache.keys();
        statImgs.textContent = String(keys.length);
      } catch (_e) {
        statImgs.textContent = "0";
      }
    }
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 Ko";
    const units = ["o", "Ko", "Mo", "Go"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + " " + units[i];
  }

  function render() {
    const grid = document.getElementById("offline-grid");
    const empty = document.getElementById("offline-empty");
    const items = lib.getOffline();
    if (grid) grid.replaceChildren(...items.map(makeCard));
    if (empty) empty.hidden = items.length > 0;
    updateStats();
  }

  const clearCacheBtn = document.getElementById("clear-cache-btn");
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener("click", async () => {
      if ("caches" in window) {
        const names = await caches.keys();
        await Promise.all(
          names
            .filter((n) => n.startsWith("omnistream-v1-images") || n.includes("pages"))
            .map((n) => caches.delete(n)),
        );
      }
      render();
    });
  }

  document.querySelectorAll('[data-clear="offline"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      lib.getOffline().slice().forEach((i) => lib.removeOffline(i));
      render();
    });
  });

  render();
})();
