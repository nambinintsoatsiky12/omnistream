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
