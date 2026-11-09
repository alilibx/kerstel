import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fail } from "../output";
import { buildReport, hasSecrets } from "../scan/report";
import { renderJson, renderText } from "../scan/render";
import { walk } from "../scan/walk";
import { cliName } from "../ui/cli-name";
import { theme } from "../ui/theme";

/**
 * `kerstel scan [path]`: find every env file under a folder and report what it
 * holds, without printing a value or changing anything. Spec
 * `2026-11-09-kerstel-scan-design.md`.
 *
 * Exit 0 when no secret is in plain text, 1 when one is, 2 on bad usage.
 */

export interface ScanOptions {
  path: string;
  keys: boolean;
  all: boolean;
  json: boolean;
  verbose: boolean;
}

export function parseScanArgs(args: string[]): ScanOptions | { error: string } {
  const options: ScanOptions = { path: ".", keys: false, all: false, json: false, verbose: false };
  let path: string | null = null;
  for (const arg of args) {
    if (arg === "--keys") options.keys = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg.startsWith("-")) return { error: `Unknown option ${arg}. Usage: ${cliName()} scan [path] [--keys] [--all] [--json] [--verbose]` };
    else if (path !== null) return { error: `${cliName()} scan takes one folder. Got ${path} and ${arg}.` };
    else path = arg;
  }
  if (path !== null) options.path = path;
  return options;
}

export interface ScanDeps {
  /** For tests: the vault whose names references are checked against. */
  vault?: string;
  home?: string;
  stdout?: (line: string) => void;
  progress?: (folders: number) => void;
}

export async function scanCommand(args: string[], deps: ScanDeps = {}): Promise<number> {
  const options = parseScanArgs(args);
  if ("error" in options) {
    fail(options.error);
    return 2;
  }
  const root = resolve(options.path);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    fail(`${options.path} is not a folder.`);
    return 2;
  }

  const print = deps.stdout ?? ((line: string) => console.log(line));
  // A progress line on stderr, only on a terminal, cleared when the walk ends,
  // so stdout stays exactly the report and a pipe never sees it.
  const tty = process.stderr.isTTY === true && !options.json;
  const progress =
    deps.progress ??
    (tty ? (folders: number) => process.stderr.write(`\r\x1b[2KScanning… ${folders.toLocaleString("en-US")} folders`) : undefined);

  const walked = walk(root, { onProgress: progress, home: deps.home });
  if (tty) process.stderr.write("\r\x1b[2K");
  const report = buildReport(walked, { vault: deps.vault });

  if (options.json) {
    print(JSON.stringify(renderJson(report), null, 2));
  } else {
    for (const line of renderText(report, { ...options, cli: cliName(), home: deps.home }, theme)) print(line);
  }
  return hasSecrets(report) ? 1 : 0;
}
