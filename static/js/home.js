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

  let page = 1;
  let hasMore = true;
  let loading = false;
  let activeGenre = "all";
  let generation = 0;
  let listController = null;
  let heroController = null;
  let heroTimer = null;
  let totalCardsRendered = 0;

  const sessionSeed =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

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
    return `/api/list?${params}`;
  }

  function heroUrl() {
    if (
      activeGenre === "all" &&
      ["films", "series", "animes", "animation_occidentale"].includes(tab)
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
    if (!["movie", "tv"].includes(mediaType) || !Number.isInteger(itemId) || itemId <= 0) {
      return null;
    }
    const params = new URLSearchParams({ tab });
    return `/details/${mediaType}/${itemId}?${params}`;
  }

  function createPoster(item, compact) {
    const poster = document.createElement("div");
    poster.className = compact ? "hero-poster" : "poster";
    const source = safeImageUrl(item.poster || item.backdrop);
    if (source) {
      const image = document.createElement("img");
      image.className = compact ? "hero-poster-img" : "poster-img";
      image.src = source;
      image.alt = `Affiche de ${String(item.title || "ce titre")}`;
      image.loading = compact ? "eager" : "lazy";
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
      tab,
    };
  }

  function createFavButton(item) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "card-fav-btn";
    btn.setAttribute("aria-label", "Ajouter à ma liste");
    const payload = favPayload(item);
    const refresh = () => {
      const on = window.OmniLibrary && window.OmniLibrary.isFavorite(payload);
      btn.classList.toggle("on", !!on);
      btn.innerHTML = on
        ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
    };
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (window.OmniLibrary) window.OmniLibrary.toggleFavorite(payload);
      refresh();
    });
    refresh();
    return btn;
  }

  function createCard(item, index) {
    const href = detailUrl(item);
    if (!href) return null;

    const card = document.createElement("a");
    card.className = "card moviebox-card";
    card.href = href;

    const poster = createPoster(item, false);

    // MovieBox-style ranking badge on top items
    if (page === 2 && index < 10 && activeGenre === "all") {
      poster.appendChild(createRankBadge(index + 1));
    } else {
      poster.appendChild(createQualityBadge());
    }

    poster.appendChild(createRatingBadge(item.rating));
    poster.appendChild(createFavButton(item));

    const info = document.createElement("div");
    info.className = "card-info";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = String(item.title || "Sans titre");

    const metaLine = document.createElement("div");
    metaLine.className = "card-meta-line";

    const yearText = item.year || (item.date ? String(item.date).slice(0, 4) : "");
    const mediaTypeLabel = tab === "animes" ? "Anime" : (item.media_type === "tv" ? "Série" : "Film");

    metaLine.innerHTML = `<span class="card-year">${yearText || "2024"}</span><span class="card-dot">•</span><span class="card-type-tag">${mediaTypeLabel}</span>`;

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
        heroTimer = window.setInterval(() => show(current + 1), 6000);
      }
    } catch (error) {
      if (error.name !== "AbortError") {
        console.error("Erreur de chargement du bandeau :", error);
        if (currentGeneration === generation) hideHero();
      }
    }
  }

  function specialPills() {
    return [
      { id: "all", label: "Tous les genres" },
      { id: "movie", label: "Films" },
      { id: "tv", label: "Séries TV" },
      { id: "anime", label: "Animés JP" },
    ];
  }

  async function loadPills() {
    try {
      const pills = ["nouveautes", "legendes"].includes(tab)
        ? specialPills()
        : (await requestJson(`/api/genres?tab=${encodeURIComponent(tab)}`)).pills || [];
      const buttons = pills.map((pill) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `pill${pill.id === activeGenre ? " active" : ""}`;
        button.dataset.id = String(pill.id);
        button.textContent = String(pill.label);
        button.addEventListener("click", () => {
          if (button.dataset.id === activeGenre) return;
          activeGenre = button.dataset.id;
          pillsEl.querySelectorAll(".pill").forEach((item) => {
            item.classList.toggle("active", item === button);
          });
          generation += 1;
          resetGrid();
          loadHero();
          loadMore();
        });
        return button;
      });
      pillsEl.replaceChildren(...buttons);
    } catch (error) {
      console.error("Erreur de chargement des genres :", error);
      pillsEl.replaceChildren();
    }
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

  loadHero();
  loadPills();
  loadMore();
})();
