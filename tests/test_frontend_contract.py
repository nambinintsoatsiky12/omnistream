"""Contrats entre le HTML, le CSS et le JavaScript.

Ces tests protègent contre les pannes réellement rencontrées sur téléphone :

* un bouton prévu dans le gabarit mais plus traité par le script (aucun effet
  au toucher) ;
* un script absent de la liste de pré-cache du Service Worker (application
  cassée hors ligne) ;
* un asset non versionné (vieux CSS toujours affiché après déploiement) ;
* une classe fabriquée par JS mais absente du CSS (cartes démesurées, mise en
  page cassée) ;
* un contrôle tactile bâclé (survol qui reste collé, font boosting, etc.).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "static"
TEMPLATES = ROOT / "templates"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def base_html() -> str:
    return read(TEMPLATES / "base.html")


@pytest.fixture(scope="module")
def player_js() -> str:
    return read(STATIC / "js" / "player.js")


@pytest.fixture(scope="module")
def service_worker() -> str:
    return read(STATIC / "service-worker.js")


@pytest.fixture(scope="module")
def style_css() -> str:
    return read(STATIC / "css" / "style.css")


def test_toutes_les_actions_du_lecteur_sont_cablees(base_html, player_js):
    """Chaque data-omni-action du gabarit doit avoir un handler côté JS."""
    in_markup = set(re.findall(r'data-omni-action="([a-z-]+)"', base_html))
    in_script = set(re.findall(r'action === "([a-z-]+)"', player_js))
    assert in_markup, "le gabarit ne déclare plus aucune action du lecteur"
    missing = in_markup - in_script
    assert not missing, f"actions sans traitement JS : {sorted(missing)}"


@pytest.mark.parametrize(
    "action",
    ["toggle", "close", "expand", "minimize", "prev", "next", "retry", "close-video"],
)
def test_actions_critiques_presents_des_deux_cotes(base_html, player_js, action):
    assert f'data-omni-action="{action}"' in base_html
    assert f'action === "{action}"' in player_js


def test_le_panneau_basse_se_ferme_toujours(base_html):
    assert 'data-omni-action="close"' in base_html
    assert 'id="omni-modal-grabber"' in base_html  # glisser pour réduire


def test_lecteur_pilote_les_icones_par_attribut_d_etat(player_js, style_css):
    """L'icône ▶ / II dépend d'un attribut d'état unique, pas d'un hidden manuel."""
    assert "body.dataset.playerPlaying" in player_js
    assert "body.dataset.playerStatus" in player_js
    assert '[data-player-playing="true"]' in style_css
    assert '[data-player-playing="false"]' in style_css
    assert '[data-player-status="loading"]' in style_css


def test_les_deux_icones_sont_dans_le_gabarit(base_html):
    assert 'class="icon icon-play"' in base_html
    assert 'class="icon icon-pause"' in base_html
    assert 'class="icon icon-spinner"' in base_html


def test_tous_les_scripts_sont_pre_cache_par_le_service_worker(service_worker):
    listed = set(re.findall(r'"/static/js/([a-z0-9-]+\.js)"', service_worker))
    on_disk = {path.name for path in (STATIC / "js").glob("*.js")}
    assert on_disk, "aucun script trouvé sur le disque"
    assert on_disk <= listed, f"scripts absents du shell : {sorted(on_disk - listed)}"


def test_le_service_worker_normalise_et_autorise_l_opaque(service_worker):
    # Sans normalisation, le « ?v= » casse toutes les clés de cache.
    assert "function normalizeKey" in service_worker
    assert 'response.type === "opaque"' in service_worker  # images cross-origin
    assert "FONT_CACHE" in service_worker, "polices plus économisées"
    assert 'data.type === "clear-cache"' in service_worker
    assert 'data.type === "cache-offline"' in service_worker
    # Les pages visitées restent lisibles sans réseau.
    assert "PAGE_CACHE" in service_worker


def test_le_script_ne_precharge_pas_youtube_sans_demande(player_js):
    """Au démarrage de page, aucun octet n'est dépensé vers YouTube."""
    marker = "if (document.readyState ==="
    before = player_js[: player_js.index(marker)]
    init_block = before[before.rindex("function init()") :]
    assert "loadYouTubeApi()" not in init_block, "YouTube doit rester paresseux"


