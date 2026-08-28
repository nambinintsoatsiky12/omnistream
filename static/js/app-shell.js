/*
 * OmniStream — App Shell
 * ------------------------------------------------------------------
 * - Navigation interne sans rechargement (PJAX) : le lecteur global
 *   reste vivant, la musique ne se coupe plus quand on change de page.
 * - Enregistrement du Service Worker (mode hors ligne + économie de Mo).
 * - Bouton « Installer l'application » (PWA).
 * - Bannière d'état hors ligne.
 */
(function () {
  "use strict";

  /* =========================================================
     1. SERVICE WORKER
     ========================================================= */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("/service-worker.js", { scope: "/" })
        .catch((err) => console.warn("SW non enregistré :", err));
    });
  }

  /* =========================================================
     2. ÉTAT HORS LIGNE
     ========================================================= */
  function updateOnlineStatus() {
    const offline = !navigator.onLine;
    document.body.classList.toggle("is-offline", offline);
    let banner = document.getElementById("offline-banner");
    if (offline) {
      if (!banner) {
        banner = document.createElement("div");
        banner.id = "offline-banner";
        banner.className = "offline-banner";
        banner.innerHTML =
          '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"></path><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"></path><path d="M10.71 5.05A16 16 0 0 1 22.58 9"></path><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"></path><path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path><line x1="12" y1="20" x2="12.01" y2="20"></line></svg>' +
          "<span>Mode hors ligne — contenu enregistré uniquement</span>";
        document.body.appendChild(banner);
      }
    } else if (banner) {
      banner.remove();
    }
  }
  window.addEventListener("online", updateOnlineStatus);
  window.addEventListener("offline", updateOnlineStatus);
  updateOnlineStatus();

  /* =========================================================
     3. INSTALLATION PWA
     ========================================================= */
  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    document.querySelectorAll("[data-pwa-install]").forEach((el) => {
      el.hidden = false;
    });
  });

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-pwa-install]");
    if (!btn || !deferredPrompt) return;
    deferredPrompt.prompt();
    try {
      await deferredPrompt.userChoice;
    } catch (_e) {
      /* noop */
    }
    deferredPrompt = null;
    document.querySelectorAll("[data-pwa-install]").forEach((el) => {
      el.hidden = true;
    });
  });

  window.addEventListener("appinstalled", () => {
    document.querySelectorAll("[data-pwa-install]").forEach((el) => {
      el.hidden = true;
    });
  });

  /* =========================================================
     4. NAVIGATION PJAX (préserve le lecteur global)
     ========================================================= */
  const SWAP_IDS = ["main-content", "page-scripts"];

  function samePage(href) {
    try {
      const u = new URL(href, location.href);
      return u.pathname === location.pathname && u.search === location.search;
    } catch (_e) {
      return false;
    }
  }

  function isInternalNav(a) {
    if (!a) return false;
    if (a.target && a.target !== "_self") return false;
    if (a.hasAttribute("download")) return false;
    if (a.dataset.noPjax !== undefined) return false;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      return false;
    }
    let url;
    try {
      url = new URL(href, location.href);
    } catch (_e) {
      return false;
    }
    if (url.origin !== location.origin) return false;
    // Les pages « lourdes » externes au flux normal restent en nav classique.
    return true;
  }

  async function navigate(url, push) {
    const shell = document.getElementById("main-content");
    if (!shell) {
      location.href = url;
      return;
    }
    document.body.classList.add("pjax-loading");
    try {
      const res = await fetch(url, {
        headers: { "X-Requested-With": "omni-pjax" },
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");

      const newMain = doc.getElementById("main-content");
      if (!newMain) {
        location.href = url;
        return;
      }

      // Remplace le contenu principal
      document.getElementById("main-content").replaceWith(newMain);

      // Met à jour la zone d'onglets du header (catalogue)
      swapTabs(doc);

      // Met à jour le titre
      if (doc.title) document.title = doc.title;

      // Ré-exécute les scripts de page
      runPageScripts(doc);

      // Historique
      if (push) history.pushState({ pjax: true }, "", url);

      // Réinitialise l'affichage
      window.scrollTo(0, 0);
      updateBottomNavActive();
      updateHeaderHeight();
      document.dispatchEvent(new CustomEvent("omni:page-loaded"));
    } catch (err) {
      console.warn("PJAX échec, rechargement complet :", err);
      location.href = url;
      return;
    } finally {
      document.body.classList.remove("pjax-loading");
    }
  }

  function swapTabs(doc) {
    const current = document.getElementById("tabs-wrap");
    const incoming = doc.getElementById("tabs-wrap");
    if (incoming && current) {
      current.replaceWith(incoming);
    } else if (incoming && !current) {
      const header = document.getElementById("topbar");
      if (header) header.appendChild(incoming);
    } else if (!incoming && current) {
      current.remove();
    }
    // Rebranche les fondus latéraux de la barre d'onglets
    bindTabsFade();
  }

  function runPageScripts(doc) {
    const container = document.getElementById("page-scripts");
    if (!container) return;
    const incoming = doc.getElementById("page-scripts");
    container.innerHTML = incoming ? incoming.innerHTML : "";
    const scripts = Array.from(container.querySelectorAll("script"));
    scripts.forEach((old) => {
      const s = document.createElement("script");
      if (old.src) {
        s.src = old.src;
      } else {
        s.textContent = old.textContent;
      }
      Array.from(old.attributes).forEach((attr) => {
        if (attr.name !== "src") s.setAttribute(attr.name, attr.value);
      });
      old.replaceWith(s);
    });
  }

  function updateBottomNavActive() {
    const path = location.pathname;
    const params = new URLSearchParams(location.search);
    const tab = params.get("tab");
    document.querySelectorAll(".bottom-nav-item").forEach((el) => {
      const nav = el.dataset.nav;
      let active = false;
      if (nav === "home" && path === "/" && !tab) active = true;
      else if (nav === "films" && path === "/" && tab === "films") active = true;
      else if (nav === "musique" && path === "/musiques") active = true;
      else if (nav === "downloads" && path === "/telechargements") active = true;
      else if (nav === "library" && path === "/bibliotheque") active = true;
      el.classList.toggle("active", active);
    });
  }

  function updateHeaderHeight() {
    const header = document.getElementById("topbar");
    if (header) {
      document.documentElement.style.setProperty(
        "--header-h",
        header.offsetHeight + "px",
      );
    }
  }

  function bindTabsFade() {
    const tabsBar = document.querySelector(".tabs");
    const tabsWrap = document.getElementById("tabs-wrap");
    if (!tabsBar || !tabsWrap || tabsBar.dataset.fadeBound) return;
    tabsBar.dataset.fadeBound = "1";
    const update = () => {
      const maxScroll = tabsBar.scrollWidth - tabsBar.clientWidth;
      tabsWrap.classList.toggle("at-end", tabsBar.scrollLeft >= maxScroll - 4);
      tabsWrap.classList.toggle("at-start", tabsBar.scrollLeft <= 4);
    };
    tabsBar.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    update();
  }

  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest("a");
    if (!isInternalNav(a)) return;
    const href = a.getAttribute("href");
    if (samePage(href)) return;
    e.preventDefault();
    // Ferme le tiroir si ouvert
    const drawer = document.getElementById("drawer-panel");
    if (drawer && drawer.classList.contains("open")) {
      const backdrop = document.getElementById("drawer-backdrop");
      const burger = document.getElementById("burger-btn");
      drawer.classList.remove("open");
      if (backdrop) backdrop.classList.remove("open");
      if (burger) burger.classList.remove("open");
      document.body.classList.remove("drawer-open");
    }
    navigate(new URL(href, location.href).href, true);
  });

  window.addEventListener("popstate", () => {
    navigate(location.href, false);
  });

  // Init au premier chargement
  updateBottomNavActive();
})();
