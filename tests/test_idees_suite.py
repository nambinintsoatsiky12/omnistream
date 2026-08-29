"""Le réglage de fraîcheur, la rotation du bandeau, « Pas intéressé », la
rangée « Continuer à lire », la page calendrier et les alertes d'épisodes.

AniList et TMDB sont bouchonnés : ce bac à sable n'a pas d'accès sortant.
"""

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


def home_js():
    return (STATIQUES / "js" / "home.js").read_text(encoding="utf-8")


def bloc_annoncer(js):
    """Le corps d'`annoncerEpisodes`, isolé pour qu'on n'y lise que lui."""
    debut = js.split("function annoncerEpisodes(", 1)[1]
    return debut.split("async function chargerCalendrier", 1)[0]


def catalogue_tmdb(monkeypatch):
    def faux(chemin, params=None):
        page = int((params or {}).get("page", 1))
        return {
            "results": [
                {
                    "id": (page - 1) * 20 + i,
                    "title": f"T{page}-{i}",
                    "poster_path": "/p.jpg",
                    "vote_average": 8.4,
                    "release_date": "2024-01-01",
                }
                for i in range(20)
            ],
            "total_pages": 50,
        }

    monkeypatch.setattr(app_module, "tmdb_get", faux)


# ---------------------------------------------------------------------------
# 1. Le réglage de fraîcheur
# ---------------------------------------------------------------------------


def test_les_trois_crans_sont_de_plus_en_plus_souples():
    crans = app_module.ROTATION_PRESETS

    assert crans["stable"] > crans["normal"] > crans["frais"]
    # Le défaut reste le cran du milieu.
    assert crans["normal"] == app_module.ROTATION_POP_POWER


def test_une_puissance_plus_basse_melange_davantage():
    items = [{"rating": 8.0, "year": "2024", "id": i} for i in range(100)]
    stable = [x["id"] for x in app_module.rotation_order(items, "g", "stable")]
    frais = [x["id"] for x in app_module.rotation_order(items, "g", "frais")]

    # « stable » garde le haut du catalogue en tête, « frais » le brasse.
    assert stable[0] < frais[0] or stable[:5] != frais[:5]
    assert sum(1 for x in stable[:10] if x < 20) > sum(
        1 for x in frais[:10] if x < 20
    )


def test_un_cran_inconnu_retombe_sur_le_defaut():
    assert app_module._rotation_power("nimporte") == app_module.ROTATION_POP_POWER
    assert app_module._rotation_power(None) == app_module.ROTATION_POP_POWER
    assert app_module._rotation_power("frais") == app_module.ROTATION_PRESETS["frais"]


def test_le_cran_change_vraiment_l_ordre_servi(client, monkeypatch):
    catalogue_tmdb(monkeypatch)

    stable = client.get(
        "/api/list?tab=films&page=1&seed=v&fraicheur=stable"
    ).get_json()
    frais = client.get("/api/list?tab=films&page=1&seed=v&fraicheur=frais").get_json()

    assert [i["id"] for i in stable["items"]] != [i["id"] for i in frais["items"]]


def test_un_cran_invalide_ne_casse_rien(client, monkeypatch):
    catalogue_tmdb(monkeypatch)

    reponse = client.get("/api/list?tab=films&page=1&seed=v&fraicheur=bogus")

    assert reponse.status_code == 200
    assert reponse.get_json()["items"]


def test_le_reglage_est_dans_l_interface_et_memorise():
    gabarit = (GABARITS / "index.html").read_text(encoding="utf-8")
    js = home_js()
    css = (STATIQUES / "css" / "style.css").read_text(encoding="utf-8")

    assert 'id="fraicheur"' in gabarit
    for cran in ("stable", "normal", "frais"):
        assert f'data-fraicheur="{cran}"' in gabarit
    assert "omni-fraicheur" in js
    assert "installerFraicheur()" in js
    assert ".fraicheur-btn.active {" in css
    # Le cran part avec chaque requête de liste.
    assert 'params.set("fraicheur", fraicheur)' in js


# ---------------------------------------------------------------------------
# 2. Le bandeau tourne par visite, pas toutes les quinze minutes
# ---------------------------------------------------------------------------


