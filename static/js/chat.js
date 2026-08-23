(function () {
  const panel = document.getElementById("chat-panel");
  const messagesEl = document.getElementById("chat-messages");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");

  // Chaque page de détail = un nouveau titre = un nouvel historique de discussion.
  // On le garde en mémoire côté navigateur (pas de stockage entre pages : à chaque
  // clic sur un film/anime différent, la conversation Gemini repart de zéro).
  let history = [];

  const context = {
    title: panel.dataset.title,
    year: panel.dataset.year,
    overview: panel.dataset.overview,
    genres: panel.dataset.genres ? panel.dataset.genres.split(",") : [],
  };

  function addMessage(role, text) {
    const div = document.createElement("div");
    div.className = "msg " + (role === "user" ? "user" : "model");
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Petites phrases qui défilent pendant l'attente, façon "vraie réflexion",
  // plutôt qu'un "..." figé qui donne l'impression que ça a planté.
  const THINKING_PHRASES = [
    "Recherche en cours",
    "Je fouille mes souvenirs de cinéphile",
    "Je vérifie les dernières infos",
    "Je prépare ma réponse",
  ];

  function startThinkingAnimation(el) {
    let dotCount = 0;
    let phraseIndex = 0;
    el.textContent = THINKING_PHRASES[0];

    const dotsInterval = setInterval(() => {
      dotCount = (dotCount + 1) % 4;
      el.dataset.dots = ".".repeat(dotCount);
      el.textContent = THINKING_PHRASES[phraseIndex] + el.dataset.dots;
    }, 400);

    const phraseInterval = setInterval(() => {
      phraseIndex = (phraseIndex + 1) % THINKING_PHRASES.length;
    }, 2200);

    return function stop() {
      clearInterval(dotsInterval);
      clearInterval(phraseInterval);
    };
  }

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
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

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: context.title,
          year: context.year,
          overview: context.overview,
          genres: context.genres,
          messages: history,
        }),
      });
      const data = await res.json();
      stopThinking();
      thinking.remove();

      if (data.error) {
        addMessage("model", "Erreur : " + data.error);
      } else {
        addMessage("model", data.reply);
        history.push({ role: "model", content: data.reply });
      }
    } catch (err) {
      stopThinking();
      thinking.remove();
      addMessage("model", "Impossible de contacter Gemini pour le moment.");
    } finally {
      input.disabled = false;
      input.focus();
    }
  });
})();
