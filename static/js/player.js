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

  // Mode audio « MP3 » : le son est servi SANS la piste vidéo (vrai flux audio
  // seul, ~128 kbps ≈ 1 Mo/min au lieu de 10-20 Mo/min pour un clip vidéo).
  // Les métadonnées de flux sont demandées à des instances publiques
  // Piped/Invidious ; en cas d'échec complet, on retombe sur le lecteur
  // YouTube en qualité minimale — le titre se lance toujours.
  const AUDIO_STREAM_KEY = "omni:audio-stream";
  const AUDIO_FALLBACK_COOLDOWN = 10 * 60 * 1000; // 10 min avant de réessayer
  const AUDIO_PROVIDERS = [
    { kind: "piped", url: (id) => `https://pipedapi.kavin.rocks/streams/${id}` },
    { kind: "piped", url: (id) => `https://pipedapi.adminforge.de/streams/${id}` },
    { kind: "piped", url: (id) => `https://pipedapi.ducks.party/streams/${id}` },
    { kind: "piped", url: (id) => `https://pipedapi.leptons.xyz/streams/${id}` },
    { kind: "piped", url: (id) => `https://pipedapi.reallyaweso.me/streams/${id}` },
    { kind: "invidious", url: (id) => `https://inv.nadeko.net/api/v1/videos/${id}` },
    { kind: "invidious", url: (id) => `https://yewtu.be/api/v1/videos/${id}` },
    { kind: "invidious", url: (id) => `https://invidious.f5.si/api/v1/videos/${id}` },
  ];

  const state = {
    apiStatus: "idle", // idle | loading | ready | error
    player: null,
    playerReady: false,
    pendingTrack: null,
    current: null, // {id,title,channel,thumbnail}
    mode: "audio", // audio = flux MP3 économe · video = YouTube plein écran
    transport: "yt", // "yt" = lecteur YouTube · "audio" = flux audio seul
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

  // Maintien de la lecture en arrière-plan. Sur Android, c'est l'élément
  // <audio> réel, rattaché au DOM, qui garde la session audio vivante écran
  // éteint : aucun artefact (oscillateur silencieux) n'est nécessaire et ne
  // risque de voler le focus audio. `keepAlive.active` mémoire simplement
  // l'état, et `system` pilote la reprise automatique après une coupure de
  // l'OS (perte de focus, écran éteint).
  const keepAlive = { active: false, timer: null, announced: false };
  const system = { suppressAutoResume: false, resumeAttempts: 0 };
  // Le minuteur seul ne suffit pas : Android gèle les timer() d'une page
  // masquée. Les événements média, eux, continuent d'arriver — c'est donc
  // <audio> qui tient la notification (timeupdate ci-dessous), et ce filet
  // périodique ne fait que rattraper les coupures de l'OS.
  let lastNotifiedAt = -10;

  // Transport audio seul (élément <audio> natif + flux audio YouTube).
  const audioT = {
    el: null,
    url: "",
    abort: null,
    resolving: false,
    failedAt: 0,
    providerIndex: -1,
  };

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

  // Un titre « MP3 libre » n'a pas d'identifiant YouTube : c'est un fichier.
  // Distinction capitale : seul le fichier lu par l'élément <audio> natif
  // continue écran éteint (le lecteur YouTube se met en pause dès que la page
  // passe en arrière-plan, et ses conditions l'interdisent de toute façon),
  // et seul lui peut être enregistré sur le téléphone.
  function isMp3Track(track) {
    return Boolean(
      track &&
        (track.kind === "mp3" ||
          (typeof track.url === "string" &&
            /^https:\/\//.test(track.url) &&
            !isValidId(track.id))),
    );
  }

  function isPlayable(track) {
    return Boolean(track) && (isValidId(track.id) || isMp3Track(track));
  }

  // Un MP3 téléchargé progressivement n'a pas toujours d'en-tête de durée :
  // `el.duration` vaut alors Infinity ou NaN. Sans durée connue, la barre
  // reste à 0 % et tout déplacement devient impossible — le symptôme « le
  // trait brillant n'apparaît pas, je ne peux ni avancer ni revenir en
  // arrière ». On retombe donc sur la durée annoncée par la source.
  function knownDuration() {
    return Number(state.current && state.current.duration) || 0;
  }

  function resolveDuration(value) {
    const live = Number(value);
    if (live > 0 && Number.isFinite(live)) return live;
    return knownDuration();
  }

  function toast(message, kind) {
    try {
      if (window.OmniUI && window.OmniUI.toast) window.OmniUI.toast(message, kind || "info");
    } catch (_error) {
      /* noop */
    }
  }

  // La cause la plus fréquente d'une coupure à l'extinction de l'écran est
  // l'optimisation de la batterie du téléphone, pas le code. Le conseil
  // n'est posé que le jour où la coupure se produit réellement (et une seule
  // fois par appareil) : avant, il apparaissait à la première lecture, au
  // moment exact où l'utilisateur n'avait encore rien constaté.
  function maybeShowBackgroundAudioTip() {
    try {
      if (window.localStorage.getItem("omni:bg-audio-tip")) return;
      window.localStorage.setItem("omni:bg-audio-tip", "1");
    } catch (_error) {
      return;
    }
    toast(
      "Le téléphone coupe le son écran éteint (économie de batterie). " +
        "Réglages > Applications > Chrome ou OmniStream > Batterie > " +
        "« Illimitée ». L'option « Écran allumé » du lecteur évite aussi " +
        "l'extinction, et les titres « MP3 libre » sont les plus fiables.",
      "info",
    );
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

  // Options du lecteur YouTube selon le mode. En audio, YouTube n'est qu'un
  // secours : on demande la plus petite qualité (vq=small, 240p) pour que la
  // bascule ne fasse pas exploser la consommation de données.
  function playerVarsForMode() {
    const vars = {
      autoplay: 1,
      playsinline: 1,
      controls: 1,
      disablekb: 1,
      modestbranding: 1,
      rel: 0,
      iv_load_policy: 3,
      origin: window.location.origin,
    };
    if (state.mode === "audio") {
      vars.controls = 0;
      vars.vq = "small"; // qualité minimale : le son reste bon (~96-128 kbps)
    }
    return vars;
  }

  function createPlayer() {
    if (state.player || !window.YT || !window.YT.Player) return;
    const host = $("global-yt-host");
    if (!host) return;
    try {
      state.player = new window.YT.Player("global-yt-host", {
        height: "100%",
        width: "100%",
        playerVars: playerVarsForMode(),
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

  // Reconstruit le lecteur YouTube après un changement de mode : les options
  // « vq=small » de l'audio ne doivent jamais brider la vidéo plein écran.
  function rebuildYouTubePlayer() {
    if (state.player && typeof state.player.destroy === "function") {
      try {
        state.player.destroy();
      } catch (_error) {
        /* noop */
      }
    }
    state.player = null;
    state.playerReady = false;
    state.pendingTrack = null;
    createPlayer();
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
   * Flux AUDIO SEUL (mode MP3 / économiseur de Mo)
   * ================================================================== *
   * Le son d'un titre YouTube est téléchargé sans la piste vidéo : un vrai
   * flux audio (~1 Mo/min à 128 kbps), exactement comme un fichier MP3, et
   * avec la QUALITÉ SONORE COMPLÈTE du titre (la piste audio est servie
   * telle quelle par YouTube). Les métadonnées de flux sont demandées à des
   * instances publiques Piped/Invidious (aucune clé, aucun compte) ; en cas
   * d'indisponibilité, on retombe sur le lecteur YouTube en qualité minimale
   * — le titre se lance toujours, quoi qu'il arrive.
   * ------------------------------------------------------------------ */
  function pickAudioStream(data, kind) {
    const list = kind === "piped"
      ? data && Array.isArray(data.audioStreams) ? data.audioStreams : []
      : data && Array.isArray(data.adaptiveFormats)
        ? data.adaptiveFormats.filter((f) => /^audio\//.test(String(f.type || "")))
        : [];
    if (!list.length) return null;
    let best = null;
    let bestScore = -1;
    for (let index = 0; index < list.length; index += 1) {
      const stream = list[index];
      if (!stream || typeof stream.url !== "string" || !stream.url) continue;
      const mime = String(stream.mimeType || stream.type || "");
      const bitrate = Number(stream.bitrate) || 0;
      let score = 0;
      if (/audio\/mp4/.test(mime)) score += 100; // AAC 128 kbps ≈ MP3
      if (/opus/.test(mime)) score += 90;
      if (bitrate >= 96000 && bitrate <= 200000) score += 40; // 96-160 kbps
      else if (bitrate > 0 && bitrate < 96000) score += 10;
      if (score > bestScore) {
        bestScore = score;
        best = stream;
      }
    }
    if (!best) return null;
    return {
      url: best.url,
      mime: String(best.mimeType || best.type || "audio/mp4").split(";")[0].trim() || "audio/mp4",
    };
  }

  function readAudioStreamCache(videoId) {
    try {
      const raw = window.localStorage.getItem(AUDIO_STREAM_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || data.id !== videoId) return null;
      if (Date.now() - Number(data.at || 0) > 45 * 60 * 1000) return null;
      return data.url || null;
    } catch (_error) {
      return null;
    }
  }

  function writeAudioStreamCache(videoId, url) {
    try {
      window.localStorage.setItem(AUDIO_STREAM_KEY, JSON.stringify({ id: videoId, url, at: Date.now() }));
    } catch (_error) {
      /* quota atteint : la lecture reste possible sans cache */
    }
  }

  // Interroge les fournisseurs dans l'ordre (le dernier qui a marché d'abord),
  // avec un délai court par instance, et s'arrête au premier flux valide.
  async function resolveAudioStreamUrl(videoId, signal) {
    const cached = readAudioStreamCache(videoId);
    if (cached) return cached;
    const order = [];
    for (let index = 0; index < AUDIO_PROVIDERS.length; index += 1) {
      if (index === audioT.providerIndex) order.unshift(index);
      else order.push(index);
    }
    for (let position = 0; position < order.length; position += 1) {
      const provider = AUDIO_PROVIDERS[order[position]];
      if (signal && signal.aborted) return null;
      const ctrl = new AbortController();
      const onOuterAbort = () => ctrl.abort();
      if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
      const timer = window.setTimeout(() => ctrl.abort(), 8000);
      try {
        const response = await fetch(provider.url(videoId), {
          headers: { Accept: "application/json" },
          signal: ctrl.signal,
        });
        if (!response.ok) continue;
        const data = await response.json();
        const picked = pickAudioStream(data, provider.kind);
        if (picked && picked.url) {
          audioT.providerIndex = order[position];
          writeAudioStreamCache(videoId, picked.url);
          return picked.url;
        }
      } catch (_error) {
        /* fournisseur injoignable : on essaie le suivant */
      } finally {
        window.clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onOuterAbort);
      }
    }
    return null;
  }

  // Hôte discret rattaché au <body> : un <audio> présent dans le DOM garde sa
  // session audio active sur Android (et donc la lecture continue écran
  // éteint), contrairement à un élément flottant créé par `new Audio()`.
  function ensureAudioHost() {
    let host = document.getElementById("omni-audio-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "omni-audio-host";
      host.hidden = true;
      host.setAttribute("aria-hidden", "true");
      document.body.appendChild(host);
    }
    return host;
  }

  function ensureAudioElement() {
    if (audioT.el) return audioT.el;
    const el = new Audio();
    // "auto" et non "none" : sans mise en mémoire anticipée, la moindre
    // lenteur du réseau vidé la fin du morceau et Android coupait la lecture
    // (le symptôme « la musique s'arrête au bout de quelques minutes »).
    el.preload = "auto";
    el.setAttribute("playsinline", "");
    el.addEventListener("playing", () => setStatus("playing"));
    el.addEventListener("pause", () => {
      if (state.status !== "error" && state.status !== "offline") setStatus("paused");
      saveResumePoint();
      // Pause NON volontaire alors que l'écran est éteint : l'OS (perte de
      // focus audio, gestion de la batterie) vient de couper le son. On tente
      // une reprise automatique bornée — jamais après une pause utilisateur
      // ou la minuterie de sommeil (system.suppressAutoResume). C'est
      // exactement le moment où le conseil « Batterie > Illimitée » devient
      // utile, donc c'est ici (et non à la première lecture) qu'il s'affiche.
      if (document.hidden && !system.suppressAutoResume && state.status === "paused") {
        scheduleBackgroundResume();
        maybeShowBackgroundAudioTip();
      }
    });
    el.addEventListener("ended", () => {
      localRemoveResume();
      if (!playNextInQueue(false)) setStatus("paused", "File terminée.");
    });
    el.addEventListener("waiting", () => {
      if (state.status === "playing" || state.status === "loading") {
        setStatus("loading", document.hidden ? "Remise en mémoire écran éteint…" : "");
        if (document.hidden) scheduleBackgroundResume();
      }
    });
    el.addEventListener("stalled", () => {
      if (state.status !== "playing") return;
      setStatus("loading", "Réseau lent : la suite se met en mémoire…");
      if (document.hidden) scheduleBackgroundResume();
    });
    // En arrière-plan, le minuteur de la page est gelé et tick() ne tourne
    // plus : ce sont les événements média qui tiennent la notification à jour,
    // et c'est eux qui prouvent à Android que la lecture est toujours active.
    el.addEventListener("timeupdate", () => {
      if (!document.hidden) return; // l'onglet visible a déjà son minuteur
      const now = Number(el.currentTime) || 0;
      state.lastDuration = resolveDuration(el.duration) || state.lastDuration;
      if (Math.abs(now - lastNotifiedAt) < 4) return;
      lastNotifiedAt = now;
      setPositionState(now, state.lastDuration);
      if (state.status === "playing") saveResumePoint();
    });
    el.addEventListener("error", () => {
      if (state.status === "loading" || state.status === "playing") onAudioStreamError();
    });
    // Durée annoncée par la source : connue avant même la première seconde, la
    // barre et le pourcentage sont justes dès le départ (et non après 30 s).
    el.addEventListener("durationchange", () => {
      state.lastDuration = resolveDuration(el.duration) || state.lastDuration;
      tick();
    });
    // Position de reprise : dès que la durée est connue, on se recale.
    el.addEventListener("loadedmetadata", () => {
      const resumeAt = state.resumeTime || 0;
      state.resumeTime = 0;
      if (resumeAt > 0 && el.duration && el.duration > resumeAt + 2) {
        try {
          el.currentTime = resumeAt;
        } catch (_error) {
          /* noop */
        }
      }
    });
    // Rattachement au DOM : condition indispensable pour que le navigateur
    // reconnaisse une vraie lecture média et la maintienne écran éteint.
    try {
      ensureAudioHost().appendChild(el);
    } catch (_error) {
      /* le DOM peut manquer pendant le préchargement : sans gravité */
    }
    audioT.el = el;
    return el;
  }

  // Les liens de Jamendo sont signés et vivent quelques minutes : un morceau
  // repris depuis la barre du lecteur après une longue pause peut refuser
  // de s'ouvrir alors que le titre, lui, reste libre. Le relais du serveur,
  // qui résout une adresse fraîche à la demande, mérite une tentative avant
  // de déclarer la panne. En passage hors ligne, c'est d'ailleurs le seul chemin.
  function retryThroughRelay() {
    const track = state.current;
    if (!track || track.kind !== "mp3" || track.__omniRelayed) return false;
    const relay = String(track.download || "").split("?")[0];
    if (!relay.startsWith("/mp3/")) return false;
    const el = audioT.el;
    if (!el || el.src.indexOf(relay) !== -1) return false;
    track.__omniRelayed = true;
    audioT.url = relay;
    el.src = relay;
    setStatus("loading", "Nouveau lien du morceau…");
    el.play().catch(() => undefined);
    return true;
  }

  function onAudioStreamError() {
    if (retryThroughRelay()) return;
    if (state.current && state.current.kind === "mp3") {
      if (isOffline()) {
        state.waitingNetwork = true;
        setStatus("offline", "Hors ligne — titre non enregistré sur le téléphone.");
        return;
      }
      state.error = "Le fichier audio n'a pas pu être ouvert.";
      setStatus("error");
      toast(state.error, "warn");
      return;
    }
    state.error = "Le flux audio n'a pas pu démarrer.";
    setStatus("error");
    if (!playNextInQueue(true)) {
      toast(state.error, "warn");
    }
  }

  function stopAudioTransport() {
    // Arrêt volontaire : aucune reprise automatique ne doit suivre.
    system.suppressAutoResume = true;
    if (audioT.abort) {
      try {
        audioT.abort.abort();
      } catch (_error) {
        /* noop */
      }
      audioT.abort = null;
    }
    if (audioT.el) {
      try {
        audioT.el.pause();
        audioT.el.removeAttribute("src");
        audioT.el.load();
      } catch (_error) {
        /* noop */
      }
    }
    audioT.url = "";
    audioT.resolving = false;
    if (state.transport === "audio") state.transport = "yt";
  }

  // Lance le flux audio seul ; en cas d'échec complet, retombe sur YouTube
  // (qualité minimale) pour que le titre se lance quand même.
  async function startAudioStream(track, options) {
    const opts = options || {};
    if (!track || !isValidId(track.id)) return;
    if (isOffline()) {
      state.waitingNetwork = true;
      setStatus("offline", "Hors ligne — lecture dès le retour du réseau.");
      return;
    }
    // Après un échec récent, on ne martèle pas les instances : on passe
    // directement au secours YouTube pendant quelques minutes.
    if (Date.now() - audioT.failedAt < AUDIO_FALLBACK_COOLDOWN) {
      startYouTubeFallback(track, opts);
      return;
    }
    if (audioT.abort) {
      try {
        audioT.abort.abort();
      } catch (_error) {
        /* noop */
      }
    }
    audioT.abort = new AbortController();
    audioT.resolving = true;
    setStatus("loading", "Préparation du flux audio…");
    try {
      const url = await resolveAudioStreamUrl(String(track.id), audioT.abort.signal);
      // Un autre titre a été lancé pendant la résolution : on abandonne.
      if (!state.current || state.current.id !== String(track.id)) return;
      // Résolution annulée (pause pendant la préparation) : on ne relance rien.
      if (audioT.abort === null || audioT.abort.signal.aborted) {
        setStatus("paused");
        return;
      }
      if (!url) {
        audioT.failedAt = Date.now();
        toast("Flux audio indisponible — bascule en mode économe.", "info");
        startYouTubeFallback(track, opts);
        return;
      }
      const el = ensureAudioElement();
      el.src = url;
      audioT.url = url;
      state.transport = "audio";
      if (opts.resumePosition) state.resumeTime = opts.resumePosition;
      try {
        await el.play();
        // L'événement « playing » posera l'état ; si l'autoplay est refusé,
        // on invite à toucher ▶ (comportement identique au lecteur YouTube).
      } catch (_error) {
        if (state.status !== "playing") setStatus("paused", "Touchez ▶ pour démarrer la lecture.");
      }
    } catch (_error) {
      if (state.current && state.current.id === String(track.id)) {
        audioT.failedAt = Date.now();
        startYouTubeFallback(track, opts);
      }
    } finally {
      audioT.resolving = false;
    }
  }

  // Titre issu d'une phonothèque MP3 : aucune instance à interroger, le
  // fichier EST le flux. C'est le seul chemin qui garantisse la lecture
  // écran éteint, la reprise sur l'écran verrouillé et l'enregistrement.
  async function playFileTrack(track, options) {
    const opts = options || {};
    if (!track || typeof track.url !== "string" || !track.url) {
      setStatus("error", "Ce titre ne fournit pas de fichier audio.");
      return;
    }
    if (audioT.abort) {
      try {
        audioT.abort.abort();
      } catch (_error) {
        /* noop */
      }
      audioT.abort = null;
    }
    const el = ensureAudioElement();
    lastNotifiedAt = -10;
    if (audioT.url !== track.url) {
      audioT.url = track.url;
      el.src = track.url;
    }
    state.transport = "audio";
    state.current.url = track.url;
    if (opts.resumePosition) state.resumeTime = opts.resumePosition;
    setStatus(
      "loading",
      isOffline()
        ? "Lecture depuis la mémoire du téléphone…"
        : "Ouverture du fichier MP3…",
    );
    try {
      await el.play();
      setMediaSessionMetadata();
    } catch (_error) {
      if (isOffline()) {
        // Épinglé, le fichier sort du cache du Service Worker ; sinon le
        // morceau est perdu jusqu'au retour du réseau.
        state.waitingNetwork = true;
        setStatus("offline", "Hors ligne — enregistrez le titre pour l'écouter sans réseau.");
        return;
      }
      if (state.status !== "playing") setStatus("paused", "Touchez ▶ pour démarrer la lecture.");
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
      let blocked = true;
      if (state.transport === "audio") {
        const el = audioT.el;
        blocked = !el || el.paused || el.readyState < 2;
      } else if (state.player && typeof state.player.getPlayerState === "function") {
        blocked = state.player.getPlayerState() !== 1;
      }
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
    if (!isPlayable(track)) return;
    const asFile = isMp3Track(track);
    // Un fichier n'a pas de piste vidéo : inutile de promettre un plein écran.
    if (asFile) state.mode = "audio";
    else if (mode === "video" || mode === "audio") state.mode = mode;
    // Nouvelle lecture : on réarme la reprise automatique et le compteur.
    system.suppressAutoResume = false;
    system.resumeAttempts = 0;
    state.current = {
      id: String(track.id),
      title: String(track.title || "Lecture en cours"),
      channel: String(track.channel || "OmniStream"),
      thumbnail: String(track.thumbnail || ""),
      kind: asFile ? "mp3" : "yt",
      url: typeof track.url === "string" ? track.url : "",
      page: typeof track.page === "string" ? track.page : "",
      download: typeof track.download === "string" ? track.download : "",
      album: String(track.album || ""),
      size: Number(track.size) || 0,
      duration: Number(track.duration) || 0,
    };
    if (asFile) state.resumeTime = 0;
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
    if (state.current.kind === "mp3") {
      playFileTrack(state.current, opts);
      return;
    }
    if (state.mode === "audio") {
      // MP3 : flux audio seul (consommation ~1 Mo/min, son complet).
      startAudioStream(state.current, opts);
      return;
    }
    startYouTubeFallback(state.current, opts);
  }

  // Secours / mode vidéo : lecteur YouTube classique, chargé paresseusement.
  function startYouTubeFallback(track, options) {
    const opts = options || {};
    // Le transport actif devient YouTube (un flux audio seul qui tournait est
    // de toute façon arrêté par le chargement d'une vidéo).
    stopAudioTransport();
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
          realLoad(track);
        } else {
          state.pendingTrack = Object.assign({}, track, {
            startAt: opts.resumePosition || 0,
          });
          setStatus("loading", "Préparation du flux…");
        }
      });
      return;
    }
    if (opts.resumePosition) state.resumeTime = opts.resumePosition;
    realLoad(track);
  }

  function setQueue(list, index) {
    if (!Array.isArray(list)) return;
    state.queue = list.filter((track) => isPlayable(track));
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
    const canSeek = state.transport === "audio" ? Boolean(audioT.el) : Boolean(state.player);
    if (state.lastPosition > 3 && canSeek) {
      transportSeek(0);
      return true;
    }
    const prev = state.queueIndex - 1;
    if (prev < 0) return false;
    return playAt(prev, true);
  }

  // Seek générique (audio seul ou lecteur YouTube).
  function transportSeek(target) {
    if (state.transport === "audio") {
      const el = audioT.el;
      if (!el) return;
      try {
        el.currentTime = Math.max(0, target || 0);
      } catch (_error) {
        /* noop */
      }
      return;
    }
    if (state.player && typeof state.player.seekTo === "function") {
      try {
        state.player.seekTo(target || 0, true);
      } catch (_error) {
        /* noop */
      }
    }
  }

  /* ================================================================== *
   * Transport
   * ================================================================== */
  function pause() {
    // Pause volontaire (bouton, minuterie de sommeil, touche du clavier) :
    // la reprise automatique doit rester inactive tant qu'on n'a pas relancé.
    system.suppressAutoResume = true;
    if (state.transport === "audio") {
      if (audioT.el && !audioT.el.paused) {
        try {
          audioT.el.pause();
        } catch (_error) {
          /* noop */
        }
      } else if (state.status === "loading" && audioT.abort) {
        // Pause pendant la préparation du flux : on annule la résolution,
        // sinon la musique démarrerait malgré tout dès la réponse reçue.
        try {
          audioT.abort.abort();
        } catch (_error) {
          /* noop */
        }
        audioT.abort = null;
      }
    } else if (state.player && typeof state.player.pauseVideo === "function") {
      try {
        state.player.pauseVideo();
      } catch (_error) {
        /* noop */
      }
    }
    saveResumePoint();
    // Bascule immédiate de l'icône : l'événement du lecteur peut traîner
    // d'un demi-segment sur une connexion 3G.
    if (state.status === "playing") setStatus("paused");
  }

  function resume() {
    // Reprise explicite : on réarme la reprise automatique pour la prochaine
    // coupure éventuelle de l'OS.
    system.suppressAutoResume = false;
    if (isOffline()) {
      state.waitingNetwork = true;
      setStatus("offline", "Hors ligne — lecture dès le retour du réseau.");
      return;
    }
    if (!state.current) return;
    if (state.transport === "audio") {
      if (audioT.el && audioT.el.src) {
        setStatus("loading", "Reprise…");
        try {
          const promise = audioT.el.play();
          if (promise && typeof promise.catch === "function") {
            promise.catch(() => {
              if (state.status !== "playing") {
                setStatus("paused", "Touchez ▶ pour démarrer la lecture.");
              }
            });
          }
          armStartWatchdog();
          return;
        } catch (_error) {
          /* on repasse par un chargement complet */
        }
      }
      startStream({ resumePosition: readResumePoint() });
      return;
    }
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
    stopAudioTransport();
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
    if (mode === "video" && state.current && state.current.kind === "mp3") {
      // Rien à cacher : un MP3 n'a pas d'image, et le chercher sur YouTube
      // serait un autre titre.
      toast("Ce titre n'existe qu'en MP3 : pas de clip vidéo à afficher.", "info");
      render();
      return;
    }
    if (state.mode === mode && mode === "audio") {
      closeVideo();
      render();
      return;
    }
    const changed = state.mode !== mode;
    state.mode = mode;
    if (changed) {
      // Bascule propre de transport : on libère l'ancien et on relance le
      // titre courant dans le nouveau, à la position où on en était.
      if (mode === "audio") {
        if (state.player && typeof state.player.stopVideo === "function") {
          try {
            state.player.stopVideo();
          } catch (_error) {
            /* noop */
          }
        }
        rebuildYouTubePlayer();
        if (state.current) {
          startAudioStream(state.current, { resumePosition: state.lastPosition || 0 });
        }
      } else {
        stopAudioTransport();
        rebuildYouTubePlayer();
        if (state.current) {
          startYouTubeFallback(state.current, { resumePosition: state.lastPosition || 0 });
        }
      }
    }
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
      if (state.transport === "audio") {
        if (audioT.el) {
          const live = audioT.el.currentTime;
          if (live > 0) time = live;
        }
      } else if (state.player && typeof state.player.getCurrentTime === "function") {
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
    let duration = 0;
    let current = 0;
    if (state.transport === "audio") {
      const el = audioT.el;
      if (!el) return;
      try {
        duration = resolveDuration(el.duration);
        current = el.currentTime || 0;
      } catch (_error) {
        return;
      }
    } else {
      const player = state.player;
      if (!player || typeof player.getCurrentTime !== "function") return;
      try {
        duration = player.getDuration() || 0;
        current = player.getCurrentTime() || 0;
      } catch (_error) {
        return;
      }
    }
    state.lastPosition = current;
    state.lastDuration = duration;
    if (state.dragging) return;
    const percent = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
    updateProgressUi(percent);
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

  function updateProgressUi(percent) {
    const fill = $("omni-bar-progress-fill");
    const modalFill = $("omni-modal-progress-fill");
    if (fill) fill.style.width = `${percent}%`;
    if (modalFill) modalFill.style.width = `${percent}%`;
  }

  function fmtTime(seconds) {
    const value = Math.max(0, Math.floor(seconds || 0));
    const minutes = Math.floor(value / 60);
    const rest = value % 60;
    return `${minutes}:${rest < 10 ? "0" : ""}${rest}`;
  }

  function seekToPercent(percent) {
    const clamped = Math.max(0, Math.min(1, percent));
    const pct = clamped * 100;
    if (state.transport === "audio") {
      const el = audioT.el;
      if (!el) return;
      const duration = resolveDuration(el.duration);
      if (duration <= 0) {
        // Un refus silencieux ressemble à un bouton cassé : on le dit.
        if (window.OmniUI) {
          window.OmniUI.toast(
            "Durée du fichier inconnue : impossible de se déplacer pour l'instant.",
            "info",
          );
        }
        render();
        return;
      }
      try {
        el.currentTime = duration * clamped;
        state.lastPosition = el.currentTime || duration * clamped;
        state.lastDuration = duration;
        updateProgressUi(pct);
        setPositionState(state.lastPosition, duration);
      } catch (_error) {
        if (window.OmniUI) window.OmniUI.toast("Ce passage n'est pas encore chargé.", "warn");
      }
      return;
    }
    const player = state.player;
    if (!player || typeof player.getDuration !== "function") return;
    let duration = 0;
    try {
      duration = player.getDuration() || 0;
    } catch (_error) {
      return;
    }
    if (duration <= 0) return;
    const target = duration * clamped;
    try {
      player.seekTo(target, true);
      state.lastPosition = target;
      updateProgressUi(pct);
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
        : track && track.kind === "mp3"
          ? "MP3 LIBRE · ÉCRAN ÉTEINT ET HORS LIGNE"
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
      ytLink.href =
        track.kind === "mp3"
          ? track.page || "#"
          : `https://www.youtube.com/watch?v=${track.id}`;
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
    const target = Math.max(0, (state.lastDuration ? state.lastPosition : 0) + delta);
    if (state.transport === "audio") {
      const el = audioT.el;
      if (!el) return;
      try {
        el.currentTime = target;
      } catch (_error) {
        /* noop */
      }
      return;
    }
    if (!state.player || typeof state.player.seekTo !== "function") return;
    try {
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
  // Android. Ici le « gardien » est l'élément <audio> réel, rattaché au DOM
  // et en cours de lecture : c'est lui, avec l'état MediaSession réaffirmé,
  // qui garde la session audio éveillée sans aucun artefact sonore. On ne
  // crée surtout pas d'oscillateur silencieux : sur Chrome Android moderne
  // il n'empêche rien et peut perturber le focus audio.
  function startKeepAlive() {
    if (!document.hidden) {
      stopKeepAlive(); // inutile onglet visible
      return;
    }
    keepAlive.active = true;
    // Réaffirme que le lecteur est en lecture : Chrome conserve ainsi la
    // session média d'une PWA installée (lecture continue écran éteint).
    setMediaSessionState("playing");
    if (audioT.el && !audioT.el.parentNode) {
      try {
        ensureAudioHost().appendChild(audioT.el);
      } catch (_error) {
        /* noop */
      }
    }
    if (state.transport !== "audio" && !keepAlive.announced) {
      // Transport iframe : la coupure vient du lecteur YouTube lui-même, qui
      // se met en pause dès que la page est masquée. Le dire vaut mieux que
      // laisser croire que l'application est cassée.
      keepAlive.announced = true;
      setStatus(
        state.status,
        "Lecture via YouTube : l'arrière-plan n'est pas garanti. Les titres " +
          "« MP3 libre » de l'espace Musique, eux, continuent écran éteint.",
      );
    }
    if (!keepAlive.timer) {
      keepAlive.timer = window.setInterval(() => {
        if (!document.hidden) {
          stopKeepAlive();
          return;
        }
        if (state.status !== "playing" || system.suppressAutoResume) return;
        setMediaSessionState("playing");
        const el = audioT.el;
        if (state.transport === "audio" && el && el.paused && el.src) {
          el.play().catch(() => undefined);
        }
      }, 15000);
    }
  }

  function stopKeepAlive() {
    keepAlive.active = false;
    keepAlive.announced = false;
    if (keepAlive.timer) {
      window.clearInterval(keepAlive.timer);
      keepAlive.timer = null;
    }
  }

  // Reprise automatique après une coupure de l'OS (écran éteint, perte
  // temporaire de focus audio). Tentatives bornées et espacées pour ne pas
  // créer de boucle ; si le navigateur refuse, la reprise se fera au retour
  // de l'écran (voir visibilitychange).
  function scheduleBackgroundResume() {
    if (state.transport !== "audio") return; // l'iframe YouTube ne nous obéit pas
    if (system.resumeAttempts >= 24) return;
    system.resumeAttempts += 1;
    // Progression lente (2 s, 2 s, 2 s, 4 s, 4 s, 4 s, 6 s…) : assez souple
    // pour ne pas marteler le réseau, assez têtue pour passer une coupure
    // d'Android qui peut durer plusieurs dizaines de secondes.
    const wait = Math.min(2000 * (1 + Math.floor((system.resumeAttempts - 1) / 3)), 9000);
    window.setTimeout(() => {
      if (!document.hidden || system.suppressAutoResume || !state.current) return;
      if (state.status !== "playing" && state.status !== "paused" && state.status !== "loading") return;
      const el = audioT.el;
      if (!el || !el.paused || !el.src) return;
      setMediaSessionState("playing");
      el.play().catch(() => {
        /* Chrome peut refuser la reprise en arrière-plan : on la laisse au
           réveil de l'écran, le son n'est pas perdu pour autant. */
        if (state.status === "loading") scheduleBackgroundResume();
      });
    }, wait);
  }

  // Re-synchronise l'interface après un retour d'onglet : l'événement
  // YouTube a pu manquer pendant la mise en veille du téléphone.
  function startResync() {
    if (state.resyncTimer) return;
    state.resyncTimer = window.setInterval(() => {
      // En flux audio seul, les événements de l'élément <audio> suffisent.
      if (state.transport === "audio") return;
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
      else if (action === "retry") {
        // « Réessayer » relance aussi la résolution du flux audio seul.
        audioT.failedAt = 0;
        startStream({ resumePosition: state.lastPosition || 0 });
      }
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
        // Pendant le geste, la transition CSS ferait traîner le repère derrière
        // le doigt : on la coupe jusqu'à la fin du glissement.
        document.body.classList.add("seeking");
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
        document.body.classList.remove("seeking");
        const percent = percentFrom(event);
        if (percent !== null) seekToPercent(percent);
      };
      track.addEventListener("pointerup", release);
      track.addEventListener("pointercancel", () => {
        state.dragging = false;
        document.body.classList.remove("seeking");
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
      system.resumeAttempts = 0; // nouveau cycle de reprise possible
      if (state.status === "playing" || state.status === "paused") {
        // L'OS a pu couper le son pendant que l'écran était éteint : dès le
        // retour, on relance le flux si le lecteur est censé jouer.
        if (state.status === "playing" && state.transport === "audio") {
          const el = audioT.el;
          if (el && el.paused && el.src) {
            try {
              el.play();
            } catch (_error) {
              /* noop */
            }
          }
        }
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
      if (!isPlayable(track)) return;
      state.current = {
        id: String(track.id),
        title: String(track.title || "Lecture en cours"),
        channel: String(track.channel || "OmniStream"),
        thumbnail: String(track.thumbnail || ""),
        kind: track.kind === "mp3" ? "mp3" : "yt",
        url: typeof track.url === "string" ? track.url : "",
        page: typeof track.page === "string" ? track.page : "",
        download: typeof track.download === "string" ? track.download : "",
        album: String(track.album || ""),
        size: Number(track.size) || 0,
        duration: Number(track.duration) || 0,
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
