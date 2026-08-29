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

import datetime
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


def test_la_recherche_de_l_onglet_animes_passe_par_anilist(monkeypatch):
    """L'onglet « Animés & Mangas » ne puise que dans AniList : TMDB ignore
    les mangas et rate une partie des animes, le mélange était la cause des
    résultats faux."""
    journal_tmdb = []

    def tmdb_interdit(chemin, params=None):
        journal_tmdb.append(chemin)
        return {"results": []}

    monkeypatch.setattr(app_module, "tmdb_get", tmdb_interdit)

    def page_anilist(noeuds):
        return {"data": {"Page": {"pageInfo": {"hasNextPage": False}, "media": noeuds}}}

    types_vus = []

    def faux_post(url, json=None, **kwargs):
        variables = (json or {}).get("variables") or {}
        types_vus.append(variables.get("type"))
        noeud = media_anilist(
            134436 if variables.get("type") == "ANIME" else 107063,
            "Solo Leveling",
            kind=variables.get("type") or "ANIME",
        )
        return Reponse(page_anilist([noeud]))

    monkeypatch.setattr(app_module.requests, "post", faux_post)

    resultats = app_module.search_by_tab("animes", "Solo Leveling")

    assert journal_tmdb == [], "TMDB ne doit plus être appelé pour cet onglet"
    assert types_vus == ["ANIME", "MANGA"], "les animes d'abord, puis les mangas"
    assert [item["media_type"] for item in resultats] == ["anime", "manga"]
    assert resultats[0]["title"] == "Solo Leveling"
    # Chaque carte ouvre notre fiche, jamais anilist.co.
    assert all(item["poster"].startswith("/api/manga_image?url=") for item in resultats)


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

    # Depuis un autre onglet : la bande AniList vient compléter TMDB.
    page = client.get("/", query_string={"tab": "films", "q": "Solo Leveling"})
    html = page.get_data(as_text=True)

    assert page.status_code == 200
    assert journal[0]["url"] == app_module.ANILIST_URL
    assert journal[0]["json"]["variables"]["search"] == "Solo Leveling"
    assert 'class="anilist-band"' in html
    assert html.count("Solo Leveling") >= 2
    assert "2024" in html and "2018" in html, "l'année vient d'AniList"
    # AniList est une SOURCE : la carte ouvre la fiche OmniStream, jamais
    # anilist.co. Le visiteur ne quitte pas le site.
    assert "/details/anime/134436?tab=films" in html
    assert "/details/manga/107063?tab=films" in html
    # Les couvertures passent par NOTRE proxy ; ce ne sont pas des liens.
    assert 'href="https://anilist.co' not in html, "aucun lien vers AniList"
    band = html.split('class="anilist-band"', 1)[1].split("</section>", 1)[0]
    assert "target=\"_blank\"" not in band, "la bande ne quitte pas le site"
    # Le manga garde son accès direct au lecteur de scan.
    assert "/lecteur-scan?titre=Solo%20Leveling" in html
    assert html.count("Lire le scan") == 1


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

    page = client.get("/", query_string={"tab": "films", "q": "Solo Leveling"})
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

    assert "await rechercherSeries(" in js
    # Le repli sans filtre reste annoncé à l'écran, jamais silencieux.
    assert 'notes.push("filtre « contenu sûr » retiré")' in js
    assert "Pour arriver à ce résultat :" in js
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

    # Le départage par ancienneté reste dans `choisirSerie` : entre deux
    # correspondances de même score, la plus ancienne est l'originale.
    assert "const aa = a.annee || Infinity;" in js


def test_la_recherche_laisse_mangadex_classer_par_pertinence():
    """`order[year]=asc` côté API faisait sortir la vraie série de la page.

    MangaDex applique le filtre `title` PUIS l'ordre demandé : avec
    `limit: 20`, demander les plus anciens renvoyait les vingt plus vieux
    homonymes et l'œuvre cherchée n'y était plus. Le classement par
    pertinence de MangaDex la garde en tête.
    """
    js = script_lecteur()

    assert '"order[year]"' not in js
    assert 'const base = { title, limit: "30" };' in js


def test_le_lecteur_essaie_plusieurs_orthographes_du_titre():
    """Rōmaji, anglais, synonymes, suffixe de saison retiré.

    La fiche affiche souvent le titre natif (« 鬼滅の刃 ») alors que MangaDex
    indexe « Kimetsu no Yaiba » : sans variante, la moitié des séries
    répondaient « aucun scan trouvé ».
    """
    gabarit = (GABARITS / "lecteur.html").read_text(encoding="utf-8")
    js = script_lecteur()

    assert "data-alt=" in gabarit
    assert "function candidats()" in js
    assert "root.dataset.alt" in js
    assert "(?:film|movie|saison|season)" in js


