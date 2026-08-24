(function () {
  const root = document.getElementById("app-root");
  if (!root) return;

  const tab = root.dataset.tab || "films";
  const gridEl = document.getElementById("grid");
  const sentinel = document.getElementById("sentinel");
  const emptyMsg = document.getElementById("grid-empty");
  const pillsEl = document.getElementById("pills");

  let page = 1;
  let hasMore = true;
  let loading = false;
  let activeGenre = "all";

  const sessionSeed = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function seededRandom(seedStr) {
    let h = 1779033703 ^ seedStr.length;
    for (let i = 0; i < seedStr.length; i++) {
      h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return (h >>> 0) / 4294967296;
    };
  }

  function seededShuffle(array, seedStr) {
    const rng = seededRandom(seedStr);
    const result = array.slice();
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  // --- VARIABLES GLOBALES ---
  window.isVipMode = false;
  window.savedVipPin = "";
  window.currentVipPage = 1;
  window.vipHasMore = true;
  window.isLoadingVip = false;

  function listUrl(p) {
    if (tab === "nouveautes") {
      return `/api/upcoming?type=${encodeURIComponent(activeGenre)}&page=${p}&seed=${sessionSeed}`;
    }
    if (tab === "legendes") {
      return `/api/legends?type=${encodeURIComponent(activeGenre)}&page=${p}&seed=${sessionSeed}`;
    }
    return `/api/list?tab=${encodeURIComponent(tab)}&genre=${encodeURIComponent(activeGenre)}&page=${p}&seed=${sessionSeed}`;
  }

  function formatDate(dStr) {
    if (!dStr) return "";
    const parts = dStr.split("-");
    if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    return dStr;
  }

  // --- CARROUSEL HERO ---
  async function loadHero() {
    const track = document.getElementById("hero-track");
    const dotsEl = document.getElementById("hero-dots");
    if (!track || !dotsEl) return;

    try {
      const res = await fetch(listUrl(1));
      const data = await res.json();

      let items = data.items || [];
      items = seededShuffle(items, `hero-${tab}-${activeGenre}-${sessionSeed}`).slice(0, 5);

      if (!items || items.length === 0) return;

      const heroSection = document.getElementById("hero");
      if(heroSection) heroSection.style.display = "block";

      track.innerHTML = items.map((item, idx) => {
        let bgUrl = item.backdrop || item.poster || "";
        if (bgUrl.startsWith("/")) bgUrl = "https://image.tmdb.org/t/p/original" + bgUrl;

        let posterUrl = item.poster || item.backdrop || "";
        if (posterUrl.startsWith("/")) posterUrl = "https://image.tmdb.org/t/p/w200" + posterUrl;

        let year = "Bientôt";
        let rawD = item.date || item.release_date || item.first_air_date || "";

        if (!rawD && item.startDate && item.startDate.year) {
            const y = item.startDate.year;
            const m = String(item.startDate.month || 1).padStart(2, '0');
            const d = String(item.startDate.day || 1).padStart(2, '0');
            rawD = `${y}-${m}-${d}`;
        }

        if (rawD && rawD.includes('-')) {
            const [y, m, d] = rawD.split('-');
            year = `${d}/${m}/${y.slice(-2)}`;
        } else if (item.year) {
            year = item.year;
        }
        const rating = item.rating ? parseFloat(item.rating).toFixed(1) : "N/A";

        return `
          <div class="hero-slide ${idx === 0 ? "active" : ""}" style="background: url('${bgUrl}') top center/cover no-repeat;">
            <div style="position: absolute; bottom: 0; left: 0; right: 0; height: 70%; background: linear-gradient(to top, #0a0a0f 10%, transparent); z-index: 1;"></div>
            <div style="position: absolute; bottom: 30px; left: 15px; right: 15px; z-index: 2; display: flex; align-items: center; gap: 15px;">
              <img src="${posterUrl}" style="width: 65px; height: 95px; border-radius: 8px; object-fit: cover; box-shadow: 0 4px 15px rgba(0,0,0,0.8); border: 1px solid rgba(255,255,255,0.1);">
              <div style="flex: 1; text-align: left; text-shadow: 2px 2px 4px rgba(0,0,0,0.9);">
                <h1 style="font-size: 1.2rem; margin: 0 0 6px 0; font-weight: 800; color: #fff; line-height: 1.2; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">
                  ${item.title}
                </h1>
                <p style="font-size: 0.85rem; margin: 0; color: #d1d1d1; font-weight: bold;">
                  <span style="color: #ffaa00;">★ ${rating}</span> &nbsp;|&nbsp; 📅 ${year}
                </p>
              </div>
              <a href="/details/${item.media_type || (tab === 'films' ? 'movie' : 'tv')}/${item.id}?tab=${encodeURIComponent(tab)}" style="background: linear-gradient(45deg, #00d2ff, #0077ff); width: 32px; height: 32px; border-radius: 50%; display: flex; justify-content: center; align-items: center; color: white; text-decoration: none; box-shadow: 0 4px 10px rgba(0, 119, 255, 0.4); flex-shrink: 0; font-size: 0.9rem;">
                ▶
              </a>
            </div>
          </div>
        `;
      }).join("");

      dotsEl.innerHTML = items.map((_, idx) => `
        <button class="dot ${idx === 0 ? "active" : ""}" data-idx="${idx}"></button>
      `).join("");

      let current = 0;
      const slides = track.querySelectorAll(".hero-slide");
      const dots = dotsEl.querySelectorAll(".dot");

      function show(i) {
        if(slides.length === 0) return;
        slides[current].classList.remove("active");
        dots[current].classList.remove("active");
        current = (i + slides.length) % slides.length;
        slides[current].classList.add("active");
        dots[current].classList.add("active");
      }

      dots.forEach(d => d.addEventListener("click", () => show(parseInt(d.dataset.idx, 10))));

      if(window.heroInterval) clearInterval(window.heroInterval);
      window.heroInterval = setInterval(() => show(current + 1), 6000);

    } catch (e) {
      console.error("Erreur chargement Hero:", e);
    }
  }

  function buildDetailUrl(item) {
    const mt = item.media_type || (tab === "films" ? "movie" : "tv");
    return `/details/${mt}/${item.id}?tab=${encodeURIComponent(tab)}`;
  }

  // --- PASTILLES / GENRES (REDIRECTION ANTI-BLOCAGE POPUP) ---
  async function loadPills() {
    let pills;
    if (tab === "nouveautes" || tab === "legendes") {
      pills = [
        { id: "all", label: "Tout" },
        { id: "movie", label: "Films" },
        { id: "tv", label: "Séries" },
        { id: "anime", label: "Animes" },
      ];
    } else {
      const res = await fetch(`/api/genres?tab=${encodeURIComponent(tab)}`);
      const data = await res.json();
      pills = data.pills || [];
    }

    pillsEl.innerHTML = pills
      .map((p) => `<button class="pill${p.id === "all" ? " active" : ""}" data-id="${p.id}">${p.label}</button>`)
      .join("");

    pillsEl.querySelectorAll(".pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.id === activeGenre) return;

        // Si l'utilisateur clique sur "Plus pertinent 🔥", redirection immédiate sans blocage
        const btnText = btn.textContent.toLowerCase();
        if (btnText.includes("pertinent")) {
          window.location.href = "https://omg10.com/4/11645531";
          return;
        }

        pillsEl.querySelectorAll(".pill").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        activeGenre = btn.dataset.id;
        resetGrid();
        loadMore();
      });
    });
  }

  // --- GRILLE & SCROLL INFINI CLASSIQUE ---
  const STAR_SVG = '<svg viewBox="0 0 24 24"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.7 7-6.3-3.9L5.7 21l1.7-7L2 9.2l7.1-.6z"/></svg>';

  function cardHtml(item) {
    const dateLine = tab === "nouveautes" ? `<div class="card-date">Sortie : ${formatDate(item.date)}</div>` : "";
    return `
      <a class="card" href="${buildDetailUrl(item)}">
        <div class="poster" style="background-image:url('${item.poster || ""}')">
          <span class="rating-badge">${STAR_SVG}${item.rating}</span>
        </div>
        <div class="card-info">
          <div class="card-title">${item.title}</div>
          ${dateLine}
        </div>
      </a>`;
  }

  function resetGrid() {
    page = 1;
    hasMore = true;
    gridEl.innerHTML = "";
    emptyMsg.hidden = true;
    window.isVipMode = false;
  }

  async function loadMore() {
    if (loading || !hasMore || window.isVipMode) return;
    loading = true;

    try {
        const res = await fetch(listUrl(page));
        const data = await res.json();
        const items = data.items || [];

        gridEl.insertAdjacentHTML("beforeend", items.map(cardHtml).join(""));

        hasMore = !!data.has_more;
        page += 1;
        loading = false;

        if (page === 2 && items.length === 0) emptyMsg.hidden = false;
    } catch (e) {
        console.error("Erreur LoadMore:", e);
        loading = false;
    }
  }

  const observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting && !window.isVipMode) {
          loadMore();
      }
    },
    { rootMargin: "600px" }
  );

  if (sentinel) observer.observe(sentinel);

  loadHero();
  loadPills();
  loadMore();
})();


