# OmniStream

Application Flask de découverte de films, séries, animés, mangas et musique.
Le catalogue et les fiches de films et séries viennent de TMDB, les animes et
les mangas viennent d'AniList, le chat utilise Gemini, les scans sont
recherchés sur MangaDex et la rubrique musique utilise YouTube.

AniList est une **source de données**, jamais une destination : les fiches
d'animes et de mangas sont lues chez AniList puis affichées dans le panneau
habituel d'OmniStream (synopsis, bande-annonce, Ma liste, hors ligne, partage,
assistant Gemini, lecteur de scan). Aucun clic ne renvoie le visiteur vers
`anilist.co` ; seul un crédit discret en bas de fiche pointe vers le catalogue
d'origine.

### La grille se redessine à chaque ouverture

Avec un simple `popularity.desc`, les vingt mêmes titres restaient en haut pour
toujours. À l'inverse, un tirage uniforme noierait les œuvres marquantes au
milieu du reste.

Le classement est donc un **tirage aléatoire pondéré** (Efraimidis-Spirakis) :
la clé d'un titre est `u**(1/poids)`, avec `u` tiré dans `]0,1[`. Plus le poids
est grand, plus le titre remonte **en moyenne** — sans qu'aucune place ne soit
jamais garantie d'une visite à l'autre. Le poids combine le rang dans le
catalogue source, la note et la fraîcheur de la sortie.

Un tirage sur vingt titres ne ferait que réordonner les mêmes vingt. La grille
est donc découpée en **bandes de cent titres**, lues d'un coup, réordonnées,
puis servies cinq pages par cinq :

| onglet | source de la bande | appels par bande |
| --- | --- | --- |
| Films, Séries, Animation | 5 pages TMDB × 20 | 5 (cachées 15 min) |
| Animés & Mangas | 2 pages AniList × 50 | 2 (cachées 10 min) |
| Films ≥ 8,5 | le pool déjà trié par note | — |

La **graine** de visite décide de l'ordre. Elle vit dans `sessionStorage` :
stable le temps de la visite — indispensable, sinon le défilement infini se
répéterait entre deux pages — et neuve à chaque nouvel onglet.

La courbe a été **calibrée par simulation** sur une bande de 100 titres : à
puissance 6, environ 14 des 20 affichés viennent du vrai top 20 du catalogue,
et le premier titre change malgré tout à (presque) chaque visite. Plus bas, la
grille devenait un bruit ; plus haut, elle se figeait de nouveau. Un test
rejoue 300 visites et encadre cette moyenne entre 11 et 19.

L'onglet **Nouveautés** reste chronologique : c'est un calendrier de sorties,
le mélanger lui ferait perdre son sens.

#### Le dosage se règle

Tout le monde ne veut pas le même degré de surprise. Trois crans sont exposés
sous la grille — **Stable**, **Équilibré**, **Surprenant** — et mémorisés sur
l'appareil (`localStorage`, clé `omni-fraicheur`). Ils pilotent la puissance du
tirage : 10, 6 et 3. Une valeur inconnue retombe sur le cran du milieu plutôt
que de renvoyer un 400 — c'est un réglage d'affichage, pas un contrat de
données.

#### « Pas intéressé »

Un troisième bouton de coin sur chaque carte écarte le titre pour de bon, dans
`localStorage` (borné à 400 entrées). C'est le mécanisme qui fait qu'un fil ne
vous remontre pas ce que vous avez déjà refusé. Le clic empêche l'ouverture de
la fiche ; sur tactile, où il n'y a pas de survol, le bouton reste visible.

#### Le bandeau aussi

`api_hero` tournait sur une horloge de quinze minutes : le même bandeau pour
tout le monde, sans égard pour la notoriété. Il suit désormais la graine de
visite et le même tirage pondéré que la grille — et le client ne le remélange
plus à l'arrivée, ce qui aurait annulé le travail du serveur.

