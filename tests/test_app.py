import json

import pytest
import requests

import app as app_module
import auth_db


class FakeResponse:
    def __init__(self, data, status_code=200, headers=None, content=b""):
        self._data = data
        self.status_code = status_code
        self.headers = headers or {"Content-Type": "application/json"}
        self.content = content

    def json(self):
        return self._data

    def raise_for_status(self):
        if self.status_code >= 400:
            error = requests.HTTPError(f"HTTP {self.status_code}")
            error.response = self
            raise error

    def iter_content(self, chunk_size=1, **_kwargs):
        for start in range(0, len(self.content), max(1, int(chunk_size))):
            yield self.content[start : start + int(chunk_size)]

    def close(self):
        return None


def sample_tmdb_item(item_id=1, media="movie"):
    item = {
        "id": item_id,
        "vote_average": 8.25,
        "poster_path": "/poster.jpg",
        "backdrop_path": "/backdrop.jpg",
        "overview": "Synopsis",
        "original_language": "fr",
    }
    if media == "movie":
        item.update({"title": "Un film", "release_date": "2026-08-27"})
    else:
        item.update(
            {
                "name": "Une série",
                "first_air_date": "2026-08-27",
                "origin_country": ["FR"],
            }
        )
    return item


def test_landing_starts_without_turso_or_tmdb(client, monkeypatch):
    monkeypatch.setattr(app_module, "TMDB_API_KEY", "")

    response = client.get("/")

    assert response.status_code == 200
    assert b"body-landing" in response.data
    assert b"Le streaming," in response.data
    assert b'id="sponsor-gift"' in response.data
    assert app_module.SPONSOR_SMARTLINK_URL.encode() in response.data
    assert auth_db.get_total_visits() == 1
    assert client.head("/").status_code == 200
    # HEAD request should not increment the counter
    assert auth_db.get_total_visits() == 1


def test_unique_visitor_counter_only_counts_once_per_session(client, monkeypatch):
    monkeypatch.setattr(app_module, "TMDB_API_KEY", "")

    # First visit counts
    client.get("/")
    assert auth_db.get_total_visits() == 1

    # Second visit in same session does not count
    client.get("/")
    assert auth_db.get_total_visits() == 1


def test_non_landing_pages_do_not_receive_landing_header(client):
    response = client.get("/confidentialite")

    assert response.status_code == 200
    assert b'<body class="body-landing">' not in response.data
    assert b"topbar-landing" not in response.data


def test_sponsor_gift_appears_on_catalog_pages(client):
    response = client.get("/?tab=films")

    assert response.status_code == 200
    assert b'id="sponsor-gift"' in response.data
    assert b'target="_blank"' in response.data
    assert b'rel="noopener noreferrer sponsored"' in response.data


def test_notification_worker_only_cleans_up_old_push_ads(client):
    response = client.get("/sw.js")

    assert response.status_code == 200
    assert response.mimetype == "application/javascript"
    assert response.headers["Cache-Control"] == "no-store, max-age=0"
    assert b"importScripts" not in response.data
    assert b"registration.unregister" in response.data
    assert b"subscription.unsubscribe" in response.data


def test_all_jinja_templates_compile():
    for template_name in app_module.app.jinja_env.list_templates():
        app_module.app.jinja_env.get_template(template_name)


@pytest.mark.parametrize("page", ["abc", "1.5", ""])
def test_invalid_page_returns_json_400(client, page):
    response = client.get(f"/api/list?tab=films&page={page}")

    assert response.status_code == 400
    assert response.is_json
    assert "entier" in response.get_json()["error"]


def test_invalid_catalog_parameters_are_rejected(client):
    assert client.get("/api/list?tab=inconnu").status_code == 400
    assert client.get("/api/list?tab=films&genre=pas-un-genre").status_code == 400
    assert client.get("/api/upcoming?type=inconnu").status_code == 400


def test_api_404_and_oversized_payload_are_json(client, monkeypatch):
    monkeypatch.setattr(app_module, "GEMINI_API_KEY", "test-key")
    not_found = client.get("/api/inconnue")
    oversized = client.post(
        "/api/chat",
        data=b"x" * (app_module.app.config["MAX_CONTENT_LENGTH"] + 1),
        headers={"Content-Type": "application/json"},
    )

    assert not_found.status_code == 404
    assert not_found.is_json
    assert oversized.status_code == 413
    assert oversized.is_json


def test_missing_tmdb_key_returns_explicit_503(client, monkeypatch):
    monkeypatch.setattr(app_module, "TMDB_API_KEY", "")

    response = client.get("/api/list?tab=films")

    assert response.status_code == 503
    assert response.is_json
    assert "TMDB_API_KEY" in response.get_json()["error"]


