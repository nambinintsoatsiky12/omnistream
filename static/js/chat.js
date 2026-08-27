(function () {
  "use strict";

  const panel = document.getElementById("chat-panel");
  const messagesEl = document.getElementById("chat-messages");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || "";
  if (!panel || !messagesEl || !form || !input) return;

  let history = [];
  const context = {
    title: panel.dataset.title || "",
    year: panel.dataset.year || "",
    overview: panel.dataset.overview || "",
    genres: panel.dataset.genres ? panel.dataset.genres.split(",").filter(Boolean) : [],
  };

  function addMessage(role, text) {
    const message = document.createElement("div");
    message.className = `msg ${role === "user" ? "user" : "model"}`;
    message.textContent = text;
    messagesEl.appendChild(message);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  const thinkingPhrases = [
    "Recherche en cours",
    "Je fouille mes souvenirs de cinéphile",
    "Je vérifie les dernières infos",
    "Je prépare ma réponse",
  ];

  function startThinkingAnimation(element) {
    let dotCount = 0;
    let phraseIndex = 0;
    element.textContent = thinkingPhrases[0];
    const dotsInterval = window.setInterval(() => {
      dotCount = (dotCount + 1) % 4;
      element.textContent = `${thinkingPhrases[phraseIndex]}${".".repeat(dotCount)}`;
    }, 400);
    const phraseInterval = window.setInterval(() => {
      phraseIndex = (phraseIndex + 1) % thinkingPhrases.length;
    }, 2200);
    return function stop() {
      window.clearInterval(dotsInterval);
      window.clearInterval(phraseInterval);
    };
  }

  form.addEventListener("submit", async function submitQuestion(event) {
    event.preventDefault();
    const question = input.value.trim();
    if (!question) return;

    addMessage("user", question);
    history.push({ role: "user", content: question });
    input.value = "";
    input.disabled = true;

    const thinking = document.createElement("div");
    thinking.className = "msg model thinking";
    messagesEl.appendChild(thinking);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    const stopThinking = startThinkingAnimation(thinking);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 35000);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-CSRF-Token": csrfToken,
        },
        body: JSON.stringify({ ...context, messages: history }),
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "La requête a échoué.");
      if (typeof data.reply !== "string" || !data.reply.trim()) {
        throw new Error("Gemini a renvoyé une réponse vide.");
      }
      addMessage("model", data.reply);
      history.push({ role: "model", content: data.reply });
      // 40 messages + la prochaine question restent sous la limite serveur.
      if (history.length > 40) history = history.slice(-40);
    } catch (error) {
      history.pop(); // Évite deux messages « user » consécutifs au prochain essai.
      const message =
        error.name === "AbortError"
          ? "Gemini met trop de temps à répondre. Réessaie dans un instant."
          : error.message || "Impossible de contacter Gemini pour le moment.";
      addMessage("model", message);
    } finally {
      window.clearTimeout(timeout);
      stopThinking();
      thinking.remove();
      input.disabled = false;
      input.focus();
    }
  });
})();
