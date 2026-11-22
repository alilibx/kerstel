---
title: Kerstel Terminal · A secure terminal for your keys
description: A calm terminal for macOS and Linux with Kerstel built in. Your secrets stay masked, encrypted, out of your clipboard and out of your shell history.
---
<section class="hero">
<div class="hero-logo"><img src="/icon-light.png" alt="Kerstel"></div>
<h1>Kerstel Terminal</h1>
<p class="tagline">A secure terminal for your keys, on macOS and Linux. Your own shell with Kerstel built in, and your secrets one shortcut away: masked, encrypted, and never on a command line.</p>
<div class="downloads">
<div class="dl-os" data-os="mac">
<div class="dl-os-head"><svg class="os-logo" aria-hidden="true"><use href="/icons.svg#apple"></use></svg><div><strong>macOS</strong><small>11 or later · signed and notarized</small></div></div>
<div class="dl-links">
<a class="download-btn" href="https://github.com/alilibx/kerstel/releases/latest/download/kerstel-terminal-macos-arm64.dmg"><svg aria-hidden="true"><use href="/icons.svg#download"></use></svg>Apple Silicon<span>.dmg</span></a>
<a class="download-btn" href="https://github.com/alilibx/kerstel/releases/latest/download/kerstel-terminal-macos-x64.dmg"><svg aria-hidden="true"><use href="/icons.svg#download"></use></svg>Intel<span>.dmg</span></a>
</div>
</div>
<div class="dl-os" data-os="linux">
<div class="dl-os-head"><svg class="os-logo" aria-hidden="true"><use href="/icons.svg#linux"></use></svg><div><strong>Linux</strong><small>x64</small></div></div>
<div class="dl-links">
<a class="download-btn" href="https://github.com/alilibx/kerstel/releases/latest/download/kerstel-terminal-linux-x64.deb"><svg aria-hidden="true"><use href="/icons.svg#download"></use></svg>Debian, Ubuntu<span>.deb</span></a>
<a class="download-btn" href="https://github.com/alilibx/kerstel/releases/latest/download/kerstel-terminal-linux-x64.AppImage"><svg aria-hidden="true"><use href="/icons.svg#download"></use></svg>Most distros<span>.AppImage</span></a>
</div>
</div>
</div>
<p class="install-note">Includes the <code>kerstel</code> CLI. On first launch it offers to install <code>kerstel</code> and <code>ks</code> for every terminal. Checksums are in each release's <a href="https://github.com/alilibx/kerstel/releases/latest">SHA256SUMS</a>.</p>
</section>

<section class="section">
<figure class="app-shot"><img src="/terminal.png" alt="Kerstel Terminal with the Kerstel panel open: three secrets, masked, and sync turned on" width="900" height="580"></figure>
</section>

<section class="section">
<div class="section-label">Built for secrets</div>
<h2>Your keys, handled with care</h2>
<p class="lede">Most terminals treat a secret like any other text. Kerstel Terminal's Kerstel panel knows which values are secrets, and keeps them out of the places they usually leak. What your own commands print still shows on screen, as in any terminal.</p>
<div class="secure-grid">
<div class="secure-card"><svg aria-hidden="true"><use href="/icons.svg#lock-key"></use></svg><h3>An encrypted vault, on your machine</h3><p>Values are encrypted with AES-256-GCM, and the key that unlocks them is held by the macOS Keychain or Linux's Secret Service. No account, no cloud, no telemetry.</p></div>
<div class="secure-card"><svg aria-hidden="true"><use href="/icons.svg#eye-slash"></use></svg><h3>Masked until you ask</h3><p>Every value shows as <code>••••••••</code>. Showing or copying one takes a deliberate click, and each one is recorded in <code>kerstel audit</code>.</p></div>
<div class="secure-card"><svg aria-hidden="true"><use href="/icons.svg#broom"></use></svg><h3>A clipboard that cleans up</h3><p>A copied value is wiped from the clipboard after 30 seconds, unless you have copied something else since.</p></div>
<div class="secure-card"><svg aria-hidden="true"><use href="/icons.svg#password"></use></svg><h3>Never on a command line</h3><p>A secret you add reaches <code>kerstel set</code> on stdin, never as an argument, so it stays out of process lists and shell history.</p></div>
<div class="secure-card"><svg aria-hidden="true"><use href="/icons.svg#list-checks"></use></svg><h3>A panel with a short leash</h3><p>The panel can run only an allowlisted set of <code>kerstel</code> commands. Setting up sync or adding a device runs in the terminal, where you see and answer every question.</p></div>
<div class="secure-card"><svg aria-hidden="true"><use href="/icons.svg#seal-check"></use></svg><h3>Signed, notarized, checksummed</h3><p>The macOS app is signed and notarized by Apple, and every download has a checksum in the release's <code>SHA256SUMS</code>. All of it is open source.</p></div>
</div>
<a class="more" href="/security">Read the full security model →</a>
</section>

<section class="section">
<div class="section-label">A real terminal</div>
<h2>Nothing new to learn</h2>
<p class="lede">It runs your own login shell, so your prompt, aliases, <code>vim</code>, <code>ssh</code> and everything else work as they do today. On top, it adds only what helps:</p>

- The current folder and git branch at the top of the window.
- A hairline between commands, with each command's duration and a ✓ or ✕ with its exit code.
- A row of key hints that lights up as you use them. Hide it once you know them.
- A command palette (⌘K) with your recent commands. Picking one types it at the prompt; nothing runs until you press Enter.
</section>

<section class="section">
<div class="section-label">Kerstel built in</div>
<h2>Your secrets, one shortcut away</h2>
<p class="lede">Press ⌘J (Ctrl+Shift+J on Linux) to open the Kerstel panel.</p>

- **Secrets:** filter, add, and delete. Values stay masked. Showing or copying one is recorded in [`kerstel audit`](/docs/cli), and a copied value is cleared from the clipboard after 30 seconds.
- **Sync:** see the server, the last sync and your devices. Set up a server, join from another device, or add a device in a click. Each of these runs in the terminal, where Kerstel asks its usual questions. See [Sync](/docs/sync).
- **Doctor:** check this machine's setup with one click.

The panel runs the same `kerstel` you use on the command line, so they always agree.
</section>

<section class="section">
<div class="section-label">Build from source</div>
<p class="lede">Kerstel Terminal is open source, in <a href="https://github.com/alilibx/kerstel/tree/main/apps/terminal"><code>apps/terminal</code></a>. Its README has the build steps.</p>
</section>
