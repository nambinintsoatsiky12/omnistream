# OmniStream

Application Flask de découverte de films, séries, animés, mangas et musique.
Le catalogue et les fiches viennent de TMDB, le chat utilise Gemini, les scans
sont recherchés sur MangaDex et la rubrique musique utilise YouTube.

Le site est entièrement public : aucune inscription, aucun compte, aucun mot
de passe. Seul un compteur anonyme de visiteurs uniques est conservé.

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

python app.py
```

Le site écoute sur <http://127.0.0.1:5000>. Sans configuration Turso,
OmniStream crée automatiquement une base SQLite locale `users.db` qui ne
contient que la table `daily_visits` (compteur de fréquentation).

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
| `TURSO_DATABASE_URL` | URL Turso (`libsql://...` ou `https://...`) |
| `TURSO_AUTH_TOKEN` | Jeton Turso ; doit être défini avec l'URL |
| `DATABASE_PATH` | Chemin SQLite local (par défaut `users.db`) |
| `SESSION_COOKIE_SECURE` | Mettre à `true` derrière HTTPS |
| `TRUST_PROXY_HEADERS` | Mettre à `true` uniquement derrière un proxy de confiance |
| `TRUSTED_HOSTS` | Hôtes autorisés, séparés par des virgules (protection de l'en-tête `Host`) |
| `PORT` | Port du serveur de développement (`5000` par défaut) |
| `FLASK_DEBUG` | Active le debug local si égal à `true` |

`TURSO_DATABASE_URL` et `TURSO_AUTH_TOKEN` doivent toujours être définis
ensemble. La table est créée automatiquement au démarrage.

## Déploiement sur Render

Le dépôt contient un `render.yaml` (blueprint) et un `Procfile` : il suffit de
connecter le dépôt à Render, qui installe `requirements.txt` et lance Gunicorn
automatiquement. Renseignez ensuite `TMDB_API_KEY` (obligatoire) et,
si besoin, `GEMINI_API_KEY`, `YOUTUBE_API_KEY`, `TURSO_DATABASE_URL` et
`TURSO_AUTH_TOKEN` dans les variables d'environnement du service.

Sans Turso, le compteur repose sur le SQLite local du conteneur : il repart de
zéro à chaque redéploiement. Pour un compteur vraiment persistant sur Render,
configurez Turso (gratuit).

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
auth_db.py              compteur de visites (SQLite ou Turso)
templates/               pages Jinja
static/css/style.css     styles responsives (dégradés violet/rose/orange)
static/js/home.js        catalogue, filtres et pagination
static/js/chat.js        chat Gemini
static/js/musique.js     recherche et lecteur YouTube (modes Audio/Vidéo)
requirements.txt        dépendances de production
requirements-dev.txt    outils de test et de lint
Procfile / render.yaml  déploiement Render
```

## Données et sécurité

- Aucune donnée personnelle n'est collectée : pas de comptes, pas d'e-mails,
  pas de mots de passe.
- Le compteur de visiteurs uniques utilise un simple marqueur de session
  (`_counted_visit`) : une session n'est comptée qu'une seule fois.
- Le proxy MangaDex n'accepte qu'une liste limitée d'endpoints et le proxy
  d'images refuse toute URL extérieure à `uploads.mangadex.org`.
- Aucun script publicitaire de notification n'est chargé. L'ancien service
  worker push est désabonné et supprimé lors de la prochaine visite.
- Le Smartlink sponsorisé ne s'ouvre qu'après un clic volontaire sur le petit
  cadeau flottant ; le bouton de lecture des scans ouvre uniquement le lecteur.