// ==========================================
// FONCTIONS VIP / SAINTE ARÈNE (Globales)
// ==========================================

function openAdultSection() {
  const modal = document.getElementById("vipModal");
  if (modal) modal.style.display = "block";
}

function closeVipModal() {
  const modal = document.getElementById("vipModal");
  if (modal) modal.style.display = "none";
}

function submitVipPin() {
  const pinInput = document.getElementById("vipPinInput");
  const savedVipPin = pinInput ? pinInput.value.trim() : "";

  if (savedVipPin !== "/admin") {
    alert("Code PIN incorrect !");
    return;
  }

  closeVipModal();
  showArenaWelcomeOverlay();

  const hero = document.getElementById("hero");
  if (hero) hero.style.display = "none";
  const pills = document.getElementById("pills");
  if (pills) pills.style.display = "none";
  const gridEl = document.getElementById("grid");
  if (gridEl) gridEl.innerHTML = '';

  const root = document.getElementById("app-root");
  if (root && !document.getElementById("vip-badge")) {
    root.insertAdjacentHTML('afterbegin', '<div id="vip-badge" style="text-align: right; padding: 10px; color: #ff0055; font-size: 0.9rem; font-weight: bold; letter-spacing: 1px;">Mode VIP Actif</div>');
  }

  window.isVipMode = true;
  window.currentVipPage = 1;
  window.vipHasMore = true;

  fetchAniListVip(1);
}