### L'onglet « Animés & Mangas »

Cet onglet ne puise **que** dans AniList — TMDB ignore les mangas et classe mal
une partie des animes, les mélanger faisait apparaître des films d'animation là
où le visiteur attendait un anime.

- une bascule **Animes / Mangas** : chaque moitié a ses propres sous-genres ;
- des sous-genres AniList : genres (Action, Romance, Comédie, Horreur…) et
  thèmes (Zombie, Isekai / Réincarnation, Harem, Shōnen, Shōjo, Seinen, Josei…) ;
- cinq tris, un seul actif à la fois : Tendances, Les plus vus, **Dernière
  génération** (les plus récents, bornés aux trois dernières années), **Ajouts
  récents**, **Note ≥ 8,5** ;
- la liste des étiquettes est relue chez AniList une fois par jour : un bouton
  dont l'étiquette n'existerait plus disparaît au lieu de renvoyer « vide » ;
- **122 sous-genres côté animes, 144 côté mangas** (Shōnen, Shōjo, Seinen,
  Josei, Réincarnation, Isekai, Villainesse, Gourmet, Wuxia, Iyashikei,
  E-sport, Miko…). Comme ils ne tiennent pas dans une bande horizontale,
  un champ **« Filtrer »** et un bouton **« Tout afficher »** (dépliage en
  grille) sont proposés dès qu'il y en a plus de douze ;
- **le défilement infini parcourt tout le catalogue** : le plafond de pages de
  cet onglet est passé de 25 à **250 pages × 20 cartes** (5 000 fiches). Deux
  freins ont sauté — `_page_arg()` écrêtait la page à 25 avant même que le
  catalogue AniList la voie, et `IntersectionObserver` ne rappelle sa fonction
  que sur un *changement* d'intersection, donc une page trop courte pour
  remplir l'écran arrêtait la grille pour de bon ;
- un bouton **« Au hasard »** pioche une page au sort dans la partie profonde
  du catalogue ;
- **survoler un sous-genre précharge sa première page** (appui maintenu de
  260 ms sur tactile). Le serveur garde ces pages dix minutes : le clic qui
  suit arrive sur une réponse déjà prête ;
- la fiche affiche **« Dans le même univers »** : suite, préquelle, manga
  d'origine, spin-off… Ces liens ouvrent **notre** fiche, jamais AniList ;
- un bandeau **« Cette semaine »** liste les épisodes diffusés dans les 7 jours
  (`airingSchedules`), avec le numéro d'épisode et le jour en français —
  « aujourd'hui », « demain », sinon le jour de la semaine. Il suit la bascule
  Animes / Mangas et reste caché quand AniList ne répond pas ;
- une page **`/calendrier`** reprend ce rail en liste verticale, filtrable par
  jour. Les épisodes sont chargés une fois puis filtrés en mémoire : changer de
  jour ne repart pas vers AniList ;
- des **alertes d'épisodes** pour les séries de « Ma Liste ». L'autorisation du
  navigateur n'est demandée que sur un clic explicite, jamais d'office, et un
  épisode n'est annoncé qu'une fois.

Par symétrie, les onglets **Nouveautés** et **Films ≥ 8.5** (TMDB) écartent
l'animation de leur vue « Tous » : l'animation a son onglet, ses filtres et sa
source.

### Le lecteur de scan (MangaDex)

