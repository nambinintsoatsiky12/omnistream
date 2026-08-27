from urllib.parse import parse_qs, urlsplit

import pytest
import requests
from conftest import authenticate, create_verified_user, csrf_token

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
    assert b"Tout ce que vous regardez" in response.data
    assert b"nap5k.com" not in response.data
    assert b"3nbf4.com" not in response.data
    assert b'id="sponsor-gift"' in response.data
    assert app_module.SPONSOR_SMARTLINK_URL.encode() in response.data
    assert auth_db.get_total_visits() == 1
    assert client.head("/").status_code == 200
    assert auth_db.get_total_visits() == 1


def test_non_landing_pages_do_not_receive_landing_header(client):
    response = client.get("/login")

    assert response.status_code == 200
    assert b'<body class="body-landing">' not in response.data
    assert b"topbar-landing" not in response.data
    assert b"nap5k.com" not in response.data
    assert b'id="sponsor-gift"' not in response.data


def test_sponsor_gift_remains_a_voluntary_link_for_authenticated_users(client):
    user = create_verified_user()
    authenticate(client, user)

    response = client.get("/?tab=films")

    assert response.status_code == 200
    assert b"nap5k.com" not in response.data
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


def test_csrf_is_required_for_form_posts(client):
    client.get("/login")

    response = client.post(
        "/login", data={"email": "alice@example.com", "password": "incorrect"}
    )

    assert response.status_code == 400
    assert b"Jeton de s\xc3\xa9curit\xc3\xa9 invalide" in response.data


def test_signup_mail_failure_does_not_leave_locked_account(client, monkeypatch):
    monkeypatch.setattr(app_module, "send_verification_email", lambda *_args: False)
    token = csrf_token(client, "/signup")

    response = client.post(
        "/signup",
        data={
            "csrf_token": token,
            "first_name": "Alice",
            "last_name": "Martin",
            "email": "ALICE@example.com",
            "password": "mot-de-passe-solide",
            "accept_privacy": "on",
        },
    )

    assert response.status_code == 200
    assert b"n&#39;a pas pu \xc3\xaatre envoy\xc3\xa9" in response.data
    assert auth_db.get_user_by_email("alice@example.com") is None


def test_signup_verification_and_login_restore_requested_page(client, monkeypatch):
    sent = {}

    def capture_email(email, url, first_name):
        sent.update(email=email, url=url, first_name=first_name)
        return True

    monkeypatch.setattr(app_module, "send_verification_email", capture_email)
    token = csrf_token(client, "/signup")
    signup_response = client.post(
        "/signup",
        data={
            "csrf_token": token,
            "first_name": "Alice",
            "last_name": "Martin",
            "email": "alice@example.com",
            "password": "mot-de-passe-solide",
            "accept_privacy": "on",
        },
    )
    assert signup_response.status_code == 200
    assert sent["email"] == "alice@example.com"

    verification_path = urlsplit(sent["url"]).path
    verification_response = client.get(verification_path)
    assert verification_response.status_code == 200
    assert b"confirm\xc3\xa9 avec succ\xc3\xa8s" in verification_response.data

    login_token = csrf_token(client, "/login?next=/details/movie/42?tab=films")
    login_response = client.post(
        "/login",
        data={
            "csrf_token": login_token,
            "email": "alice@example.com",
            "password": "mot-de-passe-solide",
            "next": "/details/movie/42?tab=films",
        },
    )
    assert login_response.status_code == 302
    assert login_response.headers["Location"] == "/details/movie/42?tab=films"


def test_password_reset_route_consumes_token(client):
    user = create_verified_user()
    token = auth_db.create_password_reset_token(user["email"])
    path = f"/reinitialiser-mot-de-passe/{token}"
    csrf = csrf_token(client, path)

    response = client.post(
        path,
        data={
            "csrf_token": csrf,
            "password": "nouveau-mot-de-passe",
            "password_confirm": "nouveau-mot-de-passe",
        },
    )

    assert response.status_code == 200
    assert b"chang\xc3\xa9 avec succ\xc3\xa8s" in response.data
    assert client.get(path).status_code == 200
    assert b"invalide ou a expir\xc3\xa9" in client.get(path).data


