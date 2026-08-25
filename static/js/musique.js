(function () {
  const form = document.getElementById("musique-search-form");
  const input = document.getElementById("musique-search-input");
  const resultsEl = document.getElementById("musique-results");
  const emptyMsg = document.getElementById("musique-empty");
  const loadingMsg = document.getElementById("musique-loading");
  const playerWrap = document.getElementById("musique-player-wrap");
  const player = document.getElementById("musique-player");

  if (!form) return;

  function cardHtml(item) {
    return `
      <a class="card musique-card" href="#" data-id="${item.id}">
        <div class="poster" style="background-image:url('${item.thumbnail}')"></div>
        <div class="card-info">
          <div class="card-title">${item.title}</div>
          <div class="card-date">${item.channel}</div>
        </div>
      </a>`;
  }

  async function search(query) {
    resultsEl.innerHTML = "";
    emptyMsg.hidden = true;
    loadingMsg.hidden = false;

    try {
      const res = await fetch(`/api/musique-search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      loadingMsg.hidden = true;

      const items = data.items || [];
      if (items.length === 0) {
        emptyMsg.hidden = false;
        return;
      }

      resultsEl.innerHTML = items.map(cardHtml).join("");

      resultsEl.querySelectorAll(".musique-card").forEach((card) => {
        card.addEventListener("click", (e) => {
          e.preventDefault();
          playVideo(card.dataset.id);
        });
      });
    } catch (e) {
      loadingMsg.hidden = true;
      console.error("Erreur recherche musique:", e);
    }
  }

  function playVideo(videoId) {
    player.src = `https://www.youtube.com/embed/${videoId}?autoplay=1`;
    playerWrap.style.display = "block";
    playerWrap.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q) search(q);
  });
})();
