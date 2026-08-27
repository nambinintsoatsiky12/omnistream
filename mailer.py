"""Envoi des e-mails transactionnels OmniStream via l'API HTTPS Mailjet."""

from __future__ import annotations

import html
import logging
import os

import requests
from requests.auth import HTTPBasicAuth

MAILJET_API_KEY = os.environ.get("MAILJET_API_KEY", "").strip()
MAILJET_SECRET_KEY = os.environ.get("MAILJET_SECRET_KEY", "").strip()
SENDER_EMAIL = os.environ.get("SENDER_EMAIL", "").strip()
MAIL_BACKEND = os.environ.get("MAIL_BACKEND", "mailjet").strip().lower()
MAILJET_API_URL = "https://api.mailjet.com/v3.1/send"

logger = logging.getLogger(__name__)


def _send_email(to_email, subject, text_body, html_body):
    """Envoie un message et indique explicitement si l'opération a réussi."""

    if MAIL_BACKEND == "console":
        # Pratique uniquement en développement : le lien est visible dans le terminal.
        logger.warning("E-mail de développement pour %s\n%s", to_email, text_body)
        return True
    if MAIL_BACKEND != "mailjet":
        logger.error("MAIL_BACKEND inconnu : %s", MAIL_BACKEND)
        return False
    if not MAILJET_API_KEY or not MAILJET_SECRET_KEY or not SENDER_EMAIL:
        logger.error(
            "MAILJET_API_KEY, MAILJET_SECRET_KEY et SENDER_EMAIL doivent être "
            "configurés."
        )
        return False

    payload = {
        "Messages": [
            {
                "From": {"Email": SENDER_EMAIL, "Name": "OmniStream"},
                "To": [{"Email": to_email}],
                "Subject": subject,
                "TextPart": text_body,
                "HTMLPart": html_body,
            }
        ]
    }
    try:
        response = requests.post(
            MAILJET_API_URL,
            json=payload,
            auth=HTTPBasicAuth(MAILJET_API_KEY, MAILJET_SECRET_KEY),
            timeout=10,
        )
    except requests.RequestException:
        logger.warning("Impossible de joindre Mailjet.", exc_info=True)
        return False

    if response.status_code in {200, 201}:
        return True
    logger.error("Mailjet a refusé l'envoi (HTTP %s).", response.status_code)
    return False


def send_verification_email(to_email, verify_url, first_name=""):
    safe_name = html.escape(first_name.strip(), quote=True)
    safe_url = html.escape(verify_url, quote=True)
    greeting_text = (
        f"Bonjour {first_name.strip()}," if first_name.strip() else "Bonjour,"
    )
    greeting_html = f"Bonjour {safe_name}," if safe_name else "Bonjour,"
    subject = "Confirmez votre adresse e-mail — OmniStream"
    text_body = (
        f"{greeting_text}\n\n"
        "Merci de vous être inscrit sur OmniStream. Pour activer votre compte, "
        "confirmez votre adresse e-mail en ouvrant le lien ci-dessous :\n\n"
        f"{verify_url}\n\n"
        "Ce lien expire dans 24 heures. Si vous n'êtes pas à l'origine de cette "
        "demande, ignorez ce message.\n\n"
        "Cordialement,\nL'équipe OmniStream"
    )
    html_body = (
        f"<p>{greeting_html}</p>"
        "<p>Merci de vous être inscrit sur OmniStream. Pour activer votre compte, "
        "confirmez votre adresse e-mail en ouvrant le lien ci-dessous :</p>"
        f'<p><a href="{safe_url}">{safe_url}</a></p>'
        "<p>Ce lien expire dans 24 heures. Si vous n'êtes pas à l'origine de cette "
        "demande, ignorez ce message.</p>"
        "<p>Cordialement,<br>L'équipe OmniStream</p>"
    )
    return _send_email(to_email, subject, text_body, html_body)


def send_password_reset_email(to_email, reset_url, first_name=""):
    safe_name = html.escape(first_name.strip(), quote=True)
    safe_url = html.escape(reset_url, quote=True)
    greeting_text = (
        f"Bonjour {first_name.strip()}," if first_name.strip() else "Bonjour,"
    )
    greeting_html = f"Bonjour {safe_name}," if safe_name else "Bonjour,"
    subject = "Réinitialisation de votre mot de passe — OmniStream"
    text_body = (
        f"{greeting_text}\n\n"
        "Vous avez demandé à réinitialiser votre mot de passe OmniStream. "
        "Ouvrez le lien ci-dessous pour en choisir un nouveau :\n\n"
        f"{reset_url}\n\n"
        "Ce lien expire dans 1 heure. Si vous n'êtes pas à l'origine de cette "
        "demande, ignorez ce message : votre mot de passe reste inchangé.\n\n"
        "Cordialement,\nL'équipe OmniStream"
    )
    html_body = (
        f"<p>{greeting_html}</p>"
        "<p>Vous avez demandé à réinitialiser votre mot de passe OmniStream. "
        "Ouvrez le lien ci-dessous pour en choisir un nouveau :</p>"
        f'<p><a href="{safe_url}">{safe_url}</a></p>'
        "<p>Ce lien expire dans 1 heure. Si vous n'êtes pas à l'origine de cette "
        "demande, ignorez ce message : votre mot de passe reste inchangé.</p>"
        "<p>Cordialement,<br>L'équipe OmniStream</p>"
    )
    return _send_email(to_email, subject, text_body, html_body)
