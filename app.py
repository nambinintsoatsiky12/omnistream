import os
import datetime
import random
import time
import functools
from werkzeug.security import generate_password_hash, check_password_hash
import requests
from flask import Flask, render_template, request, jsonify, redirect, url_for, session

import auth_db
from mailer import send_verification_email, send_password_reset_email

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "change-moi-en-production-1234567890")
auth_db.init_db()

# ---------------------------------------------------------------------------
# Configuration — set these as environment variables on PythonAnywhere
# ---------------------------------------------------------------------------
TMDB_API_KEY = os.environ.get("TMDB_API_KEY", "")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

TMDB_BASE = "https://api.themoviedb.org/3"
IMG_BASE = "https://image.tmdb.org/t/p/w500"
BACKDROP_BASE = "https://image.tmdb.org/t/p/w1280"

WESTERN_ORIGINS = "US|GB|FR|CA|DE|ES|IT|BE"
MAX_PAGES = 25

_cache = {}


# ---------------------------------------------------------------------------
# Authentification : inscription, connexion, vérification e-mail
# ---------------------------------------------------------------------------

def login_required(view):
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            return redirect(url_for("login"))
        return view(*args, **kwargs)
    return wrapped


@app.route("/signup", methods=["GET", "POST"])
def signup():
    if request.method == "POST":
        first_name = request.form.get("first_name", "").strip()
        last_name = request.form.get("last_name", "").strip()
        email = request.form.get("email", "").strip()
        password = request.form.get("password", "")
        accept = request.form.get("accept_privacy")

        form_state = {"first_name": first_name, "last_name": last_name, "email": email}

        if not first_name or not last_name:
            return render_template("signup.html", error="Merci de renseigner votre prénom et votre nom.", **form_state)
        if not accept:
            return render_template("signup.html", error="Vous devez accepter la politique de confidentialité pour continuer.", **form_state)
        if len(password) < 8:
            return render_template("signup.html", error="Le mot de passe doit contenir au moins 8 caractères.", **form_state)
        if auth_db.get_user_by_email(email):
            return render_template("signup.html", error="Un compte existe déjà avec cette adresse e-mail.", **form_state)

        password_hash = generate_password_hash(password)
        token = auth_db.create_user(first_name, last_name, email, password_hash)
        if not token:
            return render_template("signup.html", error="Un compte existe déjà avec cette adresse e-mail.", **form_state)

        verify_url = url_for("verify_email", token=token, _external=True)
        send_verification_email(email, verify_url, first_name)

        return render_template("check_email.html", email=email)

    return render_template("signup.html")


@app.route("/verify/<token>")
def verify_email(token):
    ok = auth_db.verify_user_by_token(token)
    if ok:
        return render_template("login.html", error="Votre compte a été confirmé avec succès. Vous pouvez maintenant vous connecter.")
    return render_template("login.html", error="Ce lien de confirmation est invalide ou a déjà été utilisé.")


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        email = request.form.get("email", "").strip()
        password = request.form.get("password", "")

        user = auth_db.get_user_by_email(email)
        if not user or not check_password_hash(user["password_hash"], password):
            return render_template("login.html", error="E-mail ou mot de passe incorrect.", email=email)
        if not user["verified"]:
            return render_template("login.html", error="Veuillez confirmer votre adresse e-mail avant de vous connecter (consultez votre boîte de réception).", email=email)

        session["user_id"] = user["id"]
        session["user_email"] = user["email"]
        session["user_first_name"] = user["first_name"]
        if request.form.get("remember"):
            session.permanent = True
        return redirect(url_for("index"))

    return render_template("login.html")

@app.route("/mot-de-passe-oublie", methods=["GET", "POST"])
def forgot_password():
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        user = auth_db.get_user_by_email(email)
        if user:
            token = auth_db.create_password_reset_token(email)
            reset_url = url_for("reset_password", token=token, _external=True)
            send_password_reset_email(email, reset_url, user["first_name"])
        # Même message qu'un compte existe ou non, pour ne pas révéler
        # quels e-mails sont inscrits sur le site.
        return render_template(
            "forgot_password.html",
            message="Si un compte existe avec cette adresse, un e-mail de réinitialisation vient d'être envoyé.",
        )
    return render_template("forgot_password.html")


