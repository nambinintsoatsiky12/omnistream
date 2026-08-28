"""Animes et mangas : recherche mondiale, bande AniList, lecteur de scan.

Ce banc couvre les quatre points demandés :

1. la recherche « animes » ne force plus le pays JP ;
2. une recherche du type « Solo Leveling » remonte une vraie source anime/manga ;
3. le lecteur de scan n'envoie plus ``contentRating=safe`` par défaut et gère le
   « aucun résultat » sans se taire ;
4. le proxy d'images refuse toujours les hôtes qu'on ne connaît pas.

AniList, TMDB et MangaDex sont bouchonnés : ce bac à sable n'a pas d'accès
sortant, les appels réels restent donc à vérifier à la main.
"""

from pathlib import Path

import pytest
import requests

import app as app_module

GABARITS = Path(__file__).resolve().parent.parent / "templates"


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


def media_anilist(identifiant, titre, kind="ANIME", **complements):
    noeud = {
        "id": identifiant,
        "type": kind,
        "format": "TV" if kind == "ANIME" else "MANGA",
        "isAdult": False,
        "seasonYear": 2024 if kind == "ANIME" else None,
        "startDate": {"year": 2018},
        "countryOfOrigin": "KR",
        "siteUrl": f"https://anilist.co/{kind.lower()}/{identifiant}",
        "title": {
            "romaji": "Ore dake Level Up na Ken",
            "english": titre,
            "native": "나 혼자만 레벨업",
            "userPreferred": titre,
        },
        "coverImage": {
            "medium": f"https://s4.anilist.co/file/anilistcdn/{identifiant}.jpg",
            "large": "",
        },
    }
    noeud.update(complements)
    return noeud


def bande_anilist(anime=None, manga=None):
    return {
        "data": {
            "anime": {"media": list(anime or [])},
            "manga": {"media": list(manga or [])},
        }
    }


def bouchonner_anilist(monkeypatch, donnees=None, status_code=200, exception=None):
    """Remplace requests.post et renvoie le journal des appels."""
    journal = []

    def faux_post(url, json=None, **kwargs):
        journal.append({"url": url, "json": json})
        if exception:
            raise exception
        return Reponse(donnees if donnees is not None else bande_anilist(), status_code)

    monkeypatch.setattr(app_module.requests, "post", faux_post)
    return journal


def bouchonner_tmdb(monkeypatch, resultats=None):
    def faux_get(chemin, params=None):
        return {"results": list(resultats or [])}

    monkeypatch.setattr(app_module, "tmdb_get", faux_get)


# ---------------------------------------------------------------------------
# 1. La recherche « animes » ne force plus le Japon
# ---------------------------------------------------------------------------


def test_decouverte_animes_ne_force_plus_le_pays():
    media_type, params = app_module.base_discover_params("animes")

    assert media_type == "tv"
    assert "with_origin_country" not in params
    assert params.get("with_genres") == "16", "le genre animation doit rester"


def test_recherche_animes_garde_un_anime_coreen(monkeypatch):
    """Solo Leveling est coréen : le filtre JP le faisait disparaître."""
    bouchonner_tmdb(
        monkeypatch,
        [
            {
                "id": 1,
                "name": "Solo Leveling",
                "genre_ids": [16, 10759],
                "origin_country": ["KR"],
                "poster_path": "/solo.jpg",
                "vote_average": 8.6,
            },
            {
                "id": 2,
                "name": "Naruto",
                "genre_ids": [16],
                "origin_country": ["JP"],
                "poster_path": "/naruto.jpg",
                "vote_average": 8.4,
            },
            {
                "id": 3,
                "name": "Un polar sans animation",
                "genre_ids": [80],
                "origin_country": ["FR"],
                "poster_path": "/polar.jpg",
                "vote_average": 7.0,
            },
        ],
    )

    titres = [carte["title"] for carte in app_module.search_by_tab("animes", "solo")]

    assert "Solo Leveling" in titres, titres
    assert "Naruto" in titres, titres
    assert "Un polar sans animation" not in titres, "le genre animation reste exigé"