function fetchAniListVip(page) {
  if (window.isLoadingVip) return;
  window.isLoadingVip = true;

  const query = `
  query ($page: Int) {
    Page(page: $page, perPage: 20) {
      pageInfo { hasNextPage }
      media(isAdult: true, type: ANIME, sort: POPULARITY_DESC) {
        id
        title { romaji }
        coverImage { extraLarge }
        averageScore
      }
    }
  }
  `;

  fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query: query, variables: { page: page } })
  })
    .then(res => res.json())
    .then(data => {
      const mediaList = data.data.Page.media;
      window.currentVipPage = page;
      window.vipHasMore = data.data.Page.pageInfo.hasNextPage;

      const items = mediaList.map(item => ({
        id: item.id,
        title: item.title.romaji || "Inconnu",
        poster: item.coverImage.extraLarge || "",
        rating: item.averageScore ? (item.averageScore / 10).toFixed(1) : 0
      }));

      renderVipCards(items);
      window.isLoadingVip = false;
    })
    .catch(err => {
      console.error("Erreur AniList:", err);
      window.isLoadingVip = false;
    });
}

function showArenaWelcomeOverlay() {
  const overlay = document.createElement("div");
  overlay.id = "arena-overlay";
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(10, 10, 15, 0.95); z-index: 99999;
    display: flex; justify-content: center; align-items: center;
    text-align: center; padding: 20px;
  `;
  overlay.innerHTML = `<h1 style="font-size: 2.2rem; font-weight: 900; background: linear-gradient(45deg, #ff0055, #ff5500, #00d2ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; text-transform: uppercase; letter-spacing: 2px;">🔥 BIENVENUE DANS LA SAINTE ARÈNE 🔥</h1>`;
  document.body.appendChild(overlay);
  setTimeout(() => { if (overlay) overlay.remove(); }, 3000);
}

function renderVipCards(items) {
  const gridEl = document.getElementById("grid");
  if (!gridEl) return;
  const htmlCards = items.map(item => `
    <a class="card" href="/details-vip?titre=${encodeURIComponent(item.title)}&poster=${encodeURIComponent(item.poster)}">
      <div class="poster" style="background-image:url('${item.poster}')">
        <span class="rating-badge">★ ${item.rating}</span>
      </div>
      <div class="card-info">
        <div class="card-title">${item.title}</div>
      </div>
    </a>
  `).join("");
  gridEl.insertAdjacentHTML("beforeend", htmlCards);
}

window.addEventListener("scroll", () => {
  if (!window.isVipMode || !window.vipHasMore || window.isLoadingVip) return;
  const { scrollTop, scrollHeight, clientHeight } = document.documentElement;
  if (scrollTop + clientHeight >= scrollHeight - 300) {
    fetchAniListVip(window.currentVipPage + 1);
  }
});