@app.route("/reinitialiser-mot-de-passe/<token>", methods=["GET", "POST"])
def reset_password(token):
    user = auth_db.get_user_by_reset_token(token)
    if not user:
        return render_template(
            "login.html",
            error="Ce lien de réinitialisation est invalide ou a expiré. Merci de refaire une demande.",
        )

    if request.method == "POST":
        password = request.form.get("password", "")
        password_confirm = request.form.get("password_confirm", "")
        if len(password) < 8:
            return render_template("reset_password.html", token=token, error="Le mot de passe doit contenir au moins 8 caractères.")
        if password != password_confirm:
            return render_template("reset_password.html", token=token, error="Les mots de passe ne correspondent pas.")

        new_hash = generate_password_hash(password)
        auth_db.update_password_and_clear_token(user["id"], new_hash)
        return render_template(
            "login.html",
            error="Votre mot de passe a été changé avec succès. Vous pouvez maintenant vous connecter.",
        )

    return render_template("reset_password.html", token=token)    

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/confidentialite")
def privacy():
    return render_template("privacy.html")


@app.route("/supprimer-compte", methods=["GET", "POST"])
@login_required
def delete_account():
    if request.method == "POST":
        password = request.form.get("password", "")
        user = auth_db.get_user_by_id(session["user_id"])
        if not user or not check_password_hash(user["password_hash"], password):
            return render_template("delete_account.html", error="Mot de passe incorrect.")
        auth_db.delete_user(user["id"])
        session.clear()
        return render_template("account_deleted.html")

    return render_template("delete_account.html")


ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "").lower().strip()


def admin_required(view):
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        user_id = session.get("user_id")
        if not user_id:
            return redirect(url_for("login"))
        user = auth_db.get_user_by_id(user_id)
        if not user or user["email"].lower() != ADMIN_EMAIL:
            return redirect(url_for("index"))
        return view(*args, **kwargs)
    return wrapped


@app.route("/admin")
@admin_required
def admin_dashboard():
    return render_template(
        "admin.html",
        total_members=auth_db.count_users(),
        total_visits=auth_db.get_total_visits(),
        members=auth_db.get_all_users(),
        visits_series=auth_db.get_daily_visits(30),
        signups_series=auth_db.get_signups_per_day(30),
    )
def tmdb_get(path, params=None):
    params = dict(params or {})
    params["api_key"] = TMDB_API_KEY
    params.setdefault("language", "en-US")
    key = (path, tuple(sorted(params.items())))
    if key in _cache:
        return _cache[key]
    r = requests.get(f"{TMDB_BASE}{path}", params=params, timeout=10)
    r.raise_for_status()
    data = r.json()
    _cache[key] = data
    return data


def normalize_card(item, media_type):
    title = item.get("title") or item.get("name") or "Sans titre"
    date = item.get("release_date") or item.get("first_air_date") or ""
    return {
        "id": item.get("id"),
        "media_type": media_type,
        "title": title,
        "year": date[:4] if date else "",
        "date": date,
        "rating": round(item.get("vote_average", 0), 1),
        "poster": f"{IMG_BASE}{item['poster_path']}" if item.get("poster_path") else None,
        "backdrop": f"{BACKDROP_BASE}{item['backdrop_path']}" if item.get("backdrop_path") else None,
        "overview": item.get("overview", ""),
        "original_language": item.get("original_language"),
        "origin_country": item.get("origin_country", []),
    }


def get_genres(media_type):
    cache_key = f"genres_{media_type}"
    if cache_key in _cache:
        return _cache[cache_key]
    data = tmdb_get(f"/genre/{media_type}/list")
    genres = data.get("genres", [])
    _cache[cache_key] = genres
    return genres


