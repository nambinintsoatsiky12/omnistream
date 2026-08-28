/*
 * OmniStream — Page Musique
 * Délègue toute la lecture au lecteur global (player.js) : la musique
 * continue désormais quand on quitte la page, avec pause et contrôles
 * sur l'écran verrouillé.
 */
(function () {
  "use strict";

  const form = document.getElementById("musique-search-form");
  const input = document.getElementById("musique-search-input");
  const resultsEl = document.getElementById("musique-results");
  const emptyMsg = document.getElementById("musique-empty");
  const loadingMsg = document.getElementById("musique-loading");
  const sectionTitle = document.getElementById("musique-section-title");
  const modeToggle = document.getElementById("mode-toggle");
  const dataSaverNotice = document.getElementById("data-saver-notice");

  if (!form) return;

  let requestController = null;
  let currentMode = "audio";
  let lastItems = [];

  if (modeToggle) {
    modeToggle.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentMode = btn.dataset.mode;
        modeToggle.querySelectorAll(".mode-btn").forEach((b) => {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-checked", String(b === btn));
        });
        if (dataSaverNotice) {
          dataSaverNotice.style.display = currentMode === "audio" ? "flex" : "none";
        }
        // Met à jour les badges des cartes déjà affichées
        document.querySelectorAll(".musique-card .quality-tag").forEach((tag) => {
          tag.textContent = currentMode === "video" ? "MP4 Vidéo" : "MP3 Audio";
        });
      });
    });
  }

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
    // Construit une file de lecture pour l'enchaînement automatique.
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
  }

  function createCard(item, idx) {
    if (!item || !/^[A-Za-z0-9_-]{11}$/.test(String(item.id || ""))) return null;
    const card = document.createElement("div");
    card.className = "card musique-card moviebox-card";

    const poster = document.createElement("button");
    poster.type = "button";
    poster.className = "poster music-poster";
    poster.addEventListener("click", () => triggerPlay(item, idx));
    const source = safeImageUrl(item.thumbnail);
    if (source) {
      const image = document.createElement("img");
      image.className = "poster-img";
      image.src = source;
      image.alt = String(item.title || "");
      image.loading = "lazy";
      poster.appendChild(image);
    } else {
      poster.classList.add("poster-placeholder");
      poster.textContent = "Miniature indisponible";
    }

    const playOverlay = document.createElement("div");
    playOverlay.className = "music-play-overlay";
    playOverlay.innerHTML =
      '<span class="music-play-circle"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>';
    poster.appendChild(playOverlay);

    const tag = document.createElement("span");
    tag.className = "quality-tag";
    tag.textContent = currentMode === "video" ? "MP4 Vidéo" : "MP3 Audio";
    poster.appendChild(tag);

    // Bouton favori (coin supérieur)
    const favBtn = document.createElement("button");
    favBtn.type = "button";
    favBtn.className = "music-fav-btn";
    favBtn.setAttribute("aria-label", "Ajouter à ma liste");
    const favItem = {
      type: "music",
      id: item.id,
      title: item.title,
      channel: item.channel,
      thumbnail: item.thumbnail,
    };
    const refreshFav = () => {
      const on = window.OmniLibrary && window.OmniLibrary.isFavorite(favItem);
      favBtn.classList.toggle("on", !!on);
      favBtn.innerHTML = on
        ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
    };
    favBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (window.OmniLibrary) window.OmniLibrary.toggleFavorite(favItem);
      refreshFav();
    });
    refreshFav();
    poster.appendChild(favBtn);

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
    return card;
  }

  function renderItems(items) {
    lastItems = (Array.isArray(items) ? items : []).filter(
      (i) => i && /^[A-Za-z0-9_-]{11}$/.test(String(i.id || "")),
    );
    const cards = lastItems.map(createCard).filter(Boolean);
    resultsEl.replaceChildren(...cards);
    emptyMsg.hidden = cards.length > 0;
  }

  async function fetchAndRender(url, titleText) {
    if (requestController) requestController.abort();
    const controller = new AbortController();
    requestController = controller;
    resultsEl.replaceChildren();
    emptyMsg.hidden = true;
    loadingMsg.hidden = false;
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
    } finally {
      if (requestController === controller) loadingMsg.hidden = true;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (query) {
      fetchAndRender(
        `/api/musique-search?q=${encodeURIComponent(query)}`,
        `Résultats pour « ${query} »`,
      );
    }
  });

  fetchAndRender("/api/musique-trending", "🔥 Tendances du moment");
})();