def test_catalog_pagination_uses_tmdb_total_pages(client, monkeypatch):
    monkeypatch.setattr(
        app_module,
        "tmdb_get",
        lambda *_args, **_kwargs: {
            "results": [sample_tmdb_item()],
            "total_pages": 2,
        },
    )

    first = client.get("/api/list?tab=films&page=1&seed=test").get_json()
    second = client.get("/api/list?tab=films&page=2&seed=test").get_json()

    assert first["has_more"] is True
    assert second["has_more"] is False
    assert first["items"][0]["media_type"] == "movie"
    assert first["items"][0]["rating"] == 8.2


def test_details_is_publicly_accessible(client, monkeypatch):
    item = sample_tmdb_item()
    item.update(
        {
            "genres": [{"name": "Action"}],
            "credits": {"cast": [{"name": "Acteur"}]},
        }
    )
    monkeypatch.setattr(app_module, "tmdb_get", lambda *_args, **_kwargs: item)

    response = client.get("/details/movie/1?tab=films")

    assert response.status_code == 200
    assert b"Un film" in response.data


def test_details_handles_missing_poster_and_malformed_runtime(client, monkeypatch):
    item = sample_tmdb_item()
    item.update(
        {
            "poster_path": None,
            "backdrop_path": None,
            "episode_run_time": "invalide",
            "original_language": "ja",
            "origin_country": ["JP"],
            "genres": [{"name": "Animation"}],
            "credits": {"cast": [{"name": "Actrice"}]},
        }
    )
    monkeypatch.setattr(app_module, "tmdb_get", lambda *_args, **_kwargs: item)

    response = client.get("/details/movie/1")

    assert response.status_code == 200
    assert b"Affiche indisponible" in response.data
    assert b'src="None"' not in response.data
    assert b"LIRE LE SCAN" in response.data


def test_chat_is_publicly_accessible(client, monkeypatch):
    monkeypatch.setattr(app_module, "GEMINI_API_KEY", "test-key")
    captured = {}

    def fake_post(_url, **kwargs):
        captured.update(kwargs)
        return FakeResponse(
            {
                "candidates": [
                    {
                        "content": {
                            "parts": [{"text": "Bonjour cinéphile !"}]
                        }
                    }
                ]
            }
        )

    monkeypatch.setattr(app_module.requests, "post", fake_post)
    response = client.post(
        "/api/chat",
        json={
            "title": "Un film",
            "overview": "Synopsis",
            "year": "2026",
            "genres": ["Drame"],
            "messages": [{"role": "user", "content": "Qui joue dedans ?"}],
        },
    )

    assert response.status_code == 200
    assert response.get_json()["reply"] == "Bonjour cinéphile !"
    assert captured["timeout"] == 30


def test_chat_validates_payload(client, monkeypatch):
    monkeypatch.setattr(app_module, "GEMINI_API_KEY", "test-key")

    malformed = client.post(
        "/api/chat", json={"title": "Film"}
    )

    assert malformed.status_code == 400
    assert malformed.is_json


def test_reader_serializes_title_as_safe_javascript(client):
    """Le titre ne doit jamais pouvoir fermer un attribut ni ouvrir une balise.

    Il est injecté dans un attribut HTML (`data-title`), lu ensuite par le
    script via `dataset` : c'est l'auto-échappement HTML qui protège, pas un
    échappement JSON — lequel ajoutait ses guillemets dans l'attribut et
    faisait chercher un titre guillemets compris sur MangaDex.
    """
    response = client.get(
        "/lecteur-scan", query_string={"titre": '</script><script>alert(1)</script>'}
    )

    assert response.status_code == 200
    assert b"<script>alert(1)</script>" not in response.data
    assert b"&lt;script&gt;alert(1)&lt;/script&gt;" in response.data
    # Aucun guillemet nu ne peut refermer l'attribut prématurément.
    assert b'data-title="</script>' not in response.data


def test_mangadex_proxy_rejects_arbitrary_endpoint(client):
    response = client.get("/api/mangadex_proxy?endpoint=/user")

    assert response.status_code == 400
    assert response.is_json