def test_le_flux_est_recharge_apres_une_erreur(player_js):
    assert 'action === "retry"' in player_js
    # Garde sur un démarrage qui ne vient jamais (autoplay refusé).
    assert "armStartWatchdog" in player_js


@pytest.mark.parametrize(
    "needle",
    [
        "text-size-adjust: 100%",
        "touch-action: manipulation",
        "@media (hover: none)",
        "--bottom-nav-h:",
        "@media (prefers-reduced-motion: reduce)",
        "-webkit-backdrop-filter",
    ],
)
def test_confort_mobile(style_css, needle):
    assert needle in style_css, f"règle de confort manquante : {needle}"


def test_classes_js_existant_en_css(style_css):
    """Les cartes construites en JS doivent avoir leurs styles (sinon : géantes)."""
    names = (
        "music-poster",
        "music-play-overlay",
        "music-play-circle",
        "music-pin-btn",
        "card-pin-btn",
        "omni-audio-bar",
        "omni-ctrl-main",
        "icon-spinner",
        "omni-update-bar",
        "omni-update-bar-btn",
        "omni-update-bar-label",
        "omni-toast",
        "offline-poster",
    )
    for name in names:
        assert f".{name}" in style_css, f"classe .{name} utilisée mais jamais stylée"


def test_barre_audio_ancree_au_dessus_de_la_nav(style_css):
    """La barre du bas se cale sur la hauteur réelle de la navigation basse."""
    start = style_css.index(".omni-audio-bar {")
    block = style_css[start : style_css.index("}", start)]
    assert "bottom: calc(var(--bottom-nav-total" in block


def test_scripts_de_page_versionnes():
    """Un asset sans ?v= ne se rafraîchit pas sur le téléphone après déploiement."""
    pattern = re.compile(r'(?:src|href)="([^"]*?/static/[^"]+)"')
    for template in sorted(TEMPLATES.glob("*.html")):
        for url in pattern.findall(read(template)):
            if url.endswith((".js", ".css")):
                assert "?v={{ asset_version }}" in url, f"{template.name}: {url}"


def test_client_revalide_les_assets(client):
    """Cache-Control des statiques : revalidation (304) et non fichier périmé."""
    response = client.get("/static/js/player.js")
    assert response.status_code == 200
    assert "max-age=0" in response.headers.get("Cache-Control", "")


def test_service_worker_sert_sans_cache(client):
    response = client.get("/service-worker.js")
    assert response.status_code == 200
    assert "no-store" in response.headers.get("Cache-Control", "")
    assert response.headers.get("Service-Worker-Allowed") == "/"


def test_version_d_assets_non_vide():
    from app import ASSET_VERSION

    assert re.fullmatch(r"[0-9a-f]{1,16}", ASSET_VERSION)


def test_vignettes_allegees_pour_les_grilles():
    """Les cartes des grilles demandent une variante d'image plus légère."""
    from app import CARD_BACKDROP_BASE, CARD_IMG_BASE, normalize_card

    card = normalize_card(
        {
            "id": 1,
            "title": "X",
            "poster_path": "/abc.jpg",
            "backdrop_path": "/def.jpg",
            "vote_average": 7,
        },
        "movie",
    )
    assert card["poster"].startswith(CARD_IMG_BASE)
    assert card["backdrop"].startswith(CARD_BACKDROP_BASE)
    assert "/w342/" in card["poster"] and "/w780/" in card["backdrop"]


def test_reveal_ne_masque_jamais_le_contenu_sans_js(style_css):
    """L'accueil ne peut plus rester vide : le masque n'est posé QUE par JS.

    Avant, `html.js .reveal { opacity: 0 }` cachait toute la page quand le
    script de révélation ne tournait pas (navigation interne, script bloqué).
    """
    assert ".reveal.js-hide" in style_css
    assert "html.js .reveal" not in style_css


def test_omni_reveal_est_gerce_par_le_shell():
    """La révélation au défilement survit à la navigation interne (PJAX)."""
    shell = read(STATIC / "js" / "app-shell.js")
    assert "window.OmniReveal" in shell
    assert "omni:page-loaded" in shell
    assert "js-hide" in shell
    landing = read(TEMPLATES / "landing.html")
    assert "OmniReveal.scan" in landing
    assert 'querySelectorAll(".reveal")' not in landing  # ancien script retiré


