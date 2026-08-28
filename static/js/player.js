/*
 * OmniStream — Lecteur global persistant
 * ------------------------------------------------------------------
 * Un SEUL lecteur YouTube pour toute l'application. Il vit dans le
 * gabarit de base (base.html) et n'est jamais détruit lors de la
 * navigation interne (voir app-shell.js). Objectifs :
 *   - la musique ne se coupe plus quand on quitte la page Musique ;
 *   - vraie mise en PAUSE / reprise (API IFrame YouTube) ;
 *   - contrôles sur l'écran verrouillé du téléphone (MediaSession) ;
 *   - mode Audio (économiseur de Mo) et mode Vidéo plein écran.
 */
(function () {
  "use strict";

  const state = {
    apiReady: false,
    player: null,
    pendingTrack: null,
    current: null, // {id, title, channel, thumbnail}
    mode: "audio", // "audio" | "video"
    playing: false,
    queue: [],
    queueIndex: -1,
    progressTimer: null,
  };

  // --- Chargement paresseux de l'API IFrame YouTube (une seule fois) -------
  function loadYouTubeApi() {
    if (window.YT && window.YT.Player) {
      state.apiReady = true;
      return;
    }
    if (document.getElementById("yt-iframe-api")) return;
    const tag = document.createElement("script");
    tag.id = "yt-iframe-api";
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  }

  // Callback global appelé par l'API YouTube.
  const previousReady = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = function () {
    if (typeof previousReady === "function") {
      try {
        previousReady();
      } catch (_e) {
        /* noop */
      }
    }
    state.apiReady = true;
    createPlayer();
  };

  function createPlayer() {
    if (state.player || !state.apiReady) return;
    const host = document.getElementById("global-yt-host");
    if (!host) return;
    state.player = new window.YT.Player("global-yt-host", {
      height: "100%",
      width: "100%",
      playerVars: {
        autoplay: 1,
        playsinline: 1,
        controls: state.mode === "video" ? 1 : 0,
        disablekb: 1,
        modestbranding: 1,
        rel: 0,
        iv_load_policy: 3,
      },
      events: {
        onReady: () => {
          if (state.pendingTrack) {
            const t = state.pendingTrack;
            state.pendingTrack = null;
            realLoad(t);
          }
        },
        onStateChange: onPlayerStateChange,
      },
    });
  }

  function onPlayerStateChange(event) {
    const YTS = window.YT.PlayerState;
    if (event.data === YTS.PLAYING) {
      state.playing = true;
      startProgress();
      updateUi();
      setMediaSessionState("playing");
    } else if (event.data === YTS.PAUSED) {
      state.playing = false;
      stopProgress();
      updateUi();
      setMediaSessionState("paused");
    } else if (event.data === YTS.ENDED) {
      state.playing = false;
      stopProgress();
      // Enchaîne automatiquement le morceau suivant si une file existe.
      if (!playNextInQueue()) {
        updateUi();
        setMediaSessionState("none");
      }
    }
  }

  // --- Chargement d'un morceau ---------------------------------------------
  function realLoad(track) {
    if (!state.player || typeof state.player.loadVideoById !== "function") {
      state.pendingTrack = track;
      return;
    }
    try {
      state.player.loadVideoById({ videoId: track.id });
      if (state.mode === "audio" && typeof state.player.setPlaybackQuality === "function") {
        state.player.setPlaybackQuality("small");
      }
    } catch (_e) {
      state.pendingTrack = track;
    }
  }

  function isValidId(id) {
    return /^[A-Za-z0-9_-]{11}$/.test(String(id || ""));
  }

  function play(track, mode) {
    if (!track || !isValidId(track.id)) return;
    if (mode) state.mode = mode;
    state.current = {
      id: String(track.id),
      title: String(track.title || "Lecture en cours"),
      channel: String(track.channel || "OmniStream"),
      thumbnail: String(track.thumbnail || ""),
    };
    loadYouTubeApi();
    applyModeLayout();
    if (!state.player) {
      state.pendingTrack = state.current;
      createPlayer();
    } else {
      realLoad(state.current);
    }
    showBar();
    updateUi();
    setMediaSessionMetadata();
    // Mémorise le dernier morceau écouté (reprise possible hors ligne).
    try {
      localStorage.setItem(
        "omni:last-track",
        JSON.stringify({ ...state.current, mode: state.mode }),
      );
    } catch (_e) {
      /* stockage indisponible */
    }
  }

  function setQueue(list, index) {
    if (!Array.isArray(list)) return;
    state.queue = list.filter((t) => t && isValidId(t.id));
    state.queueIndex = typeof index === "number" ? index : -1;
  }

  function playNextInQueue() {
    if (!state.queue.length) return false;
    const next = state.queueIndex + 1;
    if (next >= state.queue.length) return false;
    state.queueIndex = next;
    play(state.queue[next], state.mode);
    return true;
  }

  function playPrevInQueue() {
    if (!state.queue.length || state.queueIndex <= 0) return false;
    state.queueIndex -= 1;
    play(state.queue[state.queueIndex], state.mode);
    return true;
  }

  function pause() {
    if (state.player && typeof state.player.pauseVideo === "function") {
      state.player.pauseVideo();
    }
  }

  function resume() {
    if (state.player && typeof state.player.playVideo === "function") {
      state.player.playVideo();
    }
  }

  function toggle() {
    if (state.playing) pause();
    else resume();
  }

  function stop() {
    if (state.player && typeof state.player.stopVideo === "function") {
      try {
        state.player.stopVideo();
      } catch (_e) {
        /* noop */
      }
    }
    state.playing = false;
    state.current = null;
    stopProgress();
    hideBar();
    closeVideo();
    setMediaSessionState("none");
  }

  // --- Bascule Audio / Vidéo -----------------------------------------------
  function setMode(mode) {
    if (mode !== "audio" && mode !== "video") return;
    state.mode = mode;
    applyModeLayout();
    updateUi();
  }

  function applyModeLayout() {
    const stage = document.getElementById("global-video-stage");
    const bar = document.getElementById("omni-audio-bar");
    if (state.mode === "video") {
      openVideo();
      if (bar) bar.classList.add("is-video");
    } else {
      closeVideo();
      if (bar) bar.classList.remove("is-video");
    }
  }

  function openVideo() {
    const overlay = document.getElementById("global-video-overlay");
    const stage = document.getElementById("global-video-stage");
    const shell = document.getElementById("global-player-shell");
    if (overlay && stage && shell) {
      stage.appendChild(shell); // déplace le lecteur dans l'overlay
      overlay.classList.add("open");
      overlay.setAttribute("aria-hidden", "false");
      document.body.style.overflow = "hidden";
    }
    const vt = document.getElementById("global-video-title");
    if (vt && state.current) vt.textContent = state.current.title;
  }

  function closeVideo() {
    const overlay = document.getElementById("global-video-overlay");
    const dock = document.getElementById("global-player-dock");
    const shell = document.getElementById("global-player-shell");
    if (overlay) {
      overlay.classList.remove("open");
      overlay.setAttribute("aria-hidden", "true");
    }
    if (dock && shell && shell.parentElement !== dock) {
      dock.appendChild(shell); // range le lecteur dans son dock caché
    }
    document.body.style.overflow = "";
  }

  // --- Barre audio flottante (UI) ------------------------------------------
  function showBar() {
    const bar = document.getElementById("omni-audio-bar");
    if (bar) bar.hidden = false;
    document.body.classList.add("has-audio-bar");
  }

  function hideBar() {
    const bar = document.getElementById("omni-audio-bar");
    if (bar) bar.hidden = true;
    document.body.classList.remove("has-audio-bar");
  }

  function updateUi() {
    const t = state.current;
    const titleEl = document.getElementById("omni-bar-title");
    const chEl = document.getElementById("omni-bar-channel");
    const imgEl = document.getElementById("omni-bar-img");
    const iconEl = document.getElementById("omni-bar-icon");
    const playIcon = document.getElementById("omni-bar-play-icon");
    const pauseIcon = document.getElementById("omni-bar-pause-icon");
    const disc = document.getElementById("omni-bar-disc");

    if (titleEl) titleEl.textContent = t ? t.title : "Aucune lecture";
    if (chEl) chEl.textContent = t ? t.channel : "OmniStream Player";
    if (imgEl && iconEl) {
      if (t && t.thumbnail) {
        imgEl.src = t.thumbnail;
        imgEl.hidden = false;
        iconEl.hidden = true;
      } else {
        imgEl.hidden = true;
        iconEl.hidden = false;
      }
    }
    if (playIcon && pauseIcon) {
      playIcon.hidden = state.playing;
      pauseIcon.hidden = !state.playing;
    }
    if (disc) disc.classList.toggle("spinning", state.playing);

    // Modale agrandie
    const mTitle = document.getElementById("omni-modal-title");
    const mArtist = document.getElementById("omni-modal-artist");
    const mCover = document.getElementById("omni-modal-cover");
    const mPlay = document.getElementById("omni-modal-play-icon");
    const mPause = document.getElementById("omni-modal-pause-icon");
    if (mTitle && t) mTitle.textContent = t.title;
    if (mArtist && t) mArtist.textContent = t.channel;
    if (mCover && t && t.thumbnail) mCover.src = t.thumbnail;
    if (mPlay && mPause) {
      mPlay.hidden = state.playing;
      mPause.hidden = !state.playing;
    }
  }

  function startProgress() {
    stopProgress();
    state.progressTimer = window.setInterval(() => {
      if (!state.player || typeof state.player.getDuration !== "function") return;
      const dur = state.player.getDuration() || 0;
      const cur = state.player.getCurrentTime() || 0;
      const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
      const fill = document.getElementById("omni-bar-progress-fill");
      const mFill = document.getElementById("omni-modal-progress-fill");
      if (fill) fill.style.width = pct + "%";
      if (mFill) mFill.style.width = pct + "%";
      const curEl = document.getElementById("omni-modal-time-cur");
      const durEl = document.getElementById("omni-modal-time-dur");
      if (curEl) curEl.textContent = fmtTime(cur);
      if (durEl) durEl.textContent = fmtTime(dur);
    }, 1000);
  }

  function stopProgress() {
    if (state.progressTimer) window.clearInterval(state.progressTimer);
    state.progressTimer = null;
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function seekToPercent(pct) {
    if (!state.player || typeof state.player.getDuration !== "function") return;
    const dur = state.player.getDuration() || 0;
    if (dur > 0) state.player.seekTo(dur * pct, true);
  }

  // --- MediaSession (contrôles écran verrouillé) ---------------------------
  function setMediaSessionMetadata() {
    if (!("mediaSession" in navigator) || !state.current) return;
    try {
      const artwork = [];
      if (state.current.thumbnail) {
        artwork.push({ src: state.current.thumbnail, sizes: "480x360", type: "image/jpeg" });
      }
      artwork.push({ src: "/static/images/icon-512.png", sizes: "512x512", type: "image/png" });
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: state.current.title,
        artist: state.current.channel,
        album: "OmniStream",
        artwork,
      });
      navigator.mediaSession.setActionHandler("play", () => resume());
      navigator.mediaSession.setActionHandler("pause", () => pause());
      navigator.mediaSession.setActionHandler("stop", () => stop());
      navigator.mediaSession.setActionHandler("nexttrack", () => playNextInQueue());
      navigator.mediaSession.setActionHandler("previoustrack", () => playPrevInQueue());
    } catch (_e) {
      /* API partiellement supportée */
    }
  }

  function setMediaSessionState(playbackState) {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState = playbackState;
    } catch (_e) {
      /* noop */
    }
  }

  // --- Câblage des contrôles de l'UI (une seule fois) ----------------------
  function bindUiOnce() {
    if (window.__omniPlayerBound) return;
    window.__omniPlayerBound = true;

    document.addEventListener("click", (e) => {
      const el = e.target.closest("[data-omni-action]");
      if (!el) return;
      const action = el.getAttribute("data-omni-action");
      if (action === "toggle") toggle();
      else if (action === "stop") stop();
      else if (action === "next") playNextInQueue();
      else if (action === "prev") playPrevInQueue();
      else if (action === "expand") openModal();
      else if (action === "minimize") closeModal();
      else if (action === "close-video") {
        setMode("audio");
      }
    });

    // Barre de progression cliquable (modale)
    const track = document.getElementById("omni-modal-progress");
    if (track) {
      track.addEventListener("click", (e) => {
        const rect = track.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        seekToPercent(Math.max(0, Math.min(1, pct)));
      });
    }

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const overlay = document.getElementById("global-video-overlay");
        if (overlay && overlay.classList.contains("open")) setMode("audio");
        closeModal();
      }
    });
  }

  function openModal() {
    const modal = document.getElementById("omni-audio-modal");
    if (modal && state.current) {
      modal.classList.add("open");
      modal.setAttribute("aria-hidden", "false");
      document.body.style.overflow = "hidden";
    }
  }
  function closeModal() {
    const modal = document.getElementById("omni-audio-modal");
    if (modal) {
      modal.classList.remove("open");
      modal.setAttribute("aria-hidden", "true");
    }
    if (state.mode !== "video") document.body.style.overflow = "";
  }

  // Restaure l'affichage de la barre si un morceau était en cours
  // (utile après réouverture ; la lecture ne reprend pas seule).
  function restoreLastTrackChip() {
    try {
      const raw = localStorage.getItem("omni:last-track");
      if (!raw) return;
      const t = JSON.parse(raw);
      if (t && isValidId(t.id)) {
        state.current = t;
        showBar();
        updateUi();
      }
    } catch (_e) {
      /* noop */
    }
  }

  // API publique
  window.OmniPlayer = {
    play,
    pause,
    resume,
    toggle,
    stop,
    setMode,
    setQueue,
    next: playNextInQueue,
    prev: playPrevInQueue,
    getCurrent: () => state.current,
    isPlaying: () => state.playing,
  };

  function init() {
    bindUiOnce();
    // ne crée pas le lecteur tant qu'aucune lecture n'est demandée (économie)
    document.addEventListener("visibilitychange", () => {
      // rien : on laisse volontairement la lecture continuer en arrière-plan
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
