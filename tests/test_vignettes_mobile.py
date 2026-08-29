"""Vignettes : ce que la page demande vraiment à TMDB, et ce qu'elle cache.

Sur téléphone, une carte mesure ~115 px de large et l'affiche « à la une »
128 px — demander systématiquement la variante w342 paie le double d'octets
pour rien. Ces tests tiennent trois engagements :

* deux variantes d'affiche partent vers le navigateur, qui choisit ;
* la fresque décorative de l'accueil reste décorative (6 par colonne, décodage
  asynchrone, priorité basse) ;
* l'accueil et l'espace Musique sont cachables 25 s, sauf en navigation
  interne où une copie gardée afficherait une page en retard.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

import app as app_module

ROOT = Path(__file__).resolve().parents[1]


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def home_js() -> str:
    return read(ROOT / "static" / "js" / "home.js")


@pytest.fixture(scope="module")
def index_html() -> str:
    return read(ROOT / "templates" / "index.html")


def carte(**extra):
    from app import normalize_card

    return normalize_card(
        {
            "id": 1,
            "title": "X",
            "poster_path": "/abc.jpg",
            "backdrop_path": "/def.jpg",
            "vote_average": 7,
            **extra,
        },
        "movie",
    )


def test_la_carte_emporte_une_variante_legere():
    from app import CARD_IMG_SMALL_BASE

    assert CARD_IMG_SMALL_BASE.endswith("/w154")
    card = carte()
    assert card["poster_small"] == "https://image.tmdb.org/t/p/w154/abc.jpg"
    # La w342 reste servie : c'est le repli des navigateurs sans srcset.
    assert card["poster"] == "https://image.tmdb.org/t/p/w342/abc.jpg"


def test_sans_affiche_il_n_y_a_pas_de_variante_inventee():
    card = carte(poster_path=None)
    assert card["poster"] is None
    assert card["poster_small"] is None


def test_le_navigateur_choisit_la_definition(home_js):
    assert "image.srcset" in home_js
    assert "154w" in home_js and "342w" in home_js
    assert "image.sizes" in home_js
    assert "POSTER_SIZES" in home_js


def test_les_images_sont_decodees_hors_du_fil_principal(home_js):
    assert 'image.decoding = "async"' in home_js


def test_la_recherche_serveur_utilise_aussi_le_srcset(index_html):
    assert "154w" in index_html and "342w" in index_html
    assert "sizes=" in index_html
    assert 'decoding="async"' in index_html


def poster_wall(response) -> list[str]:
    html = response.get_data(as_text=True)
    start = html.index('<div class="poster-wall"')
    block = html[start : html.index("</section>", start)]
    return re.findall(r'<div class="poster-col [a-z-]+">(.*?)</div>', block, re.DOTALL)


def test_la_fresque_tient_en_six_affiches_par_colonne(client, monkeypatch):
    def fake_tmdb_get(path, params=None):
        return {
            "results": [
                {"id": index, "poster_path": f"/p{index}.jpg", "title": f"T{index}"}
                for index in range(1, 40)
            ]
        }

    monkeypatch.setattr(app_module, "tmdb_get", fake_tmdb_get)
    response = client.get("/")

    assert response.status_code == 200
    columns = poster_wall(response)
    assert len(columns) == 4
    for column in columns:
        images = re.findall(r"<img [^>]*>", column)
        # 6 affiches uniques, doublées pour que la boucle se recolle.
        assert len(images) == 12
        assert len(set(re.findall(r'src="([^"]+)"', column))) == 6
        assert all('decoding="async"' in image for image in images)
        assert all('fetchpriority="low"' in image for image in images)


def test_la_fresque_de_secours_n_est_pas_plus_lourde(client, monkeypatch):
    """TMDB muet : les affiches de repli restent en w185, pas en w500."""
    monkeypatch.setattr(app_module, "TMDB_API_KEY", "")
    response = client.get("/")

    columns = poster_wall(response)
    assert columns
    sources = [
        src for column in columns for src in re.findall(r'src="([^"]+)"', column)
    ]
    assert sources
    assert all("/t/p/w500/" not in src for src in sources)


@pytest.mark.parametrize("page", ["/", "/musiques"])
def test_les_pages_d_entree_sont_cachables_25_secondes(client, page):
    response = client.get(page)

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "public, max-age=25"


@pytest.mark.parametrize("page", ["/", "/musiques"])
def test_la_navigation_interne_n_est_jamais_mise_en_cache(client, page):
    """Le PJAX consomme le HTML côté script : une copie de 25 s afficherait
    une page en retard sur l'onglet demandé."""
    response = client.get(page, headers={"X-Requested-With": "omni-pjax"})

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"


def test_les_autres_pages_gardent_leur_comportement(client):
    assert client.get("/bibliotheque").headers.get("Cache-Control") is None
    # Les statiques continuent de se revalider à chaque chargement.
    assert "max-age=0" in client.get("/static/js/home.js").headers["Cache-Control"]
