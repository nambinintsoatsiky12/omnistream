"""Le rayon adulte (hentai), son portail « J'ai 18 ans », et les correctifs
qui l'accompagnent : plafond de pages de l'onglet AniList, sous-genres étendus,
outil de recherche des pastilles.

MangaDex est bouchonné : ce bac à sable n'a pas d'accès sortant vers
``api.mangadex.org``, les appels réels restent donc à vérifier à la main.
"""

from pathlib import Path

import pytest

import app as app_module

GABARITS = Path(__file__).resolve().parent.parent / "templates"
STATIQUES = Path(__file__).resolve().parent.parent / "static"

MANGA_ID = "9712c4ff-a8b5-4b21-9e8f-4a54058a1a00"


class Reponse:
    """Réponse requests minimale."""

    def __init__(self, donnees, status_code=200):
        self._donnees = donnees
        self.status_code = status_code
        self.headers = {}
        self.text = "{}"

    def json(self):
        return self._donnees

    def raise_for_status(self):
        return None

    def close(self):
        return None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None


def manga_mangadex(identifiant=MANGA_ID, titre="Demo Hentai", **complements):
    noeud = {
        "id": identifiant,
        "type": "manga",
        "attributes": {
            "title": {"en": titre, "ja": "デモ"},
            "year": 2021,
            "contentRating": "pornographic",
            "publicationDemographic": "seinen",
        },
        "relationships": [
            {"type": "cover_art", "attributes": {"fileName": "abc-123.png"}}
        ],
    }
    noeud.update(complements)
    return noeud


def bouchonner_mangadex(monkeypatch, donnees=None, status_code=200):
    journal = []

    def faux_get(url, params=None, **kwargs):
        journal.append({"url": url, "params": list(params or [])})
        if donnees is not None:
            return Reponse(donnees, status_code)
        return Reponse({"data": [manga_mangadex()], "total": 1}, status_code)

    monkeypatch.setattr(app_module.requests, "get", faux_get)
    return journal


# ---------------------------------------------------------------------------
# 1. Le portail : rien ne s'affiche avant le clic
# ---------------------------------------------------------------------------


def test_la_page_adulte_s_ouvre_sur_le_portail(client):
    page = client.get("/adulte")
    html = page.get_data(as_text=True)

    assert page.status_code == 200
    assert "J'ai 18 ans" in html
    assert 'id="adulte-gate"' in html
    # La grille est vide dans le HTML : les données n'arrivent qu'après.
    assert '<div class="grid" id="adulte-grid"></div>' in html
    assert "omni-adulte-18" in html


def test_le_portail_n_est_pas_retire_par_le_serveur(client):
    """C'est le navigateur qui le retire, jamais le gabarit."""
    html = client.get("/adulte").get_data(as_text=True)

    assert 'id="adulte-content" hidden' in html
    assert "if (confirme()) ouvrir();" in html


def test_un_bouton_permet_de_reverrouiller(client):
    html = client.get("/adulte").get_data(as_text=True)

    assert 'id="adulte-lock"' in html
    assert "Re-verrouiller" in html
    assert "function verrouiller()" in html


def test_le_rayon_adulte_est_dans_le_menu_mais_pas_dans_les_onglets():
    base = (GABARITS / "base.html").read_text(encoding="utf-8")

    assert "url_for('adulte')" in base
    # Hors de la barre d'onglets principale.
    barre = base.split('<nav class="tabs"', 1)[1].split("</nav>", 1)[0]
    assert "adulte" not in barre


# ---------------------------------------------------------------------------
# 2. L'API : une requête MangaDex figée, un seul filtre possible
# ---------------------------------------------------------------------------


def test_l_api_adulte_demande_seulement_ce_qui_se_lit(client, monkeypatch):
    journal = bouchonner_mangadex(monkeypatch)

    reponse = client.get("/api/adulte")
    params = dict(journal[0]["params"])

    assert reponse.status_code == 200
    assert params["hasAvailableChapters"] == "true"
    assert params["order[followedCount]"] == "desc"
    assert [v for k, v in journal[0]["params"] if k == "contentRating[]"] == [
        "erotica",
        "pornographic",
    ]
    assert journal[0]["url"] == "https://api.mangadex.org/manga"


