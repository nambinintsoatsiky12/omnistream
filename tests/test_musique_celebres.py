"""Source « Titres connus » : le catalogue Deezer, en extraits de 30 secondes.

Jamendo et Archive ne contiennent que de la musique libre : les titres que les
gens cherchent n'y sont pas. Deezer expose son catalogue public sans clé et
autorise la diffusion d'un extrait de 30 secondes par morceau. Ce banc vérifie
que l'application s'en tient là :

- l'extrait se lit, le morceau entier reste chez Deezer ;
- aucun bouton de téléchargement n'existe pour un extrait ;
- la durée annoncée est celle de l'extrait, pas celle du morceau ;
- un Deezer muet ne vide pas la page.

L'API est bouchonnée : ce bac à sable n'a pas d'accès sortant.
"""

from pathlib import Path

import pytest
import requests

import app as app_module


class Reponse:
    def __init__(self, donnees, status_code=200):
        self._donnees = donnees
        self.status_code = status_code

    def json(self):
        return self._donnees


def piste(identifiant, titre, artiste="Un artiste", preview="https://cdns-preview-8.dzcdn.net/s.mp3"):
    return {
        "id": identifiant,
        "title": titre,
        "duration": 294,
        "rank": 900000,
        "artist": {"name": artiste},
        "album": {"title": "Un album", "cover_medium": "https://e-cdns-images.dzcdn.net/c.jpg"},
        "preview": preview,
    }


def bouchonner(monkeypatch, donnees, status_code=200, exception=None):
    journal = []

    def faux_get(url, params=None, **kwargs):
        journal.append({"url": url, "params": params or {}})
        if exception:
            raise exception
        return Reponse(donnees, status_code)

    monkeypatch.setattr(app_module.requests, "get", faux_get)
    return journal


CLASSEMENT = {"tracks": {"data": [piste(1, "Billie Jean", "Michael Jackson")]}}


def test_sans_recherche_on_recoit_le_classement(monkeypatch):
    """« Titres les plus écoutés », c'est-à-dire des titres connus."""
    journal = bouchonner(monkeypatch, CLASSEMENT)

    items = app_module._deezer_items("")

    assert journal[0]["url"] == app_module.DEEZER_CHART_URL
    assert journal[0]["params"] == {}
    assert items[0]["title"] == "Billie Jean"
    assert items[0]["channel"] == "Michael Jackson"


def test_une_recherche_part_sur_le_moteur_et_son_index(monkeypatch):
    journal = bouchonner(monkeypatch, {"data": [piste(2, "Solo")]})

    app_module._deezer_items("michael jackson", page=3)

    assert journal[0]["url"] == app_module.DEEZER_SEARCH_URL
    assert journal[0]["params"]["q"] == "michael jackson"
    assert journal[0]["params"]["index"] == 48, "page 3 = deux pages de 25 sautées"


def test_un_rayon_sans_mot_tape_cherche_son_sujet(monkeypatch):
    journal = bouchonner(monkeypatch, {"data": []})

    app_module._deezer_items("", shelf="madagascar")

    assert journal[0]["params"]["q"] == "madagascar"


def test_un_titre_sans_extrait_est_ecarte(monkeypatch):
    """Une piste sans extrait ne ferait aucun bruit : elle ne s'affiche pas."""
    bouchonner(
        monkeypatch,
        {"data": [piste(1, "Avec extrait"), piste(2, "Sans extrait", preview="")]},
    )

    items = app_module._deezer_items("test")

    assert [item["title"] for item in items] == ["Avec extrait"]


@pytest.mark.parametrize(
    "preview",
    [
        "https://evil.example/x.mp3",
        "https://dzcdn.net.evil.example/x.mp3",
        "https://cdns-preview-8.dzcdn.net:8443/x.mp3",
        "ftp://cdns-preview-8.dzcdn.net/x.mp3",
    ],
)
def test_un_extrait_hors_du_cdn_deezer_est_ecarte(preview):
    assert app_module._deezer_https(preview) == ""


@pytest.mark.parametrize(
    "brut,attendu",
    [
        ("http://cdns-preview-8.dzcdn.net/x.mp3", "https://cdns-preview-8.dzcdn.net/x.mp3"),
        ("//cdns-preview-8.dzcdn.net/x.mp3", "https://cdns-preview-8.dzcdn.net/x.mp3"),
        ("https://e-cdns-images.dzcdn.net/c.jpg", "https://e-cdns-images.dzcdn.net/c.jpg"),
    ],
)
def test_les_adresses_du_cdn_sont_ramenees_en_https(brut, attendu):
    assert app_module._deezer_https(brut) == attendu


