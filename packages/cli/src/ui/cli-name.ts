import { basename } from "node:path";

/**
 * The name to put in hints: `ks` when the user typed `ks`, otherwise
 * `kerstel`. A compiled Bun binary sets `process.argv0` to the name it was
 * invoked as, symlink included (`argv[1]` is always `/$bunfs/root/kerstel`).
 */
export function cliName(argv0: string = process.argv0): "ks" | "kerstel" {
  return basename(argv0) === "ks" ? "ks" : "kerstel";
}
