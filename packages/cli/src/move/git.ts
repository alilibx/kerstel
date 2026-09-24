/**
 * Would git commit this env file? Spec §4.2. `ks move` asks before it puts a
 * plain-text value into a file git tracks or does not ignore.
 */
export type GitFileStatus = "tracked" | "not-ignored" | "ignored";

function git(root: string, args: string[]): number | null {
  try {
    return Bun.spawnSync(["git", "-C", root, ...args], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
      .exitCode;
  } catch {
    // git is not on PATH.
    return null;
  }
}

/** The file's status, or null outside a repository or when git is missing. */
export function gitFileStatus(root: string, name: string): GitFileStatus | null {
  if (git(root, ["rev-parse", "--is-inside-work-tree"]) !== 0) return null;
  if (git(root, ["ls-files", "--error-unmatch", "--", name]) === 0) return "tracked";
  return git(root, ["check-ignore", "-q", "--", name]) === 0 ? "ignored" : "not-ignored";
}
