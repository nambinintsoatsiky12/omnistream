/*
 * OmniStream — Espace personnel (Ma Liste + Reprendre).
 * Lit la bibliothèque locale (IndexedDB) et affiche des cartes actionnables.
 */
(function () {
  "use strict";

  const lib = window.OmniLibrary;
  if (!lib) return;

  // Un seul AbortController par page visitée : les écouteurs posés sur
  // `document` sont ainsi supprimés au départ de la page, au lieu de
  // s'empiler à chaque navigation (l'interface devenait de plus en plus
  // lente au fil de la session).
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

  function detailHref(item) {
    if (item.type === "music") return "/musiques";
    const mediaType = item.media_type;
    if ((mediaType === "movie" || mediaType === "tv") && item.id) {
      return `/details/${mediaType}/${item.id}?tab=${encodeURIComponent(item.tab || "films")}`;
    }
    return null;
  }

  function whenOnline() {
    if (navigator.onLine) return true;
    if (window.OmniUI) {
      window.OmniUI.toast("Hors ligne : le réseau est nécessaire pour lancer le flux.", "warn");
    }
    return false;
  }

  function makeCard(item, onRemove) {
    const wrap = document.createElement("div");
    wrap.className = "card lib-card";

    const inner = document.createElement("div");
    inner.className = "poster";
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

    const isMusic = item.type === "music";
    if (isMusic) {
      const tag = document.createElement("span");
      tag.className = "quality-tag";
      tag.textContent = "MP3";
      inner.appendChild(tag);
      inner.classList.add("is-tappable");
      inner.setAttribute("role", "button");
      inner.tabIndex = 0;
      const listen = () => {
        if (!window.OmniPlayer || !whenOnline()) return;
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
    }

    // Bouton retirer : stoppe la propagation pour que le tap ne relance pas
    // la lecture de la carte (bug qui donnait l'impression que rien ne partait).
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "lib-remove-btn";
    remove.setAttribute("aria-label", `Retirer ${item.title || "ce titre"}`);
    remove.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onRemove(item);
      render();
      if (window.OmniUI) window.OmniUI.toast("Retiré de votre espace.", "ok");
    });
    inner.appendChild(remove);

    const info = document.createElement("div");
    info.className = "card-info";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = item.title || "Sans titre";
    const meta = document.createElement("div");
    meta.className = "card-meta-line";
    meta.innerHTML = `<span class="card-type-tag">${
      isMusic ? "MUSIQUE" : (item.media_type || "").toUpperCase() || "TITRE"
    }</span>`;
    info.append(title, meta);

    const href = detailHref(item);
    if (href && !isMusic) {
      const link = document.createElement("a");
      link.href = href;
      link.appendChild(inner);
      wrap.append(link, info);
    } else if (!isMusic) {
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "lib-pin-btn";
      pin.textContent = lib.isOffline(item) ? "Épinglé ✓" : "Garder hors ligne";
      pin.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (lib.isOffline(item)) lib.removeOffline(item);
        else await lib.saveOffline(Object.assign({}, item, { url: detailHref(item) || "" }));
        pin.textContent = lib.isOffline(item) ? "Épinglé ✓" : "Garder hors ligne";
      });
      wrap.append(inner, info, pin);
    } else {
      wrap.append(inner, info);
    }
    return wrap;
  }

  function fill(gridId, emptyId, items, onRemove) {
    const grid = document.getElementById(gridId);
    const empty = document.getElementById(emptyId);
    if (!grid) return;
    grid.replaceChildren(...items.map((item) => makeCard(item, onRemove)));
    if (empty) empty.hidden = items.length > 0;
    const counter = document.getElementById(`${gridId}-count`);
    if (counter) counter.textContent = items.length ? String(items.length) : "";
  }

  function render() {
    fill("continue-grid", "continue-empty", lib.getContinue(), (item) => lib.removeContinue(item));
    fill("favorites-grid", "favorites-empty", lib.getFavorites(), (item) => lib.removeFavorite(item));
    const total = document.getElementById("library-total");
    if (total) {
      const counts = lib.counts();
      total.textContent = `${counts.favorites} en liste · ${counts.offline} hors ligne`;
    }
  }

  document.querySelectorAll("[data-clear]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const which = btn.getAttribute("data-clear");
      const counts = lib.counts();
      const size = which === "continue" ? counts.continue : which === "favorites" ? counts.favorites : 0;
      if (!size) {
        if (window.OmniUI) window.OmniUI.toast("Cette liste est déjà vide.", "info");
        return;
      }
      lib.clearBucket(which).then(() => {
        render();
        if (window.OmniUI) window.OmniUI.toast(`${size} élément(s) supprimés.`, "ok");
      });
    });
  });

  const wipeAll = document.getElementById("clear-library-btn");
  if (wipeAll) {
    wipeAll.addEventListener("click", () => {
      if (!window.confirm("Effacer Ma Liste, l'historique et les éléments hors ligne de cet appareil ?")) return;
      lib.clearAll().then(() => {
        render();
        if (window.OmniUI) window.OmniUI.toast("Espace personnel vidé.", "ok");
      });
    });
  }

  document.addEventListener("omni:library-change", render, { signal });
  document.addEventListener("omni:page-loaded", render, { signal });

  lib.whenReady(render);
  render();
})();