def get_keyword_id(name):
    cache_key = f"kw_{name.lower()}"
    if cache_key in _cache:
        return _cache[cache_key]
    data = tmdb_get("/search/keyword", {"query": name})
    results = data.get("results", [])
    kid = results[0]["id"] if results else None
    _cache[cache_key] = kid
    return kid


ANIME_SUBGENRES = [
    {"id": "shonen", "label": "Shonen", "keyword": "shounen"},
    {"id": "isekai", "label": "Isekai / Réincarnation", "keyword": "isekai"},
    {"id": "shoujo", "label": "Shoujo", "keyword": "shoujo"},
    {"id": "romance", "label": "Romance", "keyword": "anime romance"},
    {"id": "horreur", "label": "Horreur", "keyword": "horror"},
    {"id": "sport", "label": "Sport", "keyword": "sports"},
    {"id": "comedie", "label": "Comédie", "keyword": "comedy"},
]

FILM_BONUS_PILLS = [
    {"id": "zombie", "label": "Zombie", "genre": 27, "keyword": "zombie"},
    {
        "id": "romance_intense",
        "label": "Romance Intense",
        "keywords": ["erotic romance", "erotic thriller", "seduction", "based on bestselling novel", "sex scene"],
    },
]


def seeded_block_shuffle(items, seed_key, block_size=4):
    """Mélange les items par petits paquets, avec une graine fixe.
    Garde l'ordre général (popularité/note) mais varie l'ordre exact
    à chaque nouvelle graine (donc à chaque nouvelle visite du site)."""
    rng = random.Random(seed_key)
    result = list(items)
    for i in range(0, len(result), block_size):
        block = result[i:i + block_size]
        rng.shuffle(block)
        result[i:i + block_size] = block
    return result


def base_discover_params(tab):
    if tab == "films":
        return "movie", {"sort_by": "popularity.desc"}
    if tab == "series":
        return "tv", {"sort_by": "popularity.desc"}
    if tab == "animes":
        return "tv", {"sort_by": "popularity.desc", "with_genres": "16", "with_origin_country": "JP"}
    if tab == "animation_occidentale":
        return "movie", {"sort_by": "popularity.desc", "with_genres": "16", "with_origin_country": WESTERN_ORIGINS}
    return "movie", {"sort_by": "popularity.desc"}


def search_by_tab(tab, query):
    if tab == "films":
        data = tmdb_get("/search/movie", {"query": query, "include_adult": "true"})
        results = [i for i in data.get("results", []) if i.get("original_language") != "ja" or 16 not in (i.get("genre_ids") or [])]
        return [normalize_card(i, "movie") for i in results if i.get("poster_path")]

    if tab == "series":
        data = tmdb_get("/search/tv", {"query": query, "include_adult": "true"})
        results = [i for i in data.get("results", []) if not (16 in (i.get("genre_ids") or []) and "JP" in (i.get("origin_country") or []))]
        return [normalize_card(i, "tv") for i in results if i.get("poster_path")]

    if tab == "animes":
        data = tmdb_get("/search/tv", {"query": query, "include_adult": "true"})
        results = [i for i in data.get("results", []) if 16 in (i.get("genre_ids") or []) and "JP" in (i.get("origin_country") or [])]
        return [normalize_card(i, "tv") for i in results if i.get("poster_path")]

    if tab == "animation_occidentale":
        data = tmdb_get("/search/movie", {"query": query, "include_adult": "true"})
        results = [i for i in data.get("results", []) if 16 in (i.get("genre_ids") or []) and i.get("original_language") != "ja"]
        return [normalize_card(i, "movie") for i in results if i.get("poster_path")]

    return []


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    if not session.get("user_id"):
        visits = auth_db.increment_and_get_visit_counter()
        members = auth_db.count_users()

        # Affiches populaires (films + animés) pour le mur d'affiches animé
        # en arrière-plan de la page d'accueil.
        posters = []
        try:
            movies = tmdb_get("/discover/movie", {"sort_by": "popularity.desc"})
            animes = tmdb_get("/discover/tv", {
                "sort_by": "popularity.desc", "with_genres": "16", "with_origin_country": "JP",
            })
            pool = (movies.get("results", []) + animes.get("results", []))
            posters = [f"{IMG_BASE}{i['poster_path']}" for i in pool if i.get("poster_path")]
        except Exception:
            posters = []

        return render_template(
            "landing.html", visits=visits, members=members, posters=posters
        )

    tab = request.args.get("tab", "films")
    query = request.args.get("q", "").strip()

    if query:
        results = search_by_tab(tab, query)
        return render_template("index.html", tab=tab, items=results, query=query)

    return render_template("index.html", tab=tab, items=None, query="")


