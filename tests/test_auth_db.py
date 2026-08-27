import datetime as dt

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


def test_visit_counter_is_atomic_at_sql_level(client):
    assert auth_db.increment_and_get_visit_counter() == 1
    assert auth_db.increment_and_get_visit_counter() == 2
    assert auth_db.get_total_visits() == 2
    series = auth_db.get_daily_visits(30)
    assert len(series) == 30
    assert series[-1]["count"] == 2
    assert sum(point["count"] for point in series) == 2


def test_init_db_creates_daily_visits_table(tmp_path, monkeypatch):
    database = tmp_path / "fresh.db"
    monkeypatch.setattr(auth_db, "USE_TURSO", False)
    monkeypatch.setattr(auth_db, "SQLITE_PATH", database)

    auth_db.init_db()

    columns = {
        row["name"]
        for row in auth_db._execute("PRAGMA table_info(daily_visits)")
    }
    assert {"date", "count"} <= columns


def test_turso_response_is_converted_to_python_values(monkeypatch):
    response = FakeTursoResponse(
        {
            "results": [
                {
                    "type": "ok",
                    "response": {
                        "result": {
                            "cols": [{"name": "total"}],
                            "rows": [
                                [
                                    {"type": "integer", "value": "42"},
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
    monkeypatch.setattr(
        auth_db.requests, "post", lambda *_args, **_kwargs: response
    )

    rows = auth_db._execute_turso(
        "SELECT COALESCE(SUM(count), 0) AS total FROM daily_visits", []
    )

    assert rows == [{"total": 42}]


def test_daily_visits_series_returns_correct_length(client):
    auth_db.increment_and_get_visit_counter()
    series = auth_db.get_daily_visits(7)
    assert len(series) == 7
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    today_entry = next(e for e in series if e["date"] == today)
    assert today_entry["count"] == 1
