/*
 * OmniStream — App Shell
 * ------------------------------------------------------------------
 * - Navigation interne sans rechargement (PJAX) : le lecteur global reste
 *   vivant, la musique ne se coupe plus quand on change de page.
 * - Service Worker : mode hors ligne + économie de Mo, avec proposition de
 *   rechargement dès qu'une nouvelle version est prête.
 * - Bouton « Installer l'application » (PWA), bannière hors ligne,
 *   notifications discrètes (window.OmniUI.toast).
 */
(function () {
  "use strict";

  if (window.__omniShellBooted) return;
  window.__omniShellBooted = true;

  /* =========================================================
     0. NOTIFICATIONS DISCRÈTES
     ========================================================= */
  function toast(message, kind) {
    const text = String(message || "").trim();
    if (!text) return;
    let host = document.getElementById("omni-toasts");
    if (!host) {
      host = document.createElement("div");
      host.id = "omni-toasts";
      host.className = "omni-toasts";
      host.setAttribute("role", "status");
      host.setAttribute("aria-live", "polite");
      document.body.appendChild(host);
    }
    const pill = document.createElement("div");
    pill.className = `omni-toast ${kind || ""}`.trim();
    pill.textContent = text;
    host.appendChild(pill);
    // Au plus 3 messages, et ils disparaissent seuls.
    while (host.children.length > 3) host.removeChild(host.firstChild);
    window.setTimeout(() => {
      pill.classList.add("out");
      window.setTimeout(() => pill.remove(), 300);
    }, 2600);
  }

  window.OmniUI = {
    toast,
    // Le compteur d'octets économisés vit dans localStorage ; cette aide
    // permet de le consulter comme de le remettre à zéro depuis la page
    // « Hors ligne » (avant, le chiffre ne voulait plus rien dire).
    savedBytes: () => {
      try {
        return Number(window.localStorage.getItem("omni:saved-bytes") || 0);
      } catch (_error) {
        return 0;
      }
    },
    resetSavedBytes: () => {
      try {
        window.localStorage.removeItem("omni:saved-bytes");
      } catch (_error) {
        /* noop */
      }
      document.dispatchEvent(new CustomEvent("omni:saved-bytes-change"));
    },
  };

  /* =========================================================
     0bis. RÉVÉLATION AU DÉFILEMENT (page d'accueil)
     =========================================================
     Ce gestionnaire vit ici (et non dans la page d'accueil) parce que la
     navigation interne remplace le contenu sans exécuter les scripts de la
     page : avant, l'accueil arrivait donc avec tous ses blocs encore
     invisibles (opacity:0) et rien ne s'affichait. Il se branche une seule
     fois, puis traite chaque nouveau contenu (chargement initial, navigation
     PJAX, retour de l'historique) de façon idempotente. */
  window.OmniReveal = {
    scan() {
      const els = document.querySelectorAll(".reveal:not(.in-view):not(.js-hide)");
      if (!els.length) return;
      if (!("IntersectionObserver" in window)) {
        // Navigateur ancien : on révèle tout, sans animation.
        els.forEach((el) => el.classList.add("in-view"));
        return;
      }
      // Le masque est posé par JavaScript, juste avant l'observation : si le
      // script échouait avant cette ligne, le contenu resterait visible.
      els.forEach((el) => el.classList.add("js-hide"));
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("in-view");
          entry.target.classList.remove("js-hide");
          io.unobserve(entry.target);
        });
      }, { threshold: 0.1 });
      els.forEach((el) => io.observe(el));
      // Filet de sécurité : aucun contenu ne doit rester invisible si
      // l'observateur ne se déclenche pas (page restaurée, scroll gelé…).
      window.setTimeout(() => {
        els.forEach((el) => {
          el.classList.add("in-view");
          el.classList.remove("js-hide");
        });
      }, 2500);
    },
  };

  document.addEventListener("omni:page-loaded", () => window.OmniReveal.scan());
  window.addEventListener("pageshow", () => window.OmniReveal.scan());
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => window.OmniReveal.scan(), { once: true });
  } else {
    window.OmniReveal.scan();
  }

  /* =========================================================
     1. SERVICE WORKER
     ========================================================= */
  let waitingWorker = null;

  function askWorker(message) {
    return new Promise((resolve) => {
      if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) {
        resolve(null);
        return;
      }
      const channel = new MessageChannel();
      const timer = window.setTimeout(() => resolve(null), 4000);
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timer);
        resolve(event.data);
      };
      navigator.serviceWorker.ready
        .then((registration) => registration.active && registration.active.postMessage(message, [channel.port2]))
        .catch(() => {
          window.clearTimeout(timer);
          resolve(null);
        });
    });
  }

  window.OmniSW = { ask: askWorker };

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("/service-worker.js", { scope: "/" })
        .then((registration) => {
          // On vérifie périodiquement qu'une nouvelle version existe : le
          // téléphone reçoit les correctifs sans réinstaller quoi que ce soit.
          registration.addEventListener("updatefound", () => {
            const fresh = registration.installing;
            if (!fresh) return;
            fresh.addEventListener("statechange", () => {
              if (fresh.state === "installed" && navigator.serviceWorker.controller) {
                waitingWorker = fresh;
                offerReload();
              }
            });
          });
          window.setInterval(() => {
            registration.update().catch(() => undefined);
          }, 30 * 60 * 1000);
        })
        .catch((error) => console.warn("Service worker non enregistré :", error));

      // Cumule les octets évités grâce au cache (données non re-téléchargées).
      navigator.serviceWorker.addEventListener("message", (event) => {
        const data = event.data || {};
        if (data.type !== "omni-saved-bytes" || !data.bytes) return;
        try {
          const previous = Number(window.localStorage.getItem("omni:saved-bytes") || 0);
          window.localStorage.setItem("omni:saved-bytes", String(previous + Number(data.bytes)));
          document.dispatchEvent(new CustomEvent("omni:saved-bytes-change"));
        } catch (_error) {
          /* noop */
        }
      });
    });
  }

  function offerReload() {
    if (document.getElementById("omni-update-bar")) return;
    const bar = document.createElement("div");
    bar.id = "omni-update-bar";
    bar.className = "omni-update-bar";
    bar.innerHTML =
      '<span>OmniStream a été mis à jour.</span>' +
      '<button type="button" data-omni-reload>Recharger</button>' +
      '<button type="button" class="ghost" data-omni-dismiss aria-label="Plus tard">×</button>';
    document.body.appendChild(bar);
    bar.addEventListener("click", (event) => {
      if (event.target.closest("[data-omni-dismiss]")) {
        bar.remove();
        return;
      }
      if (waitingWorker) {
        try {
          waitingWorker.postMessage("skipWaiting");
        } catch (_error) {
          /* noop */
        }
      }
      navigator.serviceWorker
        .getRegistration()
        .then((registration) => registration && registration.active && registration.active.postMessage("skipWaiting"))
        .catch(() => undefined);
      window.location.reload();
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
          '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"></path><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"></path><path d="M10.71 5.05A16 16 0 0 1 22.58 9"></path><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"></path><path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path><line x1="12" y1="20" x2="12.01" y2="20"></line></svg>' +
          "<span>Hors ligne — vos éléments enregistrés restent consultables</span>";
        document.body.appendChild(banner);
      }
    } else if (banner) {
      banner.remove();
    }
  }
  window.addEventListener("online", () => {
    updateOnlineStatus();
    toast("Connexion rétablie.", "ok");
  });
  window.addEventListener("offline", () => {
    updateOnlineStatus();
    toast("Plus de réseau : lecture impossible, mais vos enregistrements restent lisibles.", "warn");
  });
  updateOnlineStatus();

  // Demande une fois le stockage « persistant » : le navigateur ne pourra
  // pas jeter silencieusement favoris et cache quand l'espace disque manque.
  if (window.OmniLibrary && window.OmniLibrary.requestPersistence) {
    window.OmniLibrary.requestPersistence().catch(() => false);
  }

  /* =========================================================
     3. INSTALLATION PWA
     ========================================================= */
  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    document.querySelectorAll("[data-pwa-install]").forEach((el) => {
      el.hidden = false;
    });
  });

  document.addEventListener("click", async (event) => {
    // Seule la VRAIE étiquette « Installer » déclenche l'invite ; le conteneur
    // de la carte porte le même attribut (pour son affichage) et ne doit pas
    // réagir à un clic dans le vide.
    const btn = event.target.closest("button[data-pwa-install]");
    if (!btn) return;
    if (!deferredPrompt) {
      toast("Utilisez le menu « Ajouter à l'écran d'accueil » du navigateur.", "info");
      return;
    }
    event.preventDefault();
    deferredPrompt.prompt();
    try {
      await deferredPrompt.userChoice;
    } catch (_error) {
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
    toast("OmniStream est installé sur votre appareil.", "ok");
  });

  /* =========================================================
     4. NAVIGATION PJAX (préserve le lecteur global)
     ========================================================= */
  const prefetched = new Set();

  function isRealAnchor(anchor, event) {
    if (!anchor) return false;
    if (event && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return false;
    if (event && event.button !== undefined && event.button !== 0) return false;
    if (anchor.target && anchor.target !== "_self") return false;
    if (anchor.hasAttribute("download")) return false;
    if (anchor.dataset.noPjax !== undefined) return false;
    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return false;
    try {
      return new URL(href, location.href).origin === location.origin;
    } catch (_error) {
      return false;
    }
  }

  function samePage(href) {
    try {
      const url = new URL(href, location.href);
      return url.pathname === location.pathname && url.search === location.search;
    } catch (_error) {
      return false;
    }
  }

  // Filet de visibilité : sans indicateur, un tap sur un lien paraît ignoré
  // pendant toute la durée du chargement de la page suivante.
  function showProgressBar() {
    if (document.getElementById("pjax-bar")) return;
    const bar = document.createElement("div");
    bar.id = "pjax-bar";
    bar.className = "pjax-bar";
    bar.setAttribute("aria-hidden", "true");
    document.body.appendChild(bar);
  }

  function hideProgressBar() {
    const bar = document.getElementById("pjax-bar");
    if (!bar) return;
    bar.classList.add("done");
    window.setTimeout(() => bar.remove(), 260);
  }

  async function navigate(url, push) {
    const shell = document.getElementById("main-content");
    if (!shell) {
      location.href = url;
      return;
    }
    document.body.classList.add("pjax-loading");
    showProgressBar();
    try {
      const response = await fetch(url, {
        headers: { "X-Requested-With": "omni-pjax" },
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const newMain = doc.getElementById("main-content");
      if (!newMain) {
        location.href = url;
        return;
      }

      // Les anciens écouteurs liés à la page sortante sont supprimés d'un
      // coup : sans cela, chaque navigation empilait ses gestionnaires et
      // l'interface devenait de plus en plus lente.
      if (window.__omniPageAbort) window.__omniPageAbort.abort();
      window.__omniPageAbort = new AbortController();

      document.getElementById("main-content").replaceWith(newMain);
      swapTabs(doc);
      if (doc.title) document.title = doc.title;
      runPageScripts(doc);
      if (push) history.pushState({ pjax: true }, "", url);
      window.scrollTo({ top: 0, behavior: "auto" });
      updateBottomNavActive();
      updateHeaderHeight();
      if (window.OmniPlayer) window.OmniPlayer.render();
      document.dispatchEvent(new CustomEvent("omni:page-loaded"));
    } catch (error) {
      console.warn("Navigation interne en échec, rechargement complet :", error);
      location.href = url;
    } finally {
      document.body.classList.remove("pjax-loading");
      hideProgressBar();
    }
  }

  function swapTabs(doc) {
    const current = document.getElementById("tabs-wrap");
    const incoming = doc.getElementById("tabs-wrap");
    if (incoming && current) current.replaceWith(incoming);
    else if (incoming && !current) {
      const header = document.getElementById("topbar");
      if (header) header.appendChild(incoming);
    } else if (!incoming && current) current.remove();
    bindTabsFade();
  }

  function runPageScripts(doc) {
    const container = document.getElementById("page-scripts");
    if (!container) return;
    const incoming = doc.getElementById("page-scripts");
    container.innerHTML = incoming ? incoming.innerHTML : "";
    const pending = Array.from(container.querySelectorAll("script"));
    // Les scripts de page sont insérés UN PAR UN, dans l'ordre : un fichier
    // qui appelle window.OmniPlayer / window.OmniLibrary est ainsi certain
    // de trouver l'autre (c'était la cause des « boutons sans effet » au
    // premier tap après une navigation interne).
    let chain = Promise.resolve();
    pending.forEach((old) => {
      chain = chain.then(
        () =>
          new Promise((resolve) => {
            const script = document.createElement("script");
            if (!old.src) {
              script.textContent = old.textContent;
              old.replaceWith(script);
              resolve();
              return;
            }
            script.src = old.src;
            script.onload = resolve;
            script.onerror = resolve;
            old.replaceWith(script);
          }),
      );
    });
  }

  function updateBottomNavActive() {
    const path = location.pathname;
    const tab = new URLSearchParams(location.search).get("tab");
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
      document.documentElement.style.setProperty("--header-h", `${header.offsetHeight}px`);
    }
  }
  window.__omniUpdateHeaderHeight = updateHeaderHeight;

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

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented) return;
    const anchor = event.target.closest("a");
    if (!isRealAnchor(anchor, event)) return;
    const href = anchor.getAttribute("href");
    if (samePage(href)) {
      // Même page : on remonte en haut plutôt que de recharger pour rien.
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    event.preventDefault();
    closeDrawer();
    navigate(new URL(href, location.href).href, true);
  });

  // Anticipation : dès que le doigt se pose sur un lien, la page suivante est
  // demandée. Le tap suivant trouve donc du HTML déjà chaud — la navigation
  // paraît instantanée même sur une connexion lente.
  document.addEventListener(
    "pointerdown",
    (event) => {
      const anchor = event.target.closest("a");
      if (!isRealAnchor(anchor, event) || samePage(anchor.getAttribute("href"))) return;
      const url = new URL(anchor.href, location.href).href;
      if (prefetched.has(url)) return;
      prefetched.add(url);
      if (prefetched.size > 25) prefetched.delete(prefetched.values().next().value);
      fetch(url, {
        headers: { "X-Requested-With": "omni-pjax" },
        credentials: "same-origin",
      }).catch(() => undefined);
    },
    { passive: true },
  );

  // Les formulaires GET (recherche de la barre du haut) passent aussi par la
  // navigation interne : taper une recherche ne coupe plus la musique en cours.
  document.addEventListener("submit", (event) => {
    if (event.defaultPrevented) return;
    const form = event.target;
    if (!form || form.tagName !== "FORM") return;
    if ((form.getAttribute("method") || "get").toLowerCase() !== "get") return;
    let url;
    try {
      url = new URL(form.getAttribute("action") || location.pathname, location.href);
    } catch (_error) {
      return;
    }
    if (url.origin !== location.origin) return;
    const params = new URLSearchParams(new FormData(form));
    params.delete("_");
    const query = params.toString();
    url.search = query ? `?${query}` : "";
    if (samePage(url.href)) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    closeDrawer();
    navigate(url.href, true);
  });

  window.addEventListener("popstate", () => navigate(location.href, false));

  function closeDrawer() {
    const drawer = document.getElementById("drawer-panel");
    if (!drawer || !drawer.classList.contains("open")) return;
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    const backdrop = document.getElementById("drawer-backdrop");
    if (backdrop) backdrop.classList.remove("open");
    const burger = document.getElementById("burger-btn");
    if (burger) {
      burger.classList.remove("open");
      burger.setAttribute("aria-expanded", "false");
    }
    document.body.classList.remove("drawer-open");
  }

  updateBottomNavActive();
})();