@app.route("/details/<media_type>/<int:item_id>")
@login_required
def details(media_type, item_id):
    if media_type not in ("movie", "tv"):
        return "Type invalide", 404

    origin_tab = request.args.get("tab", "films")

    data = tmdb_get(f"/{media_type}/{item_id}", {"append_to_response": "credits,videos", "language": "fr-FR"})

    title = data.get("title") or data.get("name")
    date = data.get("release_date") or data.get("first_air_date") or ""
    cast = [c["name"] for c in data.get("credits", {}).get("cast", [])[:6]]
    genres = [g["name"] for g in data.get("genres", [])]
    overview = data.get("overview")

    if not overview:
        data_en = tmdb_get(f"/{media_type}/{item_id}", {"language": "en-US"})
        overview = data_en.get("overview")
        if not title or title == data.get("original_title") or title == data.get("original_name"):
            title = data_en.get("title") or data_en.get("name") or title

    item = {
        "id": item_id,
        "media_type": media_type,
        "title": title,
        "year": date[:4] if date else "",
        "rating": round(data.get("vote_average", 0), 1),
        "overview": overview or "Pas de synopsis disponible.",
        "poster": f"{IMG_BASE}{data['poster_path']}" if data.get("poster_path") else None,
        "backdrop": f"{BACKDROP_BASE}{data['backdrop_path']}" if data.get("backdrop_path") else None,
        "genres": genres,
        "cast": cast,
        "runtime": data.get("runtime") or (data.get("episode_run_time") or [None])[0],
        "original_language": data.get("original_language"),
        "origin_country": data.get("origin_country", []),
    }
    return render_template("detail.html", item=item, tab=origin_tab)


# ---------------------------------------------------------------------------
# JSON API
# ---------------------------------------------------------------------------

@app.route("/api/genres")
def api_genres():
    tab = request.args.get("tab", "films")
    pills = [{"id": "all", "label": "Tout"}]

    if tab == "animes":
        pills += [{"id": p["id"], "label": p["label"]} for p in ANIME_SUBGENRES]
    else:
        media_type, _ = base_discover_params(tab)
        pills += [{"id": str(g["id"]), "label": g["name"]} for g in get_genres(media_type)]
        if tab == "films":
            pills += [{"id": p["id"], "label": p["label"]} for p in FILM_BONUS_PILLS]

    return jsonify({"pills": pills})


