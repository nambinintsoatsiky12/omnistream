"""Le calendrier des épisodes, la recherche du rayon adulte, l'historique de
lecture, le mode lecture continue et l'affichage de la langue réelle.

AniList et MangaDex sont bouchonnés : ce bac à sable n'a pas d'accès sortant,
les appels réels restent donc à vérifier à la main.
"""

import datetime
from pathlib import Path

import pytest

import app as app_module

GABARITS = Path(__file__).resolve().parent.parent / "templates"
STATIQUES = Path(__file__).resolve().parent.parent / "static"


class Reponse:
    def __init__(self, donnees, status_code=200):
        self._donnees = donnees
        self.status_code = status_code
        self.headers = {}

    def json(self):
        return self._donnees

    def raise_for_status(self):
        return None

    def close(self):
        return None


def media_airing(identifiant, titre, dans_heures=3, episode=12, kind="ANIME"):
    """Une entrée d'`airingSchedules` telle qu'AniList la renvoie."""
    moment = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
        hours=dans_heures
    )
    return {
        "airingAt": int(moment.timestamp()),
        "episode": episode,
        "mediaId": identifiant,
        "media": {
            "id": identifiant,
            "type": kind,
            "format": "TV",
            "isAdult": False,
            "countryOfOrigin": "JP",
            "averageScore": 82,
            "title": {"romaji": titre, "userPreferred": titre},
            "coverImage": {
                "large": f"https://s4.anilist.co/file/anilistcdn/{identifiant}.jpg"
            },
        },
    }


def bouchonner_calendrier(monkeypatch, lignes, has_next=False):
    journal = []

    def faux_post(url, json=None, **kwargs):
        journal.append((json or {}).get("variables") or {})
        return Reponse(
            {
                "data": {
                    "Page": {
                        "pageInfo": {"hasNextPage": has_next, "total": len(lignes)},
                        "airingSchedules": lignes,
                    }
                }
            }
        )

    monkeypatch.setattr(app_module.requests, "post", faux_post)
    return journal


# ---------------------------------------------------------------------------
# 1. Le calendrier
# ---------------------------------------------------------------------------


def test_le_calendrier_annonce_les_episodes_de_la_semaine(client, monkeypatch):
    journal = bouchonner_calendrier(
        monkeypatch,
        [
            media_airing(1, "Serie A", dans_heures=3, episode=12),
            media_airing(2, "Serie B", dans_heures=30, episode=5),
        ],
    )

    reponse = client.get("/api/calendrier", query_string={"media": "anime"})
    corps = reponse.get_json()

    assert reponse.status_code == 200
    assert [item["title"] for item in corps["items"]] == ["Serie A", "Serie B"]
    assert corps["items"][0]["episode"] == 12
    assert corps["fenetre_jours"] == 7
    # La fenêtre envoyée à AniList couvre bien sept jours.
    variables = journal[0]
    assert variables["fin"] - variables["debut"] == 7 * 24 * 3600


def test_le_calendrier_dit_aujourd_hui_et_demain_en_francais(client, monkeypatch):
    bouchonner_calendrier(
        monkeypatch,
        [
            media_airing(1, "Aujourd", dans_heures=1),
            media_airing(2, "Demain", dans_heures=25),
            media_airing(3, "Plus tard", dans_heures=72),
        ],
    )

    items = client.get("/api/calendrier", query_string={"media": "anime"}).get_json()[
        "items"
    ]

    assert items[0]["jour"] == "aujourd'hui"
    assert items[1]["jour"] == "demain"
    assert items[2]["jour"] in app_module.ANILIST_JOURS


def test_le_calendrier_ecarte_les_oeuvres_adultes(client, monkeypatch):
    ligne = media_airing(1, "Adulte")
    ligne["media"]["isAdult"] = True
    bouchonner_calendrier(monkeypatch, [ligne, media_airing(2, "Propre")])

    items = client.get("/api/calendrier", query_string={"media": "anime"}).get_json()[
        "items"
    ]

    assert [item["title"] for item in items] == ["Propre"]


def test_le_calendrier_ne_melange_pas_animes_et_mangas(client, monkeypatch):
    bouchonner_calendrier(
        monkeypatch,
        [
            media_airing(1, "Anime", kind="ANIME"),
            media_airing(2, "Manga", kind="MANGA"),
        ],
    )

    items = client.get("/api/calendrier", query_string={"media": "anime"}).get_json()[
        "items"
    ]

    assert [item["title"] for item in items] == ["Anime"]


def test_le_calendrier_refuse_un_media_inconnu(client, monkeypatch):
    bouchonner_calendrier(monkeypatch, [])

    assert (
        client.get("/api/calendrier", query_string={"media": "film"}).status_code == 400
    )


def test_le_calendrier_survit_a_une_ligne_malformee(client, monkeypatch):
    bouchonner_calendrier(
        monkeypatch,
        [
            None,
            {"airingAt": "pas une date", "episode": None, "media": None},
            media_airing(1, "Valide"),
        ],
    )

    items = client.get("/api/calendrier", query_string={"media": "anime"}).get_json()[
        "items"
    ]

    # Les deux lignes cassées sont écartées, la bonne passe.
    assert [item["title"] for item in items] == ["Valide"]


def test_un_episode_sans_numero_reste_annonce(client, monkeypatch):
    """Un spécial ou un OVA n'a pas toujours de numéro : il compte quand même."""
    ligne = media_airing(1, "Special")
    ligne["episode"] = None
    bouchonner_calendrier(monkeypatch, [ligne])

    items = client.get("/api/calendrier", query_string={"media": "anime"}).get_json()[
        "items"
    ]

    assert items[0]["title"] == "Special"
    assert items[0]["episode"] is None


