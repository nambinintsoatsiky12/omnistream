"""Persistance des comptes et des statistiques OmniStream.

Turso est utilisé lorsque ``TURSO_DATABASE_URL`` et ``TURSO_AUTH_TOKEN`` sont
tous les deux configurés. En local, le module utilise automatiquement SQLite
(``users.db`` par défaut), ce qui permet de démarrer le projet sans service
externe.
"""

from __future__ import annotations

import datetime as dt
import os
import secrets
import sqlite3
import threading
from pathlib import Path
from typing import Any

import requests

_raw_url = os.environ.get("TURSO_DATABASE_URL", "").strip()
TURSO_AUTH_TOKEN = os.environ.get("TURSO_AUTH_TOKEN", "").strip()
if bool(_raw_url) != bool(TURSO_AUTH_TOKEN):
    raise RuntimeError(
        "TURSO_DATABASE_URL et TURSO_AUTH_TOKEN doivent être configurés ensemble."
    )

if _raw_url.startswith("libsql://"):
    TURSO_HTTP_URL = f"https://{_raw_url.removeprefix('libsql://')}".rstrip("/")
elif _raw_url.startswith("https://") or not _raw_url:
    TURSO_HTTP_URL = _raw_url.rstrip("/")
else:
    raise RuntimeError("TURSO_DATABASE_URL doit utiliser le protocole libsql ou https.")
USE_TURSO = bool(TURSO_HTTP_URL and TURSO_AUTH_TOKEN)
SQLITE_PATH = Path(
    os.environ.get("DATABASE_PATH", Path(__file__).with_name("users.db"))
).expanduser()

_sqlite_lock = threading.RLock()


class DatabaseError(RuntimeError):
    """Erreur de communication ou d'exécution sur la base de données."""


class DuplicateEmailError(DatabaseError):
    """L'adresse e-mail est déjà utilisée."""


def _utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _to_hrana_value(value: Any) -> dict[str, Any]:
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "integer", "value": str(int(value))}
    if isinstance(value, int):
        return {"type": "integer", "value": str(value)}
    if isinstance(value, float):
        return {"type": "float", "value": value}
    return {"type": "text", "value": str(value)}


def _from_hrana_value(cell: dict[str, Any]) -> Any:
    value_type = cell.get("type")
    value = cell.get("value")
    if value_type == "null":
        return None
    if value_type == "integer":
        return int(value)
    if value_type == "float":
        return float(value)
    return value


def _execute_turso(sql: str, args: list[Any]) -> list[dict[str, Any]]:
    payload = {
        "requests": [
            {
                "type": "execute",
                "stmt": {
                    "sql": sql,
                    "args": [_to_hrana_value(value) for value in args],
                },
            },
            {"type": "close"},
        ]
    }
    headers = {
        "Authorization": f"Bearer {TURSO_AUTH_TOKEN}",
        "Content-Type": "application/json",
    }

    try:
        response = requests.post(
            f"{TURSO_HTTP_URL}/v2/pipeline",
            json=payload,
            headers=headers,
            timeout=15,
        )
        response.raise_for_status()
        data = response.json()
        result = data["results"][0]
    except (
        requests.RequestException,
        ValueError,
        KeyError,
        IndexError,
        TypeError,
    ) as exc:
        raise DatabaseError("Impossible de communiquer avec la base Turso.") from exc

    if not isinstance(result, dict):
        raise DatabaseError("Réponse Turso invalide.")
    if result.get("type") == "error":
        error = result.get("error") or {}
        message = (
            error.get("message", str(error)) if isinstance(error, dict) else str(error)
        )
        if "unique constraint failed: users.email" in message.lower():
            raise DuplicateEmailError("Cette adresse e-mail est déjà utilisée.")
        raise DatabaseError(f"Erreur Turso : {message}")

    try:
        execution = result["response"]["result"]
        columns = [column["name"] for column in execution.get("cols", [])]
        return [
            {
                columns[index]: _from_hrana_value(cell)
                for index, cell in enumerate(raw_row)
            }
            for raw_row in execution.get("rows", [])
        ]
    except (AttributeError, KeyError, TypeError, IndexError, ValueError) as exc:
        raise DatabaseError("Réponse Turso invalide.") from exc


