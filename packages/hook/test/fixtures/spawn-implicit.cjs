// Spawns a grandchild with NO `env` option at all, so Node builds its envp by
// copying this process's `process.env` implicitly -- the ordinary path almost
// every spawn in the wild takes, and the one spawn-child.cjs's explicit
// `{ ...process.env }` spread does NOT exercise.
//
// The grandchild is `sh`, running a shell builtin. It is not Node, so no
// preload can load there and it has no way to resolve a kerstel:// reference:
// if it prints the plaintext, that plaintext was already sitting in the real
// environment Node handed it. That is the whole assertion.
const { execFileSync } = require("node:child_process");

const name = process.argv[2];
const out = execFileSync("sh", ["-c", `printf %s "$${name}"`], { encoding: "utf8" });
process.stdout.write(out);
