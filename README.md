# OmniStream

Site web (Flask) qui affiche Films / Séries / Animes / Animation Occidentale via
l'API TMDB, avec une note pour chaque titre. En cliquant sur un titre, on ouvre
sa fiche détaillée + un chat avec Gemini qui connaît déjà le titre en question
(nouvelle discussion à chaque nouveau titre cliqué).

## 1. Récupérer les clés API

- **TMDB** : crée un compte sur https://www.themoviedb.org/ → Paramètres →
  API → demande une clé "API Key (v3 auth)".
- **Gemini** : va sur https://aistudio.google.com/apikey et génère une clé.

## 2. Installer en local (optionnel, pour tester avant de déployer)

```bash
cd omnistream
python -m venv venv
source venv/bin/activate      # Windows : venv\Scripts\activate
pip install -r requirements.txt

export TMDB_API_KEY="ta_cle_tmdb"        # Windows : set TMDB_API_KEY=...
export GEMINI_API_KEY="ta_cle_gemini"

python app.py
```

Le site sera visible sur http://127.0.0.1:5000

## 3. Déployer sur PythonAnywhere

1. Crée un compte sur https://www.pythonanywhere.com
2. Onglet **Files** : envoie (ou clone via git) le dossier `omnistream/`
   dans ton espace, par exemple `/home/tonpseudo/omnistream`.
3. Onglet **Consoles** → ouvre une console Bash, puis :
   ```bash
   cd omnistream
   pip install --user -r requirements.txt
   ```
4. Onglet **Web** → **Add a new web app** → choisis **Flask** puis la version
   Python. PythonAnywhere crée un fichier WSGI, par exemple
   `/var/www/tonpseudo_pythonanywhere_com_wsgi.py`. Ouvre-le et remplace
   son contenu par :
   ```python
   import sys, os
   path = '/home/tonpseudo/omnistream'
   if path not in sys.path:
       sys.path.append(path)

   os.environ["TMDB_API_KEY"] = "ta_cle_tmdb"
   os.environ["GEMINI_API_KEY"] = "ta_cle_gemini"

   from app import app as application
   ```
5. Toujours sur l'onglet **Web** :
   - **Source code** : `/home/tonpseudo/omnistream`
   - **Working directory** : `/home/tonpseudo/omnistream`
   - **Static files** : URL `/static/` → Directory `/home/tonpseudo/omnistream/static`
6. Clique sur **Reload**. Le site est en ligne sur `tonpseudo.pythonanywhere.com`.

## Structure du projet

```
omnistream/
├── app.py                 → routes Flask + appels TMDB + appel Gemini
├── requirements.txt
├── templates/
│   ├── base.html          → header, logo, barre de recherche, onglets
│   ├── index.html         → grille de films/séries/animes
│   └── detail.html        → fiche détail + chat Gemini
└── static/
    ├── css/style.css      → thème sombre (cyan / orange)
    └── js/chat.js         → logique du chat (une conversation par titre)
```

## Comment fonctionne le chat Gemini

- Chaque page de détail (`/details/<type>/<id>`) contient les infos du titre
  (titre, année, synopsis, genres) dans des attributs `data-*`.
- `chat.js` garde l'historique de conversation **en mémoire dans le
  navigateur**, propre à cette page : dès que tu cliques sur un autre
  film/anime, tu arrives sur une nouvelle page → nouvel historique vide →
  nouvelle discussion.
- À chaque message envoyé, le front-end appelle `/api/chat` avec le titre,
  le synopsis et l'historique. Le serveur construit une instruction système
  ("tu parles uniquement de CE titre") et interroge l'API Gemini, puis
  renvoie la réponse.

## Pistes d'amélioration

- Ajouter la pagination (TMDB renvoie `page` et `total_pages`).
- Distinguer "Mangas" des "Animes" (TMDB ne gère que les films/séries — pour
  de vrais mangas il faudrait ajouter l'API Jikan / MyAnimeList).
- Ajouter des boutons "lecture" pointant vers tes propres sources vidéo
  (TMDB ne fournit aucun lien de streaming).
- Stocker les favoris / historique de recherche (base de données SQLite,
  supportée nativement sur PythonAnywhere).