def test_les_autres_onglets_gardent_leurs_propres_filtres():
    """Le retrait du verrou JP ne concerne que l'onglet animes."""
    _films, params_films = app_module.base_discover_params("films")
    _series, params_series = app_module.base_discover_params("series")
    _occ, params_occ = app_module.base_discover_params("animation_occidentale")

    assert "with_origin_country" not in params_films
    assert "with_origin_country" not in params_series
    assert params_occ["with_origin_country"] == app_module.WESTERN_ORIGINS


# ---------------------------------------------------------------------------
# 2. « Solo Leveling » remonte une source anime/manga
# ---------------------------------------------------------------------------


def test_recherche_solo_leveling_remonte_anime_et_manga(client, monkeypatch):
    bouchonner_tmdb(monkeypatch, [])
    journal = bouchonner_anilist(
        monkeypatch,
        bande_anilist(
            anime=[media_anilist(134436, "Solo Leveling")],
            manga=[media_anilist(107063, "Solo Leveling", kind="MANGA")],
        ),
    )

    page = client.get("/", query_string={"tab": "animes", "q": "Solo Leveling"})
    html = page.get_data(as_text=True)

    assert page.status_code == 200
    assert journal[0]["url"] == app_module.ANILIST_URL
    assert journal[0]["json"]["variables"]["search"] == "Solo Leveling"
    assert 'class="anilist-band"' in html
    assert html.count("Solo Leveling") >= 2
    assert "2024" in html and "2018" in html, "l'année vient d'AniList"
    assert "https://anilist.co/manga/107063" in html
    # Le manga ouvre le lecteur de scan, l'anime non.
    assert "/lecteur-scan?titre=Solo%20Leveling" in html
    assert html.count("Lire le scan") == 1
    assert html.count("Voir la fiche") == 1


def test_les_couvertures_passent_par_le_proxy(client, monkeypatch):
    bouchonner_tmdb(monkeypatch, [])
    bouchonner_anilist(
        monkeypatch, bande_anilist(anime=[media_anilist(134436, "Solo")])
    )

    html = client.get("/", query_string={"q": "Solo"}).get_data(as_text=True)

    assert "/api/manga_image?url=https%3A%2F%2Fs4.anilist.co" in html


def test_une_couverture_d_un_hote_inconnu_n_est_pas_chargee(client, monkeypatch):
    """Pas d'image cassée : on n'écrit aucune balise <img> pour cet hôte."""
    bouchonner_tmdb(monkeypatch, [])
    bouchonner_anilist(
        monkeypatch,
        bande_anilist(
            anime=[
                media_anilist(
                    134436,
                    "Solo Leveling",
                    coverImage={
                        "medium": "https://cdn-inconnu.example/c.jpg",
                        "large": "",
                    },
                )
            ]
        ),
    )

    html = client.get("/", query_string={"q": "Solo Leveling"}).get_data(as_text=True)

    assert "cdn-inconnu.example" not in html
    assert "Pas de couverture" in html


def test_le_contenu_adulte_est_exclu_de_la_bande():
    items = [
        app_module._anilist_item(media_anilist(1, "Un anime", isAdult=True), "anime"),
        app_module._anilist_item(
            media_anilist(2, "Un manga", kind="MANGA", isAdult=True), "manga"
        ),
        app_module._anilist_item(media_anilist(3, "Un anime propre"), "anime"),
    ]

    assert items[0] is None
    assert items[1] is None
    assert items[2]["title"] == "Un anime propre"


def test_un_anime_n_a_pas_de_bouton_de_lecture():
    anime = app_module._anilist_item(media_anilist(1, "Un anime"), "anime")
    manga = app_module._anilist_item(
        media_anilist(2, "Un manga", kind="MANGA"), "manga"
    )

    assert anime["reader"] == ""
    assert manga["reader"] == "/lecteur-scan?titre=Un%20manga"


def test_anilist_en_panne_est_annonce_pas_silencieux(client, monkeypatch):
    bouchonner_tmdb(monkeypatch, [])
    bouchonner_anilist(monkeypatch, exception=requests.ConnectionError("panne réseau"))

    page = client.get("/", query_string={"q": "Solo Leveling"})
    html = page.get_data(as_text=True)

    assert page.status_code == 200
    assert "AniList est temporairement indisponible." in html
    assert 'class="anilist-note anilist-note-warn"' in html