def test_l_api_adulte_renvoie_des_cartes_exploitables(client, monkeypatch):
    bouchonner_mangadex(monkeypatch)

    items = client.get("/api/adulte").get_json()["items"]

    assert len(items) == 1
    carte = items[0]
    assert carte["media_type"] == "manga"
    assert carte["title"] == "Demo Hentai"
    assert carte["year"] == "2021"
    assert carte["reader"] == "/lecteur-scan?titre=Demo%20Hentai"
    # Les couvertures passent par notre proxy, jamais en direct.
    assert carte["poster"].startswith("/api/manga_image?url=")
    assert "uploads.mangadex.org" in carte["poster"]


def test_le_filtre_de_contenu_est_borne(client, monkeypatch):
    journal = bouchonner_mangadex(monkeypatch)

    refus = client.get("/api/adulte", query_string={"rating": "bogus"})
    assert refus.status_code == 400

    client.get("/api/adulte", query_string={"rating": "erotica"})
    params = [v for k, v in journal[-1]["params"] if k == "contentRating[]"]
    assert params == ["erotica"]


def test_une_fiche_sans_couverture_ou_sans_titre_est_ecartee(client, monkeypatch):
    bouchonner_mangadex(
        monkeypatch,
        donnees={
            "data": [
                manga_mangadex(
                    "11111111-1111-4111-8111-111111111111",
                    "",
                    attributes={"title": {}, "year": 2020},
                ),
                manga_mangadex(
                    "22222222-2222-4222-8222-222222222222",
                    "Sans couverture",
                    relationships=[],
                ),
                manga_mangadex(),
            ],
            "total": 3,
        },
    )

    items = client.get("/api/adulte").get_json()["items"]

    assert [item["title"] for item in items] == ["Demo Hentai"]


def test_un_identifiant_malforme_ne_passe_pas(client, monkeypatch):
    bouchonner_mangadex(
        monkeypatch,
        donnees={"data": [manga_mangadex("pas-un-uuid")], "total": 1},
    )

    assert client.get("/api/adulte").get_json()["items"] == []


def test_une_erreur_mangadex_remonte_avec_sa_raison(client, monkeypatch):
    bouchonner_mangadex(
        monkeypatch,
        donnees={
            "errors": [
                {"status": 429, "title": "Too many requests", "detail": "Slow down."}
            ]
        },
        status_code=429,
    )

    reponse = client.get("/api/adulte")

    assert reponse.status_code == 429
    assert "Slow down." in reponse.get_json()["error"]


# ---------------------------------------------------------------------------
# 3. Le lecteur de scan dit enfin pourquoi il échoue
# ---------------------------------------------------------------------------


def test_le_proxy_recopie_le_detail_mangadex(client, monkeypatch):
    def faux_get(url, params=None, **kwargs):
        return Reponse(
            {
                "errors": [
                    {"status": 404, "title": "Not found", "detail": "No such manga"}
                ]
            },
            404,
        )

    monkeypatch.setattr(app_module.requests, "get", faux_get)

    reponse = client.get(
        "/api/mangadex_proxy",
        query_string={"endpoint": "/manga", "title": "x", "limit": "20"},
    )

    assert reponse.status_code == 404
    assert "No such manga" in reponse.get_json()["error"]
    assert "ne connaît pas" in reponse.get_json()["error"]


def test_le_proxy_signale_une_page_de_controle_cloudflare(client, monkeypatch):
    def faux_get(url, params=None, **kwargs):
        return Reponse({"pas": "du json"}, 403)

    # json() doit échouer : la vraie réponse Cloudflare est du HTML.
    class PageHtml(Reponse):
        def json(self):
            raise ValueError("pas du json")

    monkeypatch.setattr(
        app_module.requests, "get", lambda *a, **k: PageHtml({}, 403)
    )

    reponse = client.get(
        "/api/mangadex_proxy",
        query_string={"endpoint": "/manga", "title": "x"},
    )

    assert reponse.status_code == 502
    assert "contrôle" in reponse.get_json()["error"]


