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

## Économie de données (forfaits mobiles)

Le mode **Audio (MP3)** de l'espace musique ne télécharge pas le clip vidéo :
il lit le **flux audio seul** du titre YouTube (~128 kbps, ≈ 1 Mo/min), avec
la qualité sonore complète. Les métadonnées de flux sont demandées à des
instances publiques Piped/Invidious (aucune clé requise) ; si aucune n'est
joignable, le lecteur retombe automatiquement sur YouTube en qualité minimale
pour que le titre se lance quand même. Le mode **Vidéo (MP4)** reste en
qualité normale.

Autres économies intégrées : fresque de l'accueil servie en petites affiches
`w185` (≈ 4× plus légères), polices limitées aux graisses réellement
utilisées, appels TMDB de l'accueil lancés en parallèle (affichage plus
rapide), Service Worker qui met en cache CSS/JS/images/pages après la
première visite (revisites à 0 Mo).

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
| `ASSET_VERSION` | Force l'empreinte de cache des CSS/JS (par défaut : mtime le plus récent de `static/`) |
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
app.py                    routes Flask, validation et intégrations externes
auth_db.py                compteur de visites (SQLite ou Turso)
templates/                pages Jinja (base.html porte le lecteur global)
static/css/style.css      interface complète : vitrine, grilles, lecteur, hors ligne
static/js/player.js       lecteur global persistant (file, MediaSession, hors ligne)
static/js/library.js      Ma Liste / Reprendre / Hors ligne (IndexedDB + miroir local)
static/js/app-shell.js    navigation interne (PJAX), Service Worker, notifications
static/js/home.js         catalogue, filtres, pagination, rangée « Reprendre »
static/js/musique.js      recherche musicale et cartes MP3/MP4
static/js/downloads.js    page « Hors ligne & Données » (cache, stats, purge)
static/js/library-page.js espace personnel (favoris, historique, purge)
static/js/detail.js       fiche : bande-annonce, Ma Liste, épinglage, partage
static/js/chat.js         chat Gemini
static/service-worker.js  cache du shell, des images, des polices et des pages
requirements.txt          dépendances de production
requirements-dev.txt      outils de test et de lint
Procfile / render.yaml    déploiement Render
```

Les tests `tests/test_frontend_contract.py` vérifient les contrats entre gabarits,
CSS et scripts (toute action `data-omni-action` doit être traitée, tout script doit
être pré-caché, tout asset doit être versionné).

## Sur le téléphone : lecteur, hors ligne et données

**Lecteur.** Un seul lecteur YouTube vit dans `base.html` et survit à la navigation
interne : la musique ne se coupe plus quand on change de page. Les commandes
(▶ / II, précédent, suivant, épingler) réagissent au toucher avant même la réponse
du réseau ; l'icône de lecture est pilotée par un attribut d'état posé sur `<body>`
(`data-player-playing`), donc barre du bas, panneau agrandi et overlay vidéo
affichent toujours le même état. Le panneau du bas se ferme par son bouton ✕, par
glissement du panneau agrandi vers le bas, par `Échap` ou par un clic hors du
panneau — et il ne revient pas tout seul à la page suivante.

**Écran verrouillé.** `MediaSession` (titre, pochette, position, `playbackState`)
garde les contrôles accessibles sur l'écran de verrouillage ; une petite session
audio silencieuse est maintenue tant que la lecture dure pour éviter qu'Android
ne gèle l'onglet ; la position est mémorisée toutes les 5 secondes, donc une
coupure reprend à l'endroit exact. L'option « Écran allumé » du panneau agrandi
demande un verrou d'écran (désactivée par défaut, aucune consommation de batterie
sans demande explicite).

**Hors ligne.** `static/service-worker.js` met en cache le shell (CSS, JS, polices,
icônes), les images, les pages HTML et les réponses JSON déjà vues ; une fiche
épinglée est rapatriée intégralement (synopsis, affiche, miniature). Les flux
YouTube et TMDB étant interdits de téléchargement par leurs conditions, **le son
et la vidéo ne peuvent pas être stockés** : un titre lancé sans réseau passe en
attente (« Hors ligne · en attente de réseau ») et démarre seul au retour de la
connexion.

**Application installée** (PWA). Le manifeste est déclaré par la route
`/manifest.webmanifest` — un mimetype garanti, sans lui Chrome le refuse et
l'application ne se lance plus. Son identité (`id: "/"`) est figée et
`start_url` pointe sur l'accueil nu, pré-enregistré par le worker : l'écran
d'accueil n'est donc jamais lié à une URL que la coquille ne connaît pas.
Le `display_override` accepte le repli `browser` : si le mode autonome n'est pas
disponible, la fenêtre s'ouvre dans un onglet au lieu de rester vide. Si le
réseau répond mal (instance Render qui se réveille, redéploiement en cours),
le worker sert la dernière copie connue de la page, sinon sa page de secours
intégrale — jamais un écran noir. Enfin, l'option « Installer » du menu des
3 tirés ne dépend plus du seul événement Chrome : sans invitation native
(iOS, visite courte), elle explique la marche à suivre au lieu de rester
cachée, et elle s'efface d'elle-même une fois dans l'application.

**Bandeau d'état.** Le message « hors ligne » et la barre « nouvelle version
disponible » se calent sous le header, en 56 px minimum, avec de vrais boutons
de 40 px (Réessayer, Mes enregistrements, masquer). La page récupère leur
hauteur via `--top-banner-h`, donc rien n'est masqué ; en mode autonome, le
header ajoute en plus `env(safe-area-inset-top)` pour ne pas passer sous
l'encoche.

**Données personnelles.** Favoris, historique et épinglages vivent dans IndexedDB
(`omnistream-library`), sans plafond arbitraire, avec un miroir compact dans
`localStorage` pour un premier affichage instantané. Une demande de stockage
persistant est émise pour que le navigateur ne purge pas silencieusement la
bibliothèque. Le compteur « Données économisées » est réinitialisable depuis la
page Hors ligne.

**Économie de Mo.** Vignettes demandées en `w342`/`w780` aux grilles, images et
polices servies depuis le cache (stratégie « cache d'abord » et « fresque »),
lazy-loading des images, aucun appel YouTube avant la première lecture, mode Audio
qui ne charge jamais la surface vidéo (lecteur réduit à 2 px).

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
