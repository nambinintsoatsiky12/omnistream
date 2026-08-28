"""Recherche « MP3 libre » sans résultat, et rayon Madagascar de Jamendo.

Deux mensonges à corriger :

* une recherche libre qui ne rend rien laissait une page blanche, sans dire que
  le rayon ne contient que des artistes indépendants sous licence ;
* le rayon « Madagascar » de Jamendo, demandé en recherche libre, ramenait des
  titres sans aucun rapport (l'API élargit aux artistes « similaires »).
"""

from __future__ import annotations

from pathlib import Path

import pytest

import app as app_module

ROOT = Path(__file__).resolve().parents[1]

# Ce que la recherche libre de Jamendo rend pour « madagascar » : trois pistes
# réellement liées au rayon, deux qui n'ont rien à voir.
REPONSE_JAMENDO = {
    "headers": {"status": "success", "code": 0},
    "results": [
        {
            "id": "1",
            "name": "Madagascar",
            "artist_name": "Un groupe",
            "album_name": "Single",
            "duration": 100,
            "audio": "https://prod-1.storage.jamendo.com/?trackid=1",
            "audiodownload_allowed": False,
        },
        {
            "id": "2",
            "name": "Soul Funk Groove",
            "artist_name": "Malagasy All Stars",
            "album_name": "Hira Gasy",
            "duration": 100,
            "audio": "https://prod-1.storage.jamendo.com/?trackid=2",
            "audiodownload_allowed": False,
        },
        {
            "id": "3",
            "name": "Salegy Party",
            "artist_name": "Rija",
            "album_name": "Fety",
            "duration": 100,
            "audio": "https://prod-1.storage.jamendo.com/?trackid=3",
            "audiodownload_allowed": False,
        },
        {
            "id": "4",
            "name": "Totally unrelated",
            "artist_name": "Someone Else",
            "album_name": "Nothing here",
            "duration": 100,
            "audio": "https://prod-1.storage.jamendo.com/?trackid=4",
            "audiodownload_allowed": False,
        },
        {
            "id": "5",
            "name": "Electronic Dreams",
            "artist_name": "DJ Person",
            "album_name": "Club",
            "duration": 100,
            "audio": "https://prod-1.storage.jamendo.com/?trackid=5",
            "audiodownload_allowed": False,
        },
    ],
}


class Reponse:
    def __init__(self, data):
        self._data = data
        self.status_code = 200
        self.headers = {}

    def json(self):
        return self._data


@pytest.fixture()
def jamendo(monkeypatch):
    appels = []

    def fake_get(url, params=None, **_kwargs):
        appels.append(dict(params or {}))
        return Reponse(REPONSE_JAMENDO)

    monkeypatch.setattr(app_module, "JAMENDO_CLIENT_ID", "cle-de-test")
    monkeypatch.setattr(app_module.requests, "get", fake_get)
    return appels


def test_le_rayon_madagascar_ne_garde_que_les_noms_du_rayon(client, jamendo):
    response = client.get("/api/mp3?provider=jamendo&shelf=madagascar")

    assert response.status_code == 200
    titres = [item["title"] for item in response.get_json()["items"]]
    assert titres == ["Madagascar", "Soul Funk Groove", "Salegy Party"]


def test_le_rayon_madagascar_ne_se_bouche_pas_avec_les_tendances(client, jamendo):
    """Un rayon qui ne rend rien reste vide : les tendances générales sous un
    libellé de rayon seraient un mensonge habillé."""
    response = client.get("/api/mp3?provider=jamendo&shelf=madagascar")

    assert response.status_code == 200
    assert len(jamendo) == 1, "un seul essai, borné par le rayon"
    assert "order" not in jamendo[0], "aucun repli vers un classement général"


def test_une_recherche_tapee_n_est_pas_filtree(client, jamendo):
    """L'internaute qui tape un mot veut ce mot-là, pas notre avis dessus."""
    response = client.get("/api/mp3?provider=jamendo&q=electronic")

    assert response.status_code == 200
    assert len(response.get_json()["items"]) == 5


def test_les_rayons_de_genre_gardent_toutes_leurs_pistes(client, jamendo):
    response = client.get("/api/mp3?provider=jamendo&shelf=live")

    assert response.status_code == 200
    assert len(response.get_json()["items"]) == 5


def test_la_correspondance_ignore_casse_et_accents():
    motif = app_module._jamendo_shelf_patterns(["hira gasy"])
    piste = {"name": "HÌRA GASY live", "album_name": "", "artist_name": ""}
    assert app_module._jamendo_shelf_match(piste, motif)


def test_un_mot_coupe_en_morceau_ne_compte_pas():
    """« Madagasikara » n'est pas « madagascar » : mot pour mot, ou rien."""
    motif = app_module._jamendo_shelf_patterns(["madagascar"])
    piste = {"name": "Madagasikara love", "album_name": "", "artist_name": ""}
    assert not app_module._jamendo_shelf_match(piste, motif)


# ---------------------------------------------------------------------------
# Interface : la page vide explique le rayon au lieu de rester blanche
# ---------------------------------------------------------------------------


def lire(nom):
    return (ROOT / nom).read_text(encoding="utf-8")


def test_l_encart_explique_le_rayon_et_propose_youtube():
    page = lire("templates/musique.html")
    assert 'id="musique-mp3-fallback"' in page
    assert 'id="mp3-fallback-youtube"' in page
    assert "artistes indépendants" in page
    assert "grandes maisons de disques" in page
    assert "YouTube" in page


def test_l_encart_ne_sort_que_d_une_recherche_aboutie():
    script = lire("static/js/musique.js")
    condition = 'currentSource === "mp3" && Boolean(lastQuery) && cards.length === 0'
    assert condition in script
    # La panne réseau passe par le catch, qui referme l'encart.
    catch = script[script.index("} catch (error) {") :]
    assert "fallbackNotice.hidden = true" in catch[: catch.index("} finally {")]


def test_le_bouton_relance_la_meme_recherche():
    script = lire("static/js/musique.js")
    assert 'fallbackButton.addEventListener("click"' in script
    # `setSource` rappelle `load(lastQuery)` : la requête tapée est conservée.
    assert 'setSource("youtube")' in script
    assert "input.value = lastQuery;" in script


def test_l_encart_est_style():
    style = lire("static/css/style.css")
    assert ".mp3-fallback" in style
    assert ".mp3-fallback-btn" in style