def bandeau_tmdb(monkeypatch):
    """Un stub qui satisfait les trois filtres d'`api_hero`.

    Le bandeau ne retient que les titres notés >= 8,5 (pour le volet « les
    mieux notés ») et dotés d'un backdrop : un stub sans ces deux champs
    renverrait un bandeau vide et le test ne prouverait rien.
    """

    def faux(chemin, params=None):
        return {
            "results": [
                {
                    "id": i,
                    "title": f"T{i}",
                    "poster_path": "/p.jpg",
                    "backdrop_path": "/b.jpg",
                    "vote_average": 9.0,
                    "vote_count": 900,
                    "release_date": "2024-01-01",
                    "genre_ids": [16],
                    "origin_country": ["JP"],
                    "original_language": "ja",
                }
                for i in range(20)
            ],
            "total_pages": 5,
        }

    monkeypatch.setattr(app_module, "tmdb_get", faux)


def test_le_bandeau_suit_la_graine_de_visite(client, monkeypatch):
    bandeau_tmdb(monkeypatch)

    premiere = client.get("/api/hero?tab=films&seed=visite-a").get_json()
    deuxieme = client.get("/api/hero?tab=films&seed=visite-b").get_json()

    assert [i["id"] for i in premiere["items"]] != [i["id"] for i in deuxieme["items"]]


def test_le_bandeau_n_est_plus_cale_sur_une_horloge():
    """Une horloge de 15 min donnait le même bandeau à tout le monde."""
    source = Path("app.py").read_text(encoding="utf-8")
    bloc = source.split('def api_hero(', 1)[1].split("@app.route", 1)[0]

    assert "time.time() // 900" not in bloc
    assert "rotation_order(" in bloc


def test_le_bandeau_part_avec_la_graine_cote_navigateur():
    js = home_js()
    bloc = js.split("function heroUrl()", 1)[1].split("function ", 1)[0]

    assert "sessionSeed" in bloc


def test_le_bandeau_n_est_pas_remelange_cote_client():
    """Sinon le tirage pondéré du serveur serait défait à l'arrivée."""
    js = home_js()
    debut = js.split("async function loadHero()", 1)[1]
    bloc = debut.split("function renderSortPills", 1)[0]

    assert "seededShuffle(" not in bloc


# ---------------------------------------------------------------------------
# 3. « Pas intéressé »
# ---------------------------------------------------------------------------


def test_un_titre_ecarte_ne_revient_plus():
    js = home_js()

    assert "omni-titres-ecartes" in js
    assert "if (estEcarte(item)) return null;" in js
    assert "function createSkipButton(" in js
    assert "poster.appendChild(createSkipButton(item, card));" in js


def test_la_liste_des_titres_ecartes_est_bornee():
    js = home_js()

    assert "ECARTES_MAX = 400" in js
    assert ".slice(-ECARTES_MAX)" in js


def test_le_bouton_ne_declenche_pas_l_ouverture_de_la_fiche():
    """Un clic sur « pas intéressé » ne doit pas ouvrir la fiche en plus."""
    js = home_js()
    bloc = js.split("function createSkipButton(", 1)[1].split("function ", 1)[0]

    assert "event.preventDefault();" in bloc
    assert "event.stopPropagation();" in bloc
    assert "carte.remove();" in bloc


def test_le_bouton_est_atteignable_sans_souris():
    css = (STATIQUES / "css" / "style.css").read_text(encoding="utf-8")

    assert ".card-skip-btn {" in css
    # Sur tactile il n'y a pas de survol : le bouton doit rester visible.
    assert "@media (hover: none)" in css.split(".card-skip-btn {", 1)[1][:1200]


# ---------------------------------------------------------------------------
# 4. « Continuer à lire »
# ---------------------------------------------------------------------------


def test_la_bibliotheque_relit_l_historique_du_lecteur():
    gabarit = (GABARITS / "bibliotheque.html").read_text(encoding="utf-8")
    js = (STATIQUES / "js" / "library-page.js").read_text(encoding="utf-8")

    assert 'id="scan-grid"' in gabarit
    assert "Continuer à lire" in gabarit
    assert "omni-scan-historique" in js
    assert "function renderScans()" in js
    assert "renderScans();" in js, "la rangée ne s'afficherait jamais"


