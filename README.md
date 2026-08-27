# OmniStream

Application Flask de découverte de films, séries, animés, mangas et musique.
Le catalogue et les fiches viennent de TMDB, le chat utilise Gemini, les scans
sont recherchés sur MangaDex et la rubrique musique utilise YouTube.

## Prérequis

- Python 3.10 ou plus récent ;
- une clé TMDB pour le catalogue ;
- les autres services sont optionnels selon les fonctionnalités utilisées.

## Démarrage local

```bash
python -m venv .venv
source .venv/bin/activate              # Windows : .venv\Scripts\activate
pip install -r requirements.txt

export TMDB_API_KEY="votre_cle_tmdb"
export GEMINI_API_KEY="votre_cle_gemini"       # chat, optionnel
export YOUTUBE_API_KEY="votre_cle_youtube"     # musique, optionnel
export MAIL_BACKEND="console"                  # développement uniquement

python app.py
```

Le site écoute sur <http://127.0.0.1:5000>. Sans configuration Turso,
OmniStream crée automatiquement une base SQLite locale `users.db`. Avec
`MAIL_BACKEND=console`, les liens de confirmation et de réinitialisation sont
écrits dans le terminal au lieu d'être envoyés : **ne jamais activer ce mode en
production**.

La page vitrine reste accessible quand TMDB est absent ou momentanément en
panne. Les routes qui ont réellement besoin d'une API renvoient alors un
message d'erreur explicite.

## Configuration

| Variable | Utilité |
| --- | --- |
| `TMDB_API_KEY` | Catalogue, recherches et fiches TMDB |
| `GEMINI_API_KEY` | Assistant sur les fiches |
| `GEMINI_MODEL` | Modèle Gemini (`gemini-2.5-flash` par défaut) |
| `YOUTUBE_API_KEY` | Recherche et tendances musicales |
| `SPONSOR_SMARTLINK_URL` | Lien du cadeau flottant (`https://omg10.com/4/11645531` par défaut, valeur vide pour le masquer) |
| `SECRET_KEY` | Signature des sessions ; obligatoire en production |
| `PUBLIC_BASE_URL` | URL publique **obligatoire avec Mailjet**, utilisée dans les liens (ex. `https://example.com`) |
| `ADMIN_EMAIL` | Compte autorisé à ouvrir `/admin` |
| `TURSO_DATABASE_URL` | URL Turso (`libsql://...` ou `https://...`) |
| `TURSO_AUTH_TOKEN` | Jeton Turso ; doit être défini avec l'URL |
| `DATABASE_PATH` | Chemin SQLite local (par défaut `users.db`) |
| `MAILJET_API_KEY` | Clé publique Mailjet |
| `MAILJET_SECRET_KEY` | Clé secrète Mailjet |
| `SENDER_EMAIL` | Expéditeur validé dans Mailjet |
| `MAIL_BACKEND` | `mailjet` par défaut, `console` seulement en local |
| `SESSION_COOKIE_SECURE` | Mettre à `true` derrière HTTPS |
| `TRUST_PROXY_HEADERS` | Mettre à `true` uniquement derrière un proxy de confiance |
| `TRUSTED_HOSTS` | Hôtes autorisés, séparés par des virgules (protection de l'en-tête `Host`) |
| `PORT` | Port du serveur de développement (`5000` par défaut) |
| `FLASK_DEBUG` | Active le debug local si égal à `true` |

`TURSO_DATABASE_URL` et `TURSO_AUTH_TOKEN` doivent toujours être définis
ensemble. Les tables et les migrations simples sont appliquées au démarrage.

## Déploiement

Exemple avec Gunicorn :

```bash
export SECRET_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(48))')"
export PUBLIC_BASE_URL="https://votre-domaine.example"
export SESSION_COOKIE_SECURE=true
export TRUSTED_HOSTS="votre-domaine.example"
# Configurer ensuite TMDB, Turso et Mailjet dans les secrets de l'hébergeur.

gunicorn --bind 0.0.0.0:${PORT:-8000} app:app
```

Si l'hébergeur place Gunicorn derrière son propre proxy HTTP de confiance,
ajoutez `TRUST_PROXY_HEADERS=true`.

## Tests et qualité

```bash
pip install -r requirements-dev.txt
pytest -q
ruff check .
```

Les tests utilisent une base SQLite temporaire et remplacent les appels aux
API externes par des réponses simulées.

## Structure

```text
app.py                  routes Flask, validation et intégrations externes
auth_db.py              stockage SQLite/Turso et jetons d'authentification
mailer.py               e-mails Mailjet (ou console en développement)
templates/               pages Jinja
static/css/style.css     styles responsives
static/js/home.js        catalogue, filtres et pagination
static/js/chat.js        chat Gemini
static/js/musique.js     recherche et lecteur YouTube
requirements.txt        dépendances de production
requirements-dev.txt    outils de test et de lint
```

## Données et sécurité

- Les mots de passe sont hachés avec Werkzeug et ne sont jamais stockés en
  clair.
- Les formulaires et le chat sont protégés contre les requêtes CSRF.
- Les jetons de confirmation expirent après 24 heures ; ceux de mot de passe
  après 1 heure et ne sont utilisables qu'une fois. Une réinitialisation révoque
  également les sessions déjà ouvertes.
- Le proxy MangaDex n'accepte qu'une liste limitée d'endpoints et l'ancien
  proxy d'images refuse toute URL extérieure à `uploads.mangadex.org`.
- Aucun script publicitaire de notification n'est chargé. L'ancien service
  worker push est désabonné et supprimé lors de la prochaine visite.
- Le Smartlink sponsorisé ne s'ouvre qu'après un clic volontaire sur le petit
  cadeau flottant ; le bouton de lecture des scans ouvre uniquement le lecteur.