def test_le_calendrier_est_dans_l_onglet_et_pas_ailleurs(client):
    animes = client.get("/?tab=animes").get_data(as_text=True)
    films = client.get("/?tab=films").get_data(as_text=True)

    assert 'id="calendrier"' in animes
    assert 'id="calendrier"' not in films


def test_le_calendrier_se_cache_quand_anilist_ne_repond_pas(client, monkeypatch):
    def faux_post(url, json=None, **kwargs):
        raise app_module.requests.exceptions.SSLError("coupé")

    monkeypatch.setattr(app_module.requests, "post", faux_post)

    # L'erreur remonte proprement plutôt que de casser la page entière.
    assert (
        client.get("/api/calendrier", query_string={"media": "anime"}).status_code
        == 502
    )
    assert client.get("/?tab=animes").status_code == 200


# ---------------------------------------------------------------------------
# 2. La recherche du rayon adulte
# ---------------------------------------------------------------------------


def bouchonner_adulte(monkeypatch, total=1):
    journal = []

    def faux_get(url, params=None, **kwargs):
        journal.append(list(params or []))
        return Reponse(
            {
                "data": [
                    {
                        "id": "9712c4ff-a8b5-4b21-9e8f-4a54058a1a00",
                        "type": "manga",
                        "attributes": {
                            "title": {"en": "Demo"},
                            "year": 2021,
                            "contentRating": "pornographic",
                        },
                        "relationships": [
                            {"type": "cover_art", "attributes": {"fileName": "a.png"}}
                        ],
                    }
                ],
                "total": total,
            }
        )

    monkeypatch.setattr(app_module.requests, "get", faux_get)
    return journal


def test_la_recherche_adulte_part_vers_mangadex(client, monkeypatch):
    journal = bouchonner_adulte(monkeypatch)

    reponse = client.get("/api/adulte", query_string={"q": "one piece"})

    assert reponse.status_code == 200
    assert ("title", "one piece") in journal[0]
    # Avec une recherche, on laisse MangaDex classer par pertinence : imposer
    # `followedCount` remonterait les plus populaires, pas les plus proches.
    assert ("order[followedCount]", "desc") not in journal[0]


def test_sans_recherche_les_plus_suivis_passent_d_abord(client, monkeypatch):
    journal = bouchonner_adulte(monkeypatch)

    client.get("/api/adulte")

    assert ("order[followedCount]", "desc") in journal[0]
    assert not [cle for cle, _ in journal[0] if cle == "title"]


def test_une_recherche_trop_longue_est_refusee(client, monkeypatch):
    bouchonner_adulte(monkeypatch)

    assert client.get("/api/adulte", query_string={"q": "a" * 200}).status_code == 400


def test_le_rayon_adulte_a_un_champ_de_recherche(client):
    html = client.get("/adulte").get_data(as_text=True)

    assert 'id="adulte-q"' in html
    assert 'id="adulte-form"' in html
    assert 'params.set("q", recherche)' in html


# ---------------------------------------------------------------------------
# 3. Historique de lecture, lecture continue, langue réelle
# ---------------------------------------------------------------------------


def script_lecteur():
    gabarit = (GABARITS / "lecteur.html").read_text(encoding="utf-8")
    return gabarit.split("{% block scripts %}", 1)[1]


def test_le_lecteur_retient_le_dernier_chapitre_lu():
    js = script_lecteur()

    assert "omni-scan-historique" in js
    assert "function noterChapitre()" in js
    assert "noterChapitre();" in js, "rien n'est mémorisé si personne n'appelle"
    assert "function reprendre()" in js
    # Borné : la clé ne doit pas grossir sans limite.
    assert "HISTORIQUE_MAX = 40" in js


def test_la_reprise_reste_dans_les_clous():
    """Un indice périmé ne doit pas faire planter le lecteur."""
    js = script_lecteur()

    assert "entree.indice < chapters.length" in js
    assert "Reprise au chapitre" in js


def test_l_historique_ne_quitte_pas_l_appareil():
    """Aucun compte sur le site : rien ne doit partir vers le serveur."""
    js = script_lecteur()
    debut = js.split("function noterChapitre()", 1)[1]
    bloc = debut.split("function reprendre()", 1)[0]

    assert "fetch(" not in bloc
    assert "localStorage" in bloc


def test_le_lecteur_propose_une_lecture_continue():
    gabarit = (GABARITS / "lecteur.html").read_text(encoding="utf-8")
    js = script_lecteur()
    css = (STATIQUES / "css" / "style.css").read_text(encoding="utf-8")

    assert 'id="scan-webtoon"' in gabarit
    assert "Lecture continue" in gabarit
    assert "mode-webtoon" in js
    assert ".scan-pages-flow.mode-webtoon {" in css
    # Le choix est mémorisé d'une lecture à l'autre.
    assert "omni-scan-webtoon" in js


def test_le_lecteur_nomme_la_langue_reellement_trouvee():
    """« Toutes langues » ne renseigne pas quand on vient de charger du coréen."""
    js = script_lecteur()

    assert "function langueReelle(" in js
    assert "translatedLanguage" in js
    assert "chapitres en ${trouvee}, pas en français" in js
    assert 'ko: "coréen"' in js


def test_le_lecteur_n_invente_pas_de_langue():
    js = script_lecteur()

    # Pas de langue exploitable : on retombe sur l'ancien message, on
    # n'affiche pas un nom de langue vide.
    assert 'if (!ordre.length) return "";' in js


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
