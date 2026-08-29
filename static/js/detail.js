/*
 * OmniStream — Interactions de la fiche (détail).
 * - Bande-annonce à la demande (économie de données).
 * - Ma Liste (favoris) et épinglage hors ligne.
 * - Enregistre la consultation pour « Reprendre ».
 */
(function () {
  "use strict";

  const actions = document.getElementById("detail-actions");
  if (!actions) return;

  const item = {
    media_type: actions.dataset.mediaType,
    id: Number(actions.dataset.id),
    title: actions.dataset.title,
    poster: actions.dataset.poster,
    backdrop: actions.dataset.backdrop,
    tab: actions.dataset.tab,
    // L'URL de la fiche est épinglée elle aussi : le Service Worker la met en
    // cache, donc la fiche entière (synopsis, note, générique) se relit sans
    // réseau. Sans cette clé, « hors ligne » ne voulait rien dire.
    url: `${location.pathname}${location.search}`,
  };

  const trailerKey = actions.dataset.trailer || window.__omniTrailerKey || "";

  // Enregistre la consultation dès l'ouverture de la fiche.
  if (window.OmniLibrary) window.OmniLibrary.recordView(item);

  // « Dans le même univers » sur l'accueil : on se souvient du dernier titre
  // consulté pour que la page d'accueil aille chercher ses œuvres liées.
  try {
    window.localStorage.setItem(
      "omni-dernier-titre",
      JSON.stringify({
        media_type: item.media_type,
        id: item.id,
        titre: item.title,
      }),
    );
  } catch (erreur) {
    /* stockage indisponible : la rangée d'accueil restera simplement cachée */
  }

  // --- Bande-annonce -------------------------------------------------------
  const watchBtn = document.getElementById("watch-btn");
  const box = document.getElementById("trailer-box");
  const frame = document.getElementById("trailer-frame");
  const note = document.getElementById("trailer-note");

  if (watchBtn) {
    watchBtn.addEventListener("click", () => {
      if (!box) return;
      box.hidden = false;
      box.scrollIntoView({ behavior: "smooth", block: "center" });
      if (trailerKey && /^[A-Za-z0-9_-]{11}$/.test(trailerKey)) {
        if (frame && frame.src === "about:blank") {
          frame.src =
            "https://www.youtube-nocookie.com/embed/" +
            trailerKey +
            "?autoplay=1&modestbranding=1&rel=0&playsinline=1";
        }
      } else if (note) {
        note.hidden = false;
        note.textContent =
          "Aucune bande-annonce officielle n'est disponible pour ce titre.";
        if (frame) frame.style.display = "none";
      }
    });
  }

  // --- Favoris -------------------------------------------------------------
  const favBtn = document.getElementById("fav-btn");
  const favOn = favBtn ? favBtn.querySelector(".fav-icon-on") : null;
  const favOff = favBtn ? favBtn.querySelector(".fav-icon-off") : null;
  const favLabel = document.getElementById("fav-label");

  function refreshFav() {
    if (!favBtn || !window.OmniLibrary) return;
    const on = window.OmniLibrary.isFavorite(item);
    favBtn.classList.toggle("on", on);
    favBtn.setAttribute("aria-pressed", String(on));
    if (favOn) favOn.hidden = !on;
    if (favOff) favOff.hidden = on;
    if (favLabel) favLabel.textContent = on ? "Dans ma liste" : "Ma liste";
  }
  if (favBtn) {
    favBtn.addEventListener("click", () => {
      if (window.OmniLibrary) window.OmniLibrary.toggleFavorite(item);
      refreshFav();
    });
    refreshFav();
  }

  // --- Partager ------------------------------------------------------------
  const shareBtn = document.getElementById("share-btn");
  const shareLabel = document.getElementById("share-label");
  if (shareBtn) {
    shareBtn.addEventListener("click", async () => {
      const shareData = {
        title: item.title + " — OmniStream",
        text: "Regarde « " + item.title + " » sur OmniStream",
        url: location.href,
      };
      if (navigator.share) {
        try {
          await navigator.share(shareData);
        } catch (_e) {
          /* partage annulé */
        }
      } else if (navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(location.href);
          if (shareLabel) {
            const prev = shareLabel.textContent;
            shareLabel.textContent = "Lien copié ✓";
            setTimeout(() => {
              shareLabel.textContent = prev;
            }, 1800);
          }
        } catch (_e) {
          /* presse-papier indisponible */
        }
      }
    });
  }

  // --- Hors ligne ----------------------------------------------------------
  const offBtn = document.getElementById("offline-btn");
  const offLabel = document.getElementById("offline-label");

  function refreshOffline() {
    if (!offBtn || !window.OmniLibrary) return;
    const on = window.OmniLibrary.isOffline(item);
    offBtn.classList.toggle("on", on);
    offBtn.setAttribute("aria-pressed", String(on));
    if (offLabel) offLabel.textContent = on ? "Épinglé ✓" : "Épingler hors ligne";
  }
  if (offBtn) {
    offBtn.addEventListener("click", async () => {
      if (!window.OmniLibrary) return;
      if (window.OmniLibrary.isOffline(item)) {
        window.OmniLibrary.removeOffline(item);
        if (window.OmniUI) window.OmniUI.toast("Retiré du hors ligne.", "ok");
      } else {
        offBtn.disabled = true;
        offBtn.classList.add("busy");
        if (offLabel) offLabel.textContent = "Enregistrement…";
        await window.OmniLibrary.saveOffline(item);
        offBtn.disabled = false;
        offBtn.classList.remove("busy");
        if (window.OmniUI) {
          window.OmniUI.toast("Fiche et affiche mises en cache : lisibles hors ligne.", "ok");
        }
      }
      refreshOffline();
    });
    refreshOffline();
  }
})();
