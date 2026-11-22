// Copies the terminal emulator (xterm.js) into ui/vendor so the app ships with
// no CDN and no bundler. Run by `cargo tauri dev` / `cargo tauri build`.
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";

const here = dirname(import.meta.dir);
const out = join(here, "ui", "vendor");
mkdirSync(out, { recursive: true });

const pkg = (name: string) => dirname(Bun.resolveSync(`${name}/package.json`, here));
const files: [string, string][] = [
  [join(pkg("@xterm/xterm"), "lib/xterm.js"), "xterm.js"],
  [join(pkg("@xterm/xterm"), "css/xterm.css"), "xterm.css"],
  [join(pkg("@xterm/addon-fit"), "lib/addon-fit.js"), "addon-fit.js"],
];
for (const [from, to] of files) copyFileSync(from, join(out, to));
console.log(`vendored ${files.length} files into ui/vendor`);
