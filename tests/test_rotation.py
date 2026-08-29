"""La rotation de la grille : chaque ouverture redessine l'ordre, sans jamais
noyer les titres les plus courus.

Le principe est un tirage aléatoire pondéré (Efraimidis-Spirakis) : la clé d'un
titre est ``u**(1/poids)`` avec ``u`` tiré dans ]0,1[, donc plus le poids est
grand plus le titre remonte EN MOYENNE — sans qu'aucune place soit garantie
d'une visite à l'autre. Un simple ``popularity.desc`` figeait le haut de page ;
un tirage uniforme noierait les chefs-d'œuvre au milieu du reste.

TMDB et AniList sont bouchonnés : ce bac à sable n'a pas d'accès sortant.
"""

from pathlib import Path

import pytest

import app as app_module

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


def carte(rang):
    """Une carte dont le rang catalogue est encodé dans le titre."""
    return {
        "id": rang,
        "media_type": "movie",
        "title": f"Titre {rang}",
        "year": "2024",
        "rating": 8.0,
        "poster": "/api/manga_image?url=x",
    }


# ---------------------------------------------------------------------------
# 1. Le tirage lui-même
# ---------------------------------------------------------------------------


def test_la_meme_graine_donne_exactement_le_meme_ordre():
    """Sans ça, le défilement infini se répéterait entre deux pages."""
    items = [carte(i) for i in range(100)]

    premier = [x["id"] for x in app_module.rotation_order(items, "visite-a")]
    second = [x["id"] for x in app_module.rotation_order(items, "visite-a")]

    assert premier == second


def test_une_nouvelle_visite_redessine_la_grille():
    items = [carte(i) for i in range(100)]

    premiere = [x["id"] for x in app_module.rotation_order(items, "visite-a")]
    deuxieme = [x["id"] for x in app_module.rotation_order(items, "visite-b")]

    assert premiere != deuxieme


def test_les_titres_les_plus_courus_restent_en_haut():
    """Le cœur de la demande : ça tourne, mais le haut reste le haut.

    Sur 300 visites, les vingt titres les plus courus du catalogue doivent
    occuper la majorité des vingt premières places — sinon la grille n'est
    plus qu'un bruit et les œuvres marquantes disparaissent.
    """
    items = [carte(i) for i in range(100)]
    dans_le_haut = []
    for visite in range(300):
        ordre = app_module.rotation_order(items, f"visite-{visite}")
        dans_le_haut.append(sum(1 for x in ordre[:20] if x["id"] < 20))

    moyenne = sum(dans_le_haut) / len(dans_le_haut)

    assert moyenne >= 11, f"seulement {moyenne:.1f}/20 viennent du vrai top 20"
    assert moyenne <= 19, "l'ordre serait figé, plus aucune rotation visible"


def test_le_premier_titre_change_d_une_visite_a_l_autre():
    items = [carte(i) for i in range(100)]
    premiers = {
        app_module.rotation_order(items, f"visite-{v}")[0]["id"] for v in range(60)
    }

    assert len(premiers) >= 5, "le premier titre ne change quasiment jamais"


def test_le_tirage_ne_perd_et_ne_duplique_aucun_titre():
    items = [carte(i) for i in range(100)]

    ordre = [x["id"] for x in app_module.rotation_order(items, "visite-a")]

    assert sorted(ordre) == list(range(100))


def test_une_liste_courte_ne_casse_pas():
    assert app_module.rotation_order([], "g") == []
    seul = [carte(1)]
    assert app_module.rotation_order(seul, "g") == seul


def test_une_note_elevee_fait_remonter_un_titre():
    """À rang égal, la note et la fraîcheur départagent."""
    modeste = [{"rating": 4.0, "year": "1998", "id": "bas"}] * 1 + [
        carte(i) for i in range(1, 40)
    ]
    for item in modeste:
        item["rating"] = 4.0
        item["year"] = "1998"
    modeste[0] = {"rating": 4.0, "year": "1998", "id": "bas"}

    poids_modeste = app_module._rotation_weight(20, 100, 4.0, "1998", 2026)
    poids_fort = app_module._rotation_weight(20, 100, 9.5, "2025", 2026)

    assert poids_fort > poids_modeste


def test_une_annee_absente_ne_casse_pas_le_poids():
    assert app_module._rotation_weight(1, 100, None, None, 2026) > 0
    assert app_module._rotation_weight(1, 100, "pas une note", "", 2026) > 0


# ---------------------------------------------------------------------------
# 2. Les bandes : cent titres lus d'un coup, servis cinq pages par cinq
# ---------------------------------------------------------------------------