def test_le_lecteur_dit_pourquoi_ca_ne_marche_pas():
    """Le message générique unique ne permettait aucun diagnostic."""
    js = script_lecteur()

    assert "Erreur de communication avec MangaDex." not in js
    assert "corps.error" in js
    assert "err.message" in js


def test_le_lecteur_pagine_les_chapitres_au_dela_de_500():
    """MangaDex plafonne à 500 chapitres par réponse."""
    js = script_lecteur()

    assert "params.offset = String(page * 500);" in js
    assert "Number(data.total)" in js


def test_le_proxy_borne_la_limite_selon_l_endpoint(client):
    """/manga refuse au-delà de 100 ; le feed monte à 500."""
    assert app_module.MANGADEX_MAX_LIMIT == {"/manga": 100, "feed": 500}

    trop_gros = client.get(
        "/api/mangadex_proxy",
        query_string={"endpoint": "/manga", "title": "x", "limit": "500"},
    )
    assert trop_gros.status_code == 400

    valide = client.get(
        "/api/mangadex_proxy",
        query_string={
            "endpoint": "/manga/9712c4ff-a8b5-4b21-9e8f-4a54058a1a00/feed",
            "limit": "500",
        },
    )
    assert valide.status_code in {200, 502}


def test_la_fiche_anime_demande_le_titre_a_anilist():
    """Sans le champ `title`, TOUTES les fiches AniList tombaient en 404.

    `_anilist_detail_item` s'arrête quand `_anilist_title()` renvoie '' — et
    comme la requête GraphQL ne demandait pas `title`, c'était systématique.
    """
    requete = app_module.ANILIST_DETAIL_QUERY

    assert "title { romaji english native userPreferred }" in requete


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


# ---------------------------------------------------------------------------
# 5. AniList est une SOURCE : la fiche s'affiche dans NOTRE panneau
# ---------------------------------------------------------------------------


def fiche_anilist(identifiant=134436, kind="ANIME", **complements):
    """Une réponse AniList complète, telle que la demande anilist_detail."""
    noeud = {
        "id": identifiant,
        "type": kind,
        "format": "TV" if kind == "ANIME" else "MANGA",
        "status": "FINISHED",
        "isAdult": False,
        "seasonYear": 2024,
        "episodes": 12 if kind == "ANIME" else None,
        "chapters": None if kind == "ANIME" else 179,
        "volumes": None if kind == "ANIME" else 14,
        "duration": 24,
        "averageScore": 86,
        "countryOfOrigin": "KR",
        "siteUrl": f"https://anilist.co/{kind.lower()}/{identifiant}",
        "title": {
            "romaji": "Ore dake Level Up na Ken",
            "english": "Solo Leveling",
            "native": "나 혼자만 레벨업",
            "userPreferred": "Solo Leveling",
        },
        "genres": ["Action", "Fantasy"],
        "synonyms": ["Ore dake Level Up na Ken"],
        "description": (
            "<i>Sung Jinwoo</i> est le chasseur le plus faible.<br>"
            'Un <a href="https://anilist.co">lien</a> &amp; des entités.'
        ),
        "startDate": {"year": 2024},
        "coverImage": {
            "medium": f"https://s4.anilist.co/file/anilistcdn/{identifiant}-m.jpg",
            "large": f"https://s4.anilist.co/file/anilistcdn/{identifiant}-l.jpg",
            "extraLarge": f"https://s4.anilist.co/file/anilistcdn/{identifiant}-xl.jpg",
        },
        "bannerImage": f"https://s4.anilist.co/file/anilistcdn/{identifiant}-banner.jpg",
        "trailer": {"id": "NjMx7QrOWZg", "site": "youtube"},
        "characters": {
            "edges": [
                {
                    "role": "MAIN",
                    "node": {"name": {"userPreferred": "Sung Jinwoo"}},
                },
                {
                    "role": "BACKGROUND",
                    "node": {"name": {"userPreferred": "Figurant"}},
                },
            ]
        },
        "staff": {"edges": []},
        "studios": {"nodes": [{"name": "A-1 Pictures"}]},
        "relations": {"edges": []},
    }
    noeud.update(complements)
    return {"data": {"Media": noeud}}


def bouchonner_fiche_anilist(
    monkeypatch, donnees=None, status_code=200, exception=None
):
    journal = []

    def faux_post(url, json=None, **kwargs):
        journal.append({"url": url, "json": json})
        if exception:
            raise exception
        return Reponse(donnees if donnees is not None else fiche_anilist(), status_code)

    monkeypatch.setattr(app_module.requests, "post", faux_post)
    return journal


def test_la_fiche_anime_s_affiche_chez_nous(client, monkeypatch):
    journal = bouchonner_fiche_anilist(monkeypatch)

    page = client.get("/details/anime/134436?tab=animes")
    html = page.get_data(as_text=True)

    assert page.status_code == 200
    assert journal[0]["url"] == app_module.ANILIST_URL
    assert journal[0]["json"]["variables"] == {"id": 134436, "type": "ANIME"}
    # Le panneau habituel, avec ses quatre fonctions.
    assert 'id="watch-btn"' in html
    assert 'id="chat-panel"' in html
    assert 'id="fav-btn"' in html and 'id="offline-btn"' in html
    assert "FICHE ANIME · CATALOGUE ANILIST" in html


