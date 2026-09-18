---
title: Kerstel · Local-first secrets for Node and Bun projects
description: Your .env files hold only references. The real values live in an encrypted vault on your machine. No account, no cloud, no telemetry.
---
<section class="hero">
<div class="hero-logo"><img src="/icon-light.png" alt="Kerstel"></div>
<h1>Kerstel</h1>
<p class="tagline">Local-first secrets for Node and Bun projects. Your <code>.env</code> holds references. The values never touch disk in the clear.</p>
<div class="terminal is-ref" role="img" aria-label="Example .env file switching from a plaintext key to a kerstel:// reference">
<div class="terminal-bar"><i></i><i></i><i></i><span>.env</span></div>
<div class="terminal-body"><span class="comment"># safe to read, grep, and commit</span><br><span class="key">OPENAI_API_KEY=</span><span class="val" id="hero-val">kerstel://global/OPENAI_API_KEY</span><span class="cursor" aria-hidden="true"></span></div>
</div>
<div class="install">
<div class="install-box">
<span class="prompt">$</span>
<code>curl -fsSL https://kerstel.dev/install.sh | bash</code>
<button class="copy-btn" type="button" onclick="copyInstall(this)">Copy</button>
</div>
<p class="install-note">macOS, Linux, and Windows. No account, no cloud, no telemetry.</p>
</div>
</section>

<section class="section">
<div class="section-label">The problem</div>
<h2>Plaintext .env files leak</h2>
<p class="lede">Anything that can read files can read your secrets: AI coding agents, editor plugins, backup tools, and the commit you did not mean to make. Other tools fix this with a cloud account and a wrapper command. Kerstel asks for neither.</p>
</section>

<section class="section">
<div class="section-label">How it works</div>
<h2>Store once. Reference everywhere.</h2>
<p class="lede">Run <code>kerstel set global/OPENAI_API_KEY</code> once. From then on your project file holds <code class="ref">kerstel://global/OPENAI_API_KEY</code> and your code still reads the real value from <code>process.env</code>.</p>
<div class="steps">
<div class="step"><h3>Vault</h3><p>Values are encrypted at rest with AES-256-GCM. The data key lives in your OS credential store, never in a file.</p></div>
<div class="step"><h3>Daemon</h3><p>A per-user resolver unlocks the vault once and answers lookups over a local socket. Nothing leaves your machine.</p></div>
<div class="step"><h3>Hook</h3><p>A small preload intercepts reads of <code>process.env</code> and swaps each reference for its value. The file on disk never changes.</p></div>
</div>
<a class="more" href="/docs/getting-started">Read the getting started guide →</a>
</section>

<section class="section">
<div class="section-label">Security model</div>
<h2>Clear about what is protected</h2>
<ul class="claims">
<li>No plaintext secret ever sits in a project file. Reading, grepping, or committing <code>.env</code> yields only references.</li>
<li>Each value is encrypted with its own random nonce. The key that unlocks them is held by macOS Keychain, Secret Service, or Windows Credential Manager.</li>
<li>Code that runs inside your project can still read resolved values. That is the boundary Kerstel draws today, and per-process approval is the next step.</li>
</ul>
<a class="more" href="/security">Read the full security model →</a>
</section>