@app.route("/api/hero")
def api_hero():
    tab = request.args.get("tab", "films")
    media_type, base_params = base_discover_params(tab)
    date_field = "primary_release_date" if media_type == "movie" else "first_air_date"

    top_rated = tmdb_get(f"/discover/{media_type}", {
        **base_params, "sort_by": "vote_average.desc", "vote_count.gte": 200,
    }).get("results", [])

    newest = tmdb_get(f"/discover/{media_type}", {
        **base_params, "sort_by": f"{date_field}.desc",
        f"{date_field}.lte": datetime.date.today().isoformat(),
        "vote_count.gte": 5,
    }).get("results", [])

    trending = tmdb_get(f"/trending/{media_type}/day", {}).get("results", [])
    if tab == "animes":
        trending = [i for i in trending if 16 in (i.get("genre_ids") or []) and "JP" in (i.get("origin_country") or [])]
    elif tab == "animation_occidentale":
        trending = [i for i in trending if 16 in (i.get("genre_ids") or [])]

    top_rated = [i for i in top_rated if i.get("vote_average", 0) >= 9 and i.get("backdrop_path")]
    newest = [i for i in newest if i.get("backdrop_path")]
    trending = [i for i in trending if i.get("backdrop_path")]

    seen, candidates = set(), []
    for i in (top_rated[:8] + trending[:8] + newest[:8]):
        if i["id"] not in seen:
            seen.add(i["id"])
            candidates.append(normalize_card(i, media_type))

    anchors = candidates[:2]
    pool = candidates[2:]
    rng = random.Random(int(time.time() // 900) + hash(tab))
    rng.shuffle(pool)

    merged = anchors + pool
    return jsonify({"items": merged[:10]})


@app.route("/api/list")
def api_list():
    tab = request.args.get("tab", "films")
    genre = request.args.get("genre", "all")
    page = min(max(int(request.args.get("page", 1)), 1), MAX_PAGES)
    seed = request.args.get("seed", "0")

    media_type, params = base_discover_params(tab)
    params = dict(params)
    params["page"] = page
    params["include_adult"] = "true"
    if genre != "all":
        if tab == "animes":
            pill = next((p for p in ANIME_SUBGENRES if p["id"] == genre), None)
            if pill:
                kw_id = get_keyword_id(pill["keyword"])
                if kw_id:
                    params["with_keywords"] = kw_id
        elif tab == "films" and any(p["id"] == genre for p in FILM_BONUS_PILLS):
            bonus = next(p for p in FILM_BONUS_PILLS if p["id"] == genre)
            if "keywords" in bonus:
                # Plusieurs mots-clés combinés en "OU" (pas de genre imposé),
                # pour couvrir aussi les films tagués Drame/Thriller.
                kw_ids = [str(get_keyword_id(k)) for k in bonus["keywords"] if get_keyword_id(k)]
                if kw_ids:
                    params["with_keywords"] = "|".join(kw_ids)
            else:
                kw_id = get_keyword_id(bonus["keyword"])
                params["with_genres"] = f"{params.get('with_genres', '')},{bonus['genre']}".strip(",")
                if kw_id:
                    params["with_keywords"] = kw_id
        elif genre.isdigit():
            existing = params.get("with_genres", "")
            params["with_genres"] = f"{existing},{genre}".strip(",") if existing else genre

    data = tmdb_get(f"/discover/{media_type}", params)
    items = [normalize_card(i, media_type) for i in data.get("results", []) if i.get("poster_path")]
    items = seeded_block_shuffle(items, f"list-{tab}-{genre}-{page}-{seed}")
    total_pages = data.get("total_pages", 1)
    has_more = page < min(total_pages, MAX_PAGES)

    return jsonify({"items": items, "page": page, "has_more": has_more})


@app.route("/api/upcoming")
def api_upcoming():
    media_filter = request.args.get("type", "all")
    page = min(max(int(request.args.get("page", 1)), 1), MAX_PAGES)
    seed = request.args.get("seed", "0")
    today = datetime.date.today().isoformat()

    items = []

    if media_filter in ("all", "movie"):
        d = tmdb_get("/discover/movie", {
            "sort_by": "primary_release_date.asc",
            "primary_release_date.gte": today,
            "page": page,
        })
        items += [normalize_card(i, "movie") for i in d.get("results", []) if i.get("poster_path")]

    if media_filter in ("all", "tv"):
        d = tmdb_get("/discover/tv", {
            "sort_by": "first_air_date.asc",
            "first_air_date.gte": today,
            "page": page,
        })
        items += [normalize_card(i, "tv") for i in d.get("results", []) if i.get("poster_path")]

    if media_filter == "anime":
        d = tmdb_get("/discover/tv", {
            "sort_by": "first_air_date.asc",
            "first_air_date.gte": today,
            "with_genres": "16",
            "with_origin_country": "JP",
            "page": page,
        })
        items = [normalize_card(i, "tv") for i in d.get("results", []) if i.get("poster_path")]

    items.sort(key=lambda x: x["date"] or "9999-99-99")
    items = seeded_block_shuffle(items, f"upcoming-{media_filter}-{page}-{seed}")
    has_more = len(items) > 0 and page < MAX_PAGES

    return jsonify({"items": items, "page": page, "has_more": has_more})


LEGENDS_RATING_MIN = 8.5
LEGENDS_VOTE_COUNT_MIN = 20


def fetch_best_rated(media_type, extra_params, page):
    d = tmdb_get(f"/discover/{media_type}", {
        **extra_params,
        "sort_by": "vote_average.desc",
        "vote_count.gte": LEGENDS_VOTE_COUNT_MIN,
        "vote_average.gte": LEGENDS_RATING_MIN,
        "page": page,
    })
    results = [
        i for i in d.get("results", [])
        if i.get("poster_path") and i.get("vote_average", 0) >= LEGENDS_RATING_MIN
    ]
    return results, (LEGENDS_RATING_MIN if results else None)


@app.route("/api/legends")
def api_legends():
    media_filter = request.args.get("type", "all")
    page = min(max(int(request.args.get("page", 1)), 1), MAX_PAGES)
    seed = request.args.get("seed", "0")

    items = []
    thresholds_used = []

    if media_filter in ("all", "movie"):
        results, threshold = fetch_best_rated("movie", {}, page)
        if threshold:
            thresholds_used.append(threshold)
        items += [normalize_card(i, "movie") for i in results]

    if media_filter in ("all", "tv"):
        results, threshold = fetch_best_rated("tv", {}, page)
        if threshold:
            thresholds_used.append(threshold)
        items += [normalize_card(i, "tv") for i in results]

    if media_filter == "anime":
        results, threshold = fetch_best_rated("tv", {"with_genres": "16", "with_origin_country": "JP"}, page)
        if threshold:
            thresholds_used.append(threshold)
        items = [normalize_card(i, "tv") for i in results]

    items.sort(key=lambda x: -x["rating"])
    items = seeded_block_shuffle(items, f"legends-{media_filter}-{page}-{seed}")
    has_more = len(items) > 0 and page < MAX_PAGES
    threshold_used = min(thresholds_used) if thresholds_used else None

    return jsonify({"items": items, "page": page, "has_more": has_more, "threshold_used": threshold_used})


# ---------------------------------------------------------------------------
# Gemini chat endpoint
# ---------------------------------------------------------------------------

@app.route("/api/chat", methods=["POST"])
def chat():
    if not GEMINI_API_KEY:
        return jsonify({"error": "GEMINI_API_KEY n'est pas configurée sur le serveur."}), 500

    body = request.get_json(force=True) or {}
    title = body.get("title", "")
    overview = body.get("overview", "")
    year = body.get("year", "")
    genres = ", ".join(body.get("genres", []))
    history = body.get("messages", [])

    today_str = datetime.date.today().strftime("%d/%m/%Y")

    system_instruction = (
        f"Tu es OmniStream Assistant, un expert cinéma/anime/série intégré à un site de streaming. "
        f"Tu as une personnalité drôle, taquine et enthousiaste — pense à un pote cinéphile qui adore "
        f"faire des blagues, PAS à un narrateur de documentaire. Utilise des emojis pour exprimer tes "
        f"émotions (😄🎬🍿✨😱), avec modération, là où ça a du sens naturellement. "
        f"Nous sommes aujourd'hui le {today_str}. Si on te demande la date, l'heure, ou toute info "
        f"relative au temps présent, base-toi STRICTEMENT sur cette date réelle — ne l'invente jamais "
        f"à partir de tes connaissances générales. "
        f"La discussion porte UNIQUEMENT sur ce titre précis : \"{title}\" ({year}). "
        f"Genres : {genres}. Synopsis officiel : {overview}. "
        "Réponds en français, avec des informations complémentaires (acteurs, contexte de production, "
        "œuvre originale, suites, curiosités, avis critique). "
        "RÈGLE STRICTE : 300 mots MAXIMUM par réponse, jamais plus — reste concis même si le sujet est riche. "
        "Si une question sort du sujet de ce titre, ramène poliment (et avec humour) la conversation dessus."
    )

    contents = []
    for m in history:
        role = "model" if m.get("role") == "model" else "user"
        contents.append({"role": role, "parts": [{"text": m.get("content", "")}]})

    payload = {
        "system_instruction": {"parts": [{"text": system_instruction}]},
        "contents": contents,
        "generationConfig": {
            # Désactive la "réflexion" interne du modèle : pour un chat
            # simple comme celui-ci, ça évite plusieurs secondes d'attente
            # inutiles sans perte de qualité notable sur la réponse.
            "thinkingConfig": {"thinkingLevel": "minimal"},
        },
    }

    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent"
    )
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
    }

    try:
        r = requests.post(url, json=payload, headers=headers, timeout=30)
        r.raise_for_status()
        data = r.json()
        reply = (
            data["candidates"][0]["content"]["parts"][0]["text"]
            if data.get("candidates")
            else "Désolé, je n'ai pas pu générer de réponse. 😅"
        )
    except requests.exceptions.Timeout:
        return jsonify({
            "reply": "Oups, je mets trop de temps à répondre là... Retente ta question ! 🍿🤖"
        })
    except requests.exceptions.HTTPError as e:
        if r.status_code == 429:
            return jsonify({
                "reply": (
                    "Woh, doucement ! 😅 Trop de questions d'un coup, je suis à court "
                    "de souffle pour la minute. Retente dans quelques instants ! 🍿"
                )
            })
        return jsonify({"error": f"Erreur Gemini : {e}"}), 502
    except requests.exceptions.RequestException as e:
        return jsonify({"error": f"Erreur Gemini : {e}"}), 502

    words = reply.split()
    if len(words) > 300:
        reply = " ".join(words[:300]) + "…"

    return jsonify({"reply": reply})