def test_mangadex_proxy_preserves_repeated_parameters(client, monkeypatch):
    captured = {}

    def fake_get(_url, **kwargs):
        captured.update(kwargs)
        return FakeResponse({"data": []})

    monkeypatch.setattr(app_module.requests, "get", fake_get)
    endpoint = "/manga/123e4567-e89b-42d3-a456-426614174000/feed"
    response = client.get(
        "/api/mangadex_proxy",
        query_string=[
            ("endpoint", endpoint),
            ("translatedLanguage[]", "fr"),
            ("contentRating[]", "safe"),
            ("contentRating[]", "suggestive"),
        ],
    )

    assert response.status_code == 200
    assert captured["params"].count(("contentRating[]", "safe")) == 1
    assert captured["params"].count(("contentRating[]", "suggestive")) == 1


@pytest.mark.parametrize(
    "url",
    [
        "http://uploads.mangadex.org/image.jpg",
        "https://127.0.0.1/secret",
        "https://uploads.mangadex.org.evil.example/image.jpg",
        "https://uploads.mangadex.org:444/image.jpg",
        "https://uploads.mangadex.org:invalid/image.jpg",
    ],
)
def test_manga_image_blocks_ssrf_urls(client, url):
    response = client.get("/api/manga_image", query_string={"url": url})

    assert response.status_code == 400


def test_missing_youtube_key_returns_503(client, monkeypatch):
    monkeypatch.setattr(app_module, "YOUTUBE_API_KEY", "")

    response = client.get("/api/musique-trending")

    assert response.status_code == 503
    assert "YOUTUBE_API_KEY" in response.get_json()["error"]


def test_youtube_formatter_decodes_entities_and_drops_invalid_ids():
    items = app_module._format_youtube_items(
        [
            {
                "id": {"videoId": "abcdefghijk"},
                "snippet": {
                    "title": "Rock &amp; Roll",
                    "channelTitle": "A &lt; B",
                    "thumbnails": {"medium": {"url": "https://img.example/a.jpg"}},
                },
            },
            {"id": {"videoId": "<script>"}, "snippet": {}},
        ],
        id_is_object=True,
    )

    assert items == [
        {
            "id": "abcdefghijk",
            "title": "Rock & Roll",
            "channel": "A < B",
            "thumbnail": "https://img.example/a.jpg",
        }
    ]


def test_musique_page_loads(client):
    response = client.get("/musiques")

    assert response.status_code == 200
    assert b"Audio" in response.data
    assert b"Vid\xc3\xa9o" in response.data
    # La lecture est désormais assurée par le lecteur global persistant
    # (présent dans le gabarit de base), pour continuer entre les pages.
    assert b"omni-audio-bar" in response.data
    assert b"global-player-dock" in response.data
    # Mode Vidéo : overlay vrai plein écran global
    assert b"global-video-overlay" in response.data
    assert b"musique.js" in response.data


def test_privacy_page_loads(client):
    response = client.get("/confidentialite")

    assert response.status_code == 200
    assert b"Confidentialit\xc3\xa9" in response.data


def test_library_page_loads(client):
    response = client.get("/bibliotheque")

    assert response.status_code == 200
    assert b"continue-grid" in response.data
    assert b"favorites-grid" in response.data


def test_downloads_page_loads(client):
    response = client.get("/telechargements")

    assert response.status_code == 200
    assert b"offline-grid" in response.data
    assert b"saver-stats" in response.data


def test_offline_page_loads(client):
    response = client.get("/offline")

    assert response.status_code == 200
    assert b"hors ligne" in response.data.lower()


def test_service_worker_served(client):
    response = client.get("/service-worker.js")

    assert response.status_code == 200
    assert "javascript" in response.headers.get("Content-Type", "")
    assert response.headers.get("Service-Worker-Allowed") == "/"


def test_manifest_served(client):
    response = client.get("/manifest.webmanifest")

    assert response.status_code == 200
    assert b"OmniStream" in response.data


def test_manifest_content_type_admis_par_chrome(client):
    """Sans ce mimetype, le manifeste est rejeté et l'application installée
    ne se lance plus du tout."""
    response = client.get("/manifest.webmanifest")

    content_type = response.headers.get("Content-Type", "")
    assert content_type.startswith("application/manifest+json")


def test_url_de_lancement_de_l_app_repond(client):
    """Tout ce que l'icône de l'application peut ouvrir doit répondre 200."""
    manifest = json.loads(client.get("/manifest.webmanifest").get_data(as_text=True))

    assert manifest["id"] == "/"
    for url in [manifest["start_url"], *[s["url"] for s in manifest["shortcuts"]]]:
        assert client.get(url).status_code == 200, url
    for icon in manifest["icons"]:
        assert client.get(icon["src"]).status_code == 200, icon["src"]