def test_les_bandes_decoupent_le_catalogue_par_cinq():
    assert app_module._rotation_band(1) == (0, 0)
    assert app_module._rotation_band(5) == (0, 4)
    assert app_module._rotation_band(6) == (1, 0)
    assert app_module._rotation_band(30) == (5, 4)


def test_une_bande_ne_repete_pas_les_memes_titres(client, monkeypatch):
    """Cinq pages du site issues d'une bande = cent titres distincts.

    Sans bande, chaque page était les vingt mêmes titres réordonnés : c'est
    exactement ce que le visiteur reprochait au site.
    """
    def faux_tmdb(chemin, params=None):
        page = int((params or {}).get("page", 1))
        return {
            "results": [
                {
                    "id": page * 100 + index,
                    "title": f"T{page}-{index}",
                    "poster_path": "/p.jpg",
                    "vote_average": 7.5,
                    "release_date": "2024-01-01",
                }
                for index in range(20)
            ],
            "total_pages": 50,
        }

    monkeypatch.setattr(app_module, "tmdb_get", faux_tmdb)

    vus = []
    for page in range(1, 6):
        corps = client.get(f"/api/list?tab=films&page={page}&seed=visite-a").get_json()
        vus.extend(item["id"] for item in corps["items"])

    assert len(vus) == 100
    assert len(set(vus)) == 100, "une bande ne doit servir aucun titre deux fois"


def test_deux_visites_ne_voient_pas_le_meme_haut_de_page(client, monkeypatch):
    def faux_tmdb(chemin, params=None):
        page = int((params or {}).get("page", 1))
        return {
            "results": [
                {
                    "id": page * 100 + index,
                    "title": f"T{page}-{index}",
                    "poster_path": "/p.jpg",
                    "vote_average": 7.5,
                    "release_date": "2024-01-01",
                }
                for index in range(20)
            ],
            "total_pages": 50,
        }

    monkeypatch.setattr(app_module, "tmdb_get", faux_tmdb)

    premiere = client.get("/api/list?tab=films&page=1&seed=visite-a").get_json()
    deuxieme = client.get("/api/list?tab=films&page=1&seed=visite-b").get_json()

    assert [i["id"] for i in premiere["items"]] != [i["id"] for i in deuxieme["items"]]


def test_la_borne_de_pagination_survit_aux_bandes(client, monkeypatch):
    monkeypatch.setattr(
        app_module,
        "tmdb_get",
        lambda *a, **k: {
            "results": [
                {
                    "id": 1,
                    "title": "T",
                    "poster_path": "/p.jpg",
                    "vote_average": 8.0,
                    "release_date": "2024-01-01",
                }
            ],
            "total_pages": 2,
        },
    )

    premiere = client.get("/api/list?tab=films&page=1&seed=v").get_json()
    derniere = client.get("/api/list?tab=films&page=2&seed=v").get_json()

    assert premiere["has_more"] is True
    assert derniere["has_more"] is False


def test_les_films_superieurs_a_8_5_tournent_aussi(client, monkeypatch):
    def faux_tmdb(chemin, params=None):
        return {
            "results": [
                {
                    "id": index,
                    "title": f"T{index}",
                    "poster_path": "/p.jpg",
                    "vote_average": 9.0,
                    "release_date": "2024-01-01",
                }
                for index in range(20)
            ],
            "total_pages": 3,
        }

    monkeypatch.setattr(app_module, "tmdb_get", faux_tmdb)

    # « Films ≥ 8,5 » a sa propre route.
    premiere = client.get("/api/legends?seed=visite-a").get_json()
    deuxieme = client.get("/api/legends?seed=visite-b").get_json()

    assert [i["id"] for i in premiere["items"]] != [i["id"] for i in deuxieme["items"]]


# ---------------------------------------------------------------------------
# 3. La graine de visite, côté navigateur
# ---------------------------------------------------------------------------


def test_la_graine_survit_a_la_session_mais_pas_a_l_onglet():
    js = (STATIQUES / "js" / "home.js").read_text(encoding="utf-8")

    # sessionStorage : stable le temps de la visite (sinon le défilement
    # infini se répète), et neuf à chaque nouvelle ouverture.
    assert "sessionStorage" in js
    assert "localStorage" not in js.split("function graineDeVisite")[1][:900]
    assert "omni-graine-visite" in js
    assert "function graineDeVisite()" in js


def test_la_graine_part_avec_chaque_requete_de_liste():
    js = (STATIQUES / "js" / "home.js").read_text(encoding="utf-8")

    assert "seed: sessionSeed" in js


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
