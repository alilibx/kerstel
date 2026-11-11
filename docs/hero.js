// Landing-page behaviour: the .env hero animation and the copy buttons.
// Dependency-free. Every other page loads this file too and exits at the first check.
(function () {
  var val = document.getElementById("hero-val");
  if (!val) return;

  var card = val.closest(".terminal");
  if (!card) return;
  var PLAIN = "sk-live-4f9c1e7b2a8d03e6";
  var REF = "ks:global";

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    val.textContent = REF;
    card.classList.add("is-ref");
    return;
  }

  function type(text, i, speed, done) {
    if (i > text.length) return done();
    val.textContent = text.slice(0, i);
    setTimeout(function () { type(text, i + 1, speed, done); }, speed);
  }

  function erase(done) {
    var t = val.textContent;
    if (!t.length) return done();
    val.textContent = t.slice(0, -1);
    setTimeout(function () { erase(done); }, 18);
  }

  function loop() {
    card.classList.remove("is-ref");
    val.textContent = "";
    type(PLAIN, 0, 45, function () {
      setTimeout(function () {
        card.classList.add("is-swapping");
        erase(function () {
          card.classList.remove("is-swapping");
          card.classList.add("is-ref");
          type(REF, 0, 30, function () {
            setTimeout(loop, 3200);
          });
        });
      }, 1100);
    });
  }

  loop();
})();

function copyText(btn, text) {
  var label = btn.textContent;
  function show(message) {
    btn.textContent = message;
    setTimeout(function () { btn.textContent = label; }, 2000);
  }
  if (!navigator.clipboard) return show("Copy failed");
  navigator.clipboard.writeText(text).then(function () { show("Copied"); }, function () { show("Copy failed"); });
}

function copyInstall(btn) {
  copyText(btn, "curl -fsSL https://kerstel.dev/install.sh | bash");
}

// Copies the prompt exactly as the page shows it, so the two can't drift.
function copyAgentPrompt(btn) {
  var prompt = document.getElementById("agent-prompt");
  if (prompt) copyText(btn, prompt.textContent);
}
