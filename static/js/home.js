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

  // L'onglet « Animés & Mangas » a deux moitiés qui ne se mélangent jamais :
  // les sous-genres et la grille dépendent de celle qui est affichée.
  const isAnimeTab = tab === "animes";
  let activeMedia = "anime";
  let activeSort = "tendances";

  let page = 1;
  let hasMore = true;
  let loading = false;
  let activeGenre = "all";
  let generation = 0;
  let listController = null;
  let heroController = null;
  let heroTimer = null;
  let totalCardsRendered = 0;

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

  function listUrl(requestedPage) {
    const params = new URLSearchParams({
      type: activeGenre,
      page: String(requestedPage),
      seed: sessionSeed,
    });
    if (tab === "nouveautes") return `/api/upcoming?${params}`;
    if (tab === "legendes") return `/api/legends?${params}`;
    params.delete("type");
    params.set("tab", tab);
    params.set("genre", activeGenre);
    if (isAnimeTab) {
      // Source AniList : le type et le tri font partie de la requête.
      params.set("media", activeMedia);
      params.set("sort", activeSort);
    }
    return `/api/list?${params}`;
  }

  function heroUrl() {
    if (isAnimeTab) {
      // Le bandeau suit le type affiché : pas d'anime au milieu des mangas.
      return `/api/hero?tab=${encodeURIComponent(tab)}&media=${activeMedia}`;
    }
    if (
      activeGenre === "all" &&
      ["films", "series", "animation_occidentale"].includes(tab)
    ) {
      return `/api/hero?tab=${encodeURIComponent(tab)}`;
    }
    return listUrl(1);
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
    if (heroTimer) window.clearInterval(heroTimer);
    heroTimer = null;
    if (heroTrack) heroTrack.replaceChildren();
    if (heroDots) heroDots.replaceChildren();
    if (heroSection) heroSection.hidden = true;
  }

  async function loadHero() {
    if (!heroTrack || !heroDots || !heroSection) return;
    if (heroController) heroController.abort();
    heroController = new AbortController();
    const currentGeneration = generation;

    try {
      const data = await requestJson(heroUrl(), heroController.signal);
      if (currentGeneration !== generation) return;
      const rawItems = Array.isArray(data.items) ? data.items : [];
      // Défilement « infini » : aucun film / animé ne doit revenir deux fois
      // dans le même cycle. On déduplique donc strictement par identifiant.
      const seenIds = new Set();
      const uniqueItems = [];
      for (const item of rawItems) {
        if (!detailUrl(item)) continue;
        const key = `${item.media_type}-${item.id}`;
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        uniqueItems.push(item);
      }
      const items = seededShuffle(
        uniqueItems,
        `hero-${tab}-${activeGenre}-${sessionSeed}`,
      ).slice(0, 12);
      if (items.length === 0) {
        hideHero();
        return;
      }

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
        link.href = detailUrl(item);
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
        // Le bandeau ne défile que pendant qu'on le regarde : une rotation
        // invisible coûte un réagencement toutes les 6 secondes pour rien, et
        // c'est autant de retard pris sur le défilement de la grille.
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
    } catch (error) {
      if (error.name !== "AbortError") {
        console.error("Erreur de chargement du bandeau :", error);
        if (currentGeneration === generation) hideHero();
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
      // Rien à annoncer : le bandeau reste caché plutôt que d'afficher un
      // « aucun épisode » qui n'apporte rien.
      calendrierEl.hidden = items.length === 0;
    } catch (error) {
      calendrierEl.hidden = true;
    }
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
      if (animeExtra) animeExtra.hidden = !isAnimeTab;
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
    page = 1;
    hasMore = true;
    loading = false;
    totalCardsRendered = 0;
    gridEl.replaceChildren();
    if (emptyMsg) emptyMsg.hidden = true;
  }

  async function loadMore() {
    if (loading || !hasMore) return;
    loading = true;
    const requestedPage = page;
    const currentGeneration = generation;
    const controller = new AbortController();
    listController = controller;

    try {
      const data = await requestJson(listUrl(requestedPage), controller.signal);
      if (currentGeneration !== generation) return;
      const items = Array.isArray(data.items) ? data.items : [];
      const cards = items.map((item, idx) => createCard(item, totalCardsRendered + idx)).filter(Boolean);
      totalCardsRendered += cards.length;
      gridEl.append(...cards);
      hasMore = Boolean(data.has_more);
      page = requestedPage + 1;
      if (requestedPage === 1 && cards.length === 0 && emptyMsg) emptyMsg.hidden = false;
    } catch (error) {
      if (error.name !== "AbortError" && currentGeneration === generation) {
        console.error("Erreur de chargement du catalogue :", error);
        if (requestedPage === 1 && emptyMsg) {
          emptyMsg.hidden = false;
        }
      }
    } finally {
      if (currentGeneration === generation) loading = false;
    }
    // IntersectionObserver ne rappelle sa fonction QUE sur un changement
    // d'intersection. Si la page chargée ne remplit pas l'écran, la sentinelle
    // reste visible sans jamais « ressortir » : la grille s'arrêtait là, bien
    // avant la fin de la liste. On relance donc tant qu'elle est en vue.
    if (
      currentGeneration === generation &&
      hasMore &&
      sentinel &&
      sentinel.getBoundingClientRect().top < window.innerHeight + 600
    ) {
      window.requestAnimationFrame(() => loadMore());
    }
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
      { rootMargin: "600px" },
    );
    observer.observe(sentinel);
  } else {
    window.addEventListener("scroll", () => {
      if (window.innerHeight + window.scrollY >= document.body.offsetHeight - 800) {
        loadMore();
      }
    });
  }

  loadPills();
  loadMore();
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