def test_anilist_sans_resultat_le_dit(client, monkeypatch):
    bouchonner_tmdb(monkeypatch, [])
    bouchonner_anilist(monkeypatch, bande_anilist())

    html = client.get("/", query_string={"q": "zzzzz"}).get_data(as_text=True)

    assert "Aucun anime ni manga ne porte ce nom" in html
    # TMDB n'a rien trouvé non plus : le message global reste pertinent.
    assert "Aucun résultat trouvé" in html


def test_une_bande_remplie_remplace_le_message_aucun_resultat(client, monkeypatch):
    bouchonner_tmdb(monkeypatch, [])
    bouchonner_anilist(
        monkeypatch, bande_anilist(manga=[media_anilist(9, "Naruto", kind="MANGA")])
    )

    html = client.get("/", query_string={"q": "Naruto"}).get_data(as_text=True)

    assert "Aucun résultat trouvé" not in html
    assert "Naruto" in html


def test_tmdb_en_panne_ne_cache_pas_la_bande_anilist(client, monkeypatch):
    """Un 503 cacherait le seul résultat disponible : la page reste debout."""

    def tmdb_hors_service(chemin, params=None):
        raise app_module.UpstreamServiceError("TMDB ne répond pas")

    monkeypatch.setattr(app_module, "tmdb_get", tmdb_hors_service)
    bouchonner_anilist(
        monkeypatch,
        bande_anilist(manga=[media_anilist(7, "Solo Leveling", kind="MANGA")]),
    )

    page = client.get("/", query_string={"tab": "animes", "q": "Solo Leveling"})
    html = page.get_data(as_text=True)

    assert page.status_code == 200
    assert "Le catalogue de films et séries ne répond pas" in html
    assert "Solo Leveling" in html
    assert "Aucun résultat trouvé" not in html


def test_anilist_limite_en_requetes_est_annonce(monkeypatch):
    bouchonner_anilist(monkeypatch, bande_anilist(), status_code=429)

    assert app_module.anilist_band("trop de requetes")["error"] == (
        "AniList limite le nombre de recherches : réessayez."
    )


def test_anilist_decale_est_annonce(monkeypatch):
    bouchonner_anilist(monkeypatch, exception=requests.Timeout("trop lent"))

    assert app_module.anilist_band("timeout anilist")["error"] == (
        "AniList met trop de temps à répondre. Réessayez."
    )


def test_anilist_n_est_pas_appele_sans_recherche(client, monkeypatch):
    journal = bouchonner_anilist(monkeypatch, bande_anilist())
    bouchonner_tmdb(monkeypatch, [])
    monkeypatch.setattr(app_module.auth_db, "get_total_visits", lambda: 0)

    page = client.get("/")

    assert page.status_code == 200
    assert journal == [], "AniList ne doit rien coûter sur l'accueil"


def test_anilist_repond_sans_lever_d_exception(monkeypatch):
    bouchonner_anilist(monkeypatch, {"data": None}, status_code=500)

    bande = app_module.anilist_band("reponse invalide")

    assert bande["items"] == []
    assert bande["error"] == "AniList a refusé la recherche."


def test_une_recherche_est_mise_en_cache(monkeypatch):
    journal = bouchonner_anilist(
        monkeypatch, bande_anilist(anime=[media_anilist(5, "Bleach")])
    )
    app_module._cache.clear()

    app_module.anilist_band("Bleach")
    app_module.anilist_band("BLEACH")

    assert len(journal) == 1, "la même recherche ne doit pas repartir vers AniList"


# ---------------------------------------------------------------------------
# 3. Le lecteur de scan : plus de filtre par défaut, repli annoncé
# ---------------------------------------------------------------------------


def script_lecteur():
    gabarit = (GABARITS / "lecteur.html").read_text(encoding="utf-8")
    return gabarit.split("<script>", 1)[1].split("</script>", 1)[0]


