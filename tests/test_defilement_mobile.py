"""Défilement sur téléphone : ce qui coûte des frames pendant le geste.

Le geste du doigt doit rester à 60 fps. Trois choses le faisaient tomber :

* `overflow-x: hidden` sur `<html>` (conteneur de défilement recalculé à
  chaque frame) et `scroll-behavior: smooth` (interpolation au lieu du
  défilement natif) ;
* des cartes peintes et animées alors qu'elles sont hors écran ;
* des boucles infinies (disque, vinyle, fresque, spinner) qui repeignent
  pendant le défilement.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "static"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def style_css() -> str:
    return read(STATIC / "css" / "style.css")


@pytest.fixture(scope="module")
def shell_js() -> str:
    return read(STATIC / "js" / "app-shell.js")


def bloc(css: str, selector: str) -> str:
    """Le corps d'une règle, sans ses accolades."""
    start = css.index(selector)
    return css[start : css.index("}", start)]


def test_html_ne_fait_plus_conteneur_de_defilement(style_css):
    """`overflow-x: hidden` sur <html> coûte un recalcul par frame."""
    racine = bloc(style_css, "\nhtml {")
    assert "overflow-x: clip" in racine
    assert "overflow-x: hidden" not in racine


def test_le_defilement_doux_est_reserve_au_pointeur_fin(style_css):
    """Au doigt, le smooth retire le défilement natif au navigateur."""
    racine = bloc(style_css, "\nhtml {")
    assert "scroll-behavior" not in racine
    media = re.search(
        r"@media \(hover: hover\) and \(pointer: fine\) \{(.*?)\n\}",
        style_css,
        re.DOTALL,
    )
    assert media, "aucun bloc réservé au pointeur fin"
    assert "scroll-behavior: smooth" in media.group(1)


def test_les_cartes_hors_ecran_ne_sont_plus_peintes(style_css):
    carte = bloc(style_css, "\n.card {")
    assert "content-visibility: auto" in carte
    # Sans taille annoncée, la mise en page saute au retour dans l'écran.
    assert "contain-intrinsic-size" in carte


def test_les_transitions_de_carte_sont_allegees(style_css):
    """Le doigt ne survole rien : transform + ombre ne servaient qu'à ramer."""
    carte = bloc(style_css, "\n.card {")
    assert "transform" not in carte.split("transition:")[-1]
    assert "box-shadow" not in carte.split("transition:")[-1]
    # L'effet complet reste disponible là où un survol existe vraiment.
    assert re.search(
        r"@media \(hover: hover\) and \(pointer: fine\) \{\s*\.card \{",
        style_css,
    )


def test_le_topbar_n_anime_plus_son_fond_au_doigt(style_css):
    barre = bloc(style_css, "\n.topbar {")
    assert "background" not in barre.split("transition:")[-1]
    media = re.search(
        r"@media \(hover: none\), \(pointer: coarse\) \{(.*?)\n\}",
        style_css,
        re.DOTALL,
    )
    assert media, "aucun bloc réservé au pointeur tactile"
    assert "transition: none" in media.group(1)


@pytest.mark.parametrize(
    "cible",
    [
        ".omni-bar-disc.spinning",  # disque de la barre du lecteur
        ".omni-vinyl",  # vinyle de la modale
        ".poster-col-up",  # fresque d'affiches de l'accueil
        ".poster-col-down",
        ".icon-spinner",  # spinner de chargement
    ],
)
def test_les_boucles_infinies_sont_en_pause_pendant_le_defilement(style_css, cible):
    assert f"html.is-scrolling {cible}" in style_css
    pause = bloc(style_css, "\nhtml.is-scrolling .omni-bar-disc.spinning")
    assert "animation-play-state: paused" in pause


def test_le_shell_pose_la_classe_pendant_le_defilement(shell_js):
    assert '"is-scrolling"' in shell_js
    assert 'addEventListener("scroll", markScrolling, { passive: true })' in shell_js
    # ~180 ms d'inactivité avant de relâcher la pause.
    assert re.search(r"SCROLL_IDLE_DELAY = \d{3}", shell_js)


def test_la_pause_ne_reste_pas_collee(shell_js):
    """Onglet masqué pendant le geste : la page ne doit pas rester figée."""
    assert "visibilitychange" in shell_js
    assert 'classList.remove("is-scrolling")' in shell_js
