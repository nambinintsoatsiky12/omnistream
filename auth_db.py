"""
Gestion des comptes utilisateurs : inscription, connexion, vérification
par e-mail, acceptation de la politique de confidentialité.

Stockage : SQLite (fichier local users.db) — pas besoin de MySQL,
compatible avec n'importe quel compte PythonAnywhere, gratuit ou payant.
"""
import os
import secrets
import sqlite3
import datetime

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "users.db")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
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
    """)
    conn.commit()
    conn.close()


def create_user(first_name, last_name, email, password_hash):
    token = secrets.token_urlsafe(32)
    now = datetime.datetime.utcnow().isoformat()
    conn = get_db()
    try:
        conn.execute(
            """INSERT INTO users (first_name, last_name, email, password_hash,
               verified, verify_token, privacy_accepted_at, created_at)
               VALUES (?, ?, ?, ?, 0, ?, ?, ?)""",
            (first_name.strip(), last_name.strip(), email.lower().strip(),
             password_hash, token, now, now),
        )
        conn.commit()
        return token
    except sqlite3.IntegrityError:
        return None  # e-mail déjà utilisé
    finally:
        conn.close()


def get_user_by_email(email):
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM users WHERE email = ?", (email.lower().strip(),)
    ).fetchone()
    conn.close()
    return row


def get_user_by_id(user_id):
    conn = get_db()
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    return row


def verify_user_by_token(token):
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM users WHERE verify_token = ?", (token,)
    ).fetchone()
    if row:
        conn.execute(
            "UPDATE users SET verified = 1, verify_token = NULL WHERE id = ?",
            (row["id"],),
        )
        conn.commit()
    conn.close()
    return row is not None


def delete_user(user_id):
    conn = get_db()
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()


def count_users():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS site_stats (
            key TEXT PRIMARY KEY,
            value INTEGER NOT NULL DEFAULT 0
        )
    """)
    row = conn.execute("SELECT COUNT(*) AS c FROM users WHERE verified = 1").fetchone()
    conn.close()
    return row["c"] if row else 0


def increment_and_get_visit_counter():
    """Compteur cumulé de visites de la page d'accueil (comme un compteur
    de vues classique), pas un nombre de gens connectés en temps réel."""
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS site_stats (
            key TEXT PRIMARY KEY,
            value INTEGER NOT NULL DEFAULT 0
        )
    """)
    conn.execute(
        "INSERT INTO site_stats (key, value) VALUES ('landing_visits', 1) "
        "ON CONFLICT(key) DO UPDATE SET value = value + 1"
    )
    conn.commit()
    row = conn.execute(
        "SELECT value FROM site_stats WHERE key = 'landing_visits'"
    ).fetchone()
    conn.close()
    return row["value"] if row else 0


# ---- Réinitialisation de mot de passe (mot de passe oublié) ----

def _ensure_reset_columns():
    """Ajoute les colonnes reset_token / reset_token_expiry si elles
    n'existent pas encore (compte déjà créé avant cette fonctionnalité)."""
    conn = get_db()
    try:
        conn.execute("ALTER TABLE users ADD COLUMN reset_token TEXT")
    except sqlite3.OperationalError:
        pass
    try:
        conn.execute("ALTER TABLE users ADD COLUMN reset_token_expiry TEXT")
    except sqlite3.OperationalError:
        pass
    conn.commit()
    conn.close()


def create_password_reset_token(email):
    """Génère un token de réinitialisation valable 1 heure.
    Retourne None si aucun compte n'existe pour cet e-mail."""
    _ensure_reset_columns()
    token = secrets.token_urlsafe(32)
    expiry = (datetime.datetime.utcnow() + datetime.timedelta(hours=1)).isoformat()
    conn = get_db()
    cur = conn.execute(
        "UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE email = ?",
        (token, expiry, email.lower().strip()),
    )
    conn.commit()
    updated = cur.rowcount > 0
    conn.close()
    return token if updated else None


def get_user_by_reset_token(token):
    """Retourne l'utilisateur si le token est valide et pas expiré, sinon None."""
    _ensure_reset_columns()
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM users WHERE reset_token = ?", (token,)
    ).fetchone()
    conn.close()
    if not row or not row["reset_token_expiry"]:
        return None
    try:
        expiry = datetime.datetime.fromisoformat(row["reset_token_expiry"])
    except ValueError:
        return None
    if datetime.datetime.utcnow() > expiry:
        return None
    return row


def update_password_and_clear_token(user_id, new_password_hash):
    """Change le mot de passe et invalide le token utilisé."""
    conn = get_db()
    conn.execute(
        "UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL WHERE id = ?",
        (new_password_hash, user_id),
    )
    conn.commit()
    conn.close()