def test_mode_audio_utilise_un_flux_audio_seul(player_js):
    """MP3 = flux audio seul (sans la piste vidéo) : c'est l'économie de Mo.

    Le son est servi à ~128 kbps (≈ 1 Mo/min) avec la qualité sonore complète,
    au lieu de télécharger le clip vidéo entier comme avant.
    """
    for needle in (
        "AUDIO_PROVIDERS",
        "startAudioStream",
        "pickAudioStream",
        "ensureAudioElement",
        "state.transport",
        'vars.vq = "small"',
        "stopAudioTransport",
    ):
        assert needle in player_js, f"morceau du flux audio manquant : {needle}"


def test_bascule_audio_video_reconstruit_le_lecteur(player_js):
    """Le mode vidéo ne doit jamais être bridé par les options de l'audio."""
    assert "rebuildYouTubePlayer" in player_js
    assert "startYouTubeFallback" in player_js


def test_player_garde_une_politique_de_secours(player_js):
    """Si le flux audio seul échoue, le titre se lance quand même sur YouTube."""
    assert "AUDIO_FALLBACK_COOLDOWN" in player_js
    assert "startYouTubeFallback" in player_js


# ---------------------------------------------------------------------------
# Application installée (PWA), bandeau d'état et menu des « 3 tirés »
# ---------------------------------------------------------------------------


def manifest_data() -> dict:
    return json.loads(read(STATIC / "manifest.webmanifest"))


def shell_assets() -> set:
    body = read(STATIC / "service-worker.js")
    head = body.index("const SHELL_ASSETS")
    block = body[head : body.index("];", head)]
    return set(re.findall(r'"(/[^"]*)"', block))


def test_le_manifeste_est_servi_par_sa_route_dediee(base_html):
    """Un manifeste au mauvais mimetype est refusé par Chrome : la fenêtre
    de l'application installée ne s'ouvre alors plus du tout."""
    assert "url_for('manifest')" in base_html


def test_url_de_lancement_pre_enregistree_par_le_worker():
    """« Installer l'application », puis l'icône qui ne s'ouvre pas : la page
    de lancement doit faire partie de la coquille pré-enregistrée, sans dépendre
    d'un paramètre de suivi que le cache ne connaît pas."""
    manifest = manifest_data()
    shell = shell_assets()
    assert manifest["start_url"] == "/", "start_url doit être une URL nue"
    assert manifest["start_url"] in shell
    for shortcut in manifest.get("shortcuts", []):
        assert shortcut["url"].split("?")[0] in shell, shortcut["url"]
    assert "source=" not in str(manifest)


def test_identite_de_l_application_est_stable():
    """Sans « id », chaque modification de start_url crée une autre
    application : les icônes déjà posées sur l'écran d'accueil ne
    pointent plus sur rien de connu. Le repli « browser » évite en outre la
    fenêtre muette quand le mode autonome n'est pas disponible."""
    manifest = manifest_data()
    assert manifest.get("id") == "/"
    assert manifest.get("display") == "standalone"
    assert "browser" in manifest.get("display_override", [])
    assert manifest.get("orientation") == "any"


def test_le_worker_ignore_les_parametres_de_suivi(service_worker):
    assert "IGNORED_PAGE_PARAMS" in service_worker
    assert '"source"' in service_worker
    assert "pageUrlWithoutTracking" in service_worker


def test_le_worker_ne_laisse_jamais_la_fenetre_vide(service_worker):
    """5xx (instance endormie, redéploiement) et hors-ligne ne doivent plus
    donner une fenêtre grise ou noire : on sert la dernière copie
    connue, sinon une page de secours fabriquée par le worker."""
    assert "response.status >= 500" in service_worker
    assert "lastKnownCopy" in service_worker
    assert "navigationRescue" in service_worker
    assert "RESCUE_HTML" in service_worker
    assert "location.reload()" in service_worker


def test_la_coquille_est_complementee_a_l_activation(service_worker):
    install = service_worker.index('self.addEventListener("install"')
    activate = service_worker.index('self.addEventListener("activate"')
    bloc_install = service_worker[install:activate]
    # L'activation ne doit plus attendre le téléchargement de la coquille :
    # avec un serveur endormi, c'était elle qui retenait l'application
    # installée muette. skipWaiting d'abord, pré-enregistrement ensuite.
    assert "self.skipWaiting();" in bloc_install
    assert "precacheShell()" in bloc_install
    assert (
        bloc_install.index("self.skipWaiting();")
        < bloc_install.index("precacheShell()")
    )
    assert "precacheShell()" in service_worker[activate : activate + 1400]


