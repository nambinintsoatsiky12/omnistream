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