def test_le_proxy_reessaie_avant_d_abandonner(client, monkeypatch):
    appels = []

    def faux_get(url, params=None, **kwargs):
        appels.append(url)
        if len(appels) < 2:
            return Reponse({"errors": [{"detail": "Trop de requêtes"}]}, 429)
        return Reponse({"data": []}, 200)

    monkeypatch.setattr(app_module.requests, "get", faux_get)
    monkeypatch.setattr(app_module.time, "sleep", lambda *_: None)

    reponse = client.get(
        "/api/mangadex_proxy", query_string={"endpoint": "/manga", "title": "x"}
    )

    assert reponse.status_code == 200
    assert len(appels) == 2


# ---------------------------------------------------------------------------
# 4. Le catalogue AniList se parcourt en entier
# ---------------------------------------------------------------------------


def test_l_onglet_animes_ne_s_arrete_plus_a_500_titres():
    assert app_module.MAX_PAGES == 25
    assert app_module.ANILIST_MAX_PAGES > app_module.MAX_PAGES
    # 250 pages × 20 cartes : bien au-delà des 500 qui bloquaient la grille.
    assert app_module.ANILIST_MAX_PAGES * app_module.ANILIST_PER_PAGE >= 5000


def test_le_catalogue_anilist_accepte_les_pages_au_dela_de_25(client, monkeypatch):
    def faux_post(url, json=None, **kwargs):
        return Reponse(
            {
                "data": {
                    "Page": {
                        "pageInfo": {"hasNextPage": True, "total": 9000},
                        "media": [
                            {
                                "id": 1,
                                "type": "ANIME",
                                "format": "TV",
                                "isAdult": False,
                                "countryOfOrigin": "JP",
                                "averageScore": 80,
                                "title": {"romaji": "Serie", "userPreferred": "Serie"},
                                "coverImage": {
                                    "large": "https://s4.anilist.co/file/anilistcdn/a.jpg"
                                },
                            }
                        ],
                    }
                }
            }
        )

    monkeypatch.setattr(app_module.requests, "post", faux_post)

    page_30 = client.get(
        "/api/list", query_string={"tab": "animes", "media": "anime", "page": 30}
    )

    assert page_30.status_code == 200
    corps = page_30.get_json()
    assert corps["page"] == 30
    assert corps["has_more"] is True


def test_le_defilement_ne_decroche_plus_quand_une_page_est_courte():
    js = (STATIQUES / "js" / "home.js").read_text(encoding="utf-8")

    # IntersectionObserver ne rappelle sa fonction que sur un CHANGEMENT
    # d'intersection : sans cette relance, une page qui ne remplit pas
    # l'écran arrêtait la grille pour de bon.
    assert "sentinel.getBoundingClientRect().top < window.innerHeight + 600" in js
    assert "requestAnimationFrame" in js


# ---------------------------------------------------------------------------
# 5. Tous les sous-genres, et un moyen de les trouver
# ---------------------------------------------------------------------------


def test_les_sous_genres_couvrent_les_rayons_attendus():
    manga = {pill["label"] for pill in app_module.ANILIST_THEMES_MANGA}
    anime = {pill["label"] for pill in app_module.ANILIST_THEMES_ANIME}

    for attendu in ("Shōnen", "Shōjo", "Seinen", "Josei", "Réincarnation", "Isekai"):
        assert attendu in manga, f"{attendu} manque aux mangas"
    for attendu in ("Réincarnation", "Isekai", "Zombie", "Harem", "Magie"):
        assert attendu in anime, f"{attendu} manque aux animes"
    # Assez de rayons pour rivaliser avec l'onglet Films, pas une poignée.
    assert len(app_module.ANILIST_THEMES_MANGA) >= 100
    assert len(app_module.ANILIST_THEMES_ANIME) >= 90


