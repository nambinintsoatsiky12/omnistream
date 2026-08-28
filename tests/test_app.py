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
    response = client.get(
        "/lecteur-scan", query_string={"titre": "</script><script>alert(1)</script>"}
    )

    assert response.status_code == 200
    assert b"\\u003c/script\\u003e" in response.data
    assert b"<script>alert(1)</script>" not in response.data


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
    # Les collections choisies sont celles dont on peut garder les fichiers.
    for name in ("etree", "netlabels", "audio_music", "fma"):
        assert name in query
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