def test_tous_les_liens_du_menu_menent_une_section():
    """Le menu des « 3 tirés » ne doit plus proposer d'option morte :
    chaque lien vers une section retrouve bien l'ancre correspondante."""
    base = read(TEMPLATES / "base.html")
    head = base.index('id="drawer-panel"')
    drawer = base[head : base.index("</aside>", head)]
    hrefs = re.findall(r'href="([^"]+)"', drawer)
    assert hrefs, "le menu ne contient plus aucun lien"
    markup = "".join(read(template) for template in sorted(TEMPLATES.glob("*.html")))
    for href in hrefs:
        if "#" not in href:
            continue
        anchor = href.split("#", 1)[1]
        assert f'id="{anchor}"' in markup, f"section manquante pour {href}"


def test_le_shell_sert_reellement_les_liens_a_ancre():
    """Un lien « /#actualites » doit descendre jusqu'à la section, depuis la
    méme page comme depuis une autre, et refermer le tiroir."""
    shell = read(STATIC / "js" / "app-shell.js")
    assert "function hashOf" in shell
    assert "scrollToHash(hash, true)" in shell
    assert "navigate(url, true, hash)" in shell
    assert "hashOf(location.hash)" in shell
    head = shell.index('document.addEventListener("click", (event) => {')
    handler = shell[head : shell.index("  });", head)]
    assert "closeDrawer();" in handler


def test_option_installer_reste_vivante_partout():
    """Chrome n'émet « beforeinstallprompt » qu'une fois l'engagement atteint,
    et pas du tout sur iOS : sans repli, l'option du menu restait cachée."""
    shell = read(STATIC / "js" / "app-shell.js")
    assert "beforeinstallprompt" in shell
    assert "showManualInstallHint" in shell
    assert "INSTALL_HINT" in shell
    assert "data-pwa-manual" in shell


def test_mode_autonome_reconnaissable(base_html, style_css):
    """Dans l'application installée, plus de proposition d'installation et le
    header tient compte de l'encoche du téléphone."""
    shell = read(STATIC / "js" / "app-shell.js")
    assert '(display-mode: standalone)' in shell
    assert 'data-display-mode' in shell
    assert 'html[data-display-mode="standalone"] .install-card' in style_css
    assert "@media (display-mode: standalone)" in style_css


def test_bandeau_etat_grand_et_actionnable(style_css):
    """Le bandeau du haut était trop petit pour être vu : texte à taille
    lisible, icône et vrais boutons de 40 px minimum."""
    shell = read(STATIC / "js" / "app-shell.js")
    classes = (
        "offline-banner-icon",
        "offline-banner-text",
        "offline-banner-actions",
        "offline-banner-btn",
        "offline-banner-close",
    )
    for name in classes:
        assert f".{name}" in style_css, f"classe .{name} posée par JS sans style"
        assert name in shell, f"le bandeau ne fabrique plus .{name}"
    assert set(re.findall(r'data-banner-action="([a-z-]+)"', shell)) == {
        "retry",
        "offline",
        "dismiss",
    }

    start = style_css.index(".offline-banner-text {")
    block = style_css[start : style_css.index("}", start)]
    size = re.search(r"font-size: *([0-9.]+)rem", block)
    assert size and float(size.group(1)) >= 0.9, "le bandeau est toujours trop petit"
    head = style_css.index(".offline-banner {")
    rule = style_css[head : style_css.index("}", head)]
    assert re.search(r"min-height: *[4-9][0-9]px", rule), "hauteur tactile insuffisante"


def test_bandeau_ne_recouvre_plus_le_header(style_css):
    head = style_css.index(".topbar {")
    rule = style_css[head : style_css.index("}", head)]
    assert "top: var(--top-banner-h, 0px)" in rule
    attendu = "padding-top: calc(var(--header-h, 110px) + var(--top-banner-h, 0px)"
    assert attendu in style_css
    bandeau = style_css[style_css.index(".offline-banner {") :]
    assert "env(safe-area-inset-top" in bandeau


def test_barre_de_mise_a_jour_lisible(style_css):
    head = style_css.index(".omni-update-bar {")
    rule = style_css[head : style_css.index("}", head)]
    assert re.search(r"font-size: *0\.9[0-9]*rem", rule), "barre toujours trop petite"
    assert "min-height" in rule
    assert "var(--top-banner-h, 0px)" in rule


