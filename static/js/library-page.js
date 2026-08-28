/*
 * OmniStream — Rendu de l'espace personnel (Ma Liste + Reprendre).
 * Lit la bibliothèque locale et affiche des cartes cliquables.
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

  function makeCard(item, onRemove) {
    const wrap = document.createElement("div");
    wrap.className = "card lib-card";

    const poster = document.createElement("a");
    poster.className = "poster";
    const href = detailHref(item);
    const img = safeImageUrl(item.poster || item.thumbnail);

    const inner = document.createElement("div");
    inner.className = "poster";
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

    if (item.type === "music") {
      inner.style.cursor = "pointer";
      inner.addEventListener("click", () => {
        if (window.OmniPlayer) window.OmniPlayer.play(item, "audio");
      });
      const tag = document.createElement("span");
      tag.className = "quality-tag";
      tag.textContent = "MP3";
      inner.appendChild(tag);
    }

    // bouton retirer
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "lib-remove-btn";
    rm.setAttribute("aria-label", "Retirer");
    rm.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    rm.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onRemove(item);
      wrap.remove();
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

    if (href && item.type !== "music") {
      poster.href = href;
      poster.appendChild(inner);
      wrap.append(poster, info);
    } else {
      wrap.append(inner, info);
    }
    return wrap;
  }

  function fill(gridId, emptyId, items, onRemove) {
    const grid = document.getElementById(gridId);
    const empty = document.getElementById(emptyId);
    if (!grid) return;
    grid.replaceChildren(...items.map((it) => makeCard(it, onRemove)));
    if (empty) empty.hidden = items.length > 0;
  }

  function render() {
    fill("continue-grid", "continue-empty", lib.getContinue(), (i) =>
      lib.removeContinue(i),
    );
    fill("favorites-grid", "favorites-empty", lib.getFavorites(), (i) =>
      lib.removeFavorite(i),
    );
  }

  document.querySelectorAll("[data-clear]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const which = btn.getAttribute("data-clear");
      if (which === "continue") {
        lib.getContinue().slice().forEach((i) => lib.removeContinue(i));
      } else if (which === "favorites") {
        lib.getFavorites().slice().forEach((i) => lib.removeFavorite(i));
      }
      render();
    });
  });

  render();
})();