def _execute_sqlite(sql: str, args: list[Any]) -> list[dict[str, Any]]:
    try:
        SQLITE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with _sqlite_lock, sqlite3.connect(SQLITE_PATH, timeout=15) as connection:
            connection.row_factory = sqlite3.Row
            cursor = connection.execute(sql, args)
            rows = (
                [dict(row) for row in cursor.fetchall()] if cursor.description else []
            )
            connection.commit()
            return rows
    except sqlite3.IntegrityError as exc:
        if "unique constraint failed: users.email" in str(exc).lower():
            raise DuplicateEmailError(
                "Cette adresse e-mail est déjà utilisée."
            ) from exc
        raise DatabaseError("Contrainte de base de données non respectée.") from exc
    except sqlite3.Error as exc:
        raise DatabaseError("Impossible d'accéder à la base SQLite locale.") from exc


def _execute(sql: str, args: list[Any] | None = None) -> list[dict[str, Any]]:
    """Exécute une requête et renvoie les lignes sous forme de dictionnaires."""

    values = list(args or [])
    if USE_TURSO:
        return _execute_turso(sql, values)
    return _execute_sqlite(sql, values)


def _ensure_column(table: str, column: str, definition: str) -> None:
    columns = _execute(f"PRAGMA table_info({table})")
    if any(row.get("name") == column for row in columns):
        return
    try:
        _execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
    except DatabaseError:
        # Deux workers peuvent tenter la même migration au même instant.
        columns = _execute(f"PRAGMA table_info({table})")
        if not any(row.get("name") == column for row in columns):
            raise