# ---------------------------------------------------------------------------
# Source MP3 libre : câblage du gabarit au joueur
# ---------------------------------------------------------------------------


def test_player_accepte_un_fichier_et_pas_seulement_youtube():
    """La coupure écran éteint venait du secours iframe : le lecteur doit savoir
    jouer un fichier MP3 par lui-même, et le dire."""
    player = read(STATIC / "js" / "player.js")
    for needle in (
        "function isMp3Track",
        "function isPlayable",
        "async function playFileTrack",
        'state.current.kind === "mp3"',
        'el.preload = "auto"',
        'el.addEventListener("timeupdate"',
        "setPositionState(now, state.lastDuration)",
        'el.addEventListener("stalled"',
        "keepAlive.timer",
        "system.resumeAttempts >= 24",
    ):
        assert needle in player, f"manquant dans player.js : {needle}"


def test_le_worker_sert_les_fichiers_audio():
    """Un MP3 épinglé doit se relire sans réseau, et un MP3 joué une fois ne
    doit pas dévorer le stockage : d'où son cache et son plafond propres."""
    worker = read(STATIC / "service-worker.js")
    for needle in (
        "function isAudioFile",
        "async function audioFileFirst",
        "AUDIO_CACHE",
        "AUDIO_CACHE_LIMIT",
        "function saveDataRequested",
        "status: 206",
        "Content-Range",
        # Un cache écrit par la page ne doit plus être détruit à l'activation.
        r"/^omnistream-v\d+-/",
    ):
        assert needle in worker, f"manquant dans service-worker.js : {needle}"


def test_pas_de_cache_version_cod_en_dur():
    """La page ne doit pas inventer un nom de cache « omnistream-v3-… » : le
    worker change de version à chaque refonte et jetterait ces entrées."""
    for name in ("library.js", "downloads.js"):
        body = read(STATIC / "js" / name)
        assert not re.search(r"omnistream-v\d", body), f"{name} cite une version"


def test_la_page_musique_ne_cite_qu_des_id_existants():
    """Un getElementById orphelin est exactement le « bouton qui ne fait rien »
    du menu : chaque id demandé par le script doit être dans un gabarit."""
    script = read(STATIC / "js" / "musique.js")
    markup = "".join(
        read(template) for template in sorted(TEMPLATES.glob("*.html"))
    )
    wanted = set(re.findall(r'getElementById\("([^"]+)"\)', script))
    assert wanted, "plus aucun id utilisé par la page Musique ?"
    missing = {name for name in wanted if f'id="{name}"' not in markup}
    assert not missing, f"ids réclamés sans balise correspondante : {sorted(missing)}"


def test_source_mp3_branchee_de_bout_en_bout():
    script = read(STATIC / "js" / "musique.js")
    page = read(TEMPLATES / "musique.html")
    assert 'id="source-toggle"' in page
    assert 'id="source-note"' in page
    assert 'getElementById("source-toggle")' in script
    assert 'getElementById("source-note")' in script
    assert "/api/mp3" in script
    assert "/api/musique-trending" in script
    assert 'kind === "mp3"' in script


def test_styles_des_boutons_mp3(style_css):
    """Les classes fabriquées par la page Musique doivent exister en CSS."""
    style = style_css
    for name in (
        "musique-source-wrap",
        "source-toggle",
        "source-btn",
        "source-btn-text",
        "source-note",
        "musique-card-mp3",
        "mp3-meta-line",
        "mp3-meta",
        "mp3-dot",
        "music-get-btn",
    ):
        assert f".{name}" in style, f"classe .{name} utilisée mais jamais stylée"


# ---------------------------------------------------------------------------
# « Enregistrer le MP3, le relire hors ligne, et bouger dans le morceau »
# ---------------------------------------------------------------------------


def test_le_worker_repond_sur_le_canal_de_message(service_worker):
    """`OmniSW.ask` (statistiques, purge) attend sur un MessageChannel : un
    worker qui ne répond que sur `event.source` laissait la page croire
    — « rien à vider » aprés avoir pourtant tout vidé."""
    assert "event.ports" in service_worker
    assert "port.postMessage(message)" in service_worker
    assert "source.postMessage(message)" in service_worker


