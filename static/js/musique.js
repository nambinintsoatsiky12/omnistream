(function () {
  "use strict";

  const form = document.getElementById("musique-search-form");
  const input = document.getElementById("musique-search-input");
  const resultsEl = document.getElementById("musique-results");
  const emptyMsg = document.getElementById("musique-empty");
  const loadingMsg = document.getElementById("musique-loading");
  const player = document.getElementById("musique-player");
  const audioBar = document.getElementById("audio-bar");
  const audioBarTitle = document.getElementById("audio-bar-title");
  const audioBarChannel = document.getElementById("audio-bar-channel");
  const audioBarStop = document.getElementById("audio-bar-stop");
  const sectionTitle = document.getElementById("musique-section-title");
  const modeToggle = document.getElementById("mode-toggle");
  const videoOverlay = document.getElementById("video-overlay");
  const videoClose = document.getElementById("video-close");
  const videoPlayer = document.getElementById("video-fullscreen-player");
  const videoTitle = document.getElementById("video-title");
  if (!form) return;

  let requestController = null;
  let currentMode = "audio"; // "audio" or "video"

  /* Mode toggle */
  if (modeToggle) {
    modeToggle.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentMode = btn.dataset.mode;
        modeToggle.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        // Close any open players when switching modes
        if (currentMode === "audio") {
          closeVideoOverlay();
        } else {
          stopAudio();
        }
      });
    });
  }

  /* Video overlay controls */
  function openVideoOverlay(videoId, title) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return;
    if (videoPlayer) {
      videoPlayer.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`;
    }
    if (videoTitle) videoTitle.textContent = title || "";
    if (videoOverlay) {
      videoOverlay.classList.add("open");
      document.body.style.overflow = "hidden";
    }
  }

  function closeVideoOverlay() {
    if (videoOverlay) {
      videoOverlay.classList.remove("open");
      document.body.style.overflow = "";
    }
    if (videoPlayer) videoPlayer.src = "about:blank";
  }

  if (videoClose) {
    videoClose.addEventListener("click", closeVideoOverlay);
  }
  if (videoOverlay) {
    videoOverlay.addEventListener("click", (e) => {
      if (e.target === videoOverlay) closeVideoOverlay();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && videoOverlay && videoOverlay.classList.contains("open")) {
      closeVideoOverlay();
    }
  });

  /* Audio mode : iframe caché de 1px + barre de lecteur visible */
  function stopAudio() {
    if (player) player.src = "about:blank";
    if (audioBar) audioBar.hidden = true;
  }

  if (audioBarStop) {
    audioBarStop.addEventListener("click", stopAudio);
  }

  function playAudio(videoId, title, channel) {
    if (player) {
      player.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`;
    }
    if (audioBarTitle) audioBarTitle.textContent = title || "Lecture en cours";
    if (audioBarChannel) audioBarChannel.textContent = channel || "";
    if (audioBar) audioBar.hidden = false;
  }

  /* Play video based on current mode */
  function playVideo(videoId, title, channel) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return;
    if (currentMode === "video") {
      stopAudio();
      openVideoOverlay(videoId, title);
    } else {
      playAudio(videoId, title, channel);
    }
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

  function createCard(item) {
    if (!item || !/^[A-Za-z0-9_-]{11}$/.test(String(item.id || ""))) return null;
    const card = document.createElement("button");
    card.type = "button";
    card.className = "card musique-card";
    card.addEventListener("click", () =>
      playVideo(String(item.id), String(item.title || ""), String(item.channel || "")),
    );

    const poster = document.createElement("div");
    poster.className = "poster";
    const source = safeImageUrl(item.thumbnail);
    if (source) {
      const image = document.createElement("img");
      image.className = "poster-img";
      image.src = source;
      image.alt = "";
      image.loading = "lazy";
      poster.appendChild(image);
    } else {
      poster.classList.add("poster-placeholder");
      poster.textContent = "Miniature indisponible";
    }

    const info = document.createElement("div");
    info.className = "card-info";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = String(item.title || "Sans titre");
    const channel = document.createElement("div");
    channel.className = "card-date";
    channel.textContent = String(item.channel || "");
    info.append(title, channel);
    card.append(poster, info);
    return card;
  }

  function renderItems(items) {
    const cards = (Array.isArray(items) ? items : []).map(createCard).filter(Boolean);
    resultsEl.replaceChildren(...cards);
    emptyMsg.hidden = cards.length > 0;
    if (cards.length === 0) emptyMsg.textContent = "Aucun résultat trouvé.";
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
      emptyMsg.textContent = error.message || "Une erreur est survenue.";
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