def test_bottom_nav_present(client):
    response = client.get("/")

    assert response.status_code == 200
    assert b"bottom-nav" in response.data
    assert b"global-player-dock" in response.data


def test_no_auth_routes_exist(client):
    """Verify all auth routes return 404."""
    assert client.get("/signup").status_code == 404
    assert client.get("/login").status_code == 404
    assert client.get("/mot-de-passe-oublie").status_code == 404
    assert client.get("/supprimer-compte").status_code == 404
    assert client.get("/admin").status_code == 404


def test_landing_wall_uses_light_posters(client, monkeypatch):
    """La fresque de l'accueil demande des affiches w185 (≈ 4× moins de Mo)."""
    from app import WALL_IMG_BASE

    assert WALL_IMG_BASE.endswith("/w185")

    def fake_tmdb_get(path, params=None):
        return {
            "results": [
                {
                    "id": index,
                    "vote_average": 7.5,
                    "poster_path": f"/p{index}.jpg",
                    "backdrop_path": f"/b{index}.jpg",
                    "overview": "Synopsis",
                    "original_language": "fr",
                    "title": f"Titre {index}",
                    "name": f"Titre {index}",
                    "release_date": "2026-01-01",
                    "first_air_date": "2026-01-01",
                    "origin_country": ["FR"],
                }
                for index in range(1, 40)
            ]
        }

    monkeypatch.setattr(app_module, "tmdb_get", fake_tmdb_get)
    response = client.get("/")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert "https://image.tmdb.org/t/p/w185/p1.jpg" in html
    assert "/w500/p1.jpg" not in html


def test_landing_page_ne_calcule_plus_de_listes_vitrines(client, monkeypatch):
    """L'accueil ne paie plus 3 appels TMDB pour des listes jamais affichées."""
    from app import render_template as original_render

    seen = {}

    def spy_render(template_name, **context):
        seen.update(context)
        return original_render(template_name, **context)

    monkeypatch.setattr(app_module, "render_template", spy_render)
    response = client.get("/")
    assert response.status_code == 200
    assert "featured_movies" not in seen
    assert "featured_series" not in seen
    assert "featured_animes" not in seen


# ---------------------------------------------------------------------------
# Source MP3 libre (Internet Archive) : recherche, filtres, relais de fichier
# ---------------------------------------------------------------------------


ARCHIVE_SEARCH_ANSWER = {
    "response": {
        "docs": [
            {"identifier": "album-1", "title": "Album Un", "creator": "Artiste"},
            {"identifier": "album-2", "title": "Album Deux", "creator": "Artiste"},
        ]
    }
}

ARCHIVE_META_ANSWER = {
    "metadata": {
        "identifier": "album-1",
        "title": "Album Un",
        "creator": "Artiste",
        "year": "2019",
        "licenseurl": "https://creativecommons.org/licenses/by-nc-sa/4.0/",
    },
    "files": [
        # Piste normale, avec ses métadonnées propres.
        {
            "name": "01 - Premier titre.mp3",
            "format": "VBR MP3",
            "size": "5242880",
            "length": "212",
            "title": "Premier titre",
            "artist": "Artiste",
        },
        # Format mm:ss et piste sans titre : on retombe sur le nom du fichier.
        {
            "name": "02-deuxieme.mp3",
            "format": "128 Kbps MP3",
            "size": "3145728",
            "length": "3:40",
        },
        # Perdu : ce n'est pas un MP3.
        {"name": "cover.jpg", "format": "JPEG", "size": "10000"},
        # Perdu aussi : fichier privé, donc non téléchargeable.
        {
            "name": "03-prive.mp3",
            "format": "VBR MP3",
            "size": "4000000",
            "length": "100",
            "private": "true",
        },
        # Perdu : beaucoup trop gros pour être un morceau.
        {"name": "04-enorme.mp3", "format": "VBR MP3", "size": "90000000"},
    ],
}

ARCHIVE_META_RESTREINT = {
    "metadata": {
        "identifier": "album-2",
        "title": "Album Deux",
        "access-restricted-item": "true",
    },
    "files": [{"name": "01.mp3", "format": "VBR MP3", "size": "1000"}],
}


def patch_archive(monkeypatch, search=ARCHIVE_SEARCH_ANSWER, metas=None, captured=None):
    """Feint Internet Archive : un seul point d'entrée, aucun réseau."""
    metas = metas or {"album-1": ARCHIVE_META_ANSWER, "album-2": ARCHIVE_META_RESTREINT}

    def fake_get(url, params=None, **_kwargs):
        if captured is not None and "advancedsearch" in url:
            captured["url"] = url
            captured["params"] = params
        if "advancedsearch" in url:
            return FakeResponse(search)
        identifier = url.rstrip("/").split("/")[-1]
        return FakeResponse(metas.get(identifier, {"metadata": {}, "files": []}))

    monkeypatch.setattr(app_module.requests, "get", fake_get)


