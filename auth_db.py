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