def test_la_fiche_reprend_les_donnees_anilist(client, monkeypatch):
    bouchonner_fiche_anilist(monkeypatch)

    html = client.get("/details/anime/134436").get_data(as_text=True)

    assert "Solo Leveling" in html, "le titre vient de la réponse bouchonnée"
    assert "8.6 / 10" in html, "AniList note sur 100, le panneau sur 10"
    assert "12 épisodes" in html
    assert "Terminé" in html
    assert "A-1 Pictures" in html
    assert "Sung Jinwoo" in html
    assert "Figurant" not in html, "seuls les rôles principaux sont affichés"
    assert "Action" in html and "Fantasy" in html


def test_le_synopsis_anilist_est_deshabille_de_son_html(client, monkeypatch):
    """Aucune balise tierce n'entre dans la page."""
    bouchonner_fiche_anilist(monkeypatch)

    html = client.get("/details/anime/134436").get_data(as_text=True)

    assert "<i>Sung Jinwoo</i>" not in html
    assert "Sung Jinwoo est le chasseur le plus faible." in html
    # Les entités sont décodées UNE fois, puis rééchappées par Jinja : un
    # « &amp;amp; » trahirait un double échappement.
    assert "&amp;amp;" not in html
    assert "Un lien &amp; des entités." in html


def test_la_bande_annonce_vient_d_anilist_et_passe_par_nos_routes(client, monkeypatch):
    bouchonner_fiche_anilist(monkeypatch)

    html = client.get("/details/anime/134436").get_data(as_text=True)

    assert "NjMx7QrOWZg" in html, "la bande-annonce YouTube d'AniList est reprise"
    assert "/api/manga_image?url=" in html, "les visuels passent par notre proxy"
    assert "image.tmdb.org" not in html.split("detail-container", 1)[1]


def test_le_manga_ouvre_le_lecteur_de_scan_depuis_la_fiche(client, monkeypatch):
    bouchonner_fiche_anilist(
        monkeypatch, fiche_anilist(107063, kind="MANGA")
    )

    html = client.get("/details/manga/107063?tab=animes").get_data(as_text=True)

    assert "FICHE MANGA · CATALOGUE ANILIST" in html
    assert "LIRE LE SCAN (VF)" in html
    assert "/lecteur-scan?titre=" in html
    assert "179 chapitres" in html
    assert "14 tomes" in html


def test_l_anime_propose_le_manga_associe(client, monkeypatch):
    bouchonner_fiche_anilist(monkeypatch)

    html = client.get("/details/anime/134436").get_data(as_text=True)

    assert "LIRE LE MANGA (VF)" in html
    assert "/lecteur-scan?titre=" in html


def test_le_credit_de_source_est_discret_et_secondaire(client, monkeypatch):
    """Le seul lien sortant est le crédit, pas la carte."""
    bouchonner_fiche_anilist(monkeypatch)

    html = client.get("/details/anime/134436").get_data(as_text=True)

    credit = html.split('class="detail-source"', 1)[1]
    assert "https://anilist.co/anime/134436" in credit
    assert "Fiche issue du catalogue" in html


def test_une_fiche_adulte_est_refusee(client, monkeypatch):
    bouchonner_fiche_anilist(monkeypatch, fiche_anilist(isAdult=True))

    assert client.get("/details/anime/134436").status_code == 404


def test_une_fiche_inconnue_repond_404(client, monkeypatch):
    bouchonner_fiche_anilist(monkeypatch, {"data": {"Media": None}})

    assert client.get("/details/anime/99999999").status_code == 404


def test_anilist_en_panne_sur_une_fiche_donne_une_page_propre(client, monkeypatch):
    bouchonner_fiche_anilist(monkeypatch, exception=requests.Timeout("trop lent"))

    page = client.get("/details/anime/134436")

    assert page.status_code == 504


def test_anilist_decale_sur_une_fiche_donne_une_page_propre(client, monkeypatch):
    bouchonner_fiche_anilist(monkeypatch, status_code=500)

    page = client.get("/details/anime/134436")

    assert page.status_code == 502


def test_anilist_sature_en_requetes_est_annonce(client, monkeypatch):
    bouchonner_fiche_anilist(monkeypatch, status_code=429)

    assert client.get("/details/anime/134436").status_code == 503


def test_la_fiche_anilist_est_mise_en_cache(client, monkeypatch):
    journal = bouchonner_fiche_anilist(monkeypatch)

    client.get("/details/anime/134436")
    client.get("/details/anime/134436")

    assert len(journal) == 1, "la même fiche ne doit pas repartir vers AniList"


