"""Round 6 — durée, recherche groupée par type, rangée « même univers ».

Ce que ces tests verrouillent :
- le filtre « durée » applique des plages strictes et sans chevauchement à
  TMDB (films) et AniList (animes), et jamais aux séries ni aux mangas ;
- la recherche globale groupe les résultats par type sans les mélanger, et
  chaque carte reste dans le site ;
- les fiches TMDB ont des relations, mais la rangée « Dans le même univers »
  de l'accueil a été retirée (les cartes « À voir aussi » ne s'affichent plus) ;
- la barre de filtre de pastilles cite les genres du bon onglet (plus de
  « Shōnen, Isekai… » sur l'onglet Films) ;
- « Partager » et « Reprendre au chapitre N » existaient déjà : on les
  protège contre une régression silencieuse.
"""

from pathlib import Path

import app as app_module

RACINE = Path(__file__).resolve().parent.parent


def stub_tmdb(monkeypatch, multi=None, recommandations=None):
    """Un TMDB de poche : journalise les appels, répond selon le chemin."""

    def faux(chemin, params=None):
        faux.journal.append((chemin, dict(params or {})))
        if chemin == "/search/multi":
            return {"results": list(multi or [])}
        if chemin.endswith("/recommendations"):
            return {"results": list(recommandations or [])}
        if chemin.startswith("/discover/"):
            return {"results": [], "total_pages": 1}
        return {}

    faux.journal = []
    monkeypatch.setattr(app_module, "tmdb_get", faux)
    return faux


def carte_tmdb(identifiant, type_media, langue="en", genres=None, pays=None):
    return {
        "id": identifiant,
        "media_type": type_media,
        "title": f"T{identifiant}" if type_media == "movie" else f"S{identifiant}",
        "name": f"S{identifiant}",
        "poster_path": "/p.jpg",
        "backdrop_path": "/b.jpg",
        "vote_average": 8.0,
        "vote_count": 500,
        "release_date": "2023-05-01",
        "first_air_date": "2023-05-01",
        "genre_ids": genres or [],
        "origin_country": pays or [],
        "original_language": langue,
    }


# ---------------------------------------------------------------------------
# 1. Le filtre « durée » : des plages strictes, là où la durée a un sens
# ---------------------------------------------------------------------------


def test_duree_court_borne_tmdb_sur_les_films(client, monkeypatch):
    faux = stub_tmdb(monkeypatch)

    client.get("/api/list?tab=films&page=1&seed=v&duree=court")

    appels = [p for c, p in faux.journal if c == "/discover/movie"]
    assert appels, "le catalogue films passe par discover"
    for params in appels:
        assert params.get("with_runtime.lte") == "90"
        assert "with_runtime.gte" not in params


def test_duree_moyen_et_long_sont_des_plages_fermees(client, monkeypatch):
    faux = stub_tmdb(monkeypatch)
    client.get("/api/list?tab=films&page=1&seed=v&duree=moyen")
    client.get("/api/list?tab=films&page=1&seed=w&duree=long")

    appels = [p for c, p in faux.journal if c == "/discover/movie"]
    # Une requête lit une bande entière : cinq appels discover. On compare
    # donc la première bande (moyen) à la seconde (long), pas appel à appel.
    bande_moyen, bande_long = appels[:5], appels[5:10]
    assert bande_moyen and bande_long
    assert all(p.get("with_runtime.gte") == "91" for p in bande_moyen)
    assert all(p.get("with_runtime.lte") == "120" for p in bande_moyen)
    assert all(p.get("with_runtime.gte") == "121" for p in bande_long)
    assert all("with_runtime.lte" not in p for p in bande_long)


def test_duree_inconnue_ou_series_ne_bornent_pas(client, monkeypatch):
    faux = stub_tmdb(monkeypatch)
    client.get("/api/list?tab=films&page=1&seed=v&duree=bogus")
    client.get("/api/list?tab=series&page=1&seed=v&duree=court")

    chemins = {"/discover/movie", "/discover/tv"}
    appels = [p for c, p in faux.journal if c in chemins]
    assert appels
    for params in appels:
        assert "with_runtime.lte" not in params
        assert "with_runtime.gte" not in params


def test_duree_anime_filtre_anilist_mais_pas_le_manga(client, monkeypatch):
    journal = []

    def faux_post(query, variables, timeout=None):
        journal.append(dict(variables))
        return {"Page": {"media": [], "pageInfo": {"total": 0}}}

    monkeypatch.setattr(app_module, "_anilist_post", faux_post)

    client.get("/api/list?tab=animes&media=anime&page=1&seed=v&duree=court")
    client.get("/api/list?tab=animes&media=manga&page=1&seed=v&duree=court")

    variables_anime = [v for v in journal if v.get("type") == "ANIME"]
    variables_manga = [v for v in journal if v.get("type") == "MANGA"]
    assert variables_anime and variables_manga
    assert all(v.get("durationMax") == 90 for v in variables_anime)
    assert all(v.get("durationMin") is None for v in variables_anime)
    # Un manga n'a pas de minutes : le filtre ne doit rien toucher.
    assert all(v.get("durationMax") is None for v in variables_manga)
    assert all(v.get("durationMin") is None for v in variables_manga)


