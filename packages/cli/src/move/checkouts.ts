import { existsSync } from "node:fs";
import { loadEnvFiles } from "../init/collect";
import { detectProject } from "../init/detect";
import { entries } from "../init/dotenv-file";
import { parseReference } from "../reference";
import { refId } from "./plan";

/**
 * Move spec §3.1: the references other checkouts of this scope still read,
 * each mapped to the first checkout root that reads it. Read the way
 * `uninstall` reads a checkout, and never written. A folder that is gone, or
 * whose env files cannot be read, reads nothing.
 */
export function referencesInCheckouts(roots: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let loaded: ReturnType<typeof loadEnvFiles>;
    try {
      loaded = loadEnvFiles(detectProject(root).envFiles);
    } catch {
      continue;
    }
    for (const entry of loaded) {
      for (const pair of entries(entry.file)) {
        const ref = parseReference(pair.value);
        if (ref && !found.has(refId(ref))) found.set(refId(ref), root);
      }
    }
  }
  return found;
}