def init_db() -> None:
    _execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            first_name TEXT NOT NULL,
            last_name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            verified INTEGER NOT NULL DEFAULT 0,
            verify_token TEXT,
            verify_token_expiry TEXT,
            reset_token TEXT,
            reset_token_expiry TEXT,
            session_version INTEGER NOT NULL DEFAULT 0,
            privacy_accepted_at TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    # Migration transparente des bases créées par une ancienne version.
    _ensure_column("users", "verify_token_expiry", "TEXT")
    _ensure_column("users", "reset_token", "TEXT")
    _ensure_column("users", "reset_token_expiry", "TEXT")
    _ensure_column("users", "session_version", "INTEGER NOT NULL DEFAULT 0")

    _execute(
        """
        CREATE TABLE IF NOT EXISTS daily_visits (
            date TEXT PRIMARY KEY,
            count INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    _execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS users_verify_token_idx "
        "ON users(verify_token) WHERE verify_token IS NOT NULL"
    )
    _execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS users_reset_token_idx "
        "ON users(reset_token) WHERE reset_token IS NOT NULL"
    )


def create_user(
    first_name: str, last_name: str, email: str, password_hash: str
) -> str | None:
    email = email.lower().strip()
    token = secrets.token_urlsafe(32)
    now = _utc_now()
    expiry = now + dt.timedelta(hours=24)

    try:
        _execute(
            """
            INSERT INTO users (
                first_name, last_name, email, password_hash, verified,
                verify_token, verify_token_expiry, privacy_accepted_at, created_at
            ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
            """,
            [
                first_name.strip(),
                last_name.strip(),
                email,
                password_hash,
                token,
                expiry.isoformat(),
                now.isoformat(),
                now.isoformat(),
            ],
        )
    except DuplicateEmailError:
        return None
    return token


def get_user_by_email(email: str) -> dict[str, Any] | None:
    rows = _execute("SELECT * FROM users WHERE email = ?", [email.lower().strip()])
    return rows[0] if rows else None


def get_user_by_id(user_id: int) -> dict[str, Any] | None:
    rows = _execute("SELECT * FROM users WHERE id = ?", [user_id])
    return rows[0] if rows else None


def refresh_verification_token(user_id: int) -> str | None:
    user = get_user_by_id(user_id)
    if not user or user["verified"]:
        return None
    if user.get("verify_token") and not _expiry_has_passed(
        user.get("verify_token_expiry")
    ):
        return str(user["verify_token"])
    token = secrets.token_urlsafe(32)
    expiry = (_utc_now() + dt.timedelta(hours=24)).isoformat()
    _execute(
        "UPDATE users SET verify_token = ?, verify_token_expiry = ? WHERE id = ?",
        [token, expiry, user_id],
    )
    return token


def _expiry_has_passed(value: str | None) -> bool:
    # Un jeton sans date (donnée ancienne ou corrompue) ne doit jamais rester
    # valable indéfiniment.
    if not value:
        return True
    try:
        expiry = dt.datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return True
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=dt.timezone.utc)
    return _utc_now() > expiry


def verify_user_by_token(token: str) -> bool:
    if not token:
        return False
    rows = _execute("SELECT * FROM users WHERE verify_token = ?", [token])
    if not rows:
        return False
    user = rows[0]
    if _expiry_has_passed(user.get("verify_token_expiry")):
        _execute(
            "UPDATE users SET verify_token = NULL, verify_token_expiry = NULL "
            "WHERE id = ? AND verify_token = ?",
            [user["id"], token],
        )
        return False
    updated = _execute(
        """
        UPDATE users
        SET verified = 1, verify_token = NULL, verify_token_expiry = NULL
        WHERE id = ? AND verify_token = ?
        RETURNING id
        """,
        [user["id"], token],
    )
    return bool(updated)


def delete_user(user_id: int) -> None:
    _execute("DELETE FROM users WHERE id = ?", [user_id])


def count_users() -> int:
    rows = _execute("SELECT COUNT(*) AS c FROM users WHERE verified = 1")
    return int(rows[0]["c"]) if rows else 0


def get_all_users() -> list[dict[str, Any]]:
    return _execute(
        "SELECT id, first_name, last_name, email, verified, created_at "
        "FROM users ORDER BY created_at DESC"
    )


def increment_and_get_visit_counter() -> int:
    today = _utc_now().date().isoformat()
    _execute(
        "INSERT INTO daily_visits (date, count) VALUES (?, 1) "
        "ON CONFLICT(date) DO UPDATE SET count = count + 1",
        [today],
    )
    return get_total_visits()


def get_total_visits() -> int:
    rows = _execute("SELECT COALESCE(SUM(count), 0) AS total FROM daily_visits")
    return int(rows[0]["total"]) if rows else 0


def _calendar_series(rows, date_key: str, days: int) -> list[dict[str, Any]]:
    counts = {str(row[date_key]): int(row["count"]) for row in rows}
    first_day = _utc_now().date() - dt.timedelta(days=days - 1)
    return [
        {
            date_key: (first_day + dt.timedelta(days=offset)).isoformat(),
            "count": counts.get((first_day + dt.timedelta(days=offset)).isoformat(), 0),
        }
        for offset in range(days)
    ]


def get_daily_visits(days: int = 30) -> list[dict[str, Any]]:
    days = min(max(int(days), 1), 365)
    first_day = (_utc_now().date() - dt.timedelta(days=days - 1)).isoformat()
    rows = _execute(
        "SELECT date, count FROM daily_visits WHERE date >= ? ORDER BY date",
        [first_day],
    )
    return _calendar_series(rows, "date", days)


def get_signups_per_day(days: int = 30) -> list[dict[str, Any]]:
    days = min(max(int(days), 1), 365)
    first_day = (_utc_now().date() - dt.timedelta(days=days - 1)).isoformat()
    rows = _execute(
        "SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count "
        "FROM users WHERE substr(created_at, 1, 10) >= ? "
        "GROUP BY day ORDER BY day",
        [first_day],
    )
    return _calendar_series(rows, "day", days)


def create_password_reset_token(email: str) -> str | None:
    email = email.lower().strip()
    if not get_user_by_email(email):
        return None
    token = secrets.token_urlsafe(32)
    expiry = (_utc_now() + dt.timedelta(hours=1)).isoformat()
    _execute(
        "UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE email = ?",
        [token, expiry, email],
    )
    return token


def get_user_by_reset_token(token: str) -> dict[str, Any] | None:
    if not token:
        return None
    rows = _execute("SELECT * FROM users WHERE reset_token = ?", [token])
    if not rows:
        return None
    user = rows[0]
    if _expiry_has_passed(user.get("reset_token_expiry")):
        _execute(
            "UPDATE users SET reset_token = NULL, reset_token_expiry = NULL "
            "WHERE id = ? AND reset_token = ?",
            [user["id"], token],
        )
        return None
    return user


def consume_password_reset_token(
    user_id: int, token: str, new_password_hash: str
) -> bool:
    updated = _execute(
        """
        UPDATE users
        SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL,
            session_version = session_version + 1
        WHERE id = ? AND reset_token = ?
        RETURNING id
        """,
        [new_password_hash, user_id, token],
    )
    return bool(updated)


def update_password_and_clear_token(user_id: int, new_password_hash: str) -> None:
    _execute(
        """
        UPDATE users
        SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL,
            session_version = session_version + 1
        WHERE id = ?
        """,
        [new_password_hash, user_id],
    )
