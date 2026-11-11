---
title: Kerstel · Local-first secrets for Node and Bun projects
description: Your .env files hold only references. The real values live in an encrypted vault on your machine. No account, no cloud, no telemetry.
---
<section class="hero">
<div class="hero-logo"><img src="/icon-light.png" alt="Kerstel"></div>
<h1>Kerstel</h1>
<p class="tagline">Local-first secrets for Node and Bun projects. Your <code>.env</code> holds references. The values never touch disk in the clear.</p>
<div class="terminal is-ref" role="img" aria-label="Example .env file switching from a plaintext key to a ks: reference">
<div class="terminal-bar"><i></i><i></i><i></i><span>.env</span></div>
<div class="terminal-body"><span class="comment"># safe to read, grep, and commit</span><br><span class="key">OPENAI_API_KEY=</span><span class="val" id="hero-val">ks:global</span><span class="cursor" aria-hidden="true"></span></div>
</div>
<div class="install">
<div class="install-box">
<span class="prompt">$</span>
<code>curl -fsSL https://kerstel.dev/install.sh | bash</code>
<button class="copy-btn" type="button" onclick="copyInstall(this)">Copy</button>
</div>
<p class="install-note">macOS and Linux. Installs <code>kerstel</code> and its shorthand, <code>ks</code>. No account, no cloud, no telemetry.</p>
</div>
</section>

<section class="section">
<div class="section-label">The problem</div>
<h2>Plaintext .env files leak</h2>
<p class="lede">Anything that can read files can read your secrets: AI coding agents, editor plugins, backup tools, and the commit you did not mean to make. Other tools fix this with a cloud account and a wrapper command you type on every run. Kerstel needs no account, and writes its wrapper into your scripts once, so <code>npm run dev</code> is still <code>npm run dev</code>.</p>
</section>

<section class="section">
<div class="section-label">Demo</div>
<h2>The whole flow in 37 seconds</h2>
<p class="lede">A plaintext key becomes a reference, <code>kerstel init</code> migrates the project, and the same wiring runs under npm, Bun, pnpm, and Yarn.</p>
<video class="demo-video" controls playsinline preload="metadata" poster="/brag-poster.jpg" width="1920" height="1080">
<source src="/brag.mp4" type="video/mp4">
</video>
</section>

<section class="section">
<div class="section-label">How it works</div>
<h2>Store once. Reference everywhere.</h2>
<p class="lede">Run <code>ks set global/OPENAI_API_KEY</code> once (<code>ks</code> is short for <code>kerstel</code>). From then on your project file holds <code class="ref">OPENAI_API_KEY=ks:global</code> and your code still reads the real value from <code>process.env</code>. <code>ks init</code> does the whole project at once, and wires your scripts for you.</p>
<div class="steps">
<div class="step"><h3>Vault</h3><p>Values are encrypted at rest with AES-256-GCM. The data key lives in your OS credential store, or in a <code>0600</code> file where there is none.</p></div>
<div class="step"><h3>Daemon</h3><p>A per-user resolver unlocks the vault once and answers lookups over a local socket. Nothing leaves your machine.</p></div>
<div class="step"><h3>Hook</h3><p>A small preload intercepts reads of <code>process.env</code> and swaps each reference for its value. The file on disk never changes.</p></div>
</div>
<a class="more" href="/docs/getting-started">Read the getting started guide →</a>
</section>

<section class="section" id="agent-setup">
<div class="section-label">AI agents</div>
<h2>Let your agent set it up</h2>
<p class="lede">Paste this into Claude Code, Cursor, Codex, or any agent that runs commands in your project. It works through Kerstel's own commands instead of reading your env files, asks you before it changes your project, and adds a Kerstel section to your agent instructions file (AGENTS.md, CLAUDE.md, or your editor's rules) so later sessions manage secrets through Kerstel too.</p>
<div class="agent-prompt">
<div class="agent-prompt-bar"><span>Prompt for your agent</span><button class="copy-btn" type="button" onclick="copyAgentPrompt(this)">Copy prompt</button></div>

