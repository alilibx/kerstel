import { resolve } from "node:path";
import { build, DEFAULT_OUT } from "./src/build";

const USAGE = "usage: bun run build.ts [--out <dir>]";

// process.argv is [bun, build.ts, ...userArgs]. The only accepted shapes are
// no args, or exactly "--out" followed by a directory. Anything else --
// including "--out=/x", which used to be silently ignored and fall through to
// DEFAULT_OUT while wiping the real docs/ -- is a usage error.
const args = process.argv.slice(2);
let outArg = DEFAULT_OUT;
if (args.length === 1 || args.length > 2) {
  console.error(USAGE);
  process.exit(2);
} else if (args.length === 2) {
  const [flag, value] = args;
  if (flag !== "--out" || value === undefined || value === "") {
    console.error(USAGE);
    process.exit(2);
  }
  outArg = value;
}

const outDir = resolve(outArg);
const written = build({ outDir });
console.log(`kerstel.dev: wrote ${written.length} page(s) to ${outDir}`);
