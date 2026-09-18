// Spawns a grandchild that is deliberately NOT hooked: NODE_OPTIONS is
// emptied in the env passed to it, so the preload cannot load there and the
// grandchild has no way to resolve a kerstel:// reference on its own. If it
// still prints the right value, that value must have already been resolved
// when THIS process (the hooked parent) built the grandchild's environment.
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

const out = execFileSync(process.execPath, [join(__dirname, "read-env.cjs"), process.argv[2]], {
  encoding: "utf8",
  env: { ...process.env, NODE_OPTIONS: "" },
});
process.stdout.write(out);