@app.route('/lecteur-scan')
def lecteur_scan():
    titre = request.args.get('titre', 'Manga Inconnu')
    return render_template('lecteur.html', titre=titre)

@app.route("/api/mangadex_proxy")
def mangadex_proxy():
    endpoint = request.args.get("endpoint", "")
    if not endpoint:
        return jsonify({"error": "Endpoint manquant"}), 400
    try:
        # Transfert les paramètres reçus vers MangaDex
        params = {k: v for k, v in request.args.items() if k != "endpoint"}
        r = requests.get(f"https://api.mangadex.org{endpoint}", params=params, timeout=10)
        return jsonify(r.json())
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/manga_image")
def manga_image():
    url = request.args.get("url", "")
    if not url:
        return "URL manquante", 400
    try:
        r = requests.get(url, timeout=15)
        return (r.content, r.status_code, {"Content-Type": r.headers.get("Content-Type", "image/jpeg")})
    except Exception as e:
        return str(e), 500

@app.route('/details-vip')
def details_vip():
    titre = request.args.get('titre', 'Anime VIP')
    poster = request.args.get('poster', '')

    item = {
        "id": 0,
        "title": titre,
        "media_type": "anime",
        "overview": f"Bienvenue sur la fiche VIP de {titre}. Lancez la lecture des scans ci-dessous ou discutez directement avec Gemini !",
        "poster": poster,
        "backdrop": poster,
        "rating": 9.5,
        "year": "VIP",
        "genres": ["Animation", "18+"],
        "original_language": "ja",  # <--- ON AJOUTE JUSTE CETTE LIGNE !
        "cast": []
    }
    return render_template("detail.html", item=item)

if __name__ == "__main__":
    app.run(debug=True)
