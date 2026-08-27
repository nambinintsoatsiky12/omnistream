from pathlib import Path

import pytest

import app as app_module
import auth_db


@pytest.fixture()
def client(tmp_path, monkeypatch):
    database_path = Path(tmp_path) / "test-users.db"
    monkeypatch.setattr(auth_db, "USE_TURSO", False)
    monkeypatch.setattr(auth_db, "SQLITE_PATH", database_path)
    auth_db.init_db()
    app_module._cache.clear()
    app_module.app.config.update(
        TESTING=True,
        SESSION_COOKIE_SECURE=False,
    )
    with app_module.app.test_client() as test_client:
        yield test_client


def csrf_token(client, path="/login"):
    client.get(path)
    with client.session_transaction() as current_session:
        return current_session["_csrf_token"]


def create_verified_user(
    email="alice@example.com", password="mot-de-passe-solide", first_name="Alice"
):
    password_hash = app_module.generate_password_hash(password)
    token = auth_db.create_user(first_name, "Martin", email, password_hash)
    assert token
    assert auth_db.verify_user_by_token(token)
    return auth_db.get_user_by_email(email)


def authenticate(client, user):
    csrf_token(client)
    with client.session_transaction() as current_session:
        current_session["user_id"] = user["id"]
        current_session["user_email"] = user["email"]
        current_session["user_first_name"] = user["first_name"]
        current_session["session_version"] = int(user.get("session_version") or 0)
        return current_session["_csrf_token"]
