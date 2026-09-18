// Landing-page behaviour: the .env hero animation and the install copy button.
// Dependency-free. Every other page loads this file too and exits at the first check.
(function () {
  var val = document.getElementById("hero-val");
  if (!val) return;

  var card = val.closest(".terminal");
  if (!card) return;
  var PLAIN = "sk-live-4f9c1e7b2a8d03e6";
  var REF = "kerstel://global/OPENAI_API_KEY";

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

function copyInstall(btn) {
  var cmd = "curl -fsSL https://kerstel.dev/install.sh | bash";
  if (!navigator.clipboard) {
    btn.textContent = "Copy failed";
    setTimeout(function () { btn.textContent = "Copy"; }, 2000);
    return;
  }
  navigator.clipboard.writeText(cmd).then(function () {
    btn.textContent = "Copied";
    setTimeout(function () { btn.textContent = "Copy"; }, 2000);
  }, function () {
    btn.textContent = "Copy failed";
    setTimeout(function () { btn.textContent = "Copy"; }, 2000);
  });
}
