(function () {
  "use strict";

  const root = document.getElementById("app-root");
  if (!root) return;

  const tab = root.dataset.tab || "films";
  const gridEl = document.getElementById("grid");
  const sentinel = document.getElementById("sentinel");
  const emptyMsg = document.getElementById("grid-empty");
  const pillsEl = document.getElementById("pills");
  const heroSection = document.getElementById("hero");
  const heroTrack = document.getElementById("hero-track");
  const heroDots = document.getElementById("hero-dots");
  const mediaSwitch = document.getElementById("media-switch");
  const sortPillsEl = document.getElementById("sort-pills");
  const pillsToolbar = document.getElementById("pills-toolbar");
  const pillSearch = document.getElementById("pill-search");
  const pillExpand = document.getElementById("pill-expand");
  const pillExpandLabel = document.getElementById("pill-expand-label");
  const hasardBtn = document.getElementById("anime-hasard");
  const animeExtra = document.getElementById("anime-extra");
  const calendrierEl = document.getElementById("calendrier");
  const calendrierRail = document.getElementById("calendrier-rail");
  const fraicheurEl = document.getElementById("fraicheur");
  const dureeEl = document.getElementById("duree");
  const notifBtn = document.getElementById("anime-notif");

  // L'onglet « Animés & Mangas » a deux moitiés qui ne se mélangent jamais :
  // les sous-genres et la grille dépendent de celle qui est affichée.
  const isAnimeTab = tab === "animes";
  let activeMedia = "anime";
  let activeSort = "tendances";

  /* Le dosage de la rotation. « stable » garde les repères, « frais » surprend
     davantage. Mémorisé sur l'appareil : c'est une préférence, pas une
     décision de visite. */
  const FRAICHEUR_CLE = "omni-fraicheur";
  const FRAICHEURS = ["stable", "normal", "frais"];

  function lireFraicheur() {
    try {
      const valeur = window.localStorage.getItem(FRAICHEUR_CLE) || "";
      return FRAICHEURS.includes(valeur) ? valeur : "";
    } catch (erreur) {
      return "";
    }
  }

  let fraicheur = lireFraicheur();

  /* Le filtre « ce soir j'ai 1 h 30 ». Vide = toutes durées. Mémorisé comme
     la fraîcheur : une préférence d'appareil, pas une décision de visite. */
  const DUREE_CLE = "omni-duree";
  const DUREES = ["court", "moyen", "long"];

  function lireDuree() {
    try {
      const valeur = window.localStorage.getItem(DUREE_CLE) || "";
      return DUREES.includes(valeur) ? valeur : "";
    } catch (erreur) {
      return "";
    }
  }

  let duree = lireDuree();

  let page = 1;
  let hasMore = true;
  let loading = false;
  let activeGenre = "all";
  let generation = 0;
  let listController = null;
  let heroController = null;
  let heroTimer = null;
  let totalCardsRendered = 0;
  // Cache instantané par onglet pour rendre le changement d'onglet immédiat
  const pageCache = new Map();
  const heroCache = new Map();
  let prefetchCache = new Map();
  let loopCount = 0;
  let currentHeroSeed = "";

  function cacheKeyForList(requestedPage, seedOverride) {
    return `${tab}|${activeGenre}|${activeMedia}|${activeSort}|${fraicheur||""}|${duree||""}|${requestedPage}|${seedOverride||sessionSeed}|${loopCount}`;
  }

  function heroCacheKey() {
    return `${tab}|${activeMedia}|${currentHeroSeed}`;
  }

  /* La graine de visite. Elle décide de l'ordre de la grille : même graine,
     même ordre. Deux exigences contradictoires en apparence —
       · une NOUVELLE ouverture du site doit redessiner la grille (sinon les
         mêmes titres restent en haut pour toujours) ;
       · une même session doit garder le même ordre, sans quoi le défilement
         infini se répéterait ou sauterait des titres entre deux pages.
     sessionStorage fait exactement ça : il meurt avec l'onglet. */
  const GRAINE_CLE = "omni-graine-visite";

  function nouvelleGraine() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function graineDeVisite() {
    let graine = "";
    try {
      graine = window.sessionStorage.getItem(GRAINE_CLE) || "";
      if (!graine) {
        graine = nouvelleGraine();
        window.sessionStorage.setItem(GRAINE_CLE, graine);
      }
    } catch (erreur) {
      // Navigation privée ou stockage coupé : une graine jetable par page,
      // la rotation marche quand même, seule la stabilité inter-pages saute.
      graine = nouvelleGraine();
    }
    return graine;
  }

  const sessionSeed = graineDeVisite();

  function seededRandom(seedString) {
    let hash = 1779033703 ^ seedString.length;
    for (let index = 0; index < seedString.length; index += 1) {
      hash = Math.imul(hash ^ seedString.charCodeAt(index), 3432918353);
      hash = (hash << 13) | (hash >>> 19);
    }
    return function random() {
      hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
      hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
      hash ^= hash >>> 16;
      return (hash >>> 0) / 4294967296;
    };
  }

  function seededShuffle(values, seedString) {
    const random = seededRandom(seedString);
    const result = values.slice();
    for (let index = result.length - 1; index > 0; index -= 1) {
      const target = Math.floor(random() * (index + 1));
      [result[index], result[target]] = [result[target], result[index]];
    }
    return result;
  }

  function listUrl(requestedPage, seedOverride) {
    const effectiveSeed = seedOverride || sessionSeed;
    const params = new URLSearchParams({
      type: activeGenre,
      page: String(requestedPage),
      seed: `${effectiveSeed}-loop${loopCount}`,
    });
    if (fraicheur) params.set("fraicheur", fraicheur);
    if (duree && dureeActive()) params.set("duree", duree);
    if (tab === "nouveautes") return `/api/upcoming?${params}`;
    if (tab === "legendes") return `/api/legends?${params}`;
    params.delete("type");
    params.set("tab", tab);
    params.set("genre", activeGenre);
    if (isAnimeTab) {
      params.set("media", activeMedia);
      params.set("sort", activeSort);
    }
    return `/api/list?${params}`;
  }

  function heroUrl() {
    // Toujours différent : nouvelle graine à chaque chargement du bandeau
    if (!currentHeroSeed) currentHeroSeed = nouvelleGraine() + Date.now().toString(36);
    const graine = `&seed=${encodeURIComponent(currentHeroSeed)}`;
    if (isAnimeTab) {
      return (
        `/api/hero?tab=${encodeURIComponent(tab)}&media=${activeMedia}${graine}`
      );
    }
    if (
      activeGenre === "all" &&
      ["films", "series", "animation_occidentale"].includes(tab)
    ) {
      return `/api/hero?tab=${encodeURIComponent(tab)}${graine}`;
    }
    return listUrl(1, currentHeroSeed);
  }

  function fallbackHeroItems() {
    // Secours client : 12 affiches garanties même si le serveur ne répond pas
    const fallbacks = [
      "https://image.tmdb.org/t/p/w780/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg",
      "https://image.tmdb.org/t/p/w780/qJ2tW6WMUDux911r6m7haRef0WH.jpg",
      "https://image.tmdb.org/t/p/w780/8Vt6mWEReuy4Of61Lnj5Xj704m8.jpg",
      "https://image.tmdb.org/t/p/w780/1pdfLvkbY9ohJlCjQH2CZjjYVvJ.jpg",
      "https://image.tmdb.org/t/p/w780/8Gxv8gSFCU0XGDykEGv7zR1n2ua.jpg",
      "https://image.tmdb.org/t/p/w780/39wmItIWsg5sZMyRUHLkWBcuVCM.jpg",
      "https://image.tmdb.org/t/p/w780/hTP1DtLGFamjfu8WqjnuQdP1n4i.jpg",
      "https://image.tmdb.org/t/p/w780/fqL8TuhvC3B00q9jV22Yq0Cswv9.jpg",
      "https://image.tmdb.org/t/p/w780/xUfRZu2mi8jH6SzQEJGP6tjBuYj.jpg",
      "https://image.tmdb.org/t/p/w780/fHpKWv1m46Z8a4WkE814e4hG4oV.jpg",
      "https://image.tmdb.org/t/p/w780/ggFHVNu6YYI5L9pCfOacjizRGt.jpg",
      "https://image.tmdb.org/t/p/w780/t6HIqrRAclMCA60NsSmeqe9RmNV.jpg",
    ];
    return fallbacks.map((url, idx) => ({
      id: 900000 + idx,
      media_type: tab === "series" ? "tv" : "movie",
      title: `À la une ${idx+1}`,
      year: "",
      date: "",
      rating: 8.5,
      poster: url,
      poster_small: url,
      backdrop: url,
      overview: "",
    }));
  }

  async function requestJson(url, signal) {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal,
    });
    let data;
    try {
      data = await response.json();
    } catch (_error) {
      throw new Error("Le serveur a renvoyé une réponse invalide.");
    }
    if (!response.ok) {
      throw new Error(data.error || "La requête a échoué.");
    }
    return data;
  }

  function safeImageUrl(value) {
    if (typeof value !== "string" || !value) return "";
    try {
      const url = new URL(value, window.location.origin);
      if (url.protocol !== "https:" && url.origin !== window.location.origin) {
        return "";
      }
      return url.href;
    } catch (_error) {
      return "";
    }
  }

  function formatDate(value) {
    if (typeof value !== "string") return "";
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
  }

  function detailUrl(item) {
    if (!item || typeof item !== "object") return null;
    const mediaType = item.media_type;
    const itemId = Number(item.id);
    // « anime » et « manga » sont des fiches servies par OmniStream (source
    // AniList) : elles s'ouvrent ici, exactement comme un film TMDB.
    if (!["movie", "tv", "anime", "manga"].includes(mediaType) || !Number.isInteger(itemId) || itemId <= 0) {
      return null;
    }
    const params = new URLSearchParams({ tab });
    return `/details/${mediaType}/${itemId}?${params}`;
  }

  // Place réellement prise par une affiche dans la grille (mêmes paliers que
  // le CSS : 3 colonnes sous 480 px, 4 jusqu'à 768 px, ~200 px au-delà). C'est
  // ce qui autorise le navigateur à descendre sur la variante w154.
  const POSTER_SIZES =
    "(max-width: 480px) calc((100vw - 44px) / 3), (max-width: 768px) calc((100vw - 60px) / 4), 200px";

  function createPoster(item, compact) {
    const poster = document.createElement("div");
    poster.className = compact ? "hero-poster" : "poster";
    const source = safeImageUrl(item.poster || item.backdrop);
    if (source) {
      const image = document.createElement("img");
      image.className = compact ? "hero-poster-img" : "poster-img";
      image.src = source;
      // Le navigateur choisit la définition : w154 pour une carte de téléphone
      // (~115 px de large) ou une affiche « à la une » de 128 px, w342
      // seulement si l'image est vraiment affichée plus grand. Sans srcset,
      // chaque carte demandait la w342 — le double de ce qu'elle montre.
      // Les deux variantes ne sont annoncées que lorsqu'elles existent toutes
      // les deux : un descripteur « 342w » sur une autre image serait un
      // mensonge que le navigateur paierait en octets.
      const small = safeImageUrl(item.poster_small);
      const full = safeImageUrl(item.poster);
      if (small && full) {
        image.srcset = `${small} 154w, ${full} 342w`;
        image.sizes = compact ? "128px" : POSTER_SIZES;
      }
      image.alt = `Affiche de ${String(item.title || "ce titre")}`;
      image.loading = compact ? "eager" : "lazy";
      // Décodage hors du fil principal : la grille arrive plus vite et le
      // défilement ne bégaie pas quand une affiche se révèle.
      image.decoding = "async";
      poster.appendChild(image);
    } else {
      poster.classList.add("poster-placeholder");
      poster.innerHTML = `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg><span>Indisponible</span>`;
    }
    return poster;
  }

  function createRatingBadge(rating) {
    const badge = document.createElement("span");
    badge.className = "rating-badge";
    const num = Number(rating);
    const text = Number.isFinite(num) && num > 0 ? num.toFixed(1) : "—";
    badge.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.7 7-6.3-3.9L5.7 21l1.7-7L2 9.2l7.1-.6z"/></svg><span>${text}</span>`;
    return badge;
  }

  function createRankBadge(rank) {
    const badge = document.createElement("span");
    badge.className = `rank-badge rank-${rank <= 3 ? rank : "default"}`;
    badge.textContent = String(rank);
    return badge;
  }

  function createQualityBadge() {
    const badge = document.createElement("span");
    badge.className = "quality-tag";
    badge.textContent = "VF · HD";
    return badge;
  }

  function favPayload(item) {
    return {
      media_type: item.media_type,
      id: Number(item.id),
      title: String(item.title || "Sans titre"),
      poster: safeImageUrl(item.poster || item.backdrop),
      backdrop: safeImageUrl(item.backdrop || item.poster),
      year: item.year || "",
      tab,
      url: detailUrl(item) || null,
    };
  }

  // Petite fabrique de boutons d'angle (favori / épinglage hors ligne).
  function makeCornerButton(className, label) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("title", label);
    return btn;
  }

  const ICONS = {
    heartOn:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    heartOff:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    pinOn:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10" fill="none" stroke="currentColor" stroke-width="2"></polyline><line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2"></line></svg>',
    pinOff:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
    skip:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><line x1="6.3" y1="6.3" x2="17.7" y2="17.7"></line></svg>',
  }

  function createFavButton(item) {
    const btn = makeCornerButton("card-fav-btn", "Ajouter à ma liste");
    const payload = favPayload(item);
    const refresh = () => {
      const on = Boolean(window.OmniLibrary && window.OmniLibrary.isFavorite(payload));
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", String(on));
      btn.innerHTML = on ? ICONS.heartOn : ICONS.heartOff;
    };
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!window.OmniLibrary) return;
      const added = window.OmniLibrary.toggleFavorite(payload);
      refresh();
      if (window.OmniUI) {
        window.OmniUI.toast(added ? "Ajouté à Ma Liste." : "Retiré de Ma Liste.", "ok");
      }
    });
    refresh();
    btn.__refresh = refresh;
    return btn;
  }

  // Épingler hors ligne depuis la grille : la vignette et la fiche sont
  // réellement mises en cache par le Service Worker.
  function createPinButton(item) {
    const btn = makeCornerButton("card-pin-btn", "Garder hors ligne");
    const payload = favPayload(item);
    const refresh = () => {
      const on = Boolean(window.OmniLibrary && window.OmniLibrary.isOffline(payload));
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", String(on));
      btn.innerHTML = on ? ICONS.pinOn : ICONS.pinOff;
    };
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!window.OmniLibrary) return;
      if (window.OmniLibrary.isOffline(payload)) {
        window.OmniLibrary.removeOffline(payload);
        if (window.OmniUI) window.OmniUI.toast("Retiré du hors ligne.", "ok");
      } else {
        btn.classList.add("busy");
        await window.OmniLibrary.saveOffline(payload);
        btn.classList.remove("busy");
        if (window.OmniUI) window.OmniUI.toast("Fiche et affiche enregistrées hors ligne.", "ok");
      }
      refresh();
    });
    refresh();
    btn.__refresh = refresh;
    return btn;
  }

  function createCard(item, index) {
    const href = detailUrl(item);
    if (!href) return null;
    if (estEcarte(item)) return null;

    const card = document.createElement("a");
    card.className = "card moviebox-card";
    card.href = href;
    card.dataset.trackId = `${item.media_type}-${item.id}`;

    const poster = createPoster(item, false);

    // MovieBox-style ranking badge on top items
    if (page === 2 && index < 10 && activeGenre === "all") {
      poster.appendChild(createRankBadge(index + 1));
    } else {
      poster.appendChild(createQualityBadge());
    }

    poster.appendChild(createRatingBadge(item.rating));
    poster.appendChild(createFavButton(item));
    poster.appendChild(createPinButton(item));
    poster.appendChild(createSkipButton(item, card));

    const info = document.createElement("div");
    info.className = "card-info";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = String(item.title || "Sans titre");

    const metaLine = document.createElement("div");
    metaLine.className = "card-meta-line";

    const yearText = item.year || (item.date ? String(item.date).slice(0, 4) : "");
    const mediaTypeLabel = isAnimeTab
      ? (item.media_type === "manga" ? "Manga" : "Anime")
      : (item.media_type === "tv" ? "Série" : "Film");

    const yearCell = yearText
      ? `<span class="card-year">${yearText}</span><span class="card-dot">•</span>`
      : "";
    metaLine.innerHTML = `${yearCell}<span class="card-type-tag">${mediaTypeLabel}</span>`;

    info.append(title, metaLine);

    if (tab === "nouveautes") {
      const date = document.createElement("div");
      date.className = "card-date";
      date.textContent = `Sortie : ${formatDate(item.date) || "À venir"}`;
      info.appendChild(date);
    }

    card.append(poster, info);
    return card;
  }

  function hideHero() {
    // Ne jamais cacher complètement : on garde le bandeau visible avec un fallback
    if (heroTimer) window.clearInterval(heroTimer);
    heroTimer = null;
    // Si on n'a rien, on injecte le fallback plutôt que de cacher
    if (heroTrack && heroTrack.children.length === 0) {
      const items = fallbackHeroItems();
      // On ne cache pas, on laisse loadHero s'en charger, mais on évite le hidden
      if (heroSection) heroSection.hidden = false;
    }
  }

  function keepHeroVisible() {
    if (heroSection) heroSection.hidden = false;
  }

  async function loadHero() {
    if (!heroTrack || !heroDots || !heroSection) return;
    currentHeroSeed = nouvelleGraine() + Date.now().toString(36);
    if (heroController) heroController.abort();
    heroController = new AbortController();
    const currentGeneration = generation;
    const url = heroUrl();

    const cachedHero = heroCache.get(`${tab}|${activeMedia}|${activeGenre}`);
    if (cachedHero && cachedHero.length) {
      try {
        renderHero(cachedHero, currentGeneration);
      } catch(e) {}
    }

    try {
      const data = await requestJson(url, heroController.signal);
      if (currentGeneration !== generation) return;
      let rawItems = Array.isArray(data.items) ? data.items : [];
      // Onglet animes : pas de fausses affiches TMDB — AniList/Jikan ou rien.
      if (!rawItems.length && !isAnimeTab) rawItems = fallbackHeroItems();
      const seenIds = new Set();
      const uniqueItems = [];
      for (const item of rawItems) {
        const href = detailUrl(item) || (item.backdrop ? "#" : null);
        if (!href && !item.backdrop) continue;
        const key = `${item.media_type}-${item.id}`;
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        uniqueItems.push(item);
      }
      let items = uniqueItems.slice(0, 12);
      if (items.length === 0) {
        if (isAnimeTab) {
          // Rien chez AniList/Jikan : on masque le bandeau, point.
          heroSection.hidden = true;
          return;
        }
        items = fallbackHeroItems();
      }
      heroCache.set(`${tab}|${activeMedia}|${activeGenre}`, items);
      if (heroCache.size > 20) {
        const first = heroCache.keys().next().value;
        heroCache.delete(first);
      }
      renderHero(items, currentGeneration);
    } catch (error) {
      if (error.name === "AbortError") return;
      console.error("Erreur de chargement du bandeau :", error);
      if (currentGeneration !== generation) return;
      if (isAnimeTab) {
        if (cachedHero && cachedHero.length) {
          try {
            renderHero(cachedHero, currentGeneration);
          } catch(e) {}
        } else if (heroSection) {
          heroSection.hidden = true;
        }
        return;
      }
      const items = cachedHero && cachedHero.length ? cachedHero : fallbackHeroItems();
      try {
        renderHero(items, currentGeneration);
      } catch(e) {
        keepHeroVisible();
      }
    }
  }

  function renderHero(items, currentGeneration) {
      if (currentGeneration !== generation) return;
      if (!items || !items.length) {
        if (isAnimeTab) {
          if (heroSection) heroSection.hidden = true;
          return;
        }
        items = fallbackHeroItems();
      }
      keepHeroVisible();
      if (heroTimer) window.clearInterval(heroTimer);
      const slides = [];
      const dots = [];
      items.forEach((item, index) => {
        const slide = document.createElement("article");
        slide.className = `hero-slide${index === 0 ? " active" : ""}`;
        const backdrop = safeImageUrl(item.backdrop || item.poster);
        if (backdrop) slide.style.backgroundImage = `url(${JSON.stringify(backdrop)})`;

        const shade = document.createElement("div");
        shade.className = "hero-content";
        const poster = createPoster(item, true);
        const copy = document.createElement("div");
        copy.className = "hero-copy";
        
        const badge = document.createElement("span");
        badge.className = "hero-badge";
        badge.textContent = "À LA UNE DU MOMENT";

        const title = document.createElement("h2");
        title.textContent = String(item.title || "Sans titre");
        
        const metadata = document.createElement("p");
        const rating = Number(item.rating);
        const ratingText = Number.isFinite(rating) && rating > 0 ? rating.toFixed(1) : "N/A";
        metadata.innerHTML = `<span class="hero-rating"><svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.7 7-6.3-3.9L5.7 21l1.7-7L2 9.2l7.1-.6z"/></svg> ${ratingText}</span> · <span>${formatDate(item.date) || item.year || "2024"}</span> · <span class="hero-quality">4K Ultra HD</span>`;
        copy.append(badge, title, metadata);

        const link = document.createElement("a");
        link.className = "hero-play";
        const href = detailUrl(item);
        link.href = href || "#";
        link.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
        link.setAttribute("aria-label", `Voir la fiche de ${String(item.title || "ce titre")}`);
        
        shade.append(poster, copy, link);
        slide.appendChild(shade);
        slides.push(slide);

        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = `hero-dot${index === 0 ? " active" : ""}`;
        dot.setAttribute("aria-label", `Afficher la sélection ${index + 1}`);
        dots.push(dot);
      });

      heroTrack.replaceChildren(...slides);
      heroDots.replaceChildren(...dots);
      heroSection.hidden = false;

      let current = 0;
      function show(index) {
        if (!slides.length || currentGeneration !== generation) return;
        slides[current].classList.remove("active");
        dots[current].classList.remove("active");
        current = (index + slides.length) % slides.length;
        slides[current].classList.add("active");
        dots[current].classList.add("active");
      }
      dots.forEach((dot, index) => dot.addEventListener("click", () => show(index)));
      if (slides.length > 1) {
        const startRotation = () => {
          if (heroTimer || currentGeneration !== generation) return;
          heroTimer = window.setInterval(() => show(current + 1), 6000);
        };
        const stopRotation = () => {
          if (!heroTimer) return;
          window.clearInterval(heroTimer);
          heroTimer = null;
        };
        if ("IntersectionObserver" in window) {
          const heroObserver = new IntersectionObserver(
            (entries) => {
              if (currentGeneration !== generation) return;
              if (entries[0]?.isIntersecting) startRotation();
              else stopRotation();
            },
            { rootMargin: "100px" }
          );
          heroObserver.observe(heroSection);
        } else {
          startRotation();
        }
      }
  }

  // Nouveautés et Légendes sont des onglets TMDB (films et séries). Les
  // animes et mangas ont leur propre onglet, puisé chez AniList, avec leurs
  // propres filtres « ajouts récents » et « note ≥ 8,5 » : on ne les mélange
  // pas ici.
  function specialPills() {
    return [
      { id: "all", label: "Films & Séries" },
      { id: "movie", label: "Films" },
      { id: "tv", label: "Séries TV" },
    ];
  }

  function makePill(pill, current, onPick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `pill${String(pill.id) === current ? " active" : ""}`;
    button.dataset.id = String(pill.id);
    button.textContent = String(pill.label);
    button.addEventListener("click", () => {
      if (button.dataset.id === current) return;
      onPick(button.dataset.id, button);
    });
    return button;
  }

  /* Une centaine de sous-genres par moitié de catalogue : la bande
     horizontale seule les rendait introuvables. Deux aides, posées une seule
     fois : un filtre texte et un dépliage en grille. */
  function normaliser(valeur) {
    return String(valeur || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function installerOutilsPills(nombres) {
    if (!pillsToolbar || !pillsEl) return;
    if (nombres < 12) {
      pillsToolbar.hidden = true;
      return;
    }
    pillsToolbar.hidden = false;
    if (pillSearch && !pillSearch.dataset.wired) {
      pillSearch.dataset.wired = "1";
      pillSearch.addEventListener("input", () => {
        const aiguille = normaliser(pillSearch.value).trim();
        pillsEl.querySelectorAll(".pill").forEach((item) => {
          item.hidden =
            Boolean(aiguille) &&
            !normaliser(item.textContent).includes(aiguille);
        });
      });
    }
    if (pillExpand && !pillExpand.dataset.wired) {
      pillExpand.dataset.wired = "1";
      pillExpand.addEventListener("click", () => {
        const ouvert = pillsEl.classList.toggle("is-wrapped");
        pillExpand.setAttribute("aria-expanded", ouvert ? "true" : "false");
        if (pillExpandLabel) {
          pillExpandLabel.textContent = ouvert ? "Replier" : "Tout afficher";
        }
      });
    }
  }

  /* Le préchargement : survoler un sous-genre lance déjà sa première page.
     Le serveur garde ces pages 10 minutes, donc le clic qui suit arrive sur
     une réponse toute prête au lieu d'attendre AniList. */
  const prefetchVus = new Set();
  let prefetchTimer = null;

  function prefetchUrl(pillId) {
    const query = isAnimeTab ? `&media=${activeMedia}` : "";
    return (
      `/api/list?tab=${encodeURIComponent(tab)}` +
      `${query}&genre=${encodeURIComponent(pillId || "all")}` +
      `&sort=${encodeURIComponent(activeSort)}&page=1`
    );
  }

  function precharger(pillId) {
    if (!isAnimeTab || !pillId || prefetchVus.has(pillId)) return;
    prefetchVus.add(pillId);
    // Le résultat n'est pas relu côté client : c'est le cache du serveur
    // qu'on remplit. Un échec ne doit donc rien afficher.
    fetch(prefetchUrl(pillId), { credentials: "same-origin" }).catch(() => {});
  }

  /* Le calendrier des épisodes de la semaine. Il vit à part de la grille :
     un échec d'AniList ne doit pas vider le catalogue, et inversement. */
  let calendrierCharge = "";

  function carteCalendrier(item) {
    const lien = document.createElement("a");
    lien.className = "calendrier-carte";
    lien.href = detailUrl(item) || "#";
    lien.dataset.trackId = `${item.media_type}-${item.id}`;

    const image = document.createElement("img");
    image.className = "calendrier-affiche";
    image.src = item.poster_small || item.poster || "";
    image.alt = String(item.title || "Sans titre");
    image.loading = "lazy";
    image.decoding = "async";

    const corps = document.createElement("div");
    corps.className = "calendrier-corps";
    const titre = document.createElement("div");
    titre.className = "calendrier-nom";
    titre.textContent = String(item.title || "Sans titre");
    const episode = document.createElement("div");
    episode.className = "calendrier-episode";
    episode.textContent = item.episode
      ? `Épisode ${item.episode}`
      : "Épisode à venir";
    const quand = document.createElement("div");
    quand.className = "calendrier-quand";
    quand.textContent = [item.jour, item.heure].filter(Boolean).join(" · ");
    corps.append(titre, episode, quand);

    lien.append(image, corps);
    return lien;
  }

  /* Prévenir des nouveaux épisodes. Deux garde-fous : l'autorisation n'est
     demandée que sur un clic explicite, et on n'annonce que les séries déjà
     dans « Ma Liste » — prévenir de tout le calendrier serait du spam. */
  const NOTIF_CLE = "omni-notif-episodes";
  const NOTIF_VUS_CLE = "omni-notif-episodes-vus";

  function lireNotifVus() {
    try {
      const brut = window.localStorage.getItem(NOTIF_VUS_CLE);
      const liste = brut ? JSON.parse(brut) : [];
      return new Set(Array.isArray(liste) ? liste.map(String) : []);
    } catch (erreur) {
      return new Set();
    }
  }

  function notificationsActives() {
    try {
      return window.localStorage.getItem(NOTIF_CLE) === "oui";
    } catch (erreur) {
      return false;
    }
  }

  function maCle(item) {
    return `${item.media_type || "x"}:${item.id}:${item.episode || 0}`;
  }

  function annoncerEpisodes(items) {
    if (!notificationsActives() || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    const suivis = new Set();
    if (window.OmniLibrary && window.OmniLibrary.getFavorites) {
      window.OmniLibrary.getFavorites().forEach((fiche) => {
        suivis.add(`${fiche.media_type || fiche.type || "x"}:${fiche.id}`);
      });
    }
    if (!suivis.size) return;
    const vus = lireNotifVus();
    const nouveaux = items.filter(
      (item) =>
        suivis.has(`${item.media_type}:${item.id}`) && !vus.has(maCle(item))
    );
    if (!nouveaux.length) return;
    nouveaux.slice(0, 3).forEach((item) => {
      try {
        new window.Notification("Nouvel épisode sur OmniStream", {
          body: `${item.title} — épisode ${item.episode || "à venir"}`,
          tag: maCle(item),
        });
      } catch (erreur) { /* notification refusée par le système */ }
    });
    // Marquées comme vues : sans ça, chaque visite rejouerait l'annonce.
    nouveaux.forEach((item) => vus.add(maCle(item)));
    try {
      window.localStorage.setItem(
        NOTIF_VUS_CLE,
        JSON.stringify([...vus].slice(-300))
      );
    } catch (erreur) { /* stockage indisponible */ }
  }

  async function chargerCalendrier() {
    if (!isAnimeTab || !calendrierEl || !calendrierRail) return;
    if (calendrierCharge === activeMedia) return;
    calendrierCharge = activeMedia;
    try {
      const data = await requestJson(
        `/api/calendrier?media=${encodeURIComponent(activeMedia)}`
      );
      const items = Array.isArray(data.items) ? data.items : [];
      calendrierRail.replaceChildren(...items.map(carteCalendrier));
      annoncerEpisodes(items);
      // Rien à annoncer : le bandeau reste caché plutôt que d'afficher un
      // « aucun épisode » qui n'apporte rien.
      calendrierEl.hidden = items.length === 0;
    } catch (error) {
      calendrierEl.hidden = true;
    }
  }

  /* « Pas intéressé ». Le vrai mécanisme qui fait qu'un fil ne vous remontre
     pas la même chose : on écarte le titre, et il ne revient plus. Tout reste
     dans localStorage — le site n'a pas de compte où l'écrire. */
  const ECARTES_CLE = "omni-titres-ecartes";
  const ECARTES_MAX = 400;
  let ecartes = new Set();

  function lireEcartes() {
    try {
      const brut = window.localStorage.getItem(ECARTES_CLE);
      const liste = brut ? JSON.parse(brut) : [];
      return new Set(Array.isArray(liste) ? liste.map(String) : []);
    } catch (erreur) {
      return new Set();
    }
  }

  function ecrireEcartes() {
    try {
      // Borné : sans limite, la clé grossirait pour toujours.
      window.localStorage.setItem(
        ECARTES_CLE,
        JSON.stringify([...ecartes].slice(-ECARTES_MAX))
      );
    } catch (erreur) { /* stockage indisponible : la session suffit */ }
  }

  function cleTitre(item) {
    return `${item.media_type || "x"}:${item.id}`;
  }

  function estEcarte(item) {
    return ecartes.has(cleTitre(item));
  }

  function ecarterTitre(item) {
    ecartes.add(cleTitre(item));
    ecrireEcartes();
  }

  ecartes = lireEcartes();

  function createSkipButton(item, carte) {
    const btn = makeCornerButton("card-skip-btn", "Pas intéressé");
    btn.innerHTML = ICONS.skip;
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      ecarterTitre(item);
      // La carte part tout de suite : laisser un bouton « annuler » supposerait
      // un état réversible qu'on ne tient pas d'une visite à l'autre.
      carte.remove();
      if (window.OmniUI) {
        window.OmniUI.toast(`« ${item.title || "Ce titre"} » ne reviendra plus.`, "ok");
      }
    });
    return btn;
  }

  /* Le cran de fraîcheur. Un clic recharge la grille : le changement d'ordre
     doit se voir tout de suite, pas à la prochaine visite. */
  function marquerFraicheur() {
    if (!fraicheurEl) return;
    fraicheurEl.querySelectorAll(".fraicheur-btn").forEach((bouton) => {
      bouton.classList.toggle(
        "active",
        bouton.dataset.fraicheur === (fraicheur || "normal")
      );
    });
  }

  // La durée n'a de sens que pour les films et les animes : une série se
  // regarde sur plusieurs soirées, un manga n'a pas de minutes.
  function dureeActive() {
    return tab === "films" || (isAnimeTab && activeMedia === "anime");
  }

  function majVisibiliteDuree() {
    if (dureeEl) dureeEl.hidden = !dureeActive();
  }

  function installerDuree() {
    if (!dureeEl || dureeEl.dataset.wired) return;
    dureeEl.dataset.wired = "1";
    marquerDuree();
    dureeEl.addEventListener("click", (event) => {
      const bouton = event.target.closest(".fraicheur-btn");
      if (!bouton) return;
      const choix = bouton.dataset.duree || "";
      duree = DUREES.includes(choix) ? choix : "";
      try {
        if (duree) window.localStorage.setItem(DUREE_CLE, duree);
        else window.localStorage.removeItem(DUREE_CLE);
      } catch (erreur) { /* préférence non mémorisée, sans gravité */ }
      marquerDuree();
      reloadEverything();
    });
  }

  function marquerDuree() {
    if (!dureeEl) return;
    dureeEl.querySelectorAll(".fraicheur-btn").forEach((bouton) => {
      const actif = (bouton.dataset.duree || "") === duree;
      bouton.classList.toggle("active", actif);
      bouton.setAttribute("aria-pressed", String(actif));
    });
  }

  function installerFraicheur() {
    if (!fraicheurEl || fraicheurEl.dataset.wired) return;
    fraicheurEl.dataset.wired = "1";
    marquerFraicheur();
    fraicheurEl.addEventListener("click", (event) => {
      const bouton = event.target.closest(".fraicheur-btn");
      if (!bouton) return;
      const choix = bouton.dataset.fraicheur || "";
      fraicheur = FRAICHEURS.includes(choix) ? choix : "";
      try {
        if (fraicheur) window.localStorage.setItem(FRAICHEUR_CLE, fraicheur);
        else window.localStorage.removeItem(FRAICHEUR_CLE);
      } catch (erreur) { /* préférence non mémorisée, sans gravité */ }
      marquerFraicheur();
      reloadEverything();
    });
  }

  function installerNotifications() {
    if (!notifBtn || notifBtn.dataset.wired) return;
    notifBtn.dataset.wired = "1";
    if (!("Notification" in window)) return;
    notifBtn.hidden = false;
    const label = document.getElementById("anime-notif-label");
    const peindre = () => {
      const actif = notificationsActives();
      notifBtn.classList.toggle("is-on", actif);
      notifBtn.setAttribute("aria-pressed", actif ? "true" : "false");
      if (label) {
        label.textContent = actif
          ? "Alertes épisodes : activées"
          : "Prévenir des nouveaux épisodes";
      }
    };
    peindre();
    notifBtn.addEventListener("click", async () => {
      const actif = notificationsActives();
      if (actif) {
        try {
          window.localStorage.removeItem(NOTIF_CLE);
        } catch (erreur) { /* stockage indisponible */ }
        peindre();
        if (window.OmniUI) window.OmniUI.toast("Alertes épisodes coupées.", "ok");
        return;
      }
      let accord = Notification.permission;
      if (accord === "default") accord = await Notification.requestPermission();
      if (accord !== "granted") {
        if (window.OmniUI) {
          window.OmniUI.toast("Le navigateur a refusé les notifications.", "info");
        }
        return;
      }
      try {
        window.localStorage.setItem(NOTIF_CLE, "oui");
      } catch (erreur) { /* stockage indisponible */ }
      peindre();
      if (window.OmniUI) {
        window.OmniUI.toast("Vous serez prévenu des épisodes de Ma Liste.", "ok");
      }
    });
  }

  function installerPrefetch() {
    if (!pillsEl || pillsEl.dataset.prefetch) return;
    pillsEl.dataset.prefetch = "1";
    pillsEl.addEventListener("pointerover", (event) => {
      const pill = event.target.closest(".pill");
      if (pill) precharger(pill.dataset.id);
    });
    // Sur tactile il n'y a pas de survol : un appui maintenu joue ce rôle,
    // sans jamais voler le clic.
    pillsEl.addEventListener("pointerdown", (event) => {
      const pill = event.target.closest(".pill");
      if (!pill) return;
      clearTimeout(prefetchTimer);
      prefetchTimer = setTimeout(() => precharger(pill.dataset.id), 260);
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((evenement) => {
      pillsEl.addEventListener(evenement, () => clearTimeout(prefetchTimer));
    });
  }

  function selectPill(container, chosen) {
    container.querySelectorAll(".pill").forEach((item) => {
      item.classList.toggle("active", item.dataset.id === chosen);
    });
  }

  function reloadEverything() {
    generation += 1;
    resetGrid();
    loadHero();
    loadMore();
    // La bascule Animes / Mangas change aussi les épisodes annoncés.
    chargerCalendrier();
  }

  function renderSortPills(sorts) {
    if (!sortPillsEl) return;
    if (!Array.isArray(sorts) || !sorts.length) {
      sortPillsEl.hidden = true;
      sortPillsEl.replaceChildren();
      return;
    }
    sortPillsEl.replaceChildren(
      ...sorts.map((sort) =>
        makePill(sort, activeSort, (id) => {
          activeSort = id;
          selectPill(sortPillsEl, id);
          reloadEverything();
        })
      )
    );
    sortPillsEl.hidden = false;
  }

  async function loadPills() {
    try {
      if (["nouveautes", "legendes"].includes(tab)) {
        pillsEl.replaceChildren(
          ...specialPills().map((pill) =>
            makePill(pill, activeGenre, (id) => {
              activeGenre = id;
              selectPill(pillsEl, id);
              reloadEverything();
            })
          )
        );
        if (sortPillsEl) sortPillsEl.hidden = true;
        return;
      }
      const query = isAnimeTab ? `&media=${activeMedia}` : "";
      const data = await requestJson(
        `/api/genres?tab=${encodeURIComponent(tab)}${query}`
      );
      const pills = data.pills || [];
      pillsEl.replaceChildren(
        ...pills.map((pill) =>
          makePill(pill, activeGenre, (id) => {
            activeGenre = id;
            selectPill(pillsEl, id);
            reloadEverything();
          })
        )
      );
      renderSortPills(data.sorts);
      installerOutilsPills(pills.length);
      installerPrefetch();
      installerNotifications();
      if (animeExtra) animeExtra.hidden = !isAnimeTab;
      majVisibiliteDuree();
      chargerCalendrier();
    } catch (error) {
      console.error("Erreur de chargement des genres :", error);
      pillsEl.replaceChildren();
    }
  }

  // Bascule Animes / Mangas : elle change les sous-genres ET la grille, et
  // remet le filtre à « Tout » — un Shōnen n'a rien à faire parmi les animes.
  if (isAnimeTab && mediaSwitch) {
    mediaSwitch.querySelectorAll(".media-switch-btn").forEach((button) => {
      button.addEventListener("click", () => {
        const next = button.dataset.media;
        if (!next || next === activeMedia) return;
        activeMedia = next;
        activeGenre = "all";
        activeSort = "tendances";
        mediaSwitch.querySelectorAll(".media-switch-btn").forEach((item) => {
          item.classList.toggle("active", item === button);
        });
        loadPills();
        reloadEverything();
      });
    });
  }

  function resetGrid() {
    if (listController) listController.abort();
    // On garde le cache pour revenir instantanément, mais on reset la vue
    page = 1;
    hasMore = true;
    loading = false;
    totalCardsRendered = 0;
    if (gridEl) gridEl.replaceChildren();
    if (emptyMsg) emptyMsg.hidden = true;
  }

  /* « Aucun titre » et « impossible de charger » ne sont pas la même chose.
     Avant, les deux affichaient la même phrase : une panne d'AniList se
     lisait comme un catalogue vide, et l'onglet restait muet sans aucun
     indice sur la cause ni sur quoi faire. Désormais le message du serveur
     s'affiche, avec un bouton qui relance la demande. */
  function afficherVide(message, avecRetente) {
    if (!emptyMsg) return;
    const titre = emptyMsg.querySelector("h3");
    const texte = emptyMsg.querySelector("p");
    const ancien = emptyMsg.querySelector("[data-recharger]");
    if (ancien) ancien.remove();
    if (titre) {
      titre.textContent = avecRetente
        ? "Impossible de charger le catalogue"
        : "Aucun titre disponible";
    }
    if (texte) {
      texte.textContent = message ||
        "Aucun titre n'a été trouvé dans cette catégorie pour le moment.";
    }
    if (avecRetente) {
      const bouton = document.createElement("button");
      bouton.type = "button";
      bouton.className = "empty-retry";
      bouton.dataset.recharger = "1";
      bouton.textContent = "Réessayer";
      bouton.addEventListener("click", () => {
        hasMore = true;
        resetGrid();
        loadMore();
      });
      emptyMsg.appendChild(bouton);
    }
    emptyMsg.hidden = false;
  }

  function renderSkeletons(count=8) {
    if (!gridEl) return;
    if (gridEl.querySelector(".skeleton-card")) return;
    const frag = document.createDocumentFragment();
    for (let i=0;i<count;i++) {
      const sk = document.createElement("div");
      sk.className = "card skeleton-card";
      sk.innerHTML = `<div class="poster skeleton"></div><div class="card-info"><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>`;
      frag.appendChild(sk);
    }
    gridEl.appendChild(frag);
  }

  function clearSkeletons() {
    if (!gridEl) return;
    gridEl.querySelectorAll(".skeleton-card").forEach(el=>el.remove());
  }

  function prefetchNextPage(nextPage) {
    if (!hasMore) return;
    const key = cacheKeyForList(nextPage);
    if (pageCache.has(key) || prefetchCache.has(key)) return;
    const url = listUrl(nextPage);
    const controller = new AbortController();
    prefetchCache.set(key, true);
    fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal })
      .then(r=>r.json())
      .then(data=>{
        if (Array.isArray(data.items)) {
          pageCache.set(key, data);
        }
      })
      .catch(()=>{})
      .finally(()=>prefetchCache.delete(key));
  }

  async function loadMore() {
    if (loading) return;
    // Boucle infinie : si hasMore est false, on reboucle avec nouvelle graine
    if (!hasMore) {
      loopCount += 1;
      page = 1;
      hasMore = true;
      if (window.OmniUI) {
        window.OmniUI.toast("Vous avez tout vu — on recommence avec d'autres titres !", "info");
      }
    }
    loading = true;
    const requestedPage = page;
    const currentGeneration = generation;
    const controller = new AbortController();
    listController = controller;
    const cacheKey = cacheKeyForList(requestedPage);

    // Si cache hit, affiche immédiatement (rend l'onglet Films instantané)
    const cached = pageCache.get(cacheKey);
    if (cached && requestedPage === 1) {
      try {
        const items = Array.isArray(cached.items) ? cached.items : [];
        const cards = items.map((item, idx) => createCard(item, totalCardsRendered + idx)).filter(Boolean);
        clearSkeletons();
        gridEl.append(...cards);
        totalCardsRendered += cards.length;
        hasMore = cached.has_more !== false ? true : true; // toujours vrai pour infini
        page = requestedPage + 1;
        loading = false;
        // Précharge la suite en arrière-plan et lance le fetch frais
        prefetchNextPage(page);
        // Lance un rafraîchissement en arrière-plan sans bloquer l'affichage
        setTimeout(()=>{ if (currentGeneration===generation) { pageCache.delete(cacheKey); loadMoreBackground(requestedPage, currentGeneration); } }, 100);
        // Si la sentinelle est déjà visible, continue
        if (currentGeneration === generation && hasMore && sentinel && sentinel.getBoundingClientRect().top < window.innerHeight + 1200) {
          window.requestAnimationFrame(() => loadMore());
        }
        return;
      } catch(e) {
        // Si le cache est corrompu, on continue en réseau
      }
    }

    if (requestedPage === 1) renderSkeletons(12);

    try {
      const data = await requestJson(listUrl(requestedPage), controller.signal);
      if (currentGeneration !== generation) return;
      const items = Array.isArray(data.items) ? data.items : [];
      // Cache la page
      pageCache.set(cacheKey, data);
      if (pageCache.size > 80) {
        const first = pageCache.keys().next().value;
        pageCache.delete(first);
      }
      clearSkeletons();
      const cards = items.map((item, idx) => createCard(item, totalCardsRendered + idx)).filter(Boolean);
      totalCardsRendered += cards.length;
      gridEl.append(...cards);
      // Infini : on garde hasMore à true même si le serveur dit false, sauf si vraiment 0 résultats partout
      if (items.length === 0 && requestedPage === 1) {
        // Vrai vide : filtre sans résultat
        afficherVide("");
        hasMore = false;
      } else {
        hasMore = true; // boucle infinie
        if (items.length === 0) {
          // Page vide au milieu : on reboucle
          loopCount += 1;
          page = 1;
        } else {
          page = requestedPage + 1;
        }
      }
      // Précharge la prochaine page immédiatement pour fluidité
      prefetchNextPage(page);
    } catch (error) {
      clearSkeletons();
      if (error.name !== "AbortError" && currentGeneration === generation) {
        console.error("Erreur de chargement du catalogue :", error);
        if (requestedPage === 1) {
          const cachedFallback = pageCache.get(cacheKey);
          if (cachedFallback && Array.isArray(cachedFallback.items) && cachedFallback.items.length) {
            const cards = cachedFallback.items.map((item, idx) => createCard(item, totalCardsRendered + idx)).filter(Boolean);
            gridEl.append(...cards);
            totalCardsRendered += cards.length;
            hasMore = true;
            page = requestedPage + 1;
          } else {
            hasMore = true; // on ne bloque pas le scroll même en cas d'erreur, on retentera
            afficherVide(error.message || "Le serveur n'a pas répondu.", true);
          }
        } else {
          // Erreur sur page suivante : on garde hasMore pour retenter
          hasMore = true;
        }
      }
    } finally {
      if (currentGeneration === generation) loading = false;
    }
    if (
      currentGeneration === generation &&
      hasMore &&
      sentinel &&
      sentinel.getBoundingClientRect().top < window.innerHeight + 1200
    ) {
      window.requestAnimationFrame(() => loadMore());
    }
  }

  async function loadMoreBackground(requestedPage, currentGeneration) {
    try {
      const data = await requestJson(listUrl(requestedPage), null);
      if (currentGeneration !== generation) return;
      if (Array.isArray(data.items) && data.items.length) {
        const key = cacheKeyForList(requestedPage);
        pageCache.set(key, data);
        // Si on est toujours sur la page 1 et que la grille a déjà été remplie depuis le cache,
        // on ne duplique pas, on laisse tel quel. Le prochain scroll prendra le frais.
      }
    } catch(e) {}
  }

  if (hasardBtn) {
    hasardBtn.addEventListener("click", async () => {
      hasardBtn.disabled = true;
      resetGrid();
      // Couper le défilement AVANT d'attendre : sinon l'observateur pourrait
      // empiler une page de catalogue pendant que la pioche arrive.
      hasMore = false;
      generation += 1;
      try {
        const data = await requestJson(
          `/api/anime-hasard?media=${encodeURIComponent(activeMedia)}`
        );
        const items = Array.isArray(data.items) ? data.items : [];
        const cards = items.map((item, idx) => createCard(item, idx)).filter(Boolean);
        gridEl.append(...cards);
        // Une pioche est une fin en soi : on ne continue pas à empiler les
        // pages derrière, ce serait recoller un catalogue à une sélection.
        hasMore = false;
        if (!cards.length && emptyMsg) {
          emptyMsg.hidden = false;
          emptyMsg.textContent = "AniList n'a rien renvoyé. Réessayez.";
        }
      } catch (error) {
        if (emptyMsg) emptyMsg.hidden = false;
      } finally {
        hasardBtn.disabled = false;
      }
    });
  }

  if ("IntersectionObserver" in window && sentinel) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "1200px" },
    );
    observer.observe(sentinel);
    // Précharge aussi au scroll pour les navigateurs qui ne déclenchent pas assez tôt
    let scrollTick = false;
    window.addEventListener("scroll", () => {
      if (scrollTick) return;
      scrollTick = true;
      requestAnimationFrame(() => {
        scrollTick = false;
        if (sentinel.getBoundingClientRect().top < window.innerHeight + 1500) loadMore();
      });
    }, { passive: true });
  } else {
    window.addEventListener("scroll", () => {
      if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 600) {
        loadMore();
      }
    });
  }

  installerFraicheur();
  installerDuree();
  majVisibiliteDuree();
  loadPills();
  loadMore();

  // Lecture musique depuis la recherche globale : délégué, car les boutons
  // n'existent que sur la page de résultats servie par le serveur.
  document.addEventListener("click", (event) => {
    const bouton = event.target.closest(".search-music-play");
    if (!bouton || !window.OmniPlayer) return;
    window.OmniPlayer.play(
      {
        id: bouton.dataset.playId,
        title: bouton.dataset.title || "Lecture en cours",
        channel: bouton.dataset.channel || "",
        thumbnail: bouton.dataset.thumbnail || "",
      },
      "audio",
    );
  });
  // Un seul AbortController par page visitée : les écouteurs posés sur
  // `document` sautent au départ de la page, au lieu de s'empiler à chaque
  // navigation interne (interface de plus en plus lente au fil de la session).
  if (!window.__omniPageAbort) window.__omniPageAbort = new AbortController();
  const signal = window.__omniPageAbort.signal;

  document.addEventListener("omni:player-change", () => {
    const current = window.OmniPlayer && window.OmniPlayer.getCurrent();
    document.querySelectorAll(".card[data-track-id]").forEach((card) => {
      const on = Boolean(current && card.dataset.trackId === String(current.id));
      card.classList.toggle("is-playing", on);
    });
  }, { signal });
  document.addEventListener("omni:page-loaded", () => {
    document.querySelectorAll(".card-fav-btn, .card-pin-btn").forEach((btn) => {
      if (btn.__refresh) btn.__refresh();
    });
  }, { signal });
})();
