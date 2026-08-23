"""
Envoi de l'e-mail de vérification via le serveur SMTP de Gmail —
le seul serveur SMTP autorisé sur un compte PythonAnywhere gratuit.

Nécessite deux variables d'environnement :
  GMAIL_ADDRESS       : l'adresse Gmail complète utilisée pour l'envoi
  GMAIL_APP_PASSWORD  : un "mot de passe d'application" Google (PAS le
                        mot de passe normal du compte)
"""
import os
import smtplib
from email.mime.text import MIMEText

GMAIL_ADDRESS = os.environ.get("GMAIL_ADDRESS", "")
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "")


def send_verification_email(to_email, verify_url, first_name=""):
    if not GMAIL_ADDRESS or not GMAIL_APP_PASSWORD:
        print("GMAIL_ADDRESS / GMAIL_APP_PASSWORD non configurés — e-mail non envoyé.")
        return False

    greeting = f"Bonjour {first_name}," if first_name else "Bonjour,"
    subject = "Confirmez votre adresse e-mail — OmniStream"
    body = (
        f"{greeting}\n\n"
        f"Merci de vous être inscrit sur OmniStream. Pour activer votre compte, "
        f"veuillez confirmer votre adresse e-mail en cliquant sur le lien ci-dessous :\n\n"
        f"{verify_url}\n\n"
        f"Ce lien expirera si vous ne l'utilisez pas. Si vous n'êtes pas à l'origine "
        f"de cette demande, vous pouvez ignorer ce message en toute sécurité.\n\n"
        f"Cordialement,\n"
        f"L'équipe OmniStream"
    )

    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = f"OmniStream <{GMAIL_ADDRESS}>"
    msg["To"] = to_email

    try:
        with smtplib.SMTP("smtp.gmail.com", 587, timeout=10) as server:
            server.starttls()
            server.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
            server.sendmail(GMAIL_ADDRESS, [to_email], msg.as_string())
        return True
    except Exception as e:
        print(f"Erreur envoi e-mail : {e}")
        return False
