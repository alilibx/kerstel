// Builds the `kerstel` CLI that ships inside Kerstel Terminal, named the way
// Tauri expects a bundled binary: src-tauri/binaries/kerstel-<target-triple>.
// The app installs it to ~/.local/bin on request, the same place install.sh uses.
//
//   bun run sidecar                       # for this machine
//   bun run sidecar -- --target <triple>  # cross-compile (e.g. in the release workflow)
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const BUN_TARGETS: Record<string, string> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
};

const app = dirname(import.meta.dir);
const root = join(app, "..", "..");

function hostTriple(): string {
  let out = "";
  try {
    out = Bun.spawnSync(["rustc", "-vV"]).stdout.toString();
  } catch {
    throw new Error("Rust is not installed or not on PATH: install it from https://rustup.rs");
  }
  const host = /^host: (.+)$/m.exec(out)?.[1];
  if (!host) throw new Error("could not read the Rust host triple from `rustc -vV`");
  return host;
}

const flag = process.argv.indexOf("--target");
const triple = flag !== -1 ? process.argv[flag + 1] : process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const bunTarget = BUN_TARGETS[triple];
if (!bunTarget) throw new Error(`no Bun target for ${triple}; supported: ${Object.keys(BUN_TARGETS).join(", ")}`);

const out = join(app, "src-tauri", "binaries", `kerstel-${triple}`);
mkdirSync(dirname(out), { recursive: true });

const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`failed: ${cmd.join(" ")}`);
};
run(["bun", "run", "--cwd", "packages/cli", "build:hook"]);
run(["bun", "build", "packages/cli/src/index.ts", "--compile", `--target=${bunTarget}`, "--outfile", out]);
console.log(`built ${out}`);
