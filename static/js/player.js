/*
 * OmniStream — Lecteur global persistant (audio / vidéo)
 * ------------------------------------------------------------------
 * Un SEUL lecteur YouTube pour toute l'application, vivant dans le gabarit
 * de base : il n'est jamais détruit par la navigation interne, donc la
 * musique continue quand on change de page.
 *
 * Règles d'orfèvrerie appliquées ici :
 *  - chaque touche réagit IMMÉDIATEMENT : l'état visuel change au toucher,
 *    le réseau suit derrière (jamais l'inverse) ;
 *  - l'icône ▶ / II est pilotée par un seul attribut d'état, donc le bouton
 *    change toujours d'apparence quand l'état change ;
 *  - le panneau du bas se ferme TOUJOURS : bouton ✕, glisser vers le bas,
 *    Échap, ou clic hors du panneau ;
 *  - écran verrouillé : MediaSession + positionState + maintien de la
 *    session audio, pour que la lecture ne se coupe pas ;
 *  - hors ligne : on n'attend pas un réseau absent. Le morceau est mis en
 *    attente et lancé dès le retour de la connexion.
 */
(function () {
  "use strict";

  const API_URL = "https://www.youtube.com/iframe_api";
  const START_TIMEOUT = 8000;
  const RESUME_KEY = "omni:resume";
  const LAST_KEY = "omni:last-track";
  const QUEUE_KEY = "omni:queue";

  const state = {
    apiStatus: "idle", // idle | loading | ready | error
    player: null,
    playerReady: false,
    pendingTrack: null,
    current: null, // {id,title,channel,thumbnail}
    mode: "audio",
    status: "idle", // idle | loading | playing | paused | offline | error
    error: "",
    hint: "",
    queue: [],
    queueIndex: -1,
    progressTimer: null,
    resyncTimer: null,
    startTimer: null,
    resumeTime: 0,
    waitingNetwork: false,
    lastPosition: 0,
    lastDuration: 0,
    dragging: false,
  };

  const keepAlive = { ctx: null, gain: null, osc: null };

  /* ================================================================== *
   * Petits utilitaires DOM / stockage
   * ================================================================== */
  const $ = (id) => document.getElementById(id);

  function localGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function localSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_error) {
      /* quota ou navigation privée : la lecture reste possible */
    }
  }

  function localRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (_error) {
      /* noop */
    }
  }

  function isValidId(id) {
    return /^[A-Za-z0-9_-]{11}$/.test(String(id || ""));
  }

  function isOffline() {
    return typeof navigator.onLine === "boolean" && navigator.onLine === false;
  }

  function toast(message, kind) {
    try {
      if (window.OmniUI && window.OmniUI.toast) window.OmniUI.toast(message, kind || "info");
    } catch (_error) {
      /* noop */
    }
  }

  /* ================================================================== *
   * API IFrame YouTube — chargement tolérant aux pannes réseau
   * ================================================================== */
  let apiAttempts = 0;
  let apiPromise = null;

  function loadYouTubeApi() {
    if (window.YT && window.YT.Player) {
      setApiReady();
      return Promise.resolve(true);
    }
    if (state.apiStatus === "loading") return apiPromise;
    apiAttempts += 1;
    state.apiStatus = "loading";
    apiPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        if (ok) setApiReady();
        else state.apiStatus = "error";
        resolve(ok);
      };
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function onReady() {
        if (typeof previous === "function") {
          try {
            previous();
          } catch (_error) {
            /* noop */
          }
        }
        finish(Boolean(window.YT && window.YT.Player));
      };
      let tag = document.getElementById("yt-iframe-api");
      if (!tag) {
        tag = document.createElement("script");
        tag.id = "yt-iframe-api";
        tag.src = API_URL;
        tag.async = true;
        tag.onerror = () => finish(false);
        document.head.appendChild(tag);
      } else {
        tag.addEventListener("error", () => finish(false), { once: true });
      }
      // Réseau lent ou bloqué : on rend la main à l'utilisateur au lieu de
      // le laisser devant un bouton qui ne fait rien.
      window.setTimeout(() => finish(Boolean(window.YT && window.YT.Player)), 12000);
    });
    return apiPromise;
  }

  function setApiReady() {
    state.apiStatus = "ready";
    createPlayer();
  }

  function createPlayer() {
    if (state.player || !window.YT || !window.YT.Player) return;
    const host = $("global-yt-host");
    if (!host) return;
    try {
      state.player = new window.YT.Player("global-yt-host", {
        height: "100%",
        width: "100%",
        playerVars: {
          autoplay: 1,
          playsinline: 1,
          controls: 1,
          disablekb: 1,
          modestbranding: 1,
          rel: 0,
          iv_load_policy: 3,
          origin: window.location.origin,
        },
        events: {
          onReady: onPlayerReady,
          onStateChange: onPlayerStateChange,
          onError: onPlayerError,
        },
      });
    } catch (_error) {
      state.player = null;
    }
  }

  function onPlayerReady() {
    state.playerReady = true;
    try {
      if (typeof state.player.setVolume === "function") state.player.setVolume(100);
    } catch (_error) {
      /* noop */
    }
    if (state.pendingTrack) {
      const track = state.pendingTrack;
      state.pendingTrack = null;
      if (track.startAt) state.resumeTime = track.startAt;
      realLoad(track);
    }
  }

  function onPlayerError(event) {
    const codes = {
      2: "Ce morceau est indisponible (identifiant invalide).",
      5: "Le lecteur HTML5 refuse ce format sur ce navigateur.",
      100: "Ce morceau n'existe plus ou est privé.",
      101: "L'auteur interdit la lecture intégrée — ouvrez-le sur YouTube.",
      150: "L'auteur interdit la lecture intégrée — ouvrez-le sur YouTube.",
    };
    const code = Number(event && event.data);
    state.error = codes[code] || "Le flux YouTube n'a pas pu démarrer.";
    setStatus("error");
    // Le morceau suivant de la file prend le relais, si possible.
    if (!playNextInQueue(true)) {
      toast(state.error, "warn");
    }
  }

  /* ================================================================== *
   * Machine à états
   * ================================================================== */
  function setStatus(status, message) {
    state.status = status;
    // Prévenu, l'écran en cours de lecture peut surligner la bonne carte.
    try {
      document.dispatchEvent(new CustomEvent("omni:player-change", { detail: { status } }));
    } catch (_error) {
      /* noop */
    }
    // Deux canaux distincts : une panne (state.error, couleur d'alerte, bouton
    // Réessayer) et une simple indication de confort (state.hint). Les confondre
    // faisait disparaître le message « Touchez ▶ pour reprendre ».
    state.hint = typeof message === "string" ? message : "";
    if (status === "error" && !state.error) state.error = "Le flux YouTube n'a pas pu démarrer.";
    if (status !== "error" && message === undefined) state.error = "";
    render();
    setMediaSessionState(status === "playing" ? "playing" : status === "paused" ? "paused" : "none");
    if (status === "playing") {
      startProgress();
      startKeepAlive();
      startResync();
    } else {
      if (status !== "loading") stopProgress();
      if (status === "paused" || status === "idle" || status === "error" || status === "offline") {
        stopKeepAlive();
      }
    }
  }

  function realLoad(track) {
    if (!state.player || typeof state.player.loadVideoById !== "function") {
      state.pendingTrack = track;
      return;
    }
    setStatus("loading");
    try {
      state.player.loadVideoById({ videoId: String(track.id), startSeconds: state.resumeTime || 0 });
      state.resumeTime = 0;
      armStartWatchdog();
    } catch (_error) {
      state.pendingTrack = track;
      setStatus("error", "Le lecteur n'était pas prêt. Touchez Réessayer.");
    }
  }

  // Si rien ne démarre dans le délai imparti, on propose l'action qui manque
  // plutôt que de laisser un bouton mort.
  function armStartWatchdog() {
    if (state.startTimer) window.clearTimeout(state.startTimer);
    state.startTimer = window.setTimeout(() => {
      state.startTimer = null;
      if (state.status !== "loading") return;
      const blocked = state.player && typeof state.player.getPlayerState === "function"
        ? state.player.getPlayerState() !== 1
        : true;
      if (blocked) {
        setStatus("paused", "Touchez ▶ pour démarrer la lecture.");
      }
    }, START_TIMEOUT);
  }

  function clearStartWatchdog() {
    if (state.startTimer) window.clearTimeout(state.startTimer);
    state.startTimer = null;
  }

  function onPlayerStateChange(event) {
    const YTS = window.YT && window.YT.PlayerState;
    if (!YTS || !event) return;
    clearStartWatchdog();
    if (event.data === YTS.PLAYING) {
      state.status = "playing";
      setStatus("playing");
    } else if (event.data === YTS.PAUSED) {
      setStatus("paused");
      saveResumePoint();
    } else if (event.data === YTS.BUFFERING) {
      if (state.status !== "loading") setStatus("loading");
    } else if (event.data === YTS.ENDED) {
      localRemoveResume();
      if (!playNextInQueue(false)) setStatus("paused", "File terminée.");
    } else if (event.data === YTS.CUED) {
      setStatus("loading");
    }
  }

  function localRemoveResume() {
    localRemove(RESUME_KEY);
  }

  /* ================================================================== *
   * Lecture / file
   * ================================================================== */
  function play(track, mode) {
    if (!track || !isValidId(track.id)) return;
    if (mode === "video" || mode === "audio") state.mode = mode;
    state.current = {
      id: String(track.id),
      title: String(track.title || "Lecture en cours"),
      channel: String(track.channel || "OmniStream"),
      thumbnail: String(track.thumbnail || ""),
    };
    showBar();
    applyModeLayout();
    localSet(LAST_KEY, JSON.stringify(Object.assign({}, state.current, { mode: state.mode })));
    setMediaSessionMetadata();

    if (isOffline()) {
      state.waitingNetwork = true;
      setStatus("offline", "Hors ligne — lecture dès le retour du réseau.");
      return;
    }
    state.waitingNetwork = false;
    startStream();
  }

  // Démarre (ou redémarre) le flux du morceau courant.
  function startStream(options) {
    const opts = options || {};
    if (!state.current) return;
    if (!state.playerReady || !state.player) {
      setStatus("loading", "Chargement du lecteur…");
      loadYouTubeApi().then((ok) => {
        if (!ok) {
          setStatus("error", "Lecteur YouTube injoignable. Vérifiez la connexion.");
          return;
        }
        createPlayer();
        if (state.player && state.playerReady) {
          if (opts.resumePosition) state.resumeTime = opts.resumePosition;
          realLoad(state.current);
        } else {
          state.pendingTrack = Object.assign({}, state.current, {
            startAt: opts.resumePosition || 0,
          });
          setStatus("loading", "Préparation du flux…");
        }
      });
      return;
    }
    if (opts.resumePosition) state.resumeTime = opts.resumePosition;
    realLoad(state.current);
  }

  function setQueue(list, index) {
    if (!Array.isArray(list)) return;
    state.queue = list.filter((track) => track && isValidId(track.id));
    state.queueIndex = typeof index === "number" ? index : -1;
    persistQueue();
  }

  function persistQueue() {
    if (!state.queue.length) return;
    localSet(
      QUEUE_KEY,
      JSON.stringify({
        index: state.queueIndex,
        items: state.queue.slice(0, 60),
      }),
    );
  }

  function restoreQueue() {
    try {
      const raw = localGet(QUEUE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.items) && data.items.length) {
        state.queue = data.items.filter((track) => track && isValidId(track.id));
        state.queueIndex = Number(data.index) || 0;
      }
    } catch (_error) {
      /* noop */
    }
  }

  function playAt(index, keepMode) {
    if (index < 0 || index >= state.queue.length) return false;
    state.queueIndex = index;
    persistQueue();
    play(state.queue[index], keepMode ? state.mode : undefined);
    return true;
  }

  function playNextInQueue(silent) {
    if (!state.queue.length) return false;
    const next = state.queueIndex + 1;
    if (next >= state.queue.length) return false;
    if (!silent) toast(`Suivant · ${state.queue[next].title || ""}`, "info");
    return playAt(next, true);
  }

  function playPrevInQueue() {
    if (!state.queue.length) return false;
    // Rejoue depuis le début si on est déjà avancé, comme un vrai lecteur.
    if (state.lastPosition > 3 && state.player && typeof state.player.seekTo === "function") {
      state.player.seekTo(0, true);
      return true;
    }
    const prev = state.queueIndex - 1;
    if (prev < 0) return false;
    return playAt(prev, true);
  }

  /* ================================================================== *
   * Transport
   * ================================================================== */
  function pause() {
    if (state.player && typeof state.player.pauseVideo === "function") {
      try {
        state.player.pauseVideo();
      } catch (_error) {
        /* noop */
      }
    }
    saveResumePoint();
    // Bascule immédiate de l'icône : l'événement YouTube peut traîner d'un
    // demi-segment sur une connexion 3G.
    if (state.status === "playing") setStatus("paused");
  }

  function resume() {
    if (isOffline()) {
      state.waitingNetwork = true;
      setStatus("offline", "Hors ligne — lecture dès le retour du réseau.");
      return;
    }
    if (!state.current) return;
    if (state.player && typeof state.player.playVideo === "function") {
      setStatus("loading", "Reprise…");
      try {
        state.player.playVideo();
        armStartWatchdog();
        return;
      } catch (_error) {
        /* on repasse par un chargement complet */
      }
    }
    startStream({ resumePosition: readResumePoint() });
  }

  function toggle() {
    if (!state.current) return;
    if (state.status === "playing") {
      pause();
      return;
    }
    if (state.status === "loading") {
      // Touche « pendant le chargement » : on annule proprement l'attente.
      pause();
      return;
    }
    resume();
  }

  function close() {
    if (state.player && typeof state.player.stopVideo === "function") {
      try {
        state.player.stopVideo();
      } catch (_error) {
        /* noop */
      }
    }
    clearStartWatchdog();
    stopProgress();
    stopResync();
    stopKeepAlive();
    state.status = "idle";
    state.error = "";
    state.hint = "";
    state.current = null;
    state.lastPosition = 0;
    state.lastDuration = 0;
    localRemoveResume();
    // Fermer doit être définitif : sans cette ligne, le panneau revenait de
    // lui-même à la page suivante, comme s'il était impossible à fermer.
    localRemove(LAST_KEY);
    localRemove(QUEUE_KEY);
    state.queue = [];
    state.queueIndex = -1;
    state.waitingNetwork = false;
    closeModal();
    closeVideo();
    hideBar();
    setMediaSessionState("none");
    render();
  }

  /* ------------------------------------------------------------------ *
   * Option « écran allumé » : sur certains téléphones très économes, la
   * lecture se coupe dès que l'écran s'éteint. Un verrou d'écran optionnel
   * (désactivé par défaut, donc sans surcoût de batterie) l'empêche.
   * ------------------------------------------------------------------ */
  const wake = { lock: null, wanted: false };

  async function applyWakeLock() {
    if (!("wakeLock" in navigator)) return false;
    if (!wake.wanted) {
      if (wake.lock) {
        try {
          await wake.lock.release();
        } catch (_error) {
          /* déjà libéré */
        }
        wake.lock = null;
      }
      return false;
    }
    if (document.hidden) return Boolean(wake.lock);
    try {
      wake.lock = await navigator.wakeLock.request("screen");
      wake.lock.addEventListener("release", () => {
        // Le navigateur libère le verrou quand l'onglet passe en arrière-plan :
        // on le reprendra au retour, tant que l'option est active.
        wake.lock = null;
        renderWakeLock();
      });
      return true;
    } catch (_error) {
      return false;
    }
  }

  function toggleWakeLock() {
    wake.wanted = !wake.wanted;
    try {
      localSet("omni:wake-lock", wake.wanted ? "1" : "0");
    } catch (_error) {
      /* noop */
    }
    applyWakeLock().then((ok) => {
      renderWakeLock();
      if (window.OmniUI) {
        window.OmniUI.toast(
          wake.wanted
            ? ok
              ? "Écran maintenu allumé pendant la lecture."
              : "Le navigateur refuse ce verrou — la lecture reste prioritaire, mais l'écran peut s'éteindre."
            : "Écran libre : il s'éteindra normalement.",
          "info",
        );
      }
    });
  }

  function renderWakeLock() {
    document.querySelectorAll("[data-omni-action='wake-lock']").forEach((btn) => {
      btn.classList.toggle("on", wake.wanted);
      btn.setAttribute("aria-pressed", String(wake.wanted));
      const label = btn.querySelector("span");
      if (label) label.textContent = wake.wanted ? "Écran allumé : oui" : "Écran allumé : non";
    });
  }

  function setMode(mode) {
    if (mode !== "audio" && mode !== "video") return;
    if (state.mode === mode && mode === "audio") {
      closeVideo();
      render();
      return;
    }
    state.mode = mode;
    applyModeLayout();
    render();
  }

  function applyModeLayout() {
    const bar = $("omni-audio-bar");
    if (state.mode === "video") {
      openVideo();
      if (bar) bar.classList.add("is-video");
    } else {
      closeVideo();
      if (bar) bar.classList.remove("is-video");
    }
  }

  function openVideo() {
    const overlay = $("global-video-overlay");
    const stage = $("global-video-stage");
    const shell = $("global-player-shell");
    if (overlay && stage && shell) {
      stage.appendChild(shell);
      overlay.classList.add("open");
      overlay.setAttribute("aria-hidden", "false");
      document.body.classList.add("media-fullscreen");
      setScrollLock(true);
    }
    const title = $("global-video-title");
    if (title && state.current) title.textContent = state.current.title;
  }

  function closeVideo() {
    const overlay = $("global-video-overlay");
    const dock = $("global-player-dock");
    const shell = $("global-player-shell");
    if (overlay) {
      overlay.classList.remove("open");
      overlay.setAttribute("aria-hidden", "true");
    }
    if (dock && shell && shell.parentElement !== dock) {
      dock.appendChild(shell);
    }
    document.body.classList.remove("media-fullscreen");
    setScrollLock(false);
  }

  /* ================================================================== *
   * Reprise : on retrouve l'endroit où la lecture s'est arrêtée
   * ================================================================== */
  function readResumePoint() {
    try {
      const raw = localGet(RESUME_KEY);
      if (!raw || !state.current) return 0;
      const data = JSON.parse(raw);
      if (!data || String(data.id) !== state.current.id) return 0;
      // Au-delà de 12 h, on repart du début : c'est une nouvelle écoute.
      if (Date.now() - Number(data.at || 0) > 43200000) return 0;
      const time = Number(data.time) || 0;
      const duration = Number(data.duration) || 0;
      if (duration > 0 && time > duration - 3) return 0;
      return time;
    } catch (_error) {
      return 0;
    }
  }

  function saveResumePoint() {
    if (!state.current) return;
    let time = state.lastPosition;
    try {
      if (state.player && typeof state.player.getCurrentTime === "function") {
        const live = state.player.getCurrentTime();
        if (live > 0) time = live;
      }
    } catch (_error) {
      /* on garde la dernière valeur connue */
    }
    if (!time || time < 3) return;
    localSet(
      RESUME_KEY,
      JSON.stringify({ id: state.current.id, time: Math.floor(time), at: Date.now() }),
    );
  }

  /* ================================================================== *
   * Progression + barre cliquable
   * ================================================================== */
  function startProgress() {
    if (state.progressTimer) return;
    state.progressTimer = window.setInterval(tick, 500);
    tick();
  }

  function stopProgress() {
    if (state.progressTimer) window.clearInterval(state.progressTimer);
    state.progressTimer = null;
  }

  function tick() {
    const player = state.player;
    if (!player || typeof player.getCurrentTime !== "function") return;
    let duration = 0;
    let current = 0;
    try {
      duration = player.getDuration() || 0;
      current = player.getCurrentTime() || 0;
    } catch (_error) {
      return;
    }
    state.lastPosition = current;
    state.lastDuration = duration;
    if (state.dragging) return;
    const percent = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
    const fill = $("omni-bar-progress-fill");
    const modalFill = $("omni-modal-progress-fill");
    if (fill) fill.style.width = `${percent}%`;
    if (modalFill) modalFill.style.width = `${percent}%`;
    const cur = $("omni-modal-time-cur");
    const dur = $("omni-modal-time-dur");
    if (cur) cur.textContent = fmtTime(current);
    if (dur) dur.textContent = fmtTime(duration);
    const timeEl = $("omni-bar-time");
    if (timeEl && state.status === "playing") timeEl.textContent = fmtTime(current);
    if (state.status === "playing") {
      setPositionState(current, duration);
      if (Math.floor(current) % 5 === 0) saveResumePoint();
    }
  }

  function fmtTime(seconds) {
    const value = Math.max(0, Math.floor(seconds || 0));
    const minutes = Math.floor(value / 60);
    const rest = value % 60;
    return `${minutes}:${rest < 10 ? "0" : ""}${rest}`;
  }

  function seekToPercent(percent) {
    const player = state.player;
    if (!player || typeof player.getDuration !== "function") return;
    let duration = 0;
    try {
      duration = player.getDuration() || 0;
    } catch (_error) {
      return;
    }
    if (duration <= 0) return;
    const target = duration * Math.max(0, Math.min(1, percent));
    try {
      player.seekTo(target, true);
      state.lastPosition = target;
      const fill = $("omni-bar-progress-fill");
      const modalFill = $("omni-modal-progress-fill");
      const pct = `${Math.max(0, Math.min(100, percent * 100))}%`;
      if (fill) fill.style.width = pct;
      if (modalFill) modalFill.style.width = pct;
    } catch (_error) {
      /* noop */
    }
  }

  /* ================================================================== *
   * Interface
   * ================================================================== */
  const STATUS_LABELS = {
    idle: "",
    loading: "Chargement…",
    playing: "Lecture",
    paused: "En pause",
    offline: "Hors ligne · en attente de réseau",
    error: "Problème de flux",
  };

  function render() {
    const track = state.current;
    const bar = $("omni-audio-bar");
    const modal = $("omni-audio-modal");

    // L'état vit sur <body> : barre, modale et overlay vidéo partagent ainsi
    // exactement la même icône ▶ / II, sans se marcher dessus.
    const body = document.body;
    body.dataset.playerStatus = state.status;
    body.dataset.playerPlaying = state.status === "playing" ? "true" : "false";
    body.dataset.playerMode = state.mode;
    if (bar) {
      bar.dataset.status = state.status;
      bar.dataset.playing = state.status === "playing" ? "true" : "false";
      bar.dataset.mode = state.mode;
    }
    if (modal) {
      modal.dataset.status = state.status;
      modal.dataset.playing = state.status === "playing" ? "true" : "false";
      modal.dataset.mode = state.mode;
    }
    const badge = $("omni-modal-badge");
    if (badge) {
      badge.textContent = state.mode === "video"
        ? "LECTURE VIDÉO · PLEIN ÉCRAN"
        : "LECTURE AUDIO · ÉCONOMISEUR DE Mo";
    }

    const titleEl = $("omni-bar-title");
    const channelEl = $("omni-bar-channel");
    const statusEl = $("omni-bar-status");
    const imgEl = $("omni-bar-img");
    const iconEl = $("omni-bar-icon");
    const disc = $("omni-bar-disc");

    if (titleEl) titleEl.textContent = track ? track.title : "Aucune lecture";
    if (channelEl) channelEl.textContent = track ? track.channel : "OmniStream Player";
    if (statusEl) {
      const text = state.error || state.hint || STATUS_LABELS[state.status] || "";
      statusEl.textContent = text;
      // En lecture normale, on n'encombre pas : seule une info utile s'affiche.
      statusEl.hidden = !text || (state.status === "playing" && !state.error && !state.hint);
    }
    if (imgEl && iconEl) {
      if (track && track.thumbnail) {
        const src = safeThumb(track.thumbnail);
        if (src) {
          if (imgEl.getAttribute("src") !== src) imgEl.src = src;
          imgEl.hidden = false;
          iconEl.hidden = true;
        } else {
          imgEl.hidden = true;
          iconEl.hidden = false;
        }
      } else {
        imgEl.hidden = true;
        iconEl.hidden = false;
      }
    }
    if (disc) disc.classList.toggle("spinning", state.status === "playing");

    // Libellés + état pressé des boutons (lecture/pause) partout.
    const label = state.status === "playing" ? "Pause" : "Lecture";
    document.querySelectorAll("[data-omni-action='toggle']").forEach((btn) => {
      btn.setAttribute("aria-label", label);
      btn.setAttribute("title", label);
      btn.setAttribute("aria-pressed", state.status === "playing" ? "true" : "false");
    });

    // Zone modale agrandie
    const mTitle = $("omni-modal-title");
    const mArtist = $("omni-modal-artist");
    const mCover = $("omni-modal-cover");
    const mStatus = $("omni-modal-status");
    if (mTitle && track) mTitle.textContent = track.title;
    if (mArtist && track) mArtist.textContent = track.channel;
    if (mCover && track && track.thumbnail) {
      const src = safeThumb(track.thumbnail);
      if (src) mCover.src = src;
    }
    if (mStatus) {
      const text = state.error || state.hint || STATUS_LABELS[state.status] || "";
      mStatus.textContent = text;
      mStatus.hidden = !text;
    }
    const ytLink = $("omni-modal-yt");
    if (ytLink && track) {
      ytLink.href = `https://www.youtube.com/watch?v=${track.id}`;
      // Le secours n'est utile que si le flux intégré est refusé : sinon la
      // ligne resterait un bouton gris sans emploi.
      ytLink.hidden = state.status !== "error";
    } else if (ytLink) {
      ytLink.hidden = true;
    }
    const retry = document.querySelector("[data-omni-action='retry']");
    if (retry) retry.hidden = !(state.status === "error" || state.status === "offline");

    // Minuteur de sommeil : recharge le libellé restant.
    updateSleepUi();
  }

  function safeThumb(value) {
    if (typeof value !== "string" || !value) return "";
    try {
      const url = new URL(value, window.location.origin);
      return url.protocol === "https:" || url.origin === window.location.origin ? url.href : "";
    } catch (_error) {
      return "";
    }
  }

  function showBar() {
    const bar = $("omni-audio-bar");
    if (bar) bar.hidden = false;
    document.body.classList.add("has-audio-bar");
  }

  function hideBar() {
    const bar = $("omni-audio-bar");
    if (bar) bar.hidden = true;
    document.body.classList.remove("has-audio-bar");
  }

  // Verrou de défilement réel : sur mobile, seule la racine du document défile,
  // donc `body { overflow:hidden }` seul ne suffit pas (le fond continuait de
  // bouger derrière le panneau, ce qui donnait l'impression qu'il ne se
  // refermait jamais vraiment).
  function setScrollLock(on) {
    const root = document.documentElement;
    if (on) root.classList.add("modal-lock");
    else if (!document.getElementById("omni-audio-modal")?.classList.contains("open")
      && !document.body.classList.contains("media-fullscreen")) {
      root.classList.remove("modal-lock");
    }
  }

  function openModal() {
    if (!state.current) return;
    const modal = $("omni-audio-modal");
    if (!modal) return;
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    setScrollLock(true);
    render();
  }

  function closeModal() {
    const modal = $("omni-audio-modal");
    if (modal) {
      modal.classList.remove("open");
      modal.setAttribute("aria-hidden", "true");
    }
    if (!document.body.classList.contains("media-fullscreen")) {
      document.body.classList.remove("modal-open");
    }
    setScrollLock(false);
  }

  /* ================================================================== *
   * Écran verrouillé : MediaSession + session audio maintenue
   * ================================================================== */
  function setMediaSessionMetadata() {
    if (!("mediaSession" in navigator) || !state.current) return;
    try {
      const artwork = [];
      const thumb = safeThumb(state.current.thumbnail);
      if (thumb) artwork.push({ src: thumb, sizes: "480x360", type: "image/jpeg" });
      artwork.push({ src: "/static/images/icon-512.png", sizes: "512x512", type: "image/png" });
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: state.current.title,
        artist: state.current.channel,
        album: "OmniStream",
        artwork,
      });
      navigator.mediaSession.setActionHandler("play", () => resume());
      navigator.mediaSession.setActionHandler("pause", () => pause());
      navigator.mediaSession.setActionHandler("stop", () => close());
      navigator.mediaSession.setActionHandler("nexttrack", () => playNextInQueue(true));
      navigator.mediaSession.setActionHandler("previoustrack", () => playPrevInQueue());
      navigator.mediaSession.setActionHandler("seekto", (details) => {
        if (details && typeof details.seekTime === "number" && state.lastDuration > 0) {
          seekToPercent(details.seekTime / state.lastDuration);
        }
      });
      navigator.mediaSession.setActionHandler("seekbackward", (details) => {
        nudge(-Number(details && details.seekOffset || 10));
      });
      navigator.mediaSession.setActionHandler("seekforward", (details) => {
        nudge(Number(details && details.seekOffset || 10));
      });
      const item = Object.assign({ type: "music" }, state.current);
      if (window.OmniLibrary && typeof navigator.mediaSession.setActionHandler === "function") {
        navigator.mediaSession.setActionHandler("favorite", () => {
          window.OmniLibrary.toggleFavorite(item);
        });
        try {
          navigator.mediaSession.playbackState = state.status === "playing" ? "playing" : "paused";
          navigator.mediaSession.setActionHandler(
            "setfavorites",
            () => window.OmniLibrary.saveOffline(item),
          );
        } catch (_error) {
          /* « setfavorites » encore rarement supporté */
        }
      }
    } catch (_error) {
      /* API partiellement disponible : rien de bloquant */
    }
  }

  function nudge(delta) {
    if (!state.player || typeof state.player.seekTo !== "function") return;
    try {
      const target = Math.max(0, (state.lastDuration ? state.lastPosition : 0) + delta);
      state.player.seekTo(target, true);
    } catch (_error) {
      /* noop */
    }
  }

  function setPositionState(current, duration) {
    if (!("mediaSession" in navigator) || typeof navigator.mediaSession.setPositionState !== "function") {
      return;
    }
    if (!(duration > 0)) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: 1,
        position: Math.min(current, duration),
      });
    } catch (_error) {
      /* noop */
    }
  }

  function setMediaSessionState(playbackState) {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState = playbackState;
    } catch (_error) {
      /* noop */
    }
  }

  // Une page masquée avec un simple <iframe> est parfois suspendue par
  // Android. Un minuteur audio silencieux garde la session audio éveillée
  // sans consommer de données ; il se met en veille dès la pause.
  function startKeepAlive() {
    if (!document.hidden) {
      stopKeepAlive(); // inutile onglet visible
      return;
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!keepAlive.ctx) {
        keepAlive.ctx = new Ctx();
        keepAlive.gain = keepAlive.ctx.createGain();
        keepAlive.gain.gain.value = 0.0001; // inaudible (-80 dB)
        keepAlive.osc = keepAlive.ctx.createOscillator();
        keepAlive.osc.type = "sine";
        keepAlive.osc.frequency.value = 40;
        keepAlive.osc.connect(keepAlive.gain);
        keepAlive.gain.connect(keepAlive.ctx.destination);
        keepAlive.osc.start(0);
      }
      if (keepAlive.ctx.state === "suspended") keepAlive.ctx.resume();
    } catch (_error) {
      /* AudioContext indisponible */
    }
  }

  function stopKeepAlive() {
    try {
      if (keepAlive.ctx && keepAlive.ctx.state === "running") keepAlive.ctx.suspend();
    } catch (_error) {
      /* noop */
    }
  }

  // Re-synchronise l'interface après un retour d'onglet : l'événement
  // YouTube a pu manquer pendant la mise en veille du téléphone.
  function startResync() {
    if (state.resyncTimer) return;
    state.resyncTimer = window.setInterval(() => {
      if (!state.player || typeof state.player.getPlayerState !== "function") return;
      let value;
      try {
        value = state.player.getPlayerState();
      } catch (_error) {
        return;
      }
      const YTS = window.YT && window.YT.PlayerState;
      if (!YTS) return;
      if (value === YTS.PLAYING && state.status !== "playing") {
        state.status = "playing";
        setStatus("playing");
      } else if (value === YTS.PAUSED && state.status === "playing") {
        setStatus("paused");
      }
    }, 4000);
  }

  function stopResync() {
    if (state.resyncTimer) window.clearInterval(state.resyncTimer);
    state.resyncTimer = null;
  }

  /* ================================================================== *
   * Minuteur de sommeil
   * ================================================================== */
  const sleep = { timer: null, deadline: 0, tick: null };

  function setSleepTimer(minutes) {
    clearSleepTimer();
    const value = Number(minutes);
    if (!value || value <= 0) {
      updateSleepUi();
      return;
    }
    sleep.deadline = Date.now() + value * 60000;
    sleep.timer = window.setTimeout(() => {
      pause();
      clearSleepTimer();
      toast("Minuteur écoulé — lecture mise en pause.", "info");
    }, value * 60000);
    sleep.tick = window.setInterval(updateSleepUi, 1000);
    document.querySelectorAll(".omni-sleep-btn[data-sleep]").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.sleep) === value);
    });
    updateSleepUi();
    toast(`Arrêt programmé dans ${value} min.`, "info");
  }

  function clearSleepTimer() {
    if (sleep.timer) window.clearTimeout(sleep.timer);
    if (sleep.tick) window.clearInterval(sleep.tick);
    sleep.timer = null;
    sleep.tick = null;
    sleep.deadline = 0;
    document.querySelectorAll(".omni-sleep-btn[data-sleep]").forEach((btn) => {
      btn.classList.remove("active");
    });
    updateSleepUi();
  }

  function updateSleepUi() {
    const status = $("omni-sleep-status");
    const offBtn = document.querySelector(".omni-sleep-off");
    const active = sleep.deadline > Date.now();
    if (offBtn) offBtn.hidden = !active;
    if (status) {
      if (active) {
        const remaining = Math.max(0, sleep.deadline - Date.now());
        const minutes = Math.floor(remaining / 60000);
        const seconds = Math.floor((remaining % 60000) / 1000);
        status.hidden = false;
        status.textContent = `Arrêt dans ${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
      } else {
        status.hidden = true;
      }
    }
  }

  /* ================================================================== *
   * Câblage des commandes (une seule fois, pour toute la session)
   * ================================================================== */
  function bindUi() {
    if (window.__omniPlayerBound) return;
    window.__omniPlayerBound = true;

    document.addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-omni-action]");
      if (!trigger) return;
      const action = trigger.getAttribute("data-omni-action");
      if (action === "toggle") toggle();
      else if (action === "next") playNextInQueue(true);
      else if (action === "prev") playPrevInQueue();
      else if (action === "expand") openModal();
      else if (action === "minimize") closeModal();
      else if (action === "stop" || action === "close") close();
      else if (action === "retry") startStream({ resumePosition: state.lastPosition || 0 });
      else if (action === "mode-audio") setMode("audio");
      else if (action === "mode-video") setMode("video");
      else if (action === "close-video") setMode("audio");
      else if (action === "sleep-cancel") clearSleepTimer();
      else if (action === "wake-lock") toggleWakeLock();
    });

    document.addEventListener("click", (event) => {
      const sleeper = event.target.closest("[data-sleep]");
      if (!sleeper) return;
      const minutes = Number(sleeper.dataset.sleep);
      if (minutes > 0) setSleepTimer(minutes);
      else clearSleepTimer();
    });

    // Barres de progression : clic + glissement, sur la barre comme sur la modale.
    ["omni-modal-progress", "omni-bar-progress"].forEach((id) => {
      const track = $(id);
      if (!track) return;
      const percentFrom = (event) => {
        const rect = track.getBoundingClientRect();
        if (!rect.width) return null;
        return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      };
      track.addEventListener("pointerdown", (event) => {
        state.dragging = true;
        const percent = percentFrom(event);
        if (percent !== null) previewSeek(track, percent);
        if (track.setPointerCapture) {
          try {
            track.setPointerCapture(event.pointerId);
          } catch (_error) {
            /* noop */
          }
        }
      });
      track.addEventListener("pointermove", (event) => {
        if (!state.dragging) return;
        const percent = percentFrom(event);
        if (percent !== null) previewSeek(track, percent);
      });
      const release = (event) => {
        if (!state.dragging) return;
        state.dragging = false;
        const percent = percentFrom(event);
        if (percent !== null) seekToPercent(percent);
      };
      track.addEventListener("pointerup", release);
      track.addEventListener("pointercancel", () => {
        state.dragging = false;
        render();
      });
    });

    // Fermeture : Échap (modale, puis overlay vidéo).
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const modal = $("omni-audio-modal");
      const overlay = $("global-video-overlay");
      if (modal && modal.classList.contains("open")) {
        closeModal();
        return;
      }
      if (overlay && overlay.classList.contains("open")) setMode("audio");
    });

    // Glisser-réduire sur le panneau agrandi (geste naturel sur téléphone).
    const grabber = $("omni-modal-grabber");
    if (grabber) {
      let startY = 0;
      let moving = false;
      grabber.addEventListener("pointerdown", (event) => {
        moving = true;
        startY = event.clientY;
        grabber.classList.add("dragging");
      });
      grabber.addEventListener("pointermove", (event) => {
        if (!moving) return;
        const delta = event.clientY - startY;
        grabber.style.transform = `translateY(${Math.max(0, delta)}px)`;
      });
      const end = (event) => {
        if (!moving) return;
        moving = false;
        const delta = event.clientY - startY;
        grabber.style.transform = "";
        grabber.classList.remove("dragging");
        if (delta > 64) closeModal();
      };
      grabber.addEventListener("pointerup", end);
      grabber.addEventListener("pointercancel", () => {
        moving = false;
        grabber.style.transform = "";
        grabber.classList.remove("dragging");
      });
    }

    // Changement d'onglet / déverrouillage : on ne coupe jamais le son, on
    // resynchronise seulement l'affichage.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        saveResumePoint();
        startKeepAlive();
        return;
      }
      if (wake.wanted) applyWakeLock();
      stopKeepAlive();
      if (state.status === "playing" || state.status === "paused") {
        if (state.status === "playing") startProgress();
        tick();
        setMediaSessionState(state.status === "playing" ? "playing" : "paused");
      }
    });

    // Cycle de vie (gel d'onglet par Android) : réveil = resynchro.
    window.addEventListener("pageshow", () => {
      if (wake.wanted) applyWakeLock();
      if (state.current) {
        showBar();
        render();
      }
    });
    document.addEventListener("resume", () => {
      if (state.status === "playing") {
        setMediaSessionState("playing");
        startProgress();
      }
    });

    // Retour du réseau : on lance ce qui était en attente.
    window.addEventListener("online", () => {
      if (state.waitingNetwork) {
        state.waitingNetwork = false;
        toast("Connexion rétablie — lecture en cours.", "ok");
        startStream({ resumePosition: 0 });
        return;
      }
      if (state.status === "error") {
        toast("Connexion rétablie — nouvelle tentative.", "ok");
        startStream({ resumePosition: state.lastPosition || 0 });
      }
    });
    window.addEventListener("offline", () => {
      if (!state.current) return;
      if (state.status === "playing") return; // la lecture en cours continue
      state.waitingNetwork = true;
      setStatus("offline", "Hors ligne — impossible de charger le flux.");
    });

    // Au déchargement, on mémorise la position pour reprendre à l'identique.
    window.addEventListener("pagehide", () => {
      if (state.status === "playing" || state.status === "paused") saveResumePoint();
    });
  }

  function previewSeek(track, percent) {
    const fill = track.querySelector("[data-fill]");
    if (fill) fill.style.width = `${percent * 100}%`;
  }

  /* ================================================================== *
   * Reprise de la dernière lecture (après rechargement de page)
   * ================================================================== */
  function restoreLastTrack() {
    restoreQueue();
    if (state.current || state.status !== "idle") return; // une lecture tourne déjà
    try {
      const raw = localGet(LAST_KEY);
      if (!raw) return;
      const track = JSON.parse(raw);
      if (!track || !isValidId(track.id)) return;
      state.current = {
        id: String(track.id),
        title: String(track.title || "Lecture en cours"),
        channel: String(track.channel || "OmniStream"),
        thumbnail: String(track.thumbnail || ""),
      };
      state.mode = track.mode === "video" ? "video" : "audio";
      showBar();
      if (isOffline()) {
        state.waitingNetwork = true;
        setStatus("offline", "Hors ligne — lecture dès le retour du réseau.");
      } else {
        setStatus("paused", "Touchez ▶ pour reprendre.");
      }
      render();
    } catch (_error) {
      /* noop */
    }
  }

  // API publique
  window.OmniPlayer = {
    play,
    pause,
    resume,
    toggle,
    stop: close,
    close,
    setMode,
    setQueue,
    next: () => playNextInQueue(true),
    prev: playPrevInQueue,
    setSleepTimer,
    clearSleepTimer,
    getCurrent: () => state.current,
    getStatus: () => state.status,
    isPlaying: () => state.status === "playing",
    showBar,
    render,
  };

  function init() {
    wake.wanted = localGet("omni:wake-lock") === "1";
    renderWakeLock();
    bindUi();
    render();
    restoreLastTrack();
    // Le lecteur YouTube ne se charge qu'à la première demande : aucun octet
    // dépensé pour un visiteur qui n'écoute rien.
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