def test_api_mp3_extrait_les_pistes_telechargeables(client, monkeypatch):
    patch_archive(monkeypatch)

    response = client.get("/api/mp3")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["source"] == "archive"

    items = payload["items"]
    # « album-2 » est « access-restricted » : ses pistes ne doivent pas être
    # proposées, sous peine d'afficher un bouton d'enregistrement menteur.
    assert [item["id"] for item in items] == [
        "ia:album-1#01 - Premier titre.mp3",
        "ia:album-1#02-deuxieme.mp3",
    ]
    first = items[0]
    assert first["kind"] == "mp3"
    assert first["type"] == "music"
    assert first["title"] == "Premier titre"
    assert first["channel"] == "Artiste"
    assert first["duration"] == 212
    assert first["size"] == 5242880
    assert first["url"] == "https://archive.org/download/album-1/01%20-%20Premier%20titre.mp3"
    # Le relais même-origin porte le « download=1 » qui force l'enregistrement.
    assert first["download"].startswith("/mp3/album-1/")
    assert first["download"].endswith("download=1")
    assert first["page"] == "https://archive.org/details/album-1"
    assert first["license"].startswith("https://creativecommons.org/")
    # mm:ss converti en secondes, nom de fichier en secours du titre manquant.
    assert items[1]["duration"] == 220
    assert items[1]["title"] == "02-deuxieme"


def test_api_mp3_recherche_sanitisee(client, monkeypatch):
    captured = {}
    patch_archive(monkeypatch, captured=captured)

    client.get('/api/mp3?q=sega" OR all:true (live)')

    query = captured["params"]["q"]
    assert 'all:true' not in query
    assert "(" in query and "sega" in query
    # Les collections choisies sont celles dont on peut garder les fichiers, et
    # elles sont verifiees une par une : « fma » et « live_music_archive » ne
    # renvoyaient plus rien du tout (0 resultat) et faisaient un rayon vide.
    for name in ("etree", "netlabels", "audio_music"):
        assert name in query
    assert "fma" not in query
    assert "live_music_archive" not in query
    assert captured["params"]["sort[]"] == "score desc"


def test_api_mp3_tendances_trient_par_telechargements(client, monkeypatch):
    captured = {}
    patch_archive(monkeypatch, captured=captured)

    client.get("/api/mp3")

    assert captured["params"]["sort[]"] == "downloads desc"
    assert captured["params"]["q"].startswith("mediatype:(audio)")


def test_api_mp3_panne_renvoie_une_erreur_lisible(client, monkeypatch):
    def fake_get(_url, **_kwargs):
        raise requests.ConnectionError("plus de réseau")

    monkeypatch.setattr(app_module.requests, "get", fake_get)

    response = client.get("/api/mp3")

    assert response.status_code == 502
    assert "Internet Archive" in response.get_json()["error"]


def test_mp3_relais_joint_le_nom_du_fichier(client, monkeypatch):
    captured = {}

    def fake_get(url, **kwargs):
        captured["url"] = url
        captured["headers"] = kwargs.get("headers")
        return FakeResponse(
            None,
            headers={
                "Content-Type": "audio/mpeg",
                "Content-Length": "5",
            },
            content=b"MP3DA",
        )

    monkeypatch.setattr(app_module.requests, "get", fake_get)

    response = client.get("/mp3/album-1/01%20-%20Premier%20titre.mp3?download=1")

    assert response.status_code == 200
    assert captured["url"] == "https://archive.org/download/album-1/01%20-%20Premier%20titre.mp3"
    assert response.headers["Content-Type"] == "audio/mpeg"
    assert response.headers["Accept-Ranges"] == "bytes"
    disposition = response.headers["Content-Disposition"]
    assert disposition.startswith("attachment; filename=")
    assert "Premier titre.mp3" in disposition
    assert response.data == b"MP3DA"


