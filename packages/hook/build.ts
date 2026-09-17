import { rmSync } from "node:fs";
import { resolve } from "node:path";

const root = import.meta.dir;
const outdir = resolve(root, "dist");
rmSync(outdir, { recursive: true, force: true });

// worker.js must stay a separate file because Worker loads it by path.
for (const [entry, outfile] of [
  ["src/preload.js", "preload.cjs"],
  ["src/worker.js", "worker.cjs"],
] as const) {
  const result = await Bun.build({
    entrypoints: [resolve(root, entry)],
    outdir,
    target: "node",
    format: "cjs",
    naming: outfile,
    minify: false,
    external: ["node:*"],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

console.log(`Built hook assets in ${outdir}`);
