/*
 * OmniStream — Page Musique
 * ------------------------------------------------------------------
 * Toute la lecture est déléguée au lecteur global (player.js) : la musique
 * continue quand on quitte la page, avec pause et contrôles sur l'écran
 * verrouillé. Cette page ne fait que chercher, afficher et piloter la file.
 */
(function () {
  "use strict";

  const form = document.getElementById("musique-search-form");
  if (!form) return;

  const input = document.getElementById("musique-search-input");
  const resultsEl = document.getElementById("musique-results");
  const emptyMsg = document.getElementById("musique-empty");
  const loadingMsg = document.getElementById("musique-loading");
  const sectionTitle = document.getElementById("musique-section-title");
  const modeToggle = document.getElementById("mode-toggle");
  const dataSaverNotice = document.getElementById("data-saver-notice");
  const resultCount = document.getElementById("musique-result-count");

  let requestController = null;
  let currentMode = "audio";
  let lastItems = [];

  /* --- Mode Audio / Vidéo ------------------------------------------------- */
  function setMode(mode, announce) {
    currentMode = mode === "video" ? "video" : "audio";
    if (modeToggle) {
      modeToggle.querySelectorAll(".mode-btn").forEach((btn) => {
        const active = btn.dataset.mode === currentMode;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-checked", String(active));
      });
    }
    if (dataSaverNotice) dataSaverNotice.hidden = currentMode !== "audio";
    document.querySelectorAll(".musique-card .quality-tag").forEach((tag) => {
      tag.textContent = currentMode === "video" ? "MP4 Vidéo" : "MP3 Audio";
    });
    document.body.dataset.musicMode = currentMode;
    // On ne bascule le lecteur global que s'il y a quelque chose à lire :
    // sinon choisir « Vidéo » ouvrirait un plein écran vide, ce qui ferait
    // croire à un bouton cassé.
    if (announce && window.OmniPlayer && window.OmniPlayer.getCurrent()) {
      window.OmniPlayer.setMode(currentMode);
    }
  }

  if (modeToggle) {
    modeToggle.addEventListener("click", (event) => {
      const btn = event.target.closest(".mode-btn");
      if (!btn) return;
      setMode(btn.dataset.mode, true);
    });
  }
  setMode("audio", false);

  function safeImageUrl(value) {
    if (typeof value !== "string" || !value) return "";
    try {
      const url = new URL(value, window.location.origin);
      return url.protocol === "https:" ? url.href : "";
    } catch (_error) {
      return "";
    }
  }

  function triggerPlay(item, index) {
    if (!window.OmniPlayer) return;
    // File de lecture : les titres s'enchaînent tout seuls.
    window.OmniPlayer.setQueue(lastItems, index);
    window.OmniPlayer.play(item, currentMode);
    if (window.OmniLibrary) {
      window.OmniLibrary.recordView({
        type: "music",
        id: item.id,
        title: item.title,
        channel: item.channel,
        thumbnail: item.thumbnail,
      });
    }
    markPlaying();
  }

  // Surligne la carte en cours d'écoute (repère visuel immédiat).
  function markPlaying() {
    const current = window.OmniPlayer && window.OmniPlayer.getCurrent();
    document.querySelectorAll(".musique-card").forEach((card) => {
      const on = Boolean(current && card.dataset.trackId === String(current.id));
      card.classList.toggle("is-playing", on);
      const overlay = card.querySelector(".music-play-overlay");
      if (overlay) overlay.classList.toggle("is-playing", on);
    });
  }

  function createCard(item, idx) {
    if (!item || !/^[A-Za-z0-9_-]{11}$/.test(String(item.id || ""))) return null;
    const card = document.createElement("div");
    card.className = "card musique-card";
    card.dataset.trackId = String(item.id);

    const poster = document.createElement("button");
    poster.type = "button";
    poster.className = "poster music-poster";
    poster.setAttribute(
      "aria-label",
      `${currentMode === "video" ? "Regarder" : "Écouter"} ${item.title || "ce titre"}`,
    );
    poster.addEventListener("click", () => triggerPlay(item, idx));

    const source = safeImageUrl(item.thumbnail);
    if (source) {
      const image = document.createElement("img");
      image.className = "poster-img";
      image.src = source;
      image.alt = String(item.title || "");
      image.loading = "lazy";
      image.decoding = "async";
      poster.appendChild(image);
    } else {
      poster.classList.add("poster-placeholder");
      poster.textContent = "Miniature indisponible";
    }

    const playOverlay = document.createElement("span");
    playOverlay.className = "music-play-overlay";
    playOverlay.innerHTML =
      '<span class="music-play-circle"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></span>';
    poster.appendChild(playOverlay);

    const tag = document.createElement("span");
    tag.className = "quality-tag";
    tag.textContent = currentMode === "video" ? "MP4 Vidéo" : "MP3 Audio";
    poster.appendChild(tag);

    // Épingler hors ligne : la miniature est réellement mise en cache, le
    // titre est prêt à être relu dès le retour du réseau.
    const favItem = {
      type: "music",
      id: item.id,
      title: item.title,
      channel: item.channel,
      thumbnail: item.thumbnail,
    };

    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.className = "music-pin-btn";
    pinBtn.setAttribute("aria-label", "Garder hors ligne");
    pinBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';
    pinBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!window.OmniLibrary) return;
      if (window.OmniLibrary.isOffline(favItem)) {
        window.OmniLibrary.removeOffline(favItem);
        if (window.OmniUI) window.OmniUI.toast("Retiré du hors ligne.", "ok");
      } else {
        pinBtn.classList.add("busy");
        await window.OmniLibrary.saveOffline(Object.assign({}, favItem, { url: "/musiques" }));
        pinBtn.classList.remove("busy");
        if (window.OmniUI) window.OmniUI.toast("Miniature et fiche mises en cache hors ligne.", "ok");
      }
      refreshIcons();
    });

    const favBtn = document.createElement("button");
    favBtn.type = "button";
    favBtn.className = "music-fav-btn";
    favBtn.setAttribute("aria-label", "Ajouter à ma liste");
    favBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (window.OmniLibrary) window.OmniLibrary.toggleFavorite(favItem);
      refreshIcons();
    });

    function refreshIcons() {
      const lib = window.OmniLibrary;
      const on = Boolean(lib && lib.isFavorite(favItem));
      favBtn.classList.toggle("on", on);
      favBtn.setAttribute("aria-pressed", String(on));
      favBtn.innerHTML = on
        ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
      const pinned = Boolean(lib && lib.isOffline(favItem));
      pinBtn.classList.toggle("on", pinned);
      pinBtn.setAttribute("aria-pressed", String(pinned));
    }
    refreshIcons();

    poster.append(favBtn, pinBtn);

    const info = document.createElement("div");
    info.className = "card-info";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = String(item.title || "Sans titre");
    const channel = document.createElement("div");
    channel.className = "card-meta-line";
    channel.innerHTML = `<span class="card-year">${String(item.channel || "Artiste")}</span>`;
    info.append(title, channel);

    card.append(poster, info);
    card.dataset.refreshIcons = "1";
    card.__refreshIcons = refreshIcons;
    return card;
  }

  function renderItems(items) {
    lastItems = (Array.isArray(items) ? items : []).filter(
      (item) => item && /^[A-Za-z0-9_-]{11}$/.test(String(item.id || "")),
    );
    const cards = lastItems.map(createCard).filter(Boolean);
    resultsEl.replaceChildren(...cards);
    emptyMsg.hidden = cards.length > 0;
    if (resultCount) {
      resultCount.hidden = cards.length === 0;
      resultCount.textContent =
        cards.length === 1 ? "1 titre prêt à écouter" : `${cards.length} titres prêts à écouter`;
    }
    markPlaying();
  }

  async function fetchAndRender(url, titleText) {
    if (requestController) requestController.abort();
    const controller = new AbortController();
    requestController = controller;
    resultsEl.replaceChildren();
    emptyMsg.hidden = true;
    if (loadingMsg) loadingMsg.hidden = false;
    if (sectionTitle) sectionTitle.textContent = titleText;

    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "La recherche a échoué.");
      renderItems(data.items);
    } catch (error) {
      if (error.name === "AbortError") return;
      console.error("Erreur de recherche musicale :", error);
      emptyMsg.hidden = false;
      const message = emptyMsg.querySelector("p");
      if (message) {
        message.textContent = navigator.onLine
          ? "Le service musical n'a pas répondu. Vérifiez votre connexion et réessayez."
          : "Vous êtes hors ligne : la musique a besoin de réseau, mais vos titres épinglés vous attendent dans « Hors ligne ».";
      }
      if (window.OmniUI) window.OmniUI.toast("Recherche musicale impossible pour le moment.", "warn");
    } finally {
      if (requestController === controller && loadingMsg) loadingMsg.hidden = true;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = (input.value || "").trim();
    if (!query) {
      fetchAndRender("/api/musique-trending", "🔥 Tendances du moment");
      return;
    }
    fetchAndRender(
      `/api/musique-search?q=${encodeURIComponent(query)}`,
      `Résultats pour « ${query} »`,
    );
  });

  const clearBtn = document.getElementById("musique-clear");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      input.value = "";
      input.focus();
      fetchAndRender("/api/musique-trending", "🔥 Tendances du moment");
    });
  }

  // Synchronise la carte surlignée avec l'état réel du lecteur.
  // Un seul AbortController par page visitée : les écouteurs posés sur
  // `document` sont ainsi supprimés au départ de la page, au lieu de
  // s'empiler à chaque navigation (l'interface devenait de plus en plus
  // lente au fil de la session).
  if (!window.__omniPageAbort) window.__omniPageAbort = new AbortController();
  const signal = window.__omniPageAbort.signal;

  document.addEventListener("omni:library-change", () => {
    resultsEl.querySelectorAll(".musique-card").forEach((card) => {
      if (card.__refreshIcons) card.__refreshIcons();
    });
  }, { signal });
  document.addEventListener("omni:player-change", markPlaying, { signal });
  document.addEventListener("visibilitychange", markPlaying, { signal });

  fetchAndRender("/api/musique-trending", "🔥 Tendances du moment");
})();