def test_mp3_relais_transmet_la_plage(client, monkeypatch):
    captured = {}

    def fake_get(url, **kwargs):
        captured["headers"] = kwargs.get("headers")
        return FakeResponse(
            None,
            status_code=206,
            headers={
                "Content-Type": "audio/mpeg",
                "Content-Length": "3",
                "Content-Range": "bytes 0-2/900",
            },
            content=b"ABC",
        )

    monkeypatch.setattr(app_module.requests, "get", fake_get)

    response = client.get(
        "/mp3/album-1/titre.mp3", headers={"Range": "bytes=0-2"}
    )

    assert captured["headers"]["Range"] == "bytes=0-2"
    assert response.status_code == 206
    assert response.headers["Content-Range"] == "bytes 0-2/900"
    # Sans « download=1 », rien ne force l'enregistrement : la lecture peut
    # utiliser la même adresse, en streaming.
    assert "Content-Disposition" not in response.headers


@pytest.mark.parametrize(
    "path",
    [
        "/mp3/album-1/notaire.txt",
        "/mp3/album-1/titre.mp4",
        "/mp3/..%2F..%2Fetc%2Fpasswd",
        "/mp3/al bum/titre.mp3",
        "/mp3/album-1/",
    ],
)
def test_mp3_relais_refuse_tout_chemin_inattendu(client, path):
    # Aucun de ces chemins ne doit partir en direction d'Internet Archive.
    response = client.get(path)

    assert response.status_code in {400, 404, 405}


def test_mp3_relais_refuse_un_fichier_trop_gros(client, monkeypatch):
    def fake_get(_url, **_kwargs):
        return FakeResponse(
            None,
            headers={"Content-Length": str(90 * 1024 * 1024)},
            content=b"",
        )

    monkeypatch.setattr(app_module.requests, "get", fake_get)

    response = client.get("/mp3/album-1/titre.mp3")

    assert response.status_code == 413


def test_mp3_relais_refuse_un_fichier_disparu(client, monkeypatch):
    def fake_get(_url, **_kwargs):
        return FakeResponse(None, status_code=403, content=b"")

    monkeypatch.setattr(app_module.requests, "get", fake_get)

    response = client.get("/mp3/album-1/titre.mp3")

    assert response.status_code == 502


def test_espace_musique_propose_la_source_mp3(client):
    response = client.get("/musiques")

    assert response.status_code == 200
    assert b'id="source-toggle"' in response.data
    assert b'data-source="mp3"' in response.data
    assert b'data-source="youtube"' in response.data


# ---------------------------------------------------------------------------
# Jamendo : un catalogue moderne de MP3 que les artistes laissent copier
# ---------------------------------------------------------------------------

# Calque sur la reponse reelle de l'API : identifiants en CHAINE, date en
# `releasedate`, licence en `license_ccurl` (en http), aucune taille de fichier,
# et pas de champ `filesize`.
JAMENDO_TRACKS = {
    "headers": {"status": "success", "code": 0, "results_count": 2},
    "results": [
        {
            "id": "125871",
            "name": "Tsikimba Soa",
            "artist_id": "441585",
            "artist_name": "Rija Natural",
            "album_name": "Hira Gasy Electronique",
            "album_id": "145774",
            "duration": 236,
            "releasedate": "2015-04-11",
            "license_ccurl": "http://creativecommons.org/licenses/by-nc-sa/3.0/",
            "image": "http://usercontent.jamendo.com?type=album&id=145774&width=200",
            "audio": "https://prod-1.storage.jamendo.com/?trackid=125871&format=mp32",
            "audiodownload": "https://prod-1.storage.jamendo.com/download/track/125871/mp32/",
            "audiodownload_allowed": True,
            "shorturl": "https://jamen.do/t/125871",
            "shareurl": "https://www.jamendo.com/track/125871",
        },
        {
            # L'artiste a ferme la copie : le bouton ne doit pas exister.
            "id": "999",
            "name": "Interdit de copier",
            "artist_name": "Quelqu'un",
            "duration": 120,
            "license_ccurl": "",
            "audio": "https://prod-1.storage.jamendo.com/?trackid=999&format=mp32",
            "audiodownload": "",
            "audiodownload_allowed": False,
        },
    ],
}


def patch_jamendo(
    monkeypatch, payload=JAMENDO_TRACKS, captured=None, stream=b"MP3DATA"
):
    """Feint a la fois l'API Jamendo et le fichier qu'elle designe."""

    def fake_get(url, params=None, **kwargs):
        if captured is not None:
            captured.setdefault("calls", []).append((url, params, kwargs))
        if "api.jamendo.com" in url:
            wanted = (params or {}).get("id")
            results = payload["results"]
            if wanted:
                # L'API rend des identifiants en chaine ; la route, elle, recoit
                # un entier. On compare les deux sous forme de texte.
                results = [t for t in results if str(t.get("id")) == str(wanted)]
            return FakeResponse({**payload, "results": results})
        return FakeResponse(
            None,
            headers={"Content-Type": "audio/mpeg", "Content-Length": str(len(stream))},
            content=stream,
        )

    monkeypatch.setattr(app_module, "JAMENDO_CLIENT_ID", "cle-de-test")
    monkeypatch.setattr(app_module.requests, "get", fake_get)