def test_login_rejects_external_next_url(client):
    create_verified_user()
    token = csrf_token(client, "/login")

    response = client.post(
        "/login",
        data={
            "csrf_token": token,
            "email": "alice@example.com",
            "password": "mot-de-passe-solide",
            "next": "https://evil.example/vol",
        },
    )

    assert response.status_code == 302
    assert response.headers["Location"] == "/?tab=films"


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
    not_found = client.get("/api/inconnue")
    user = create_verified_user()
    token = authenticate(client, user)
    monkeypatch.setattr(app_module, "GEMINI_API_KEY", "test-key")
    oversized = client.post(
        "/api/chat",
        data=b"x" * (app_module.app.config["MAX_CONTENT_LENGTH"] + 1),
        headers={"Content-Type": "application/json", "X-CSRF-Token": token},
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


def test_details_requires_login_and_preserves_destination(client):
    response = client.get("/details/movie/42?tab=films")

    assert response.status_code == 302
    parsed = urlsplit(response.headers["Location"])
    assert parsed.path == "/login"
    assert parse_qs(parsed.query)["next"] == ["/details/movie/42?tab=films"]


def test_details_handles_missing_poster_and_malformed_runtime(client, monkeypatch):
    user = create_verified_user()
    authenticate(client, user)
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
    assert b"onclick=" not in response.data
    assert response.data.count(app_module.SPONSOR_SMARTLINK_URL.encode()) == 1


def test_password_change_invalidates_existing_sessions(client):
    user = create_verified_user()
    authenticate(client, user)
    auth_db.update_password_and_clear_token(
        user["id"], app_module.generate_password_hash("nouveau-mot-de-passe")
    )

    response = client.get("/api/mangadex_proxy?endpoint=/manga")

    assert response.status_code == 401
    with client.session_transaction() as current_session:
        assert "user_id" not in current_session


def test_chat_requires_authentication(client):
    response = client.post("/api/chat", json={})

    assert response.status_code == 401
    assert response.get_json()["error"] == "Authentification requise."


def test_chat_validates_payload_and_csrf(client, monkeypatch):
    user = create_verified_user()
    token = authenticate(client, user)
    monkeypatch.setattr(app_module, "GEMINI_API_KEY", "test-key")

    without_csrf = client.post("/api/chat", json={})
    malformed = client.post(
        "/api/chat", json={"title": "Film"}, headers={"X-CSRF-Token": token}
    )

    assert without_csrf.status_code == 400
    assert malformed.status_code == 400
    assert malformed.is_json


def test_chat_collects_all_gemini_text_parts(client, monkeypatch):
    user = create_verified_user()
    token = authenticate(client, user)
    monkeypatch.setattr(app_module, "GEMINI_API_KEY", "test-key")
    captured = {}

    def fake_post(_url, **kwargs):
        captured.update(kwargs)
        return FakeResponse(
            {
                "candidates": [
                    {
                        "content": {
                            "parts": [{"text": "Bonjour "}, {"text": "cinéphile !"}]
                        }
                    }
                ]
            }
        )

    monkeypatch.setattr(app_module.requests, "post", fake_post)
    response = client.post(
        "/api/chat",
        headers={"X-CSRF-Token": token},
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


def test_reader_serializes_title_as_safe_javascript(client):
    user = create_verified_user()
    authenticate(client, user)

    response = client.get(
        "/lecteur-scan", query_string={"titre": "</script><script>alert(1)</script>"}
    )

    assert response.status_code == 200
    assert b"\\u003c/script\\u003e" in response.data
    assert b"<script>alert(1)</script>" not in response.data


def test_mangadex_proxy_rejects_arbitrary_endpoint(client):
    user = create_verified_user()
    authenticate(client, user)

    response = client.get("/api/mangadex_proxy?endpoint=/user")

    assert response.status_code == 400
    assert response.is_json


def test_mangadex_proxy_preserves_repeated_parameters(client, monkeypatch):
    user = create_verified_user()
    authenticate(client, user)
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
    user = create_verified_user()
    authenticate(client, user)

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