def test_le_cran_duree_est_dans_la_page_et_le_js():
    gabarit = (RACINE / "templates" / "index.html").read_text(encoding="utf-8")
    js = (RACINE / "static" / "js" / "home.js").read_text(encoding="utf-8")

    assert 'id="duree"' in gabarit
    for bouton in ("court", "moyen", "long"):
        assert f'data-duree="{bouton}"' in gabarit
    # Le contrôle se cache tout seul là où la durée n'a pas de sens.
    assert "dureeActive()" in js
    assert "majVisibiliteDuree" in js


# ---------------------------------------------------------------------------
# 2. Recherche globale : une barre, des rayons séparés
# ---------------------------------------------------------------------------


def test_la_recherche_separe_films_et_series(client, monkeypatch):
    multi = [
        carte_tmdb(1, "movie"),
        carte_tmdb(2, "tv"),
        carte_tmdb(3, "movie", langue="ja", genres=[16]),  # anime : pas un film
        carte_tmdb(4, "tv", langue="ja", genres=[16], pays=["JP"]),  # ni série
        {"id": 9, "media_type": "person"},  # jamais une personne
    ]
    stub_tmdb(monkeypatch, multi=multi)
    monkeypatch.setattr(
        app_module,
        "_anilist_post",
        lambda q, v, timeout=None: {"Page": {"media": [], "pageInfo": {}}},
    )

    html = client.get("/?q=test&tab=films").get_data(as_text=True)

    assert "Résultats pour" in html
    for titre in ("Films", "Séries", "Animes", "Mangas"):
        assert f">{titre}<" in html, f"le rayon {titre} manque"
    section_films = html.split(">Films<", 1)[1].split(">Séries<", 1)[0]
    section_series = html.split(">Séries<", 1)[1].split('class="anilist-band"', 1)[0]
    assert "/details/movie/1?" in section_films
    assert "/details/movie/2" not in section_films, "la série a fui dans les films"
    assert "/details/tv/2?" in section_series
    assert "/details/tv/1" not in section_series, "le film a fui dans les séries"
    assert "/details/movie/3" not in html, "l'anime ne se déguise pas en film"
    assert "/details/tv/4" not in html, "l'anime ne se déguise pas en série"
    assert "person" not in html


def test_la_recherche_garde_les_cartes_dans_le_site(client, monkeypatch):
    stub_tmdb(monkeypatch, multi=[])

    def faux_post(url, json=None, **kwargs):
        class Reponse:
            status_code = 200

            @staticmethod
            def json():
                return {
                    "data": {
                        "anime": {
                            "media": [
                                {
                                    "id": 77,
                                    "isAdult": False,
                                    "siteUrl": "https://anilist.co/anime/77",
                                    "title": {"userPreferred": "Naruto"},
                                    "coverImage": {
                                        "medium": "https://s4.anilist.co/x.jpg"
                                    },
                                }
                            ]
                        },
                        "manga": {"media": []},
                    }
                }

        return Reponse()

    monkeypatch.setattr(app_module.requests, "post", faux_post)
    html = client.get("/?q=naruto&tab=films").get_data(as_text=True)

    assert "/details/anime/77?" in html
    assert 'href="https://anilist.co' not in html


def test_recherche_musique_sans_cle_reste_vide(client, monkeypatch):
    stub_tmdb(monkeypatch, multi=[])
    monkeypatch.setattr(
        app_module,
        "_anilist_post",
        lambda q, v, timeout=None: {"Page": {"media": [], "pageInfo": {}}},
    )
    monkeypatch.setattr(app_module, "YOUTUBE_API_KEY", "")

    html = client.get("/?q=test&tab=films").get_data(as_text=True)

    assert "search-music-play" not in html
    assert ">Musiques<" not in html


