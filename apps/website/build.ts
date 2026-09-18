import { resolve } from "node:path";
import { build, DEFAULT_OUT } from "./src/build";

const idx = process.argv.indexOf("--out");
const outArg = idx === -1 ? DEFAULT_OUT : process.argv[idx + 1];
if (!outArg) {
  console.error("usage: bun run build.ts [--out <dir>]");
  process.exit(2);
}
const outDir = resolve(outArg);
const written = build({ outDir });
console.log(`kerstel.dev: wrote ${written.length} page(s) to ${outDir}`);
