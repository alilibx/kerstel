// Landing-page behaviour: the .env hero animation, the copy buttons, and the
// Kerstel Terminal download card for the visitor's system.
// Dependency-free. Every other page loads this file too and exits at the first check.
// Marks the download card that matches the visitor's system. Purely a hint:
// every download stays a plain link, and nothing is marked when unsure.
(function () {
  var cards = document.querySelectorAll(".dl-os[data-os]");
  if (!cards.length) return;
  var ua = navigator.userAgent || "";
  var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  var os = null;
  if (/mac/i.test(platform) && !/iPhone|iPad|iPod/.test(ua) && !(navigator.maxTouchPoints > 1)) os = "mac";
  // The Linux builds are x64 only, so an ARM or unknown CPU gets no mark.
  else if (/linux/i.test(platform) && !/android/i.test(ua) && /x86_64|amd64/i.test(navigator.platform + " " + ua)) os = "linux";
  if (!os) return;
  for (var i = 0; i < cards.length; i++) {
    if (cards[i].getAttribute("data-os") === os) cards[i].classList.add("is-yours");
  }
})();

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
  // The first label, kept on the button, so a second click while "Copied"
  // shows can't make "Copied" the label it resets to.
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  function show(message) {
    btn.textContent = message;
    clearTimeout(btn._reset);
    btn._reset = setTimeout(function () { btn.textContent = btn.dataset.label; }, 2000);
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
