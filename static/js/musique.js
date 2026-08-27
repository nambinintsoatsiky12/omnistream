(function () {
  "use strict";

  const form = document.getElementById("musique-search-form");
  const input = document.getElementById("musique-search-input");
  const resultsEl = document.getElementById("musique-results");
  const emptyMsg = document.getElementById("musique-empty");
  const loadingMsg = document.getElementById("musique-loading");
  const player = document.getElementById("musique-player");
  const sectionTitle = document.getElementById("musique-section-title");
  const modeToggle = document.getElementById("mode-toggle");
  const dataSaverNotice = document.getElementById("data-saver-notice");

  // Bottom floating audio bar
  const audioBar = document.getElementById("audio-bar");
  const audioBarTitle = document.getElementById("audio-bar-title");
  const audioBarChannel = document.getElementById("audio-bar-channel");
  const audioBarStop = document.getElementById("audio-bar-stop");
  const audioBarImg = document.getElementById("audio-bar-img");
  const audioBarIcon = document.getElementById("audio-bar-icon");
  const audioBarExpand = document.getElementById("audio-bar-expand");
  const audioProgressFill = document.getElementById("audio-progress-fill");

  // Expanded Audio Modal
  const expandedModal = document.getElementById("expanded-audio-modal");
  const modalCloseBtn = document.getElementById("modal-close-btn");
  const modalCoverImg = document.getElementById("modal-cover-img");
  const modalTrackTitle = document.getElementById("modal-track-title");
  const modalTrackArtist = document.getElementById("modal-track-artist");
  const modalStopBtn = document.getElementById("modal-stop-btn");
  const modalMinimizeBtn = document.getElementById("modal-minimize-btn");

  // Video overlay
  const videoOverlay = document.getElementById("video-overlay");
  const videoClose = document.getElementById("video-close");
  const videoPlayer = document.getElementById("video-fullscreen-player");
  const videoTitle = document.getElementById("video-title");

  if (!form) return;

  let requestController = null;
  let currentMode = "audio"; // "audio" or "video"
  let currentTrack = null;
  let progressInterval = null;
  let progressPercent = 0;

  /* Mode switch */
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
      videoPlayer.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&modestbranding=1&rel=0&playsinline=1&fs=1`;
    }
    if (videoTitle) videoTitle.textContent = title || "Vidéo plein écran";
    if (videoOverlay) {
      videoOverlay.classList.add("open");
      videoOverlay.setAttribute("aria-hidden", "false");
      document.body.style.overflow = "hidden";
    }
  }

  function closeVideoOverlay() {
    if (videoOverlay) {
      videoOverlay.classList.remove("open");
      videoOverlay.setAttribute("aria-hidden", "true");
      document.body.style.overflow = "";
    }
    if (videoPlayer) videoPlayer.src = "about:blank";
  }

  if (videoClose) videoClose.addEventListener("click", closeVideoOverlay);
  if (videoOverlay) {
    videoOverlay.addEventListener("click", (e) => {
      if (e.target === videoOverlay) closeVideoOverlay();
    });
  }

  /* Audio Mode Controls & Data Saver Optimization */
  function startProgress() {
    if (progressInterval) clearInterval(progressInterval);
    progressPercent = 0;
    progressInterval = setInterval(() => {
      progressPercent = (progressPercent + 0.5) % 100;
      if (audioProgressFill) audioProgressFill.style.width = `${progressPercent}%`;
    }, 1000);
  }

  function stopProgress() {
    if (progressInterval) clearInterval(progressInterval);
    progressInterval = null;
    progressPercent = 0;
    if (audioProgressFill) audioProgressFill.style.width = "0%";
  }

  function stopAudio() {
    if (player) player.src = "about:blank";
    if (audioBar) audioBar.hidden = true;
    closeExpandedModal();
    stopProgress();
    currentTrack = null;
  }

  function playAudio(item) {
    if (!item || !/^[A-Za-z0-9_-]{11}$/.test(String(item.id || ""))) return;
    currentTrack = item;

    // Load in hidden 1px player with lowest bitrate request
    if (player) {
      player.src = `https://www.youtube-nocookie.com/embed/${item.id}?autoplay=1&playsinline=1&controls=0&disablekb=1&iv_load_policy=3&modestbranding=1&rel=0&vq=tiny`;
    }

    const titleStr = String(item.title || "Lecture en cours");
    const channelStr = String(item.channel || "OmniStream Musique");
    const thumbUrl = safeImageUrl(item.thumbnail);

    if (audioBarTitle) audioBarTitle.textContent = titleStr;
    if (audioBarChannel) audioBarChannel.textContent = channelStr;

    if (thumbUrl && audioBarImg) {
      audioBarImg.src = thumbUrl;
      audioBarImg.hidden = false;
      if (audioBarIcon) audioBarIcon.hidden = true;
    } else {
      if (audioBarImg) audioBarImg.hidden = true;
      if (audioBarIcon) audioBarIcon.hidden = false;
    }

    if (audioBar) audioBar.hidden = false;
    startProgress();
  }

  /* Expanded Modal Controls */
  function openExpandedModal() {
    if (!currentTrack || !expandedModal) return;
    const titleStr = String(currentTrack.title || "Lecture en cours");
    const channelStr = String(currentTrack.channel || "OmniStream Musique");
    const thumbUrl = safeImageUrl(currentTrack.thumbnail);

    if (modalTrackTitle) modalTrackTitle.textContent = titleStr;
    if (modalTrackArtist) modalTrackArtist.textContent = channelStr;
    if (modalCoverImg && thumbUrl) modalCoverImg.src = thumbUrl;

    expandedModal.classList.add("open");
    expandedModal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function closeExpandedModal() {
    if (!expandedModal) return;
    expandedModal.classList.remove("open");
    expandedModal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  if (audioBarExpand) audioBarExpand.addEventListener("click", openExpandedModal);
  if (modalCloseBtn) modalCloseBtn.addEventListener("click", closeExpandedModal);
  if (modalMinimizeBtn) modalMinimizeBtn.addEventListener("click", closeExpandedModal);
  if (modalStopBtn) modalStopBtn.addEventListener("click", stopAudio);
  if (audioBarStop) audioBarStop.addEventListener("click", stopAudio);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (videoOverlay && videoOverlay.classList.contains("open")) closeVideoOverlay();
      if (expandedModal && expandedModal.classList.contains("open")) closeExpandedModal();
    }
  });

  /* Play Trigger based on mode */
  function triggerPlay(item) {
    if (currentMode === "video") {
      stopAudio();
      openVideoOverlay(item.id, item.title);
    } else {
      playAudio(item);
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

  function createCard(item, idx) {
    if (!item || !/^[A-Za-z0-9_-]{11}$/.test(String(item.id || ""))) return null;
    const card = document.createElement("button");
    card.type = "button";
    card.className = "card musique-card moviebox-card";
    card.addEventListener("click", () => triggerPlay(item));

    const poster = document.createElement("div");
    poster.className = "poster music-poster";
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

    // Play button overlay
    const playOverlay = document.createElement("div");
    playOverlay.className = "music-play-overlay";
    playOverlay.innerHTML = `<span class="music-play-circle"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>`;
    poster.appendChild(playOverlay);

    // Mode indicator badge
    const tag = document.createElement("span");
    tag.className = "quality-tag";
    tag.textContent = currentMode === "video" ? "MP4 Vidéo" : "MP3 Audio";
    poster.appendChild(tag);

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
    const cards = (Array.isArray(items) ? items : []).map(createCard).filter(Boolean);
    resultsEl.replaceChildren(...cards);
    emptyMsg.hidden = cards.length > 0;
    if (cards.length === 0) emptyMsg.hidden = false;
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