Le lecteur partait chercher le titre **guillemets compris** : le gabarit
écrivait `data-title="{{ titre | tojson }}"`, et `tojson` ajoute ses propres
guillemets JSON dans un attribut déjà guillemeté — d'où `data-title=""One
Piece""`. MangaDex recevait donc `"One Piece"`. L'attribut utilise maintenant
l'auto-échappement HTML simple.

Trois autres causes d'échec ont été traitées :

- **les erreurs étaient toutes fondues en « Erreur de communication avec
  MangaDex »**. Le proxy recopie désormais la raison exacte renvoyée par
  MangaDex (`errors[].detail`) et distingue un 403 de Cloudflare, un 429, un
  404 et une réponse non-JSON ;
- **`order[year]=asc` côté recherche** faisait renvoyer à MangaDex les vingt
  correspondances *les plus anciennes*, ce qui faisait sortir la vraie série
  de la page dès que le titre comptait beaucoup d'homonymes. Le classement par
  pertinence de MangaDex est laissé intact, et le départage par ancienneté
  reste dans `choisirSerie` ;
- **un 429 isolé coupait la lecture** : deux essais supplémentaires, en
  respectant `Retry-After`.

Trois ajouts au lecteur :

- **l'historique de lecture** : le dernier chapitre ouvert est retenu par
  série, dans `localStorage` uniquement (borné à 40 séries, aucune donnée ne
  quitte l'appareil — le site n'a pas de compte où l'accrocher). À la
  réouverture, la lecture reprend où elle s'était arrêtée ;
- **la lecture continue** (mode webtoon) : les planches se touchent, comme se
  lisent les webtoons et la plupart des manhwas. Le choix est mémorisé ;
- **la langue réellement trouvée** est nommée : « chapitres en coréen, pas en
  français » au lieu d'un « toutes langues » qui ne renseignait personne ;
- la **Bibliothèque** affiche une rangée **« Continuer à lire »** qui relit cet
  historique — elle ne le duplique pas, elle ne fait que l'afficher.

La recherche essaie aussi plusieurs orthographes (rōmaji, anglais, synonymes
transmis par la fiche, suffixe de film/saison retiré), et les chapitres sont
paginés au-delà de 500 — MangaDex ne renvoie jamais plus de 500 lignes d'un
coup, un manga à 900 chapitres perdait donc silencieusement sa fin.

### Le rayon adulte (18+)

Accessible depuis le menu (jamais depuis la barre d'onglets), sur `/adulte`.
La page s'ouvre sur un portail **« J'ai 18 ans »** : la grille est vide dans le
HTML et l'appel à `/api/adulte` n'est lancé qu'après le clic. La réponse est
conservée dans `localStorage` sur cet appareil uniquement, et un bouton
**« Re-verrouiller »** remet le portail en place.

Le contenu vient de MangaDex (`contentRating[] = erotica | pornographic`,
`hasAvailableChapters=true`, les plus suivis d'abord). AniList et TMDB
filtrent ce contenu à la source : il n'apparaît donc dans aucun autre onglet.
La requête est figée côté serveur ; les deux seuls paramètres acceptés sont
`rating` (liste close) et `q` (recherche, 80 caractères au plus) — tout le
reste renvoie un 400. Avec une recherche, MangaDex classe par pertinence ;
sans, les séries les plus suivies passent d'abord.

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

Le mode **Audio** de l'espace musique distingue deux sources, parce qu'elles
n'offrent pas la même liberté :

- **MP3 libre** (par défaut) : de vrais fichiers MP3 publiés sous licence de copie,
  servis par deux fournisseurs. **Internet Archive** (fonctionne sans rien
  configurer : `etree`, `audio_music`, `netlabels`, trois fonds vérifiés un par un)
  et, si une clé est configurée, **Jamendo** (catalogue moderne sous Creative
  Commons). C'est la seule source qui lise écran éteint, qui s'épingle hors ligne
  et qui s'enregistre comme fichier sur le téléphone. La page propose des rayons
  (`/api/mp3?shelf=…`) — Tout, Madagascar, Concerts, Netlabels, Musique du monde —
  et la liste vient du serveur, pas du gabarit ;
- **YouTube** : les clips et les sessions. L'économie de Mo passe alors par le
  flux audio seul (~128 kbps, ≈ 1 Mo/min) résolu auprès d'instances publiques
  Piped/Invidious ; écran allumé seulement, et aucun téléchargement possible
  (les conditions de YouTube l'interdisent). Si aucune instance n'est joignable,
  le lecteur retombe sur l'iframe YouTube en qualité minimale, pour que le
  titre se lance quand même.

Le mode **Vidéo (MP4)** reste réservé à YouTube, en qualité normale.

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
| `JAMENDO_CLIENT_ID` | Facultatif : la 2ᵉ source de MP3 libres (rayon « MP3 libre » de l'espace Musique) — voir « Brancher Jamendo » |
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

## Brancher Jamendo (facultatif, 5 minutes)

À quoi ça sert : Internet Archive est une bibliothèque (concerts, netlabels,
ethnomusicologie) — on y trouve peu de sons « du moment ». **Jamendo** est un
catalogue de musique actuelle publiée sous licence Creative Commons par les
artistes eux-mêmes, avec un point d'accès public qui donne, pour chaque piste,
l'URL du **MP3 réel** (`audioformat=mp32`, VBR) et, quand l'artiste l'autorise,
son lien de téléchargement (`audiodownload`). Brancher cette source ajoute donc
un catalogue moderne à l'app, avec les mêmes droits : écoute écran éteint,
épinglage hors ligne, fichier enregistrable. Elle est **gratuite pour un usage non
commercial** et limitée à environ 35 000 requêtes par mois — les réponses sont
cachées 15 minutes côté serveur, ce qui laisse une marge confortable pour un site
comme OmniStream.

Étapes :

1. créer un compte sur <https://devportal.jamendo.com/signup> (e-mail + mot de
   passe, lien de confirmation) ;
2. se connecter, puis « My applications » → **Create new application**
   (<https://devportal.jamendo.com/admin/applications>) ;
3. remplir le nom (`OmniStream`), l'URL publique du site, une description courte,
   et choisir le plan **Read only** (lecture seule : aucune écriture, aucun
   compte utilisateur impliqué) ; accepter les conditions d'utilisation ;
4. copier la valeur **Client ID** affichée sur la fiche de l'application — c'est
   la seule information dont l'app a besoin (le `client_secret` ne sert pas pour
   la lecture du catalogue) ;
5. la ranger dans Render : *Environment* → `JAMENDO_CLIENT_ID` → Save, puis
   **Apply** (redéploiement). En local : `.env`/`export JAMENDO_CLIENT_ID=…`
   avant de lancer le serveur ;
6. vérifier, une fois le serveur redémarré : `curl -s
   https://<domaine>/api/mp3?provider=jamendo|head -c 200` doit renvoyer des
   pistes, et la page Musique doit afficher un sélecteur **Internet Archive /
   Jamendo (CC)**.