def test_chaque_sous_genre_a_un_identifiant_unique():
    for kind in ("anime", "manga"):
        identifiants = [
            pill["id"]
            for pill in app_module.ANILIST_GENRES + app_module.anilist_themes(kind)
        ]
        assert len(identifiants) == len(set(identifiants)), kind


def test_les_pastilles_sont_cherchables_et_depliables():
    gabarit = (GABARITS / "index.html").read_text(encoding="utf-8")
    js = (STATIQUES / "js" / "home.js").read_text(encoding="utf-8")
    css = (STATIQUES / "css" / "style.css").read_text(encoding="utf-8")

    assert 'id="pill-search"' in gabarit
    assert 'id="pill-expand"' in gabarit
    assert "installerOutilsPills" in js
    assert ".pills.is-wrapped {" in css


# ---------------------------------------------------------------------------
# 6. La fiche : variantes de titre et œuvres liées
# ---------------------------------------------------------------------------


def test_le_lecteur_recoit_les_variantes_depuis_l_url(client):
    page = client.get(
        "/lecteur-scan",
        query_string={"titre": "鬼滅の刃", "alt": "Kimetsu no Yaiba|Demon Slayer"},
    )
    html = page.get_data(as_text=True)

    assert page.status_code == 200
    assert "Kimetsu no Yaiba" in html
    assert "root.dataset.alt" in html


def test_une_variante_hors_norme_est_refusee(client):
    """Nos propres liens ne dépassent jamais 260 caractères : au-delà, la
    requête n'est pas la nôtre et elle est écartée plutôt que tronquée."""
    page = client.get(
        "/lecteur-scan",
        query_string={"titre": "x", "alt": "a" * 900},
    )

    assert page.status_code == 400
    assert "a" * 300 not in page.get_data(as_text=True)


def test_le_lecteur_ne_regarde_que_nos_variantes(client):
    """Le séparateur « | » ne peut pas faire passer autre chose qu'un titre."""
    page = client.get(
        "/lecteur-scan",
        query_string={"titre": "x", "alt": '"><script>alert(1)</script>'},
    )
    html = page.get_data(as_text=True)

    assert "<script>alert(1)</script>" not in html


def test_les_relations_anilist_sont_triees_et_filtrees():
    node = {
        "relations": {
            "edges": [
                {
                    "relationType": "SEQUEL",
                    "node": {
                        "id": 2,
                        "type": "ANIME",
                        "format": "TV",
                        "title": {"userPreferred": "Suite"},
                    },
                },
                {
                    # Hors de nos catalogues : écarté.
                    "relationType": "SEQUEL",
                    "node": {
                        "id": 3,
                        "type": "STAFF",
                        "title": {"userPreferred": "Inconnu"},
                    },
                },
                {
                    "relationType": "CHARACTER",
                    "node": {
                        "id": 4,
                        "type": "ANIME",
                        "title": {"userPreferred": "Figurant"},
                    },
                },
            ]
        }
    }

    liens = app_module._anilist_relations(node)

    assert [lien["title"] for lien in liens] == ["Suite"]
    assert liens[0]["href"] == "/details/anime/2?tab=animes"


def test_les_variantes_ne_repetent_pas_le_titre_affiche():
    node = {
        "title": {"romaji": "Solo Leveling", "english": "Solo Leveling"},
        "synonyms": ["Solo Leveling", "나 혼자만 레벨업"],
    }

    assert app_module._scan_alt(node, "Solo Leveling") == "나 혼자만 레벨업"


def test_trois_variantes_au_maximum():
    node = {
        "title": {"romaji": "A", "english": "B"},
        "synonyms": ["C", "D", "E", "F"],
    }

    assert len(app_module._scan_alt(node, "Z").split("|")) == 3


# ---------------------------------------------------------------------------
# 7. « Au hasard » et préchargement des sous-genres
# ---------------------------------------------------------------------------


