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

/**
 * The top of the work tree holding `dir`, or null outside a repository. Null
 * also when git is missing; `gitAvailable()` tells the two apart.
 */
export function gitTopLevel(dir: string): string | null {
  try {
    const result = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    if (result.exitCode !== 0) return null;
    const top = result.stdout.toString().trim();
    return top === "" ? null : top;
  } catch {
    return null;
  }
}

/** Whether a `git` binary runs at all. */
export function gitAvailable(): boolean {
  try {
    return Bun.spawnSync(["git", "--version"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * The status of many files in one repository, with two git runs in all rather
 * than three per file: `kerstel scan` may find hundreds. `files` are relative
 * to `repo` with forward slashes. Null when git fails, such as for a folder
 * that is not a work tree after all.
 */
export function gitStatuses(repo: string, files: string[]): Map<string, GitFileStatus> | null {
  const statuses = new Map<string, GitFileStatus>();
  if (files.length === 0) return statuses;
  try {
    const tracked = Bun.spawnSync(["git", "--literal-pathspecs", "-C", repo, "ls-files", "-z", "--", ...files], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    if (tracked.exitCode !== 0) return null;
    const trackedSet = new Set(tracked.stdout.toString().split("\0").filter((f) => f !== ""));

    const rest = files.filter((f) => !trackedSet.has(f));
    let ignoredSet = new Set<string>();
    if (rest.length > 0) {
      const ignored = Bun.spawnSync(["git", "-C", repo, "check-ignore", "-z", "--stdin"], {
        stdin: Buffer.from(rest.map((f) => `${f}\0`).join("")),
        stdout: "pipe",
        stderr: "ignore",
      });
      // 0: some are ignored, 1: none are. Anything else is an error.
      if (ignored.exitCode !== 0 && ignored.exitCode !== 1) return null;
      ignoredSet = new Set(ignored.stdout.toString().split("\0").filter((f) => f !== ""));
    }
    for (const file of files) {
      statuses.set(file, trackedSet.has(file) ? "tracked" : ignoredSet.has(file) ? "ignored" : "not-ignored");
    }
    return statuses;
  } catch {
    return null;
  }
}
