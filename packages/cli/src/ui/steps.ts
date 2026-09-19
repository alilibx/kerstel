import * as clack from "@clack/prompts";
import { ok } from "../output";

/**
 * The rail (`◆ │ └`) in a terminal, plain lines everywhere else, so logs,
 * CI, and tests read stable text. Spec §4.3 and §4.6.
 */
export function interactive(): boolean {
  return process.stdout.isTTY === true;
}

export function step(title: string, lines: string[] = []): void {
  if (interactive()) {
    clack.log.step([title, ...lines].join("\n"));
    return;
  }
  console.log(title);
  for (const line of lines) console.log(`  ${line}`);
}

export function note(body: string, title?: string): void {
  if (interactive()) {
    clack.note(body, title);
    return;
  }
  if (title) console.log(title);
  for (const line of body.split("\n")) console.log(line);
}

/** `done` may depend on the result, e.g. a path the work has just created. */
export async function withSpinner<T>(
  label: string,
  done: string | ((result: T) => string),
  work: () => Promise<T>,
): Promise<T> {
  const doneText = (result: T): string => (typeof done === "string" ? done : done(result));
  if (!interactive()) {
    const result = await work();
    ok(doneText(result));
    return result;
  }
  const spin = clack.spinner();
  spin.start(label);
  try {
    const result = await work();
    spin.stop(doneText(result));
    return result;
  } catch (error) {
    spin.error((error as Error).message);
    throw error;
  }
}