def test_une_bande_annonce_absente_ne_casse_pas_la_fiche(client, monkeypatch):
    bouchonner_fiche_anilist(monkeypatch, fiche_anilist(trailer=None))

    page = client.get("/details/anime/134436")

    assert page.status_code == 200
    assert 'data-trailer=""' in page.get_data(as_text=True)


def test_un_type_de_media_inconnu_reste_refuse(client):
    assert client.get("/details/musique/12").status_code == 404
    assert client.get("/details/anime/0").status_code == 404
    assert client.get("/details/anime/-5").status_code == 404


# ---------------------------------------------------------------------------
# 6. Onglet « Animés & Mangas » : catalogue AniList, sous-genres et tris
# ---------------------------------------------------------------------------


def reponse_page(noeuds, has_next=True, total=None):
    return {
        "data": {
            "Page": {
                "pageInfo": {
                    "hasNextPage": has_next,
                    "total": total if total is not None else len(noeuds),
                },
                "media": noeuds,
            }
        }
    }


def bouchonner_catalogue(monkeypatch, noeuds=None, has_next=True, total=None):
    """Remplace l'appel GraphQL et renvoie le journal des variables.

    Sans ``noeuds`` explicites, le bouchon dérive les titres de la page
    demandée. C'est indispensable depuis que le catalogue lit une BANDE de
    deux pages : un bouchon qui renverrait les mêmes cartes partout ferait
    apparaître chaque titre en double.
    """
    journal = []

    def faux_post(url, json=None, **kwargs):
        variables = (json or {}).get("variables") or {}
        journal.append(variables)
        kind = variables.get("type") or "ANIME"
        donnees = noeuds
        if donnees is None:
            page = int(variables.get("page") or 1)
            donnees = [
                media_anilist(
                    1000 * page + index, f"Anime p{page}-{index}", kind=kind
                )
                for index in range(3)
            ]
        # AniList renvoie le même `total` sur toutes les pages et il est
        # cohérent avec hasNextPage. Un bouchon qui annoncerait total=3 avec
        # hasNextPage=true ne ressemble à rien de réel.
        annonce = total
        if annonce is None:
            annonce = 5000 if has_next else len(donnees)
        return Reponse(reponse_page(donnees, has_next, annonce))

    monkeypatch.setattr(app_module.requests, "post", faux_post)
    return journal


def test_l_onglet_animes_ne_repond_que_depuis_anilist(client, monkeypatch):
    journal_tmdb = []

    def tmdb_interdit(chemin, params=None):
        journal_tmdb.append(chemin)
        return {"results": []}

    monkeypatch.setattr(app_module, "tmdb_get", tmdb_interdit)
    journal = bouchonner_catalogue(monkeypatch)

    reponse = client.get("/api/list", query_string={"tab": "animes", "media": "anime"})

    assert reponse.status_code == 200
    assert journal_tmdb == [], "aucune carte de cet onglet ne vient de TMDB"
    assert journal[0]["type"] == "ANIME"
    donnees = reponse.get_json()
    # Une bande lit DEUX pages source de trois cartes : six titres au total.
    assert len(donnees["items"]) == 6
    assert donnees["has_more"] is True
    assert all(item["media_type"] == "anime" for item in donnees["items"])


def test_la_bascule_manga_change_la_requete(client, monkeypatch):
    journal = bouchonner_catalogue(monkeypatch)

    client.get("/api/list", query_string={"tab": "animes", "media": "manga"})

    assert journal[0]["type"] == "MANGA"


def test_un_type_de_media_inconnu_est_refuse(client, monkeypatch):
    bouchonner_catalogue(monkeypatch)

    reponse = client.get(
        "/api/list", query_string={"tab": "animes", "media": "film"}
    )

    assert reponse.status_code == 400


def test_les_sous_genres_dependent_du_type(client, monkeypatch):
    """L'onglet se filtre par TYPES d'animé, pas par genres de film.

    Demande utilisateur : en appuyant sur « Animés & Mangas », les pastilles
    Action / Aventure / Tranche de vie disparaissent, remplacées par Isekai,
    Réincarnation, Shōnen… Shōnen figure maintenant des deux côtés (c'est un
    type d'anime autant que de manga).
    """
    bouchonner_catalogue(monkeypatch)

    animes = client.get(
        "/api/genres", query_string={"tab": "animes", "media": "anime"}
    ).get_json()
    mangas = client.get(
        "/api/genres", query_string={"tab": "animes", "media": "manga"}
    ).get_json()

    ids_animes = {pill["id"] for pill in animes["pills"]}
    ids_mangas = {pill["id"] for pill in mangas["pills"]}
    assert {"isekai", "reincarnation", "shonen", "seinen", "zombie"} <= ids_animes
    assert {"shonen", "shojo", "seinen", "josei", "isekai"} <= ids_mangas
    # Les pastilles de genres de film (Action, Aventure, Comédie, Romance,
    # Tranche de vie…) ne servent plus sur l'onglet : ce qui le filtre, ce
    # sont les types d'animé et de manga. (« Action » subsiste chez les
    # mangas : c'est une vraie étiquette MangaDex/AniList pour ce support. )
    for genre_film in ("action", "aventure", "comedie", "romance", "tranche-de-vie"):
        assert genre_film not in ids_animes, "les genres de film ne bouchent plus l'onglet"
    assert animes["media"] == "anime" and mangas["media"] == "manga"
    assert animes["source"] == "anilist"