<pre id="agent-prompt">Set up Kerstel (https://kerstel.dev) in this project, so its .env files hold references and the secret values live in Kerstel's encrypted vault.

Rules for this whole task:
- Never open, print, grep or copy the contents of an .env file, and never run `kerstel get --reveal`. Use the kerstel commands below to see what is there: they show key names, and mask the values they move into the vault.
- Their output can still show text as it is written in my files: comments in env files (such as a commented-out old key) and package.json scripts. If anything there looks like a secret, don't repeat, copy or summarise it. Tell me the file and line, and let me deal with it.
- Never put a secret value in a command. If a step needs one, ask me to pipe it in from my own terminal, as in `pbpaste | kerstel set &lt;scope&gt;/&lt;KEY&gt;`.
- Don't commit or push anything.

Steps:
1. Run `kerstel --version`. If Kerstel isn't installed, run `curl -fsSL https://kerstel.dev/install.sh | bash`. If it is older than 0.2.0, run `kerstel update`, since the steps below need 0.2.0 or later. If the installer says ~/.local/bin is not on PATH, call it as ~/.local/bin/kerstel for the rest of this task.
2. Run `kerstel scan . --keys`. It lists each env file and the keys it holds in plain text, by line number, never a value. It exits 1 when it finds a secret. That is expected.
3. From the project root (the folder with package.json, or the workspace root of a monorepo), run `kerstel init --dry-run --yes`. It prints the plan and every diff, with the values it moves masked, and writes nothing.
4. Summarise the plan for me: which keys go to this project's vault, which go to the vault shared by all my projects (global), which stay in plain text, which package.json scripts get wired, and which agent instructions file you will add a Kerstel section to (step 7). Then stop and ask me to approve it. If I want a key somewhere else, tell me to run `kerstel init` in my own terminal instead, where it asks me about each one.
5. Once I approve, run `kerstel init --yes`. It backs up the original files, encrypted, before it writes. On macOS the first run may show a Keychain dialog for me to allow.
6. Run `kerstel doctor` and follow any "Fix:" line it prints. Then run `kerstel scan .` again to confirm no secret is left in plain text. If either one names a line it could not read or classify, don't open the file: give me the file and line number, and ask me to check it myself before anything is committed.
7. So that you and other agents use Kerstel for secrets from now on, add the section below to this project's agent instructions file: AGENTS.md, CLAUDE.md, .cursor/rules/, .github/copilot-instructions.md, or whichever one this project's agents read. Use the file that already exists (if CLAUDE.md only imports AGENTS.md, use AGENTS.md), and create AGENTS.md if there is none. If a Kerstel section is already there, replace it. Put this project's scope, from `kerstel ls`, where it says &lt;scope&gt;.

```markdown
## Secrets: Kerstel

This project keeps its secrets in Kerstel (https://kerstel.dev), an encrypted vault on each developer's machine. Env files hold references, not values: `KEY=ks:&lt;scope&gt;` when the vault key has the variable's name, `KEY=ks:&lt;scope&gt;/OTHER_KEY` when it doesn't. This project's scope is &lt;scope&gt;. `global` holds secrets shared by every project on the machine.

- Never read, print, log or paste a secret value, and never run `kerstel get --reveal`. Use `kerstel ls` and `kerstel scan .` rather than opening env files: one may still hold a plaintext secret nobody has moved into the vault.
- Never write a secret value into an env file, code, a command, or a commit. To add or change one, ask the user to pipe it in from their own terminal, as in `pbpaste | kerstel set &lt;scope&gt;/&lt;KEY&gt;`, then add `KEY=ks:&lt;scope&gt;` to the env file yourself.
- `kerstel ls` lists the secrets the vault holds, without values. `kerstel refs` shows which files reference which secrets.
- package.json scripts run through `.kerstel/exec.cjs`, which resolves references when the app reads them. Run scripts as usual (`npm run dev`). For another command, use `kerstel exec -- &lt;command&gt;`. Wrap a new script the way the existing ones are.
- A new plaintext secret in an env file: `kerstel scan .` finds it, and `kerstel init --dry-run --yes` previews moving it into the vault, and `kerstel init --yes` does it and wires any new script. Ask the user before running it.
- To move a key between this project's vault, `global`, and plain text, ask the user, then run `kerstel move &lt;KEY&gt; --to project|global|plaintext --yes`.
- If a reference doesn't resolve, run `kerstel doctor` and follow its "Fix:" lines.
```

8. Tell me which files to commit: the rewritten env files, package.json, .kerstel/exec.cjs, and the instructions file. Leave out any env file with a line from step 6 that I haven't checked yet. If .gitignore still hides the env files, say so: `kerstel init --yes` leaves .gitignore as it is.</pre>
</div>
</section>

<section class="section">
<div class="section-label">Security model</div>
<h2>Clear about what is protected</h2>
<ul class="claims">
<li>No plaintext secret ever sits in a project file. Reading, grepping, or committing <code>.env</code> yields only references.</li>
<li>Each value is encrypted with its own random nonce. The key that unlocks them is held by the macOS Keychain or Linux's Secret Service.</li>
<li>Code that runs inside your project can still read resolved values. That is the boundary Kerstel draws today, and per-process approval is the next step.</li>
</ul>
<a class="more" href="/security">Read the full security model →</a>
</section>