Sans clé, rien ne casse : le sélecteur n'apparaît pas, le rayon `MP3 libre` reste
sur Internet Archive, et une demande forcée `?provider=jamendo` répond
« JAMENDO_CLIENT_ID n'est pas configurée sur le serveur » au lieu d'une page vide.

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
static/js/musique.js      deux sources (« MP3 libre » / YouTube), épinglage, relais
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

La barre de progression est une vraie commande : 5 px visibles mais une
zone tactile d’une vingtaine de pixels, un repère brillant à la position courante
et aucun temps mort pendant un glissement. Un MP3 téléchargé progressivement
n’annonce pas toujours sa durée (`el.duration` infini ou absent) : la durée
connue de la source sert alors de repère, sinon la barre resterait à 0 % et
avancer dans le morceau deviendrait impossible. Si la durée est réellement
inconnue, c’est dit à l’utilisateur au lieu de laisser un bouton muet.

**Écran verrouillé.** `MediaSession` (titre, pochette, position, `playbackState`)
garde les contrôles accessibles sur l'écran de verrouillage ; une petite session
audio silencieuse est maintenue tant que la lecture dure pour éviter qu'Android
ne gèle l'onglet ; la position est mémorisée toutes les 5 secondes, donc une
coupure reprend à l'endroit exact. L'option « Écran allumé » du panneau agrandi
demande un verrou d'écran (désactivée par défaut, aucune consommation de batterie
sans demande explicite).