def test_aucun_bouton_de_telechargement_sur_un_extrait(monkeypatch):
    """Le morceau entier appartient à l'ayant droit : rien à enregistrer ici."""
    bouchonner(monkeypatch, CLASSEMENT)

    items = app_module._deezer_items("")

    assert items[0]["download"] == ""
    assert items[0]["page"] == "https://www.deezer.com/track/1"
    assert "30 s" in items[0]["license_name"], "l'écran doit dire ce qu'est l'extrait"


def test_la_duree_annoncee_est_celle_de_l_extrait(monkeypatch):
    """294 s dans l'API, 30 s à l'écoute : annoncer 4:54 serait un mensonge."""
    bouchonner(monkeypatch, CLASSEMENT)

    assert app_module._deezer_items("")[0]["duration"] == 30


def test_deezer_demande_explicitement_en_panne_le_dit(client, monkeypatch):
    bouchonner(monkeypatch, {}, exception=requests.ConnectionError("coupé"))

    reponse = client.get("/api/mp3?provider=deezer")

    assert reponse.status_code == 502
    assert "Deezer" in reponse.get_json()["error"]


def test_deezer_muet_ne_vide_pas_une_page_mixte(client, monkeypatch):
    monkeypatch.setattr(app_module, "_jamendo_available", lambda: False)

    def archive_muet(query, page=1, shelf="tout"):
        return [
            {
                "kind": "mp3",
                "type": "music",
                "provider": "archive",
                "id": "ar:1",
                "identifier": "album-1",
                "title": "Un titre libre",
                "channel": "Un artiste",
                "album": "",
                "year": "",
                "duration": 200,
                "size": 0,
                "thumbnail": "",
                "url": "https://archive.org/download/album-1/piste.mp3",
                "download": "/mp3/album-1/piste.mp3?download=1",
                "page": "https://archive.org/details/album-1",
                "license": "",
                "license_name": "",
            }
        ]

    monkeypatch.setattr(app_module, "_archive_search_items", archive_muet)
    monkeypatch.setattr(app_module, "_archive_item_tracks", lambda doc: [doc])
    bouchonner(monkeypatch, {}, exception=requests.ConnectionError("coupé"))

    reponse = client.get("/api/mp3?q=billie")

    assert reponse.status_code == 200
    payload = reponse.get_json()
    assert payload["source"] == "archive", "seule Archive a vraiment répondu"
    assert "Deezer" in payload["warning"]


def test_la_source_annoncee_est_celle_qui_a_repondu(client, monkeypatch):
    bouchonner(monkeypatch, CLASSEMENT)

    payload = client.get("/api/mp3?provider=deezer&q=billie").get_json()

    assert payload["source"] == "deezer"


def test_deezer_ne_se_glisse_pas_parmi_les_fournisseurs(client, monkeypatch):
    """La ligne « fournisseur » ne propose que des fichiers complets et
    enregistrables. Les extraits passent par le sélecteur de source."""
    monkeypatch.setattr(app_module, "_jamendo_available", lambda: False)
    bouchonner(monkeypatch, CLASSEMENT)

    payload = client.get("/api/mp3?provider=deezer").get_json()

    assert payload["providers"] == ["archive"]


def test_l_interface_propose_la_source_titres_connus():
    racine = Path(app_module.app.root_path)
    gabarit = (racine / "templates" / "musique.html").read_text(encoding="utf-8")
    js = (racine / "static" / "js" / "musique.js").read_text(encoding="utf-8")

    assert 'data-source="celebres"' in gabarit
    assert "Titres connus" in gabarit
    assert 'celebres: {' in js
    assert 'trending: "/api/mp3?provider=deezer"' in js
    # La promesse est écrite noir sur blanc sous le bouton.
    assert "Extraits de 30 secondes" in js
    assert "s'enregistre pas" in js


def test_une_source_inconnue_ne_casse_pas_le_selecteur():
    js = (
        Path(app_module.app.root_path) / "static" / "js" / "musique.js"
    ).read_text(encoding="utf-8")

    # Une source ajoutée côté serveur ne demande plus de correctif côté page.
    assert 'hasOwnProperty.call(SOURCES, source)' in js
    assert 'hasOwnProperty.call(SOURCES, saved)' in js
    # Seule YouTube a une image : les deux autres sont des fichiers audio.
    assert 'currentSource !== "youtube" && btn.dataset.mode === "video"' in js