def test_le_delai_de_reponse_laisse_le_temps_de_reflechir():
    shell = read(STATIC / "js" / "app-shell.js")
    """`stats` lit le corps de chaque réponse : 4 secondes étaient trop
    courtes sur un téléphone et la page restait vide."""
    assert "const timer = window.setTimeout(() => resolve(null), 20000);" in shell


def test_epingler_un_mp3_attend_la_confirmation_du_cache():
    """Annoncer « MP3 enregistré » avant que le fichier soit là était
    la promesse menteuse qui faisait croire à un hors ligne cassé."""
    library = read(STATIC / "js" / "library.js")
    assert "function swRequest(" in library
    assert "channel.port2" in library
    assert "waitMsForBytes" in library
    assert "answer.cached" in library
    assert "return stored > 0;" in library
    # La page Musique branche son message sur le résultat réel.
    page = read(STATIC / "js" / "musique.js")
    assert "const stored = await window.OmniLibrary.saveOffline(favItem);" in page
    assert "n'a pas pu être mis en cache" in page


def test_la_page_hors_ligne_distingue_le_fichier_du_clip():
    """Un MP3 libre épinglé se relit à 0 Mo ; un clip YouTube, non. Mélanger
    les deux affichait un avertissement faux et lançait une lecture
    vouée à l'échec."""
    downloads = read(STATIC / "js" / "downloads.js")
    assert "function hasStoredFile(" in downloads
    assert "function storageLabel(" in downloads
    assert "MP3 · 0 Mo HORS LIGNE" in downloads
    assert "CLIP · RÉSEAU REQUIS" in downloads
    assert "if (!navigator.onLine && !hasStoredFile(item)) {" in downloads
    # Le compteur « Fichiers en cache » doit compter les morceaux aussi.
    assert 'name.includes("-audio")' in downloads


def test_la_duree_inconnue_ne_vide_plus_la_barre_de_progression():
    """Un MP3 téléchargé progressivement sans en-tête de durée rend
    `el.duration` infini : la barre restait à 0 % et `currentTime` refusait
    la valeur — « le trait brillant ne s'affiche pas, je ne peux ni avancer
    ni recommencer »."""
    player = read(STATIC / "js" / "player.js")
    for needle in (
        "function knownDuration",
        "function resolveDuration",
        "Number.isFinite",
        "duration = resolveDuration(el.duration);",
        'el.addEventListener("durationchange"',
        'document.body.classList.add("seeking")',
        'document.body.classList.remove("seeking")',
    ):
        assert needle in player, f"manquant dans player.js : {needle}"
    # Un refus silencieux ressemble à un bouton cassé : il doit être dit.
    assert "Durée du fichier inconnue" in player


def test_le_repere_de_progression_se_voit_et_se_saisit(style_css):
    """3 px de trait et 4 px de zone tactile : personne ne le voyait, personne
    ne l'attrapait. Le repére a désormais un grain visible et une zone de
    vingtaine de pixels."""
    assert ".omni-bar-progress::before" in style_css
    assert ".omni-bar-progress-fill::after" in style_css
    assert "body.seeking .omni-bar-progress-fill" in style_css
    block = style_css[style_css.index(".omni-bar-progress {") :]
    block = block[: block.index("}")]
    assert "touch-action: none" in block
    assert "overflow: hidden" not in block, "le repére serait rogné"
    assert "min-width: 6px" in style_css


def test_la_barre_de_la_modale_a_le_droit_d_etre_grasse(style_css):
    start = style_css.index(".omni-modal-progress {")
    block = style_css[start : style_css.index("}", start)]
    assert "height: 8px" in block
    assert "overflow: hidden" not in block
    assert ".omni-modal-progress-fill::after" in style_css


def test_le_relais_de_fichier_ne_cache_rien_de_silencieux():
    """Le relais ne sert qu'à nommer le fichier : la lecture part sur
    l'Archive, sinon chaque écoute immobiliserait un worker."""
    source = read(ROOT / "app.py")
    assert 'ARCHIVE_FILE_URL.format(identifier=identifier, name=quote(name))' in source
    assert '"url": ARCHIVE_FILE_URL' in source
    assert "Content-Disposition" in source


