(function () {
  "use strict";

  const form = document.getElementById("musique-search-form");
  const input = document.getElementById("musique-search-input");
  const resultsEl = document.getElementById("musique-results");
  const emptyMsg = document.getElementById("musique-empty");
  const loadingMsg = document.getElementById("musique-loading");
  const playerWrap = document.getElementById("musique-player-wrap");
  const player = document.getElementById("musique-player");
  const sectionTitle = document.getElementById("musique-section-title");
  if (!form) return;

  let requestController = null;

  function safeImageUrl(value) {
    if (typeof value !== "string" || !value) return "";
    try {
      const url = new URL(value, window.location.origin);
      return url.protocol === "https:" ? url.href : "";
    } catch (_error) {
      return "";
    }
  }

  function playVideo(videoId) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return;
    player.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1`;
    player.title = "Lecteur YouTube";
    playerWrap.hidden = false;
    playerWrap.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function createCard(item) {
    if (!item || !/^[A-Za-z0-9_-]{11}$/.test(String(item.id || ""))) return null;
    const card = document.createElement("button");
    card.type = "button";
    card.className = "card musique-card";
    card.addEventListener("click", () => playVideo(String(item.id)));

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
