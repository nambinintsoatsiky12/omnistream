"""
Gestion des comptes utilisateurs et des statistiques du site, connectée à
Turso via son API HTTP directe (au lieu de la librairie libsql-client qui
a un bug de connexion WebSocket sur certains hébergeurs comme Render).

Nécessite deux variables d'environnement :
  TURSO_DATABASE_URL : l'URL de ta base Turso (libsql://... ou https://...)
  TURSO_AUTH_TOKEN     : le token généré dans le tableau de bord Turso
"""
import os
import secrets
import datetime
import requests

_raw_url = os.environ.get("TURSO_DATABASE_URL", "")
TURSO_HTTP_URL = _raw_url.replace("libsql://", "https://").rstrip("/")
TURSO_AUTH_TOKEN = os.environ.get("TURSO_AUTH_TOKEN", "")


def _to_hrana_value(value):
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "integer", "value": str(int(value))}
    if isinstance(value, int):
        return {"type": "integer", "value": str(value)}
    if isinstance(value, float):
        return {"type": "float", "value": value}
    return {"type": "text", "value": str(value)}


def _from_hrana_value(cell):
    t = cell.get("type")
    v = cell.get("value")
    if t == "null":
        return None
    if t == "integer":
        return int(v)
    if t == "float":
        return float(v)
    return v


def _execute(sql, args=None):
    """Exécute une requête SQL sur Turso via l'API HTTP et retourne une
    liste de dicts (une par ligne de résultat)."""
    args = args or []
    payload = {
        "requests": [
            {"type": "execute", "stmt": {"sql": sql, "args": [_to_hrana_value(a) for a in args]}},
            {"type": "close"},
        ]
    }
    headers = {
        "Authorization": f"Bearer {TURSO_AUTH_TOKEN}",
        "Content-Type": "application/json",
    }
    resp = requests.post(f"{TURSO_HTTP_URL}/v2/pipeline", json=payload, headers=headers, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    result = data["results"][0]
    if result["type"] == "error":
        raise RuntimeError(f"Erreur Turso : {result.get('error')}")

    exec_result = result["response"]["result"]
    cols = [c["name"] for c in exec_result.get("cols", [])]
    rows = []
    for raw_row in exec_result.get("rows", []):
        rows.append({cols[i]: _from_hrana_value(cell) for i, cell in enumerate(raw_row)})
    return rows


def init_db():
    _execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            first_name TEXT NOT NULL,
            last_name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            verified INTEGER NOT NULL DEFAULT 0,
            verify_token TEXT,
            reset_token TEXT,
            reset_token_expiry TEXT,
            privacy_accepted_at TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    _execute("""
        CREATE TABLE IF NOT EXISTS daily_visits (
            date TEXT PRIMARY KEY,
            count INTEGER NOT NULL DEFAULT 0
        )
    """)


def create_user(first_name, last_name, email, password_hash):
    email = email.lower().strip()
    if get_user_by_email(email):
        return None  # e-mail déjà utilisé

    token = secrets.token_urlsafe(32)
    now = datetime.datetime.utcnow().isoformat()
    _execute(
        """INSERT INTO users (first_name, last_name, email, password_hash,
           verified, verify_token, privacy_accepted_at, created_at)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?)""",
        [first_name.strip(), last_name.strip(), email, password_hash, token, now, now],
    )
    return token


def get_user_by_email(email):
    rows = _execute("SELECT * FROM users WHERE email = ?", [email.lower().strip()])
    return rows[0] if rows else None


def get_user_by_id(user_id):
    rows = _execute("SELECT * FROM users WHERE id = ?", [user_id])
    return rows[0] if rows else None


def verify_user_by_token(token):
    rows = _execute("SELECT * FROM users WHERE verify_token = ?", [token])
    if not rows:
        return False
    _execute(
        "UPDATE users SET verified = 1, verify_token = NULL WHERE id = ?",
        [rows[0]["id"]],
    )
    return True


def delete_user(user_id):
    _execute("DELETE FROM users WHERE id = ?", [user_id])


def count_users():
    rows = _execute("SELECT COUNT(*) AS c FROM users WHERE verified = 1")
    return rows[0]["c"] if rows else 0


def get_all_users():
    return _execute(
        "SELECT id, first_name, last_name, email, verified, created_at "
        "FROM users ORDER BY created_at DESC"
    )


def increment_and_get_visit_counter():
    today = datetime.date.today().isoformat()
    _execute(
        "INSERT INTO daily_visits (date, count) VALUES (?, 1) "
        "ON CONFLICT(date) DO UPDATE SET count = count + 1",
        [today],
    )
    rows = _execute("SELECT COALESCE(SUM(count), 0) AS total FROM daily_visits")
    return rows[0]["total"] if rows else 0


def get_total_visits():
    rows = _execute("SELECT COALESCE(SUM(count), 0) AS total FROM daily_visits")
    return rows[0]["total"] if rows else 0


def get_daily_visits(days=30):
    rows = _execute(
        "SELECT date, count FROM daily_visits ORDER BY date DESC LIMIT ?", [days]
    )
    return list(reversed(rows))


def get_signups_per_day(days=30):
    rows = _execute(
        "SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count "
        "FROM users GROUP BY day ORDER BY day DESC LIMIT ?",
        [days],
    )
    return list(reversed(rows))


# ---- Réinitialisation de mot de passe (mot de passe oublié) ----

def create_password_reset_token(email):
    email = email.lower().strip()
    if not get_user_by_email(email):
        return None
    token = secrets.token_urlsafe(32)
    expiry = (datetime.datetime.utcnow() + datetime.timedelta(hours=1)).isoformat()
    _execute(
        "UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE email = ?",
        [token, expiry, email],
    )
    return token


def get_user_by_reset_token(token):
    rows = _execute("SELECT * FROM users WHERE reset_token = ?", [token])
    if not rows:
        return None
    user = rows[0]
    if not user.get("reset_token_expiry"):
        return None
    try:
        expiry = datetime.datetime.fromisoformat(user["reset_token_expiry"])
    except ValueError:
        return None
    if datetime.datetime.utcnow() > expiry:
        return None
    return user


def update_password_and_clear_token(user_id, new_password_hash):
    _execute(
        "UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?",
        [new_password_hash, user_id],
    )
