"""
Envoi de l'e-mail de vérification via l'API HTTPS de Mailjet —
utilisé à la place du SMTP Gmail, car Render bloque le trafic sortant sur
les ports SMTP (25, 465, 587) pour les services gratuits. L'API Mailjet
passe par HTTPS (port 443), qui n'est jamais bloqué.

Nécessite trois variables d'environnement :
  MAILJET_API_KEY    : ta clé API Mailjet (Primary API Key)
  MAILJET_SECRET_KEY : ta clé secrète Mailjet (Secret Key)
  SENDER_EMAIL         : ton adresse Gmail déjà validée comme expéditeur
                          dans Mailjet (Domains and senders > Active)
"""
import os
import requests
from requests.auth import HTTPBasicAuth

MAILJET_API_KEY = os.environ.get("MAILJET_API_KEY", "")
MAILJET_SECRET_KEY = os.environ.get("MAILJET_SECRET_KEY", "")
SENDER_EMAIL = os.environ.get("SENDER_EMAIL", "")

MAILJET_API_URL = "https://api.mailjet.com/v3.1/send"


def send_verification_email(to_email, verify_url, first_name=""):
    if not MAILJET_API_KEY or not MAILJET_SECRET_KEY or not SENDER_EMAIL:
        print("MAILJET_API_KEY / MAILJET_SECRET_KEY / SENDER_EMAIL non configurés — e-mail non envoyé.")
        return False

    greeting = f"Bonjour {first_name}," if first_name else "Bonjour,"
    subject = "Confirmez votre adresse e-mail — OmniStream"
    text_body = (
        f"{greeting}\n\n"
        f"Merci de vous être inscrit sur OmniStream. Pour activer votre compte, "
        f"veuillez confirmer votre adresse e-mail en cliquant sur le lien ci-dessous :\n\n"
        f"{verify_url}\n\n"
        f"Ce lien expirera si vous ne l'utilisez pas. Si vous n'êtes pas à l'origine "
        f"de cette demande, vous pouvez ignorer ce message en toute sécurité.\n\n"
        f"Cordialement,\n"
        f"L'équipe OmniStream"
    )
    html_body = (
        f"<p>{greeting}</p>"
        f"<p>Merci de vous être inscrit sur OmniStream. Pour activer votre compte, "
        f"veuillez confirmer votre adresse e-mail en cliquant sur le lien ci-dessous :</p>"
        f'<p><a href="{verify_url}">{verify_url}</a></p>'
        f"<p>Ce lien expirera si vous ne l'utilisez pas. Si vous n'êtes pas à l'origine "
        f"de cette demande, vous pouvez ignorer ce message en toute sécurité.</p>"
        f"<p>Cordialement,<br>L'équipe OmniStream</p>"
    )

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
        if response.status_code in (200, 201):
            return True
        print(f"Erreur envoi e-mail : {response.status_code} — {response.text}")
        return False
    except Exception as e:
        print(f"Erreur envoi e-mail : {e}")
        return False
