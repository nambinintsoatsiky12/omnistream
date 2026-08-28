/*
 * OmniStream — Page Musique
 * ------------------------------------------------------------------
 * Toute la lecture est déléguée au lecteur global (player.js) : la musique
 * continue quand on quitte la page, avec pause et contrôles sur l'écran
 * verrouillé. Cette page ne fait que chercher, afficher et piloter la file.
 *
 * Deux sources, parce qu'elles n'offrent pas la même chose :
 *  - « MP3 libre » : de vrais fichiers MP3 publiés sous licence de copie
 *    (Internet Archive). Seule source qui lise écran éteint, qui s'épingle hors
 *    ligne ET qui s'enregistre comme fichier sur le téléphone ;
 *  - « YouTube » : les clips, via l'iframe YouTube — lecture à l'écran, pas de
 *    téléchargement possible (les conditions de YouTube l'interdisent).
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
  const sourceToggle = document.getElementById("source-toggle");
  const sourceNote = document.getElementById("source-note");

  let requestController = null;
  let currentMode = "audio";
  let currentSource = "mp3";
  let lastQuery = "";
  let lastItems = [];

  const SOURCES = {
    mp3: {
      trending: "/api/mp3",
      search: (query) => `/api/mp3?q=${encodeURIComponent(query)}`,
      title: (query) => (query ? `MP3 libres pour « ${query} »` : "Nouveautés MP3 libres"),
      note:
        "Fichiers MP3 sous licence libre (Internet Archive) : la lecture continue écran " +
        "éteint et à l'écran verrouillé, la flèche les enregistre sur le téléphone, et un " +
        "titre épinglé se relit sans un seul Mo de forfait.",
    },
    youtube: {
      trending: "/api/musique-trending",
      search: (query) => `/api/musique-search?q=${encodeURIComponent(query)}`,
      title: (query) => (query ? `Résultats pour « ${query} »` : "🔥 Tendances du moment"),
      note:
        "Clips et sessions YouTube : l'image et le son, mais la lecture s'arrête quand " +
        "l'application est fermée et YouTube interdit d'enregistrer les fichiers. Pour du " +
        "MP3 vraiment libre, Choisis la source « MP3 libre ».",
    },
  };

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
      if (btn.disabled) {
        if (window.OmniUI) {
          window.OmniUI.toast("Un MP3 libre n'a pas de clip vidéo à afficher.", "info");
        }
        return;
      }
      setMode(btn.dataset.mode, true);
    });
  }
  setMode("audio", false);

  // Un fichier audio n'a pas de piste vidéo : griser le bouton vaut mieux que
  // promettre un plein écran vide.
  function applySourceToMode() {
    if (!modeToggle) return;
    modeToggle.querySelectorAll(".mode-btn").forEach((btn) => {
      const blocked = currentSource === "mp3" && btn.dataset.mode === "video";
      btn.disabled = blocked;
      btn.title = blocked
        ? "Les MP3 libres sont des fichiers audio : pas de clip."
        : "";
      btn.classList.toggle("is-blocked", blocked);
    });
  }

  function setSource(source) {
    currentSource = source === "youtube" ? "youtube" : "mp3";
    if (sourceToggle) {
      sourceToggle.querySelectorAll(".source-btn").forEach((btn) => {
        const on = btn.dataset.source === currentSource;
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-checked", String(on));
      });
    }
    if (sourceNote) sourceNote.textContent = SOURCES[currentSource].note;
    if (currentSource === "mp3") setMode("audio", false);
    applySourceToMode();
    try {
      window.localStorage.setItem("omni:music-source", currentSource);
    } catch (_error) {
      /* stockage indisponible : le choix vaut pour la visite */
    }
    load(lastQuery);
  }

  if (sourceToggle) {
    sourceToggle.addEventListener("click", (event) => {
      const btn = event.target.closest(".source-btn");
      if (!btn || btn.dataset.source === currentSource) return;
      setSource(btn.dataset.source);
    });
  }

  function load(query) {
    lastQuery = typeof query === "string" ? query.trim() : "";
    const config = SOURCES[currentSource];
    fetchAndRender(
      lastQuery ? config.search(lastQuery) : config.trending,
      config.title(lastQuery),
    );
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
    // File de lecture : les titres s'enchaînent tout seuls.
    window.OmniPlayer.setQueue(lastItems, index);
    // Un MP3 libre n'a qu'un seul mode possible ; les clips YouTube gardent
    // le choix Audio/Vidéo de l'utilisateur.
    window.OmniPlayer.play(item, item && item.kind === "mp3" ? "audio" : currentMode);
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

  function humanSize(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} Ko`;
    return `${(value / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
  }

  function humanDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    if (!total) return "";
    const minutes = Math.floor(total / 60);
    const rest = String(total % 60).padStart(2, "0");
    return `${minutes}:${rest}`;
  }

  function svgIcon(paths, size) {
    return (
      `<svg viewBox="0 0 24 24" width="${size || 15}" height="${size || 15}" fill="none" ` +
      `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
      `aria-hidden="true">${paths}</svg>`
    );
  }

  // Carte d'un fichier MP3 libre : même gabarit que les cartes YouTube, mais
  // avec la durée, le poids réel et un bouton qui enregistre le fichier.
  function createMp3Card(item, idx) {
    const card = document.createElement("div");
    card.className = "card musique-card musique-card-mp3";
    card.dataset.trackId = String(item.id);

    const poster = document.createElement("button");
    poster.type = "button";
    poster.className = "poster music-poster";
    poster.setAttribute("aria-label", `Écouter ${item.title || "ce titre"}`);
    poster.addEventListener("click", () => triggerPlay(item, idx));

    const source = safeImageUrl(item.thumbnail);
    if (source) {
      const image = document.createElement("img");
      image.className = "poster-img";
      image.src = source;
      image.alt = String(item.album || item.title || "");
      image.loading = "lazy";
      image.decoding = "async";
      poster.appendChild(image);
    } else {
      poster.classList.add("poster-placeholder");
      poster.textContent = "Pochette indisponible";
    }

    const overlay = document.createElement("span");
    overlay.className = "music-play-overlay";
    overlay.innerHTML =
      '<span class="music-play-circle"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></span>';
    poster.appendChild(overlay);

    const tag = document.createElement("span");
    tag.className = "quality-tag";
    tag.textContent = `MP3 · ${humanSize(item.size)}`;
    poster.appendChild(tag);

    const favItem = {
      type: "music",
      kind: "mp3",
      id: item.id,
      title: item.title,
      channel: item.channel,
      thumbnail: item.thumbnail,
      album: item.album,
      size: item.size,
      duration: item.duration,
      download: item.download,
      page: item.page,
      // Le Service Worker rapatrie ces URL : la fiche et le fichier lui-même.
      url: item.url,
    };

    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.className = "music-pin-btn";
    pinBtn.setAttribute("aria-label", "Garder le MP3 hors ligne");
    pinBtn.setAttribute("title", "Garder le MP3 hors ligne");
    pinBtn.innerHTML = svgIcon(
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>' +
        "<polyline points=\"7 10 12 15 17 10\"></polyline><line x1=\"12\" y1=\"15\" x2=\"12\" y2=\"3\"></line>",
    );
    pinBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!window.OmniLibrary) return;
      if (window.OmniLibrary.isOffline(favItem)) {
        window.OmniLibrary.removeOffline(favItem);
        if (window.OmniUI) window.OmniUI.toast("MP3 retiré du hors ligne.", "ok");
      } else {
        pinBtn.classList.add("busy");
        pinBtn.setAttribute("aria-busy", "true");
        if (window.OmniUI) {
          window.OmniUI.toast(
            `Enregistrement du MP3 (${humanSize(item.size)}) : gardez la page ouverte, ça télécharge…`,
            "info",
          );
        }
        // `saveOffline` attend la réponse du Service Worker : on ne promet plus
        // un morceau « enregistré » qui ne l'est pas — sur un forfait mobile,
        // 5 Mo peuvent demander une minute, et le reste de l'interface doit le
        // savoir pour ne pas mentir.
        const stored = await window.OmniLibrary.saveOffline(favItem);
        pinBtn.classList.remove("busy");
        pinBtn.removeAttribute("aria-busy");
        if (window.OmniUI) {
          window.OmniUI.toast(
            stored
              ? `MP3 enregistré (${humanSize(item.size)}) : il se relit même sans réseau.`
              : "Le fichier n'a pas pu être mis en cache (réseau instable). Réessayez, ou utilisez le bouton MP3.",
            stored ? "ok" : "warn",
          );
        }
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

    poster.append(favBtn, pinBtn);

    const info = document.createElement("div");
    info.className = "card-info";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = String(item.title || "Sans titre");
    const channel = document.createElement("div");
    channel.className = "card-meta-line";
    const artist = document.createElement("span");
    artist.className = "card-year";
    artist.textContent = String(item.channel || "Artiste");
    channel.appendChild(artist);
    info.append(title, channel);

    // Duree, poids, anne : de quoi juger la depense avant de lancer. Tout est
    // insere par textContent (les libelles viennent d'un service externe).
    const meta = document.createElement("div");
    meta.className = "card-meta-line mp3-meta-line";
    [humanDuration(item.duration), humanSize(item.size), String(item.year || "")]
      .filter(Boolean)
      .forEach((value, position) => {
        if (position > 0) {
          const dot = document.createElement("span");
          dot.className = "mp3-dot";
          dot.textContent = "·";
          meta.appendChild(dot);
        }
        const bit = document.createElement("span");
        bit.className = "mp3-meta";
        bit.textContent = value;
        meta.appendChild(bit);
      });
    if (meta.childNodes.length) info.append(meta);

    // Le fichier, cette fois : le lien passe par le relais du serveur qui lui
    // donne son nom et un « Content-Disposition » — sans lui, le navigateur
    // ouvrirait le MP3 dans un onglet au lieu de l'enregistrer.
    const download = document.createElement("a");
    download.className = "music-get-btn";
    download.href = item.download || item.url;
    download.setAttribute("download", "");
    download.dataset.noPjax = "1";
    download.target = "_blank";
    download.rel = "noopener";
    download.innerHTML = `${svgIcon(
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>' +
        "<polyline points=\"7 10 12 15 17 10\"></polyline><line x1=\"12\" y1=\"15\" x2=\"12\" y2=\"3\"></line>",
    )}<span>MP3</span>`;
    download.setAttribute(
      "aria-label",
      `Enregistrer ${item.title || "ce titre"} en MP3 (${humanSize(item.size)})`,
    );
    info.append(download);

    function refreshIcons() {
      const lib = window.OmniLibrary;
      const on = Boolean(lib && lib.isFavorite(favItem));
      favBtn.classList.toggle("on", on);
      favBtn.setAttribute("aria-pressed", String(on));
      favBtn.innerHTML = on
        ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06 1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06 1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
      const pinned = Boolean(lib && lib.isOffline(favItem));
      pinBtn.classList.toggle("on", pinned);
      pinBtn.setAttribute("aria-pressed", String(pinned));
    }
    refreshIcons();

    card.append(poster, info);
    card.dataset.refreshIcons = "1";
    card.__refreshIcons = refreshIcons;
    return card;
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
    const list = Array.isArray(items) ? items : [];
    // Les MP3 sont repérés par « kind », les clips YouTube par leur identifiant
    // de 11 caractères : mélanger les deux dans une seule grille est possible,
    // mais chaque carte garde ses propres boutons.
    lastItems = list.filter(
      (item) =>
        item &&
        (item.kind === "mp3" || /^[A-Za-z0-9_-]{11}$/.test(String(item.id || ""))),
    );
    const cards = lastItems
      .map((item, index) => (item.kind === "mp3" ? createMp3Card(item, index) : createCard(item, index)))
      .filter(Boolean);
    resultsEl.replaceChildren(...cards);
    emptyMsg.hidden = cards.length > 0;
    if (resultCount) {
      resultCount.hidden = cards.length === 0;
      const savable = lastItems.filter((item) => item.kind === "mp3").length;
      resultCount.textContent =
        cards.length === 1
          ? "1 titre prêt à écouter"
          : `${cards.length} titres prêts à écouter` +
            (savable ? ` · ${savable} enregistrables en MP3` : "");
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
    load(input.value || "");
  });

  const clearBtn = document.getElementById("musique-clear");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      input.value = "";
      input.focus();
      load("");
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

  // La source choisie la dernière fois est conservée sur l'appareil.
  try {
    const saved = window.localStorage.getItem("omni:music-source");
    if (saved === "youtube" || saved === "mp3") currentSource = saved;
  } catch (_error) {
    /* stockage indisponible : source par défaut */
  }
  if (sourceToggle) {
    sourceToggle.querySelectorAll(".source-btn").forEach((btn) => {
      const on = btn.dataset.source === currentSource;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-checked", String(on));
    });
  }
  if (sourceNote) sourceNote.textContent = SOURCES[currentSource].note;
  applySourceToMode();
  load(input.value || "");
})();