def test_jamendo_normalise_les_pistes_dans_le_meme_moule(client, monkeypatch):
    captured = {}
    patch_jamendo(monkeypatch, captured=captured)

    response = client.get("/api/mp3?provider=jamendo&q=rija")

    assert response.status_code == 200
    payload = response.get_json()
    items = payload["items"]
    assert [item["id"] for item in items] == ["jm:125871", "jm:999"]
    first = items[0]
    assert first["kind"] == "mp3"
    assert first["title"] == "Tsikimba Soa"
    assert first["channel"] == "Rija Natural"
    assert first["duration"] == 236
    assert first["year"] == "2015"
    # L'API ne dit pas la taille du fichier : elle reste absente, jamais « 0 Ko ».
    assert first["size"] == 0
    assert first["url"].startswith("https://prod-1.storage.jamendo.com/")
    assert first["download"] == "/mp3/jamendo/125871.mp3?download=1"
    # Une page https ne peut pas charger une image ni une licence en http.
    assert first["thumbnail"].startswith("https://")
    assert first["license"].startswith("https://creativecommons.org/licenses/by-nc-sa")
    assert first["license_name"] == "by-nc-sa 3.0"
    assert first["page"] == "https://www.jamendo.com/track/125871"
    # Le second titre n'a pas le droit d'etre copie : pas de bouton.
    assert items[1]["download"] == ""
    # Qualite explicite : le defaut de l'API est un 96 kbps de lecture seule.
    params = captured["calls"][0][1]
    assert params["audioformat"] == "mp32"
    assert params["audiodlformat"] == "mp32"
    assert params["search"] == "rija"
    # Pas d'include : `stats` ajoute une forme d'onde de plusieurs kilo-octets
    # par piste, et la licence est deja dans la reponse de base.
    assert "include" not in params
    assert "jamendo" in payload["providers"]


def test_jamendo_tendances_ordennees_par_popularite(client, monkeypatch):
    captured = {}
    patch_jamendo(monkeypatch, captured=captured)

    client.get("/api/mp3?provider=jamendo")

    params = captured["calls"][0][1]
    assert params["order"] == "popularity_total"
    # `groupby=artist_id` fait repondre « success » avec zero resultat a l'API :
    # le plafond par artiste est donc applique ici, pas la-bas.
    assert "groupby" not in params


def test_jamendo_rebondit_si_le_classement_ne_rend_rien(client, monkeypatch):
    """L'API repond parfois « success » avec zero resultat selon le classement
    demande : la page doit se remplir quand meme, pas rester vide."""
    seen = []

    def fake_get(url, params=None, **_kwargs):
        seen.append(dict(params or {}))
        empty = {"headers": {"status": "success", "code": 0}, "results": []}
        full = JAMENDO_TRACKS
        return FakeResponse(full if len(seen) > 1 else empty)

    monkeypatch.setattr(app_module, "JAMENDO_CLIENT_ID", "cle-de-test")
    monkeypatch.setattr(app_module.requests, "get", fake_get)

    response = client.get("/api/mp3?provider=jamendo")

    assert response.status_code == 200
    assert response.get_json()["items"], "le deuxieme essai doit remplir la page"
    assert len(seen) >= 2
    assert seen[0].get("order") == "popularity_total"
    assert "order" not in seen[1]


def test_les_tendances_jamendo_ne_sont_pas_un_seul_artiste(client, monkeypatch):
    """Trois pistes du meme artiste dans la reponse : deux maximum dans la page,
    sinon les tendances ne montrent qu'un seul musicien."""
    payload = {
        "headers": {"status": "success", "code": 0},
        "results": [
            {
                "id": str(1000 + index),
                "name": f"Piste {index}",
                "artist_id": "77",
                "artist_name": "Un seul artiste",
                "duration": 100,
                "audio": f"https://prod-1.storage.jamendo.com/?trackid={1000 + index}",
                "audiodownload_allowed": False,
            }
            for index in range(3)
        ],
    }
    patch_jamendo(monkeypatch, payload=payload)

    items = client.get("/api/mp3?provider=jamendo").get_json()["items"]

    assert len(items) == 2
    assert [item["channel"] for item in items] == ["Un seul artiste"] * 2