def test_recherche_musique_avec_cle_donne_des_boutons_lecture(client, monkeypatch):
    stub_tmdb(monkeypatch, multi=[])
    monkeypatch.setattr(
        app_module,
        "_anilist_post",
        lambda q, v, timeout=None: {"Page": {"media": [], "pageInfo": {}}},
    )
    monkeypatch.setattr(app_module, "YOUTUBE_API_KEY", "cle-de-test")
    monkeypatch.setattr(
        app_module,
        "_youtube_get",
        lambda endpoint, params: {
            "items": [
                {
                    "id": {"videoId": "abc12345678"},
                    "snippet": {
                        "title": "Titre musical",
                        "channelTitle": "Artiste",
                        "thumbnails": {
                            "medium": {"url": "https://i.ytimg.com/x.jpg"}
                        },
                    },
                }
            ]
        },
    )

    html = client.get("/?q=test&tab=films").get_data(as_text=True)

    assert "search-music-play" in html
    assert 'data-play-id="abc12345678"' in html


# ---------------------------------------------------------------------------
# 3. « Dans le même univers » : la fiche TMDB garde ses liens ; la rangée
#    d'accueil a été retirée à la demande du visiteur (les cartes
#    « À voir aussi » ne devaient plus s'afficher sur l'accueil).
# ---------------------------------------------------------------------------


def test_la_fiche_tmdb_a_desormais_des_relations(client, monkeypatch):
    stub_tmdb(
        monkeypatch,
        recommandations=[
            {"id": 11, "title": "Suite attendue", "poster_path": "/s.jpg"},
            {"id": 12, "name": "Sans poster"},  # écarté : pas d'affiche
        ],
    )

    html = client.get("/details/movie/5").get_data(as_text=True)

    assert "Dans le même univers" in html
    assert "À voir aussi" in html
    assert "/details/movie/11?" in html
    assert "/details/movie/12" not in html, "sans affiche, pas de carte"


def test_l_accueil_n_a_plus_sa_rangee_univers():
    """La rangée « Dans le même univers » (cartes « À voir aussi ») a été
    retirée de l'accueil : plus de balise, plus de script, plus d'API, plus
    de mémoire du dernier titre consulté."""
    gabarit = (RACINE / "templates" / "index.html").read_text(encoding="utf-8")
    js = (RACINE / "static" / "js" / "home.js").read_text(encoding="utf-8")
    detail_js = (RACINE / "static" / "js" / "detail.js").read_text(encoding="utf-8")
    style = (RACINE / "static" / "css" / "style.css").read_text(encoding="utf-8")

    assert 'id="univers-row"' not in gabarit
    assert 'id="univers-list"' not in gabarit
    assert "chargerUnivers" not in js
    assert "/api/univers" not in js
    assert "omni-dernier-titre" not in detail_js
    assert ".univers-row" not in style


def test_l_api_univers_n_existe_plus(client):
    assert client.get("/api/univers?media_type=movie&id=5").status_code == 404


def test_la_barre_de_filtre_cite_les_genres_du_bon_onglet(client):
    """L'exemple du champ de filtre doit ressembler aux pastilles de
    l'onglet : l'onglet Films n'affichait plus « Shōnen, Isekai… », qui ne
    vivent que dans l'onglet Animés & Mangas — et l'inverse."""
    films = client.get("/", query_string={"tab": "films"}).get_data(as_text=True)
    animes = client.get("/", query_string={"tab": "animes"}).get_data(as_text=True)

    assert "Filtrer : Action, Comédie, Drame, Horreur…" in films
    assert "Shōnen, Isekai" not in films
    assert "Filtrer : Shōnen, Isekai, Réincarnation, Cuisine…" in animes
    assert "Action, Comédie, Drame, Horreur" not in animes
    # Chaque exemple cité existe VRAIMENT parmi les pastilles de l'onglet :
    # un « Gourmet » fantôme aurait continué de promettre un bouton absent.
    labels = {pill["label"] for pill in app_module.ANILIST_THEMES_ANIME}
    for exemple in ("Shōnen", "Isekai", "Réincarnation", "Cuisine"):
        assert exemple in labels, f"le placeholder cite « {exemple} » sans pastille"


# ---------------------------------------------------------------------------
# 4. Ce qui existait déjà ne doit pas régresser
# ---------------------------------------------------------------------------


def test_le_bouton_partager_existe_toujours(client, monkeypatch):
    stub_tmdb(monkeypatch)

    html = client.get("/details/movie/5").get_data(as_text=True)

    assert 'id="share-btn"' in html
    detail_js = (RACINE / "static" / "js" / "detail.js").read_text(encoding="utf-8")
    assert "navigator.share" in detail_js
    assert "Lien copié" in detail_js


def test_la_reprise_au_chapitre_existe_toujours():
    lecteur = (RACINE / "templates" / "lecteur.html").read_text(encoding="utf-8")
    biblio = (RACINE / "static" / "js" / "library-page.js").read_text(encoding="utf-8")

    # Le lecteur rouvre là où on s'était arrêté…
    assert "Reprise au chapitre" in lecteur
    # …et la Bibliothèque propose « Reprendre au chapitre N ».
    assert "Reprendre au chapitre" in biblio
