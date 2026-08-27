"""Persistance des statistiques de visites OmniStream.

Turso est utilisé lorsque ``TURSO_DATABASE_URL`` et ``TURSO_AUTH_TOKEN`` sont
tous les deux configurés. En local, le module utilise automatiquement SQLite
(``users.db`` par défaut), ce qui permet de démarrer le projet sans service
externe.
"""

from __future__ import annotations

import datetime as dt
import os
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
        raise DatabaseError("Contrainte de base de données non respectée.") from exc
    except sqlite3.Error as exc:
        raise DatabaseError("Impossible d'accéder à la base SQLite locale.") from exc


def _execute(sql: str, args: list[Any] | None = None) -> list[dict[str, Any]]:
    """Exécute une requête et renvoie les lignes sous forme de dictionnaires."""
    values = list(args or [])
    if USE_TURSO:
        return _execute_turso(sql, values)
    return _execute_sqlite(sql, values)


def init_db() -> None:
    _execute(
        """
        CREATE TABLE IF NOT EXISTS daily_visits (
            date TEXT PRIMARY KEY,
            count INTEGER NOT NULL DEFAULT 0
        )
        """
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


def get_daily_visits(days: int = 30) -> list[dict[str, Any]]:
    days = min(max(int(days), 1), 365)
    first_day = (_utc_now().date() - dt.timedelta(days=days - 1)).isoformat()
    rows = _execute(
        "SELECT date, count FROM daily_visits WHERE date >= ? ORDER BY date",
        [first_day],
    )
    counts = {str(row["date"]): int(row["count"]) for row in rows}
    first = _utc_now().date() - dt.timedelta(days=days - 1)
    return [
        {
            "date": (first + dt.timedelta(days=offset)).isoformat(),
            "count": counts.get((first + dt.timedelta(days=offset)).isoformat(), 0),
        }
        for offset in range(days)
    ]