def test_jamendo_sans_cle_refuse_sans_casser_la_page(client, monkeypatch):
    monkeypatch.setattr(app_module, "JAMENDO_CLIENT_ID", "")

    direct = client.get("/api/mp3?provider=jamendo")
    assert direct.status_code == 503
    assert "JAMENDO_CLIENT_ID" in direct.get_json()["error"]

    patch_archive(monkeypatch)
    auto = client.get("/api/mp3")
    assert auto.status_code == 200
    # Sans cle, le selecteur de fournisseur ne se montre meme pas.
    assert auto.get_json()["providers"] == ["archive"]


def test_jamendo_hors_quota_laisse_parler_archive(client, monkeypatch):
    def fake_get(url, params=None, **_kwargs):
        if "api.jamendo.com" in url:
            return FakeResponse({}, status_code=429)
        if "advancedsearch" in url:
            return FakeResponse(ARCHIVE_SEARCH_ANSWER)
        return FakeResponse(ARCHIVE_META_ANSWER)

    monkeypatch.setattr(app_module, "JAMENDO_CLIENT_ID", "cle-de-test")
    monkeypatch.setattr(app_module.requests, "get", fake_get)

    response = client.get("/api/mp3")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["items"], "le secours Archive doit remplir la page"
    assert "Jamendo" in payload["warning"]


def test_rayon_madagascar_restreint_aux_fonds_musicaux(client, monkeypatch):
    captured = {}
    patch_archive(monkeypatch, captured=captured)

    response = client.get("/api/mp3?shelf=madagascar")

    assert response.status_code == 200
    query = captured["params"]["q"]
    for term in ("madagascar", "malagasy", "salegy", "hira gasy"):
        assert term in query
    # Pas de plein texte : il faisait remonter des livres audio a la place.
    assert "text:" not in query
    for name in ("etree", "audio_music", "netlabels"):
        assert name in query


def test_rayon_inconnu_retombe_sans_se_plaindre(client, monkeypatch):
    captured = {}
    patch_archive(monkeypatch, captured=captured)

    response = client.get("/api/mp3?shelf=et-qu_si-ca-n-existe-pas")

    assert response.status_code == 200
    assert "madagascar" not in captured["params"]["q"]


def test_shelves_exposes_a_l_interface(client, monkeypatch):
    patch_archive(monkeypatch)

    payload = client.get("/api/mp3").get_json()

    keys = [shelf["key"] for shelf in payload["shelves"]]
    assert keys[0] == "tout"
    assert "madagascar" in keys
    assert all(shelf["label"] for shelf in payload["shelves"])


def test_relais_jamendo_impose_le_nom_du_morceau(client, monkeypatch):
    captured = {}
    patch_jamendo(monkeypatch, captured=captured)

    response = client.get("/mp3/jamendo/125871.mp3?download=1")

    assert response.status_code == 200
    assert response.headers["Content-Type"] == "audio/mpeg"
    assert "Tsikimba Soa" in response.headers["Content-Disposition"]
    # L'URL de telechargement Jamendo expire : elle est resolue a la demande.
    stream_call = captured["calls"][-1][0]
    assert stream_call == (
        "https://prod-1.storage.jamendo.com/download/track/125871/mp32/"
    )
    assert response.data == b"MP3DATA"


def test_relais_jamendo_refuse_un_titre_non_copiable(client, monkeypatch):
    patch_jamendo(monkeypatch)

    response = client.get("/mp3/jamendo/999.mp3?download=1")

    assert response.status_code == 410
    assert "téléchargement libre" in response.get_data(as_text=True)


def test_un_rayon_jamendo_ne_se_substitue_pas_aux_tendances(client, monkeypatch):
    """Sous le libellé « Madagascar », répondre les tendances générales serait un
    mensonge. Si Jamendo n'a rien pour ce rayon, la page doit rester vide de ce
    côté-là — et c'est Internet Archive qui la remplira."""
    seen = []

    def fake_get(url, params=None, **_kwargs):
        seen.append(dict(params or {}))
        vide = {"headers": {"status": "success", "code": 0}, "results": []}
        return FakeResponse(vide)

    monkeypatch.setattr(app_module, "JAMENDO_CLIENT_ID", "cle-de-test")
    monkeypatch.setattr(app_module.requests, "get", fake_get)

    response = client.get("/api/mp3?provider=jamendo&shelf=madagascar")

    assert response.status_code == 200
    assert response.get_json()["items"] == []
    # Un seul essai, borné par le rayon : pas de repli « sans filtre ».
    assert len(seen) == 1
    assert seen[0]["search"] == "madagascar"
    assert "order" not in seen[0]