def test_les_rayons_viennent_du_serveur():
    """Ni le gabarit ni le script ne connaissent la liste des rayons : un rayon
    ajoute cote serveur apparait, un rayon retire disparait."""
    script = read(STATIC / "js" / "musique.js")
    page = read(TEMPLATES / "musique.html")
    assert 'id="shelf-row"' in page
    assert 'id="provider-row"' in page
    assert 'searchParams.set("shelf", currentShelf)' in script
    assert 'searchParams.set("provider", currentProvider)' in script
    assert "renderChoices(data)" in script
    assert "function renderChoice(" in script


def test_le_poids_et_le_bouton_ne_mentent_pas():
    """Taille inconnue = pas de « 0 Ko » ; telechargement non autorise par
    l'artiste = pas de bouton."""
    script = read(STATIC / "js" / "musique.js")
    assert "item.size ? `MP3 \u00b7 ${humanSize(item.size)}` : \"MP3\"" in script
    assert "if (item.download) info.append(download);" in script


def test_le_credit_de_licence_est_affiche_et_style():
    """Une licence Creative Commons se monnaie en attribution : elle doit etre
    visible sur la carte, pas planquee dans une balise meta."""
    script = read(STATIC / "js" / "musique.js")
    style = read(STATIC / "css" / "style.css")
    assert 'credit.className = "music-credit"' in script
    assert 'rel = "noopener license"' in script
    assert ".music-credit" in style
    assert ".choice-btn" in style
    assert ".choice-btn.active" in style
    assert ".musique-choice-rows" in style


def test_un_lien_signe_qui_a_vecu_ne_tue_pas_la_lecture():
    """Les URL de Jamendo sont signees et vivent quelques minutes : un morceau
    repris depuis la barre du lecteur apres une longue pause doit repartir par
    le relais du serveur (qui resout une adresse fraiche) avant d'etre declare
    en panne."""
    player = read(STATIC / "js" / "player.js")
    assert "function retryThroughRelay" in player
    assert "if (retryThroughRelay()) return;" in player
    assert 'relay.startsWith("/mp3/")' in player
    assert "__omniRelayed" in player


# ---------------------------------------------------------------------------
# Fluidité : rien d'animé ne tourne pour personne
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def app_shell_js() -> str:
    return read(STATIC / "js" / "app-shell.js")


@pytest.fixture(scope="module")
def home_js() -> str:
    return read(STATIC / "js" / "home.js")


@pytest.fixture(scope="module")
def landing_html() -> str:
    return read(TEMPLATES / "landing.html")


def test_les_animations_hors_ecran_sont_mises_en_pause(app_shell_js, style_css):
    """La fresque d'affiches tournait pour toujours, y compris une fois le
    visiteur descendu plus bas : c'est le premier gisement de fluidité."""
    assert "window.OmniIdle" in app_shell_js
    assert "omni:page-loaded" in app_shell_js
    assert "[data-anim-idle].is-offscreen" in style_css


def test_la_fresque_de_l_accueil_est_marquee_pour_la_pause(landing_html):
    assert 'class="poster-wall"' in landing_html
    assert "data-anim-idle" in landing_html.split('class="poster-wall"', 1)[1][:80]


def test_la_fresque_ne_porte_plus_de_filtre_global(style_css):
    """Un `filter` sur le conteneur d'une boucle infinie est réappliqué sur
    toute la surface à chaque frame."""
    bloc = style_css[style_css.index(".poster-wall {") :]
    bloc = bloc[: bloc.index("}")]
    assert "filter:" not in bloc


def test_le_bandeau_a_la_une_ne_defile_que_sous_les_yeux(home_js):
    assert "IntersectionObserver" in home_js
    assert "heroObserver.observe(heroSection)" in home_js
    assert "stopRotation" in home_js


# ---------------------------------------------------------------------------
# Accueil : le décor doit se voir derrière le texte
# ---------------------------------------------------------------------------


def test_le_bloc_de_bienvenue_est_transparent(style_css):
    """Ni fond blanc, ni bordure, ni flou : les affiches passent au travers."""
    bloc = style_css[style_css.index(".hero-ua-content {") :]
    bloc = bloc[: bloc.index("}")]
    assert "background: transparent" in bloc
    assert "backdrop-filter" not in bloc
    assert "border: 0" in bloc


def test_le_voile_du_heros_laisse_passer_le_decor(style_css):
    """Un voile à 0,9 cacherait l'image que la page est censée montrer."""
    bloc = style_css[style_css.index(".hero-ua-overlay {") :]
    bloc = bloc[: bloc.index("}")]
    motif = r"rgba\(\s*13,\s*17,\s*27,\s*([0-9.]+)\)"
    opacites = [float(v) for v in re.findall(motif, bloc)]
    assert opacites, "le voile doit rester un dégradé sombre transparent"
    assert min(opacites) <= 0.35, "le centre du héros doit rester largement visible"


