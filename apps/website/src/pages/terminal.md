---
title: Kerstel Terminal · A calm terminal with Kerstel built in
description: A minimal terminal app for macOS and Linux that includes Kerstel, with a panel for your secrets and sync.
---
<section class="hero">
<div class="hero-logo"><img src="/icon-light.png" alt="Kerstel"></div>
<h1>Kerstel Terminal</h1>
<p class="tagline">A calm terminal for macOS and Linux, with Kerstel built in. Your own shell, a quiet line between commands, and your secrets one shortcut away.</p>
<div class="downloads">
<a class="download-btn" href="https://github.com/alilibx/kerstel/releases/latest/download/kerstel-terminal-macos-arm64.dmg">macOS<span>Apple Silicon · .dmg</span></a>
<a class="download-btn" href="https://github.com/alilibx/kerstel/releases/latest/download/kerstel-terminal-macos-x64.dmg">macOS<span>Intel · .dmg</span></a>
<a class="download-btn" href="https://github.com/alilibx/kerstel/releases/latest/download/kerstel-terminal-linux-x64.deb">Linux<span>x64 · .deb</span></a>
<a class="download-btn" href="https://github.com/alilibx/kerstel/releases/latest/download/kerstel-terminal-linux-x64.AppImage">Linux<span>x64 · .AppImage</span></a>
</div>
<p class="install-note">Includes the <code>kerstel</code> CLI. On first launch it offers to install <code>kerstel</code> and <code>ks</code> for every terminal. Checksums are in each release's <a href="https://github.com/alilibx/kerstel/releases/latest">SHA256SUMS</a>.</p>
</section>

<section class="section">
<img class="screenshot" src="/terminal.png" alt="Kerstel Terminal with the Kerstel panel open: two secrets and sync turned on" width="900" height="580">
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
