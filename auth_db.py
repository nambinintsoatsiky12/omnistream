"""
Gestion des comptes utilisateurs et des statistiques du site, connectée à
Turso (base SQLite distante et persistante) au lieu d'un fichier local —
car Render efface le système de fichiers local à chaque redéploiement.

Nécessite deux variables d'environnement :
  TURSO_DATABASE_URL : l'URL libsql://... de ta base Turso
  TURSO_AUTH_TOKEN     : le token généré dans le tableau de bord Turso
"""
import os
import secrets
import datetime
import libsql_client

TURSO_DATABASE_URL = os.environ.get("TURSO_DATABASE_URL", "")
TURSO_AUTH_TOKEN = os.environ.get("TURSO_AUTH_TOKEN", "")

_client = None


def _get_client():
    global _client
    if _client is None:
        _client = libsql_client.create_client_sync(
            url=TURSO_DATABASE_URL, auth_token=TURSO_AUTH_TOKEN
        )
    return _client


def _row_to_dict(result_set, index=0):
    """Convertit une ligne de résultat Turso en dict, comme sqlite3.Row."""
    if not result_set.rows or index >= len(result_set.rows):
        return None
    row = result_set.rows[index]
    return {col: row[i] for i, col in enumerate(result_set.columns)}


def _rows_to_dicts(result_set):
    return [
        {col: row[i] for i, col in enumerate(result_set.columns)}
        for row in result_set.rows
    ]


def init_db():
    client = _get_client()
    client.execute("""
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
    client.execute("""
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
    client = _get_client()
    client.execute(
        """INSERT INTO users (first_name, last_name, email, password_hash,
           verified, verify_token, privacy_accepted_at, created_at)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?)""",
        [first_name.strip(), last_name.strip(), email, password_hash, token, now, now],
    )
    return token


def get_user_by_email(email):
    client = _get_client()
    rs = client.execute(
        "SELECT * FROM users WHERE email = ?", [email.lower().strip()]
    )
    return _row_to_dict(rs)


def get_user_by_id(user_id):
    client = _get_client()
    rs = client.execute("SELECT * FROM users WHERE id = ?", [user_id])
    return _row_to_dict(rs)


def verify_user_by_token(token):
    client = _get_client()
    rs = client.execute("SELECT * FROM users WHERE verify_token = ?", [token])
    user = _row_to_dict(rs)
    if user:
        client.execute(
            "UPDATE users SET verified = 1, verify_token = NULL WHERE id = ?",
            [user["id"]],
        )
    return user is not None


def delete_user(user_id):
    client = _get_client()
    client.execute("DELETE FROM users WHERE id = ?", [user_id])


def count_users():
    client = _get_client()
    rs = client.execute("SELECT COUNT(*) AS c FROM users WHERE verified = 1")
    row = _row_to_dict(rs)
    return row["c"] if row else 0


def get_all_users():
    """Liste complète des membres, pour le panel admin."""
    client = _get_client()
    rs = client.execute(
        "SELECT id, first_name, last_name, email, verified, created_at "
        "FROM users ORDER BY created_at DESC"
    )
    return _rows_to_dicts(rs)


def increment_and_get_visit_counter():
    """Incrémente le compteur du jour et retourne le total cumulé depuis
    le début (toutes les dates confondues)."""
    client = _get_client()
    today = datetime.date.today().isoformat()
    client.execute(
        "INSERT INTO daily_visits (date, count) VALUES (?, 1) "
        "ON CONFLICT(date) DO UPDATE SET count = count + 1",
        [today],
    )
    rs = client.execute("SELECT COALESCE(SUM(count), 0) AS total FROM daily_visits")
    row = _row_to_dict(rs)
    return row["total"] if row else 0


def get_total_visits():
    client = _get_client()
    rs = client.execute("SELECT COALESCE(SUM(count), 0) AS total FROM daily_visits")
    row = _row_to_dict(rs)
    return row["total"] if row else 0


def get_daily_visits(days=30):
    """Visites par jour sur les N derniers jours, pour le graphique."""
    client = _get_client()
    rs = client.execute(
        "SELECT date, count FROM daily_visits ORDER BY date DESC LIMIT ?", [days]
    )
    return list(reversed(_rows_to_dicts(rs)))


def get_signups_per_day(days=30):
    """Nouvelles inscriptions par jour sur les N derniers jours, pour le graphique."""
    client = _get_client()
    rs = client.execute(
        "SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count "
        "FROM users GROUP BY day ORDER BY day DESC LIMIT ?",
        [days],
    )
    return list(reversed(_rows_to_dicts(rs)))


# ---- Réinitialisation de mot de passe (mot de passe oublié) ----

def create_password_reset_token(email):
    email = email.lower().strip()
    if not get_user_by_email(email):
        return None
    token = secrets.token_urlsafe(32)
    expiry = (datetime.datetime.utcnow() + datetime.timedelta(hours=1)).isoformat()
    client = _get_client()
    client.execute(
        "UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE email = ?",
        [token, expiry, email],
    )
    return token


def get_user_by_reset_token(token):
    client = _get_client()
    rs = client.execute("SELECT * FROM users WHERE reset_token = ?", [token])
    user = _row_to_dict(rs)
    if not user or not user["reset_token_expiry"]:
        return None
    try:
        expiry = datetime.datetime.fromisoformat(user["reset_token_expiry"])
    except ValueError:
        return None
    if datetime.datetime.utcnow() > expiry:
        return None
    return user


def update_password_and_clear_token(user_id, new_password_hash):
    client = _get_client()
    client.execute(
        "UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?",
        [new_password_hash, user_id],
    )
