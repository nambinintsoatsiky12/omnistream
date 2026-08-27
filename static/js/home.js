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
      poster.textContent = "Affiche indisponible";
    }
    return poster;
  }

  function createRatingBadge(rating) {
    const badge = document.createElement("span");
    badge.className = "rating-badge";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M12 2l2.9 6.6 7.1.6-5.4 4.7 1.7 7-6.3-3.9L5.7 21l1.7-7L2 9.2l7.1-.6z",
    );
    svg.appendChild(path);
    badge.append(svg, document.createTextNode(String(rating ?? 0)));
    return badge;
  }

  function createCard(item) {
    const href = detailUrl(item);
    if (!href) return null;

    const card = document.createElement("a");
    card.className = "card";
    card.href = href;

    const poster = createPoster(item, false);
    poster.appendChild(createRatingBadge(item.rating));

    const info = document.createElement("div");
    info.className = "card-info";
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = String(item.title || "Sans titre");
    info.appendChild(title);

    if (tab === "nouveautes") {
      const date = document.createElement("div");
      date.className = "card-date";
      date.textContent = `Sortie : ${formatDate(item.date) || "date inconnue"}`;
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
      const items = seededShuffle(
        rawItems.filter((item) => detailUrl(item)),
        `hero-${tab}-${activeGenre}-${sessionSeed}`,
      ).slice(0, 5);
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
        const title = document.createElement("h2");
        title.textContent = String(item.title || "Sans titre");
        const metadata = document.createElement("p");
        const rating = Number(item.rating);
        const ratingText = Number.isFinite(rating) && rating > 0 ? rating.toFixed(1) : "N/A";
        metadata.textContent = `★ ${ratingText} · ${formatDate(item.date) || item.year || "Date inconnue"}`;
        copy.append(title, metadata);

        const link = document.createElement("a");
        link.className = "hero-play";
        link.href = detailUrl(item);
        link.textContent = "▶";
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
      { id: "all", label: "Tout" },
      { id: "movie", label: "Films" },
      { id: "tv", label: "Séries" },
      { id: "anime", label: "Animes" },
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
    gridEl.replaceChildren();
    emptyMsg.hidden = true;
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
      const cards = items.map(createCard).filter(Boolean);
      gridEl.append(...cards);
      hasMore = Boolean(data.has_more);
      page = requestedPage + 1;
      if (requestedPage === 1 && cards.length === 0) emptyMsg.hidden = false;
    } catch (error) {
      if (error.name !== "AbortError" && currentGeneration === generation) {
        console.error("Erreur de chargement du catalogue :", error);
        if (requestedPage === 1) {
          emptyMsg.textContent = error.message || "Impossible de charger le catalogue.";
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
