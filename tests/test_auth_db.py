import datetime as dt
import sqlite3

import pytest
import requests

import auth_db


class FakeTursoResponse:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"HTTP {self.status_code}")

    def json(self):
        return self.payload


def test_create_user_normalizes_email_and_rejects_duplicates(client):
    first_token = auth_db.create_user(
        " Alice ", " Martin ", "ALICE@Example.COM ", "hash"
    )
    duplicate_token = auth_db.create_user(
        "Autre", "Personne", "alice@example.com", "hash-2"
    )

    user = auth_db.get_user_by_email("alice@example.com")
    assert first_token
    assert duplicate_token is None
    assert user["first_name"] == "Alice"
    assert user["email"] == "alice@example.com"


def test_verification_token_is_single_use(client):
    token = auth_db.create_user("Alice", "Martin", "alice@example.com", "hash")

    assert auth_db.verify_user_by_token(token) is True
    assert auth_db.verify_user_by_token(token) is False
    assert auth_db.get_user_by_email("alice@example.com")["verified"] == 1


def test_expired_verification_token_is_rejected_and_can_be_refreshed(client):
    token = auth_db.create_user("Alice", "Martin", "alice@example.com", "hash")
    user = auth_db.get_user_by_email("alice@example.com")
    auth_db._execute(
        "UPDATE users SET verify_token_expiry = ? WHERE id = ?",
        [
            (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=1)).isoformat(),
            user["id"],
        ],
    )

    assert auth_db.verify_user_by_token(token) is False
    replacement = auth_db.refresh_verification_token(user["id"])
    assert replacement
    assert replacement != token
    assert auth_db.verify_user_by_token(replacement) is True


def test_reset_token_without_expiry_is_rejected(client):
    auth_db.create_user("Alice", "Martin", "alice@example.com", "hash")
    user = auth_db.get_user_by_email("alice@example.com")
    auth_db._execute(
        "UPDATE users SET reset_token = ?, reset_token_expiry = NULL WHERE id = ?",
        ["legacy-token", user["id"]],
    )

    assert auth_db.get_user_by_reset_token("legacy-token") is None


def test_password_reset_token_expires_and_is_cleared(client):
    auth_db.create_user("Alice", "Martin", "alice@example.com", "hash")
    token = auth_db.create_password_reset_token("alice@example.com")
    user = auth_db.get_user_by_email("alice@example.com")
    auth_db._execute(
        "UPDATE users SET reset_token_expiry = ? WHERE id = ?",
        [
            (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=1)).isoformat(),
            user["id"],
        ],
    )

    assert auth_db.get_user_by_reset_token(token) is None
    refreshed = auth_db.get_user_by_email("alice@example.com")
    assert refreshed["reset_token"] is None
    assert refreshed["reset_token_expiry"] is None


def test_password_update_consumes_reset_token(client):
    auth_db.create_user("Alice", "Martin", "alice@example.com", "old-hash")
    token = auth_db.create_password_reset_token("alice@example.com")
    user = auth_db.get_user_by_reset_token(token)

    assert auth_db.consume_password_reset_token(user["id"], token, "new-hash") is True
    assert (
        auth_db.consume_password_reset_token(user["id"], token, "other-hash") is False
    )

    updated = auth_db.get_user_by_email("alice@example.com")
    assert updated["password_hash"] == "new-hash"
    assert updated["session_version"] == 1
    assert auth_db.get_user_by_reset_token(token) is None


def test_visit_counter_is_atomic_at_sql_level(client):
    assert auth_db.increment_and_get_visit_counter() == 1
    assert auth_db.increment_and_get_visit_counter() == 2
    assert auth_db.get_total_visits() == 2
    series = auth_db.get_daily_visits(30)
    assert len(series) == 30
    assert series[-1]["count"] == 2
    assert sum(point["count"] for point in series) == 2


def test_init_db_migrates_legacy_sqlite_schema(tmp_path, monkeypatch):
    database = tmp_path / "legacy.db"
    with sqlite3.connect(database) as connection:
        connection.execute(
            """
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                first_name TEXT NOT NULL,
                last_name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                verified INTEGER NOT NULL DEFAULT 0,
                verify_token TEXT,
                privacy_accepted_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
    monkeypatch.setattr(auth_db, "USE_TURSO", False)
    monkeypatch.setattr(auth_db, "SQLITE_PATH", database)

    auth_db.init_db()

    columns = {row["name"] for row in auth_db._execute("PRAGMA table_info(users)")}
    assert {
        "verify_token_expiry",
        "reset_token",
        "reset_token_expiry",
        "session_version",
    } <= columns


def test_turso_response_is_converted_to_python_values(monkeypatch):
    response = FakeTursoResponse(
        {
            "results": [
                {
                    "type": "ok",
                    "response": {
                        "result": {
                            "cols": [{"name": "id"}, {"name": "email"}],
                            "rows": [
                                [
                                    {"type": "integer", "value": "7"},
                                    {"type": "text", "value": "alice@example.com"},
                                ]
                            ],
                        }
                    },
                }
            ]
        }
    )
    monkeypatch.setattr(auth_db, "TURSO_HTTP_URL", "https://db.example")
    monkeypatch.setattr(auth_db, "TURSO_AUTH_TOKEN", "token")
    monkeypatch.setattr(auth_db.requests, "post", lambda *_args, **_kwargs: response)

    rows = auth_db._execute_turso("SELECT id, email FROM users", [])

    assert rows == [{"id": 7, "email": "alice@example.com"}]


def test_turso_duplicate_email_has_specific_error(monkeypatch):
    response = FakeTursoResponse(
        {
            "results": [
                {
                    "type": "error",
                    "error": {
                        "message": "SQLite error: UNIQUE constraint failed: users.email"
                    },
                }
            ]
        }
    )
    monkeypatch.setattr(auth_db, "TURSO_HTTP_URL", "https://db.example")
    monkeypatch.setattr(auth_db, "TURSO_AUTH_TOKEN", "token")
    monkeypatch.setattr(auth_db.requests, "post", lambda *_args, **_kwargs: response)

    with pytest.raises(auth_db.DuplicateEmailError):
        auth_db._execute_turso("INSERT", [])
