import mailer


def test_verification_email_escapes_html(monkeypatch):
    captured = {}

    def capture(to_email, subject, text_body, html_body):
        captured.update(
            to_email=to_email,
            subject=subject,
            text_body=text_body,
            html_body=html_body,
        )
        return True

    monkeypatch.setattr(mailer, "_send_email", capture)

    assert mailer.send_verification_email(
        "alice@example.com",
        'https://example.com/verify/a?next="danger"&x=1',
        '<img src=x onerror="alert(1)">',
    )
    assert "<img" not in captured["html_body"]
    assert "&lt;img" in captured["html_body"]
    assert "&quot;danger&quot;&amp;x=1" in captured["html_body"]


def test_console_backend_reports_success(monkeypatch):
    monkeypatch.setattr(mailer, "MAIL_BACKEND", "console")

    assert mailer._send_email("alice@example.com", "Sujet", "Texte", "<p>Texte</p>")