def test_les_tris_proposes_couvrent_la_demande(client, monkeypatch):
    bouchonner_catalogue(monkeypatch)

    donnees = client.get(
        "/api/genres", query_string={"tab": "animes", "media": "anime"}
    ).get_json()
    ids = [tri["id"] for tri in donnees["sorts"]]

    assert "recent" in ids, "filtre « dernière génération »"
    assert "nouveautes" in ids, "filtre « ajouts récents »"
    assert "note85" in ids, "filtre « note supérieure à 8,5 »"


@pytest.mark.parametrize(
    "tri,attendu",
    [
        ("tendances", "TRENDING_DESC"),
        ("populaires", "POPULARITY_DESC"),
        ("recent", "START_DATE_DESC"),
        ("nouveautes", "ID_DESC"),
        ("note85", "SCORE_DESC"),
    ],
)
def test_chaque_tri_envoie_son_critere(client, monkeypatch, tri, attendu):
    journal = bouchonner_catalogue(monkeypatch)

    client.get(
        "/api/list",
        query_string={"tab": "animes", "media": "anime", "sort": tri},
    )

    assert journal[0]["sort"] == [attendu]


def test_le_filtre_note_85_est_strict(client, monkeypatch):
    """AniList note sur 100 : 8,5 sur 10 vaut 85, pas 8."""
    journal = bouchonner_catalogue(monkeypatch)

    client.get(
        "/api/list",
        query_string={"tab": "animes", "media": "anime", "sort": "note85"},
    )

    assert journal[0]["scoreMin"] == 85


def test_le_filtre_derniere_generation_borne_l_annee(client, monkeypatch):
    journal = bouchonner_catalogue(monkeypatch)

    client.get(
        "/api/list",
        query_string={"tab": "animes", "media": "anime", "sort": "recent"},
    )

    annee = datetime.datetime.now(datetime.timezone.utc).year
    assert journal[0]["yearMin"] == annee - app_module.ANILIST_RECENT_WINDOW_YEARS
    assert journal[0]["sort"] == ["START_DATE_DESC"]


def test_un_tri_sans_filtre_ne_borne_rien(client, monkeypatch):
    journal = bouchonner_catalogue(monkeypatch)

    client.get(
        "/api/list",
        query_string={"tab": "animes", "media": "anime", "sort": "tendances"},
    )

    assert journal[0]["yearMin"] is None
    assert journal[0]["scoreMin"] is None


def test_un_sous_genre_envoie_le_bon_critere_anilist(client, monkeypatch):
    journal = bouchonner_catalogue(monkeypatch)

    client.get(
        "/api/list",
        query_string={"tab": "animes", "media": "anime", "genre": "zombie"},
    )
    client.get(
        "/api/list",
        query_string={"tab": "animes", "media": "manga", "genre": "shonen"},
    )

    assert journal[0]["tag"] == "Zombie" and journal[0]["genre"] is None
    # Deux pages source par page du site : la deuxième requête commence à 2.
    assert journal[2]["tag"] == "Shounen"


def test_un_genre_anilist_passe_par_le_champ_genre(client, monkeypatch):
    journal = bouchonner_catalogue(monkeypatch)

    client.get(
        "/api/list",
        query_string={"tab": "animes", "media": "anime", "genre": "romance"},
    )

    assert journal[0]["genre"] == "Romance" and journal[0]["tag"] is None


def test_un_sous_genre_invalide_est_refuse(client, monkeypatch):
    bouchonner_catalogue(monkeypatch)

    reponse = client.get(
        "/api/list",
        query_string={"tab": "animes", "media": "anime", "genre": "invente"},
    )

    assert reponse.status_code == 400


def test_un_tri_invalide_est_refuse(client, monkeypatch):
    bouchonner_catalogue(monkeypatch)

    reponse = client.get(
        "/api/list",
        query_string={"tab": "animes", "media": "anime", "sort": "invente"},
    )

    assert reponse.status_code == 400


def test_le_contenu_adulte_ne_passe_jamais(client, monkeypatch):
    bouchonner_catalogue(
        monkeypatch,
        [media_anilist(1, "Anime propre"), media_anilist(2, "Adulte", isAdult=True)],
    )

    donnees = client.get(
        "/api/list", query_string={"tab": "animes", "media": "anime"}
    ).get_json()

    titres = {item["title"] for item in donnees["items"]}
    assert titres == {"Anime propre"}, "aucune œuvre adulte ne doit passer"
    assert donnees["items"], "l'œuvre propre, elle, reste affichée"