def test_le_lecteur_n_envoie_plus_de_filtre_de_contenu_par_defaut():
    js = script_lecteur()

    assert '"contentRating[]": "safe"' not in js, "le filtre codé en dur est revenu"
    lignes = [ligne.strip() for ligne in js.splitlines() if "contentRating[]" in ligne]
    assert lignes, "le filtre doit rester disponible à la demande"
    for ligne in lignes:
        assert "filtre" in ligne, f"le filtre doit être conditionnel : {ligne}"
    assert js.count('"safe"') == 1, "« safe » ne sert qu'au retour de filtreContenu()"


def test_le_filtre_de_contenu_redevient_un_choix_du_lecteur():
    gabarit = (GABARITS / "lecteur.html").read_text(encoding="utf-8")
    js = script_lecteur()

    assert 'type="checkbox" id="scan-rating"' in gabarit
    assert 'if (filtre) params["contentRating[]"] = filtre;' in js


def test_le_lecteur_relance_sans_filtre_quand_rien_ne_sort():
    js = script_lecteur()

    assert "results = await rechercherSeries(base);" in js
    assert "Aucune série avec le filtre « contenu sûr »" in js
    assert "Aucun chapitre avec tous les filtres" in js


def test_le_lecteur_choisit_par_ressemblance_de_titre():
    js = script_lecteur()

    assert "function choisirSerie(" in js
    assert "function normaliser(" in js
    assert "function ressemblance(" in js
    # Comparaison en minuscules, sans accents ni ponctuation.
    assert ".toLowerCase()" in js
    assert "[\\u0300-\\u036f]" in js
    assert "[^\\p{L}\\p{N}]+" in js
    assert "results[0]" not in js, "le premier résultat ne doit plus être pris tel quel"


def test_le_lecteur_accepte_toutes_les_langues():
    gabarit = (GABARITS / "lecteur.html").read_text(encoding="utf-8")
    js = script_lecteur()

    assert '<option value="">🌐 Toutes les langues</option>' in gabarit
    for code in ("ko", "ja", "es", "pt-br", "zh-hans", "ar", "hi"):
        assert f'value="{code}"' in gabarit, f"langue {code} absente du sélecteur"
    # Le titre affiché n'est plus limité au français et à l'anglais.
    assert "title.fr || title.en" not in js
    assert "function titreAffiche(" in js
    assert 'if (lang) params["translatedLanguage[]"] = lang;' in js


def test_le_lecteur_trie_par_annee_pour_ecarter_les_travaux_de_fans():
    js = script_lecteur()

    assert '"order[year]": "asc"' in js
    assert "const aa = a.annee || Infinity;" in js


def test_le_lecteur_garde_la_serie_retenue_affichee():
    gabarit = (GABARITS / "lecteur.html").read_text(encoding="utf-8")

    assert 'id="scan-series"' in gabarit
    assert "Série retenue :" in script_lecteur()


def test_le_titre_du_lecteur_reste_echappe(client):
    page = client.get(
        "/lecteur-scan", query_string={"titre": "</script><script>alert(1)</script>"}
    )

    assert page.status_code == 200
    assert b"\\u003c/script\\u003e" in page.data
    assert b"<script>alert(1)</script>" not in page.data


def test_le_proxy_transmet_le_tri_et_refuse_l_inconnu(client, monkeypatch):
    journal = {}

    def faux_get(url, **kwargs):
        journal.update(kwargs)
        return Reponse({"data": []})

    monkeypatch.setattr(app_module.requests, "get", faux_get)

    autorise = client.get(
        "/api/mangadex_proxy",
        query_string={
            "endpoint": "/manga",
            "title": "Solo Leveling",
            "order[year]": "asc",
        },
    )
    assert autorise.status_code == 200
    assert ("order[year]", "asc") in journal["params"]

    refuse = client.get(
        "/api/mangadex_proxy",
        query_string={
            "endpoint": "/manga",
            "title": "Solo Leveling",
            "order[hack]": "asc",
        },
    )
    assert refuse.status_code == 400