def test_la_bibliotheque_ne_duplique_pas_le_stockage():
    """L'historique est écrit par le lecteur : ici on ne fait que le lire."""
    js = (STATIQUES / "js" / "library-page.js").read_text(encoding="utf-8")
    bloc = js.split("function lireScans()", 1)[1].split("function carteScan(", 1)[0]

    assert "getItem" in bloc
    assert "setItem" not in bloc


def test_la_reprise_pointe_vers_le_lecteur():
    js = (STATIQUES / "js" / "library-page.js").read_text(encoding="utf-8")

    assert "/lecteur-scan?titre=" in js
    assert "Reprendre au chapitre" in js


def test_on_peut_oublier_une_lecture():
    gabarit = (GABARITS / "bibliotheque.html").read_text(encoding="utf-8")
    js = (STATIQUES / "js" / "library-page.js").read_text(encoding="utf-8")

    assert 'id="scan-clear"' in gabarit
    assert 'removeItem(SCAN_CLE)' in js


# ---------------------------------------------------------------------------
# 5. La page calendrier
# ---------------------------------------------------------------------------


def test_la_page_calendrier_existe(client):
    reponse = client.get("/calendrier")

    assert reponse.status_code == 200
    assert 'id="calendrier-liste"' in reponse.get_data(as_text=True)


def test_la_page_calendrier_est_dans_le_menu(client):
    html = client.get("/").get_data(as_text=True)

    # Le gabarit écrit `url_for('calendrier')` ; ce qui compte, c'est le href
    # réellement servi.
    assert 'href="/calendrier"' in html


def test_le_filtre_par_jour_ne_repart_pas_vers_anilist():
    js = (GABARITS / "calendrier.html").read_text(encoding="utf-8")

    # Les épisodes sont chargés une fois, puis filtrés en mémoire.
    assert "function rendre()" in js
    assert "item.jour === jour" in js
    bloc = js.split("joursEl.addEventListener", 1)[1].split("if (mediaEl)", 1)[0]
    assert "fetch(" not in bloc


def test_le_calendrier_change_avec_la_bascule_animes_mangas():
    js = (GABARITS / "calendrier.html").read_text(encoding="utf-8")
    bloc = js.split("mediaEl.addEventListener", 1)[1].split("charger();", 1)[0]

    assert "charger();" in js.split("mediaEl.addEventListener", 1)[1][:900]
    assert "dataset.media" in bloc


def test_le_calendrier_dit_quand_anilist_ne_repond_pas():
    js = (GABARITS / "calendrier.html").read_text(encoding="utf-8")

    assert "AniList n'a pas répondu" in js


# ---------------------------------------------------------------------------
# 6. Les alertes d'épisodes
# ---------------------------------------------------------------------------


def test_l_autorisation_n_est_jamais_demandee_d_office():
    js = home_js()

    assert "requestPermission()" in js
    bloc = js.split('notifBtn.addEventListener("click"', 1)[1][:900]
    # La demande part du clic, pas du chargement de la page.
    assert "requestPermission()" in bloc
    assert 'if (accord === "default")' in js


def test_on_n_annonce_que_les_series_de_ma_liste():
    """Prévenir de tout le calendrier serait du spam."""
    js = home_js()
    bloc = bloc_annoncer(js)

    assert "getFavorites()" in bloc
    assert "if (!suivis.size) return;" in bloc


def test_un_episode_n_est_annonce_qu_une_fois():
    js = home_js()
    bloc = bloc_annoncer(js)

    assert "omni-notif-episodes-vus" in js
    assert "!vus.has(maCle(item))" in bloc
    assert "vus.add(maCle(item))" in bloc


def test_les_alertes_sont_coupees_par_defaut():
    js = home_js()

    # Rien dans localStorage ⇒ désactivé : on ne surprend personne.
    assert 'getItem(NOTIF_CLE) === "oui"' in js
    assert "notifBtn.hidden = false;" in js, "le bouton doit rester caché sans support"


def test_le_bouton_d_alerte_est_dans_l_onglet_animes():
    gabarit = (GABARITS / "index.html").read_text(encoding="utf-8")

    assert 'id="anime-notif"' in gabarit
    assert "hidden" in gabarit.split('id="anime-notif"')[1][:80]


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