def test_une_carte_sans_affiche_n_est_pas_publiee(client, monkeypatch):
    bouchonner_catalogue(
        monkeypatch,
        [media_anilist(1, "Sans affiche", coverImage={"medium": "", "large": ""})],
    )

    donnees = client.get(
        "/api/list", query_string={"tab": "animes", "media": "anime"}
    ).get_json()

    assert donnees["items"] == []


def test_les_couvertures_passent_par_notre_proxy(client, monkeypatch):
    bouchonner_catalogue(monkeypatch)

    donnees = client.get(
        "/api/list", query_string={"tab": "animes", "media": "anime"}
    ).get_json()
    carte = donnees["items"][0]

    assert carte["poster"].startswith("/api/manga_image?url=")
    assert carte["poster_small"].startswith("/api/manga_image?url=")


def test_le_catalogue_est_mis_en_cache(client, monkeypatch):
    journal = bouchonner_catalogue(monkeypatch)
    params = {"tab": "animes", "media": "anime", "genre": "zombie", "sort": "recent"}

    client.get("/api/list", query_string=params)
    apres_premiere = len(journal)
    client.get("/api/list", query_string=params)

    # Une bande coûte deux pages source, mais la deuxième visite ne repart
    # pas vers AniList : chaque page source a son propre cache.
    assert apres_premiere == app_module.ANILIST_POOL_PAGES
    assert len(journal) == apres_premiere, "la même page ne doit pas repartir"


def test_le_bandeau_de_l_onglet_vient_d_anilist(client, monkeypatch):
    journal = bouchonner_catalogue(monkeypatch)

    donnees = client.get(
        "/api/hero", query_string={"tab": "animes", "media": "manga"}
    ).get_json()

    assert journal[0]["type"] == "MANGA"
    assert all(item["media_type"] == "manga" for item in donnees["items"])


def test_anilist_en_panne_sur_le_catalogue_donne_une_erreur_propre(client, monkeypatch):
    def faux_post(url, json=None, **kwargs):
        raise requests.Timeout("trop lent")

    monkeypatch.setattr(app_module.requests, "post", faux_post)

    assert (
        client.get("/api/list", query_string={"tab": "animes"}).status_code == 504
    )


def test_les_etiquettes_inexistantes_ne_sont_pas_proposees(client, monkeypatch):
    """Un bouton qui renverrait toujours « vide » est un mensonge."""

    def faux_post(url, json=None, **kwargs):
        if "MediaTagCollection" in (json or {}).get("query", ""):
            return Reponse(
                {"data": {"MediaTagCollection": [
                    {"name": "Zombie", "isAdult": False},
                    {"name": "Shounen", "isAdult": False},
                    {"name": "Contenu adulte", "isAdult": True},
                ]}}
            )
        return Reponse(reponse_page([]))

    monkeypatch.setattr(app_module.requests, "post", faux_post)

    pills = client.get(
        "/api/genres", query_string={"tab": "animes", "media": "anime"}
    ).get_json()["pills"]
    ids = {pill["id"] for pill in pills}

    assert "zombie" in ids
    assert "harem" not in ids, "AniList ne connaît pas cette étiquette ici"


def test_les_etiquettes_sont_gardees_si_anilist_ne_repond_pas(client, monkeypatch):
    """Mieux vaut un onglet vide expliqué qu'un filtre amputé en silence."""

    def faux_post(url, json=None, **kwargs):
        raise requests.ConnectionError("pas de réseau")

    monkeypatch.setattr(app_module.requests, "post", faux_post)

    pills = client.get(
        "/api/genres", query_string={"tab": "animes", "media": "anime"}
    ).get_json()["pills"]

    assert {pill["id"] for pill in pills} >= {"zombie", "harem", "isekai"}


def test_la_page_d_onglet_n_affiche_plus_deux_fois_les_resultats(client, monkeypatch):
    """La grille EST le résultat AniList : la bande du bas ferait doublon."""
    bouchonner_catalogue(monkeypatch)

    html = client.get("/", query_string={"tab": "animes", "q": "Solo"}).get_data(
        as_text=True
    )

    assert 'class="anilist-band"' not in html


def test_la_bascule_et_les_tris_sont_dans_le_gabarit():
    chemin = Path(__file__).resolve().parent.parent / "templates" / "index.html"
    gabarit = chemin.read_text(encoding="utf-8")

    assert 'id="media-switch"' in gabarit
    assert 'data-media="anime"' in gabarit
    assert 'data-media="manga"' in gabarit
    assert 'id="sort-pills"' in gabarit