def catalogue_hasard(monkeypatch, pages_vides=0):
    """Bouchonne AniList ; les N premières pages tirées reviennent vides."""
    appels = []

    def faux_post(url, json=None, **kwargs):
        variables = (json or {}).get("variables") or {}
        appels.append(variables.get("page"))
        vide = len(appels) <= pages_vides
        return Reponse(
            {
                "data": {
                    "Page": {
                        "pageInfo": {"hasNextPage": True, "total": 9000},
                        "media": []
                        if vide
                        else [
                            {
                                "id": 1,
                                "type": "ANIME",
                                "format": "TV",
                                "isAdult": False,
                                "countryOfOrigin": "JP",
                                "averageScore": 80,
                                "title": {
                                    "romaji": "Serie",
                                    "userPreferred": "Serie",
                                },
                                "coverImage": {
                                    "large": "https://s4.anilist.co/file/anilistcdn/a.jpg"
                                },
                            }
                        ],
                    }
                }
            }
        )

    monkeypatch.setattr(app_module.requests, "post", faux_post)
    return appels


def test_la_pioche_au_hasard_renvoie_des_cartes(client, monkeypatch):
    catalogue_hasard(monkeypatch)

    reponse = client.get("/api/anime-hasard", query_string={"media": "manga"})
    corps = reponse.get_json()

    assert reponse.status_code == 200
    assert corps["random"] is True
    assert corps["items"], "une pioche vide ne servirait à rien"
    # La pioche retombe sur la première page d'une bande : c'est là que les
    # titres se trouvent, pas au milieu d'une bande déjà entamée.
    assert (corps["page"] - 1) % app_module.ROTATION_BAND_PAGES == 0


def test_la_pioche_refuse_un_media_inconnu(client, monkeypatch):
    catalogue_hasard(monkeypatch)

    assert (
        client.get("/api/anime-hasard", query_string={"media": "film"}).status_code
        == 400
    )


def test_la_pioche_retente_si_la_page_tombait_sur_du_vide(client, monkeypatch):
    appels = catalogue_hasard(monkeypatch, pages_vides=2)

    corps = client.get(
        "/api/anime-hasard", query_string={"media": "anime", "seed": "graine"}
    ).get_json()

    # Deux pages source par bande : la première bande est vide, la deuxième
    # aboutit, soit deux bandes = 2 × ANILIST_POOL_PAGES appels.
    assert len(appels) == 2 * app_module.ANILIST_POOL_PAGES
    assert corps["items"], "la deuxième bande, pleine, doit aboutir"


def test_la_profondeur_de_la_pioche_est_bornee():
    bandes = app_module.ANILIST_RANDOM_MAX_BAND
    assert bandes >= 1
    # Une bande alimente ROTATION_BAND_PAGES pages du site : la pioche ne doit
    # jamais dépasser le plafond du catalogue.
    assert bandes * app_module.ROTATION_BAND_PAGES <= app_module.ANILIST_MAX_PAGES


def test_le_bouton_au_hasard_n_existe_que_dans_l_onglet_animes():
    gabarit = (GABARITS / "index.html").read_text(encoding="utf-8")
    js = (STATIQUES / "js" / "home.js").read_text(encoding="utf-8")

    assert 'id="anime-hasard"' in gabarit
    assert "/api/anime-hasard" in js
    assert "animeExtra.hidden = !isAnimeTab" in js


def test_un_sous_genre_survole_part_en_avance():
    js = (STATIQUES / "js" / "home.js").read_text(encoding="utf-8")

    assert "pointerover" in js
    assert "function precharger(" in js
    # Sur tactile, un appui maintenu remplace le survol sans voler le clic.
    assert "setTimeout(() => precharger(pill.dataset.id), 260)" in js


def test_la_pioche_coupe_le_defilement_avant_d_attendre():
    """Sinon l'observateur empile une page de catalogue sous la sélection."""
    js = (STATIQUES / "js" / "home.js").read_text(encoding="utf-8")
    bloc = js.split('hasardBtn.addEventListener("click"', 1)[1]

    assert bloc.index("hasMore = false;") < bloc.index("requestJson")


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))