def test_le_proxy_accepte_toute_langue_valide(client, monkeypatch):
    def faux_get(url, **kwargs):
        return Reponse({"data": []})

    monkeypatch.setattr(app_module.requests, "get", faux_get)
    endpoint = "/manga/123e4567-e89b-12d3-a456-426614174000/feed"

    for langue in ("fr", "en", "ko", "pt-br", "zh-hans", "ja-ro"):
        reponse = client.get(
            "/api/mangadex_proxy",
            query_string={"endpoint": endpoint, "translatedLanguage[]": langue},
        )
        assert reponse.status_code == 200, langue

    for langue in ("../../etc", "fr;DROP", "FR"):
        reponse = client.get(
            "/api/mangadex_proxy",
            query_string={"endpoint": endpoint, "translatedLanguage[]": langue},
        )
        assert reponse.status_code == 400, langue


def test_le_proxy_renvoie_proprement_une_liste_vide(client, monkeypatch):
    def faux_get(url, **kwargs):
        return Reponse({"data": []})

    monkeypatch.setattr(app_module.requests, "get", faux_get)

    reponse = client.get(
        "/api/mangadex_proxy", query_string={"endpoint": "/manga", "title": "zzz"}
    )

    assert reponse.status_code == 200
    assert reponse.get_json() == {"data": []}


def test_le_proxy_ne_transmet_pas_de_filtre_non_demande(client, monkeypatch):
    journal = {}

    def faux_get(url, **kwargs):
        journal.update(kwargs)
        return Reponse({"data": []})

    monkeypatch.setattr(app_module.requests, "get", faux_get)

    client.get(
        "/api/mangadex_proxy", query_string={"endpoint": "/manga", "title": "Solo"}
    )

    assert all(cle != "contentRating[]" for cle, _valeur in journal["params"])


# ---------------------------------------------------------------------------
# 4. Le proxy d'images refuse toujours les hôtes inconnus
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example/cover.jpg",
        "https://s4.anilist.co.evil.example/cover.jpg",
        "https://uploads.mangadex.org.evil.example/cover.jpg",
        "http://uploads.mangadex.org/cover.jpg",
        "https://s4.anilist.co:8443/cover.jpg",
        "https://user:pass@uploads.mangadex.org/cover.jpg",
        "https://127.0.0.1/cover.jpg",
        "",
        None,
    ],
)
def test_le_proxy_d_image_refuse_les_hotes_inconnus(client, url):
    reponse = client.get("/api/manga_image", query_string={"url": url})

    assert reponse.status_code == 400, url


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example/cover.jpg",
        "https://s4.anilist.co.evil.example/cover.jpg",
        "http://s4.anilist.co/cover.jpg",
        "https://s4.anilist.co:8443/cover.jpg",
        "https://user:pass@s4.anilist.co/cover.jpg",
        "",
        None,
    ],
)
def test_aucune_balise_img_pour_un_hote_non_autorise(url):
    assert app_module._image_proxy_url(url) == ""


@pytest.mark.parametrize(
    "hote",
    [
        "s4.anilist.co",
        "s5.anilist.co",
        "s6.anilist.co",
        "s7.anilist.co",
        "uploads.mangadex.org",
    ],
)
def test_les_hotes_autorises_sont_explicites(hote):
    assert hote in app_module.IMAGE_PROXY_HOSTS

    proxy = app_module._image_proxy_url(f"https://{hote}/fichier.jpg")

    assert proxy.startswith("/api/manga_image?url=")
    assert hote in proxy


def test_le_proxy_d_image_accepte_les_hotes_de_la_liste(client, monkeypatch):
    """Le contrôle d'hôte laisse passer ce qui est autorisé : l'appel échoue
    plus loin, faute de réseau sortant ici, mais ce n'est plus un refus."""

    def faux_get(url, **kwargs):
        raise requests.ConnectionError("pas de réseau sortant dans le bac à sable")

    monkeypatch.setattr(app_module.requests, "get", faux_get)

    reponse = client.get(
        "/api/manga_image",
        query_string={"url": "https://s4.anilist.co/file/anilistcdn/x.jpg"},
    )

    assert reponse.status_code != 400