def test_le_texte_du_heros_est_lisible_sur_le_decor(style_css):
    titre = style_css[style_css.index(".hero-ua-title {") :]
    titre = titre[: titre.index("}")]
    assert "color: #ffffff" in titre
    assert "text-shadow:" in titre


# ---------------------------------------------------------------------------
# Thème : plus de noir pur
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "variable,pire",
    [("--bg:", 0x14), ("--bg-deep:", 0x0F), ("--surface:", 0x1C)],
)
def test_le_fond_n_est_plus_noir(style_css, variable, pire):
    """« Trop noir » : le fond remonte au-dessus du seuil demandé."""
    ligne = next(
        line for line in style_css.splitlines() if line.strip().startswith(variable)
    )
    valeur = re.search(r"#([0-9a-f]{6})", ligne).group(1)
    rouge = int(valeur[0:2], 16)
    assert rouge >= pire, f"{variable} encore trop sombre ({ligne.strip()})"


def test_aucun_gabarit_ne_reste_sur_l_ancien_noir():
    for template in TEMPLATES.glob("*.html"):
        assert "#090b10" not in read(template), template.name


# ---------------------------------------------------------------------------
# Onglet « Animés & Mangas » : la bascule et les tris sont câblés des deux côtés
# ---------------------------------------------------------------------------


def test_la_bascule_animes_mangas_existe_des_deux_cotes(style_css, home_js):
    gabarit = read(TEMPLATES / "index.html")
    assert 'id="media-switch"' in gabarit
    assert ".media-switch-btn" in style_css
    assert "mediaSwitch" in home_js


def test_la_rangee_de_tris_existe_des_deux_cotes(style_css, home_js):
    gabarit = read(TEMPLATES / "index.html")
    assert 'id="sort-pills"' in gabarit
    assert ".pills-sort" in style_css
    assert "renderSortPills" in home_js


def test_l_onglet_animes_envoie_son_type_et_son_tri(home_js):
    assert 'params.set("media", activeMedia)' in home_js
    assert 'params.set("sort", activeSort)' in home_js
    # Le bandeau suit le type affiché, lui aussi.
    assert "media=${activeMedia}" in home_js


def test_reprendre_ne_s_affiche_plus_dans_les_catalogues(home_js):
    """L'historique se consulte dans « Mon espace », pas en haut de Films."""
    gabarit = read(TEMPLATES / "index.html")
    assert 'id="resume-row"' not in gabarit
    assert "renderResumeRow" not in home_js


def test_reprendre_reste_dans_l_espace_personnel():
    gabarit = read(TEMPLATES / "bibliotheque.html")
    assert "Reprendre" in gabarit
    assert 'id="continue-grid"' in gabarit


def _bloc_css(style_css: str, selecteur: str) -> str:
    """Le corps d'une règle CSS de premier niveau, accolades comprises.

    Tolère les sélecteurs multiples (``.a,\\n.b {``) et les listes à virgules.
    """
    debut = style_css.index(selecteur)
    ouverture = style_css.index("{", debut)
    fin = style_css.index("}", ouverture)
    return style_css[debut:fin]


def test_la_note_de_la_carte_n_est_pas_cachee_par_les_boutons(style_css):
    """Le cœur, le hors-ligne et « écarter » vivent en haut à droite de
    l'affiche : la note doit donc vivre ailleurs, sinon les trois boutons
    la recouvrent et l'utilisateur ne voit plus aucune note."""

    badge = _bloc_css(style_css, ".rating-badge")
    assert "bottom:" in badge, "la note doit être ancrée en bas de l'affiche"
    assert "top:" not in badge, "la note ne doit plus remonter dans le coin des boutons"
    assert "left:" in badge, "la note doit rester à gauche, loin de la rangée de boutons"

    for bouton in (".card-fav-btn,", ".card-pin-btn,", ".card-skip-btn {"):
        bloc = _bloc_css(style_css, bouton.rstrip(" {,"))
        assert "top:" in bloc, f"{bouton} doit rester en haut de l'affiche"
        assert "right:" in bloc, f"{bouton} doit rester dans le coin droit"