**Hors ligne.** `static/service-worker.js` met en cache le shell (CSS, JS, polices,
icônes), les images, les pages HTML et les réponses JSON déjà vues ; une fiche
épinglée est rapatriée intégralement (synopsis, affiche, miniature). Les
**MP3 libres** étant des fichiers, épinglés ils se relisent sans réseau, et le
worker répond même aux demandes de plage (à partir du fichier enregistré) pour
que naviguer dans le morceau fonctionne hors connexion. Le compte « ôpingler »
attend la réponse du worker (délai calculé sur la taille du fichier) : le message
« MP3 enregistré » n’apparaît que si le morceau est réellement en cache, et la page
« Hors ligne » écrit « MP3 · 0 Mo HORS LIGNE » au lieu de promettre un réseau
inutile à un fichier déjà là. YouTube et TMDB,
en revanche, interdisent le téléchargement de leurs flux : **le son et la vidéo
d'un clip ne peuvent pas être stockés** ; un titre lancé sans réseau passe en
attente (« Hors ligne · en attente de réseau ») et démarre seul au retour de la
connexion. Un MP3 déjà joué est gardé en mémoire (12 fichiers, cache
`omnistream-vN-audio`), jamais si l'appareil a demandé d'économiser les données.

**Musique écran éteint.** La règle tient en une ligne : ce que joue
l'élément `<audio>` du navigateur survit à l'extinction de l'écran et à
l'écran verrouillé (les **MP3 libres** sont dans ce cas) ; ce que joue l'iframe
YouTube n'y survit pas, parce que le lecteur YouTube se met en pause dès que la
page passe en arrière-plan — et que ses conditions l'interdisent de toute
façon. Quand cette bascule devient la réalité de l'écoute, l'application le dit
au lieu de laisser croire à un bug. Trois gardiens complètent : `MediaSession`
(métadonnées, `playbackState`, position tenue par les événements média, car les
minuteurs de la page sont gelés par Android), reprise automatique bornée mais
têtue (2 s → 9 s, 24 essais) quand le système coupe le son, et préchargement
`auto` du fichier pour traverser les ralentissements du réseau. Reste une
limite qu'aucune page web ne peut franchir : une PWA fermée depuis les
applications récentes est détruite par l'OS, donc sa lecture s'arrête — il faut
laisser l'application ouverte, ou piloter la musique depuis la notification.

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

**Relais de fichier.** `/mp3/<identifiant>/<fichier>.mp3` n'est pas un proxy
média : il sert à donner au fichier son nom et un
`Content-Disposition: attachment`, seuls moyens d'obtenir un véritable
enregistrement sur le téléphone (un lien cross-origin, même muni de `download`,
est ignoré par les navigateurs). Toute extension autre que `.mp3`, tout chemin
inattendu et tout fichier de plus de 80 Mo sont refusés ; les en-têtes `Range`
sont transmis, donc une copie interrompue peut reprendre. La lecture, elle,
part directement sur `archive.org` : aucun octet de musique ne transite par le
serveur.

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
  d'images refuse toute URL extérieure à sa liste d'hôtes autorisés
  (`uploads.mangadex.org` et le CDN d'AniList).
- Le synopsis renvoyé par AniList arrive en HTML : toutes les balises sont
  retirées et les entités décodées avant l'affichage, rien de tiers n'est
  injecté dans la page. Les fiches au contenu adulte sont refusées (404).
- Aucun script publicitaire de notification n'est chargé. L'ancien service
  worker push est désabonné et supprimé lors de la prochaine visite.
- Le Smartlink sponsorisé ne s'ouvre qu'après un clic volontaire sur le petit
  cadeau flottant ; le bouton de lecture des scans ouvre uniquement le lecteur.