def test_les_types_occupent_la_tete_des_pastilles(client, monkeypatch):
    """La demande utilisateur, à la lettre : Isekai, Réincarnation, Shōnen…
    en tête de liste, pas Action ou Tranche de vie."""
    bouchonner_catalogue(monkeypatch)

    pills = client.get(
        "/api/genres", query_string={"tab": "animes", "media": "anime"}
    ).get_json()["pills"]

    tete = [pill["id"] for pill in pills[:6]]
    assert tete[:1] == ["all"]
    assert {"isekai", "reincarnation", "shonen"} <= set(tete)


# ---------------------------------------------------------------------------
# 6bis. Panne AniList : plus de grille vide muette
# ---------------------------------------------------------------------------


def test_une_erreur_graphql_ne_passe_plus_inapercue(monkeypatch):
    """HTTP 200 avec ``errors`` mais sans ``data`` : avant, la grille
    affichait silencieusement « Aucun titre disponible ». Désormais la
    demande est déclarée en échec et l'interface montre la cause."""

    def faux_post(url, json=None, **kwargs):
        return Reponse({"errors": [{"message": "Source en maintenance"}]})

    monkeypatch.setattr(app_module.requests, "post", faux_post)

    with pytest.raises(app_module.UpstreamServiceError):
        app_module._anilist_post("query { Page { pageInfo { total } } }", {})


def test_un_429_est_relance_une_seule_fois(monkeypatch):
    def faux_post(url, json=None, **kwargs):
        faux_post.appels += 1
        if faux_post.appels == 1:
            return Reponse({"errors": []}, status_code=429)
        return Reponse(reponse_page([]), status_code=200)

    faux_post.appels = 0
    monkeypatch.setattr(app_module.requests, "post", faux_post)
    monkeypatch.setattr(app_module.time, "sleep", lambda *_args: None)

    donnees = app_module._anilist_post("query { Page { pageInfo { total } } }", {})

    assert faux_post.appels == 2, "une seule relance, pas un martèlement"
    assert "Page" in donnees


def test_une_panne_anilist_est_memorisee(client, monkeypatch):
    """Sans ce garde-fou, chaque clic de pilule, de tri ou de défilement
    repayait la panne (et l'attente). L'erreur est mémorisée une minute :
    la seconde demande est servie de mémoire, sans recontacter AniList."""

    journal = []

    def faux_post(url, json=None, **kwargs):
        journal.append(1)
        raise requests.ConnectionError("source en panne")

    monkeypatch.setattr(app_module.requests, "post", faux_post)
    monkeypatch.setattr(app_module.time, "sleep", lambda *_args: None)

    premiere = client.get(
        "/api/list", query_string={"tab": "animes", "media": "anime"}
    )
    seconde = client.get(
        "/api/list", query_string={"tab": "animes", "media": "anime"}
    )

    assert premiere.status_code == 502
    assert seconde.status_code == 502
    assert premiere.get_json()["error"], "le message est affiché, pas une grille vide"
    # Une seule page source a été demandée (deux tentatives de POST), et la
    # seconde requête HTTP n'a rien ajouté au journal.
    assert len(journal) == 2


# ---------------------------------------------------------------------------
# 7. Aucun mélange : nouveautés et légendes restent films et séries
# ---------------------------------------------------------------------------


def bouchonner_tmdb_animation(monkeypatch):
    """Deux titres, dont un d'animation, sur chaque découverte TMDB."""

    def faux_get(chemin, params=None):
        if "/discover/movie" in chemin:
            return {
                "page": 1,
                "total_pages": 1,
                "results": [
                    {
                        "id": 11,
                        "title": "Un polar",
                        "genre_ids": [80],
                        "poster_path": "/p.jpg",
                        "vote_average": 8.9,
                        "release_date": "2027-01-01",
                    },
                    {
                        "id": 12,
                        "title": "Un dessin animé",
                        "genre_ids": [16],
                        "poster_path": "/a.jpg",
                        "vote_average": 8.9,
                        "release_date": "2027-02-01",
                    },
                ],
            }
        series = [
            {
                "id": 21,
                "name": "Une série",
                "genre_ids": [18],
                "poster_path": "/s.jpg",
                "vote_average": 8.9,
                "first_air_date": "2027-03-01",
            },
            {
                "id": 22,
                "name": "Un anime",
                "genre_ids": [16],
                "poster_path": "/n.jpg",
                "vote_average": 8.9,
                "first_air_date": "2027-04-01",
            },
        ]
        # TMDB applique `with_genres` côté serveur : le bouchon fait pareil,
        # sinon le test ne prouverait rien.
        demande = str((params or {}).get("with_genres") or "")
        if demande == "16":
            series = [item for item in series if 16 in item["genre_ids"]]
        return {"page": 1, "total_pages": 1, "results": series}

    monkeypatch.setattr(app_module, "tmdb_get", faux_get)


def test_les_nouveautes_ne_melangent_pas_d_animation(client, monkeypatch):
    bouchonner_tmdb_animation(monkeypatch)

    donnees = client.get("/api/upcoming", query_string={"type": "all"}).get_json()
    titres = [item["title"] for item in donnees["items"]]

    assert "Un polar" in titres and "Une série" in titres
    assert "Un dessin animé" not in titres
    assert "Un anime" not in titres


