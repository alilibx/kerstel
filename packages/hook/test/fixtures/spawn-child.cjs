// Spawns a grandchild WITHOUT explicitly passing env, to prove the hook
// propagates itself and the reference resolves one level down.
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

const out = execFileSync(process.execPath, [join(__dirname, "read-env.cjs"), process.argv[2]], {
  encoding: "utf8",
});
process.stdout.write(out);
