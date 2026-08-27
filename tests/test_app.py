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

    def iter_content(self, _chunk_size):
        yield self.content

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
    # Mode Audio : iframe cachée en 1px + barre de lecteur
    assert b"audio-hidden-frame" in response.data
    assert b"audio-bar" in response.data
    # Mode Vidéo : overlay vrai plein écran
    assert b"video-overlay" in response.data
    assert b"video-fullscreen-frame" in response.data


def test_privacy_page_loads(client):
    response = client.get("/confidentialite")

    assert response.status_code == 200
    assert b"Confidentialit\xc3\xa9" in response.data


def test_no_auth_routes_exist(client):
    """Verify all auth routes return 404."""
    assert client.get("/signup").status_code == 404
    assert client.get("/login").status_code == 404
    assert client.get("/mot-de-passe-oublie").status_code == 404
    assert client.get("/supprimer-compte").status_code == 404
    assert client.get("/admin").status_code == 404