def test_les_legendes_ne_melangent_pas_d_animation(client, monkeypatch):
    bouchonner_tmdb_animation(monkeypatch)

    donnees = client.get("/api/legends", query_string={"type": "all"}).get_json()
    titres = [item["title"] for item in donnees["items"]]

    assert "Un polar" in titres and "Une série" in titres
    assert "Un dessin animé" not in titres
    assert "Un anime" not in titres


def test_le_filtre_explicite_animation_des_nouveautes_marche_toujours(
    client, monkeypatch
):
    bouchonner_tmdb_animation(monkeypatch)

    titres = [
        item["title"]
        for item in client.get(
            "/api/upcoming", query_string={"type": "anime"}
        ).get_json()["items"]
    ]

    assert titres == ["Un anime"], "le filtre demandé explicitement reste servi"


def test_les_onglets_nouveautes_et_legendes_ne_proposent_plus_l_anime():
    """Ces deux onglets sont TMDB ; l'anime a le sien, puisé chez AniList."""
    chemin = Path(__file__).resolve().parent.parent / "static" / "js" / "home.js"
    home = chemin.read_text(encoding="utf-8")
    bloc = home[home.index("function specialPills()") :]
    bloc = bloc[: bloc.index("}")]

    assert '"anime"' not in bloc


def test_la_fiche_anime_transmet_ses_variantes_au_lecteur(client, monkeypatch):
    """Rōmaji + synonymes voyagent vers le lecteur de scan."""
    bouchonner_fiche_anilist(
        monkeypatch,
        donnees=fiche_anilist(
            title={
                "romaji": "Ore dake Level Up na Ken",
                "english": "Solo Leveling",
                "native": "나 혼자만 레벨업",
                "userPreferred": "나 혼자만 레벨업",
            }
        ),
    )

    page = client.get("/details/anime/134436?tab=animes")
    html = page.get_data(as_text=True)

    assert page.status_code == 200
    # Le href précède la classe dans le gabarit : on remonte à l'attribut.
    bouton = html.split('class="scan-btn"', 1)[0].rsplit("href=", 1)[1]
    assert "alt=" in bouton
    assert "Ore%20dake%20Level%20Up%20na%20Ken" in bouton
    assert "Solo%20Leveling" in bouton


def test_la_fiche_anime_liste_les_oeuvres_liees(client, monkeypatch):
    """« Dans le même univers » : les relations AniList, déjà demandées mais
    jusqu'ici jetées sans être lues."""
    bouchonner_fiche_anilist(
        monkeypatch,
        donnees=fiche_anilist(
            relations={
                "edges": [
                    {
                        "relationType": "SOURCE",
                        "node": {
                            "id": 106481,
                            "type": "MANGA",
                            "format": "MANGA",
                            "title": {"userPreferred": "Ore dake Level Up na Ken"},
                        },
                    },
                    {
                        "relationType": "SEQUEL",
                        "node": {
                            "id": 151807,
                            "type": "ANIME",
                            "format": "TV",
                            "title": {"userPreferred": "Solo Leveling S2"},
                        },
                    },
                    {
                        # Un lien sans intérêt éditorial : écarté, pas traduit.
                        "relationType": "CHARACTER",
                        "node": {
                            "id": 1,
                            "type": "ANIME",
                            "format": "TV",
                            "title": {"userPreferred": "Figurant"},
                        },
                    },
                ]
            }
        ),
    )

    page = client.get("/details/anime/134436?tab=animes")
    corps = page.get_data(as_text=True)

    assert page.status_code == 200
    assert "Dans le même univers" in corps
    assert "/details/manga/106481?tab=animes" in corps
    assert "/details/anime/151807?tab=animes" in corps
    # L'apostrophe typographique est échappée par Jinja (&#39;).
    assert "origine" in corps and "Suite" in corps
    assert "Figurant" not in corps


def test_le_titre_du_lecteur_n_est_pas_doublement_quoté(client):
    """`| tojson` ajoutait SES guillemets dans l'attribut déjà guillemeté.

    Le lecteur partait donc chercher « "One Piece" », guillemets compris, sur
    MangaDex — et ne trouvait rien.
    """
    page = client.get("/lecteur-scan", query_string={"titre": "One Piece"})
    html = page.get_data(as_text=True)

    assert 'data-title="One Piece"' in html
    assert 'data-title=""One Piece""' not in html
    assert "| tojson }}" not in html.split("{% block scripts %}", 1)[0]


def test_les_variantes_arrivent_propres_au_lecteur(client):
    page = client.get(
        "/lecteur-scan",
        query_string={"titre": "One Piece", "alt": "OP|ワンピース"},
    )
    html = page.get_data(as_text=True)

    assert 'data-alt="OP|ワンピース"' in html



if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
