"""Le poids des MP3 Jamendo : mesuré sur le fichier, jamais inventé.

L'API Jamendo ne donne aucun `filesize`. Deux règles en découlent :

* côté serveur, le poids se lit dans le `Content-Length` du fichier (un HEAD,
  jamais le fichier lui-même) et se garde en cache ;
* côté interface, un poids inconnu s'écrit « poids inconnu » — et un morceau
  lourd demande deux taps, le premier prévenant de la dépense.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import requests

import app as app_module

ROOT = Path(__file__).resolve().parents[1]

PISTES = {
    "headers": {"status": "success", "code": 0},
    "results": [
        {
            "id": "125871",
            "name": "Tsikimba Soa",
            "artist_name": "Rija Natural",
            "duration": 236,
            "audio": "https://prod-1.storage.jamendo.com/?trackid=125871&format=mp32",
            "audiodownload": "https://prod-1.storage.jamendo.com/download/125871/",
            "audiodownload_allowed": True,
        },
        {
            # Copie interdite : le poids se mesure alors sur le flux.
            "id": "999",
            "name": "Interdit de copier",
            "artist_name": "Quelqu'un",
            "duration": 120,
            "audio": "https://prod-1.storage.jamendo.com/?trackid=999&format=mp32",
            "audiodownload": "",
            "audiodownload_allowed": False,
        },
    ],
}


class Reponse:
    def __init__(self, data=None, status_code=200, headers=None):
        self._data = data
        self.status_code = status_code
        self.headers = headers or {}

    def json(self):
        return self._data


@pytest.fixture()
def jamendo(monkeypatch):
    """API Jamendo feinte + compteur des HEAD réellement émis."""
    appeles = []

    def fake_get(url, params=None, **_kwargs):
        return Reponse(PISTES)

    def fake_head(url, **_kwargs):
        appeles.append(url)
        poids = 8_812_345 if "125871" in url else 1_048_576
        return Reponse(status_code=200, headers={"Content-Length": str(poids)})

    monkeypatch.setattr(app_module, "JAMENDO_CLIENT_ID", "cle-de-test")
    monkeypatch.setattr(app_module.requests, "get", fake_get)
    monkeypatch.setattr(app_module.requests, "head", fake_head)
    return appeles


def test_le_poids_reel_est_lu_sur_le_fichier(client, jamendo):
    response = client.get("/api/mp3?provider=jamendo&sizes=1")

    assert response.status_code == 200
    items = {item["id"]: item for item in response.get_json()["items"]}
    assert items["jm:125871"]["size"] == 8_812_345
    assert items["jm:999"]["size"] == 1_048_576
    # Le morceau copiable se mesure sur le fichier que le bouton enregistrera.
    assert jamendo[0] == "https://prod-1.storage.jamendo.com/download/125871/"


def test_sans_demande_de_poids_aucun_head_n_est_emis(client, jamendo):
    response = client.get("/api/mp3?provider=jamendo")

    assert response.status_code == 200
    assert jamendo == []
    assert all(item["size"] == 0 for item in response.get_json()["items"])


def test_le_poids_mesure_est_garde_en_cache(jamendo):
    url = "https://prod-1.storage.jamendo.com/download/4242/"

    assert app_module._jamendo_probe_size(url) == 1_048_576
    assert app_module._jamendo_probe_size(url) == 1_048_576
    assert jamendo == [url], "un morceau ne change pas de taille : un seul HEAD"


def test_une_erreur_de_la_source_ne_donne_pas_de_poids(monkeypatch):
    """Un 404 a aussi un Content-Length — celui de sa page d'erreur."""

    def fake_head(url, **_kwargs):
        return Reponse(status_code=404, headers={"Content-Length": "512"})

    monkeypatch.setattr(app_module.requests, "head", fake_head)
    assert app_module._jamendo_probe_size("https://exemple.test/fichier.mp3") == 0


def test_une_source_muette_laisse_le_poids_inconnu(monkeypatch):
    def fake_head(url, **_kwargs):
        raise requests.ConnectionError("hors ligne")

    monkeypatch.setattr(app_module.requests, "head", fake_head)
    assert app_module._jamendo_probe_size("https://exemple.test/fichier.mp3") == 0


def test_aucune_url_ne_part_en_head():
    assert app_module._jamendo_probe_size("") == 0


# ---------------------------------------------------------------------------
# Interface : le poids s'écrit, ou ne s'écrit pas
# ---------------------------------------------------------------------------


def lire(nom):
    return (ROOT / "static" / nom).read_text(encoding="utf-8")


def test_un_poids_inconnu_s_ecrit_en_toutes_lettres():
    script = lire("js/musique.js")
    assert 'if (value <= 0) return "poids inconnu";' in script
    # La pastille, elle, ne donne aucun chiffre quand le poids manque.
    assert 'item.size ? `MP3 · ${humanSize(item.size)}` : "MP3"' in script


def test_un_morceau_lourd_demande_deux_taps():
    script = lire("js/musique.js")
    assert "CONFIRM_WINDOW_MS = 8000" in script
    assert "Encore un tap : ${humanSize(weight)} sur ton forfait mobile" in script
    # Les deux boutons qui dépensent du forfait sont couverts.
    assert "confirmHeavy(pinBtn, item.size)" in script
    assert "confirmHeavy(download, item.size)" in script


def test_le_poids_est_demande_au_serveur():
    script = lire("js/musique.js")
    assert 'searchParams.set("sizes", "1")' in script


def test_l_etat_a_confirmer_est_visible():
    style = lire("css/style.css")
    assert ".music-pin-btn.is-confirm" in style
    assert ".music-get-btn.is-confirm" in style
