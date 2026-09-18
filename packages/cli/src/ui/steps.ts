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

export async function withSpinner<T>(label: string, done: string, work: () => Promise<T>): Promise<T> {
  if (!interactive()) {
    const result = await work();
    ok(done);
    return result;
  }
  const spin = clack.spinner();
  spin.start(label);
  try {
    const result = await work();
    spin.stop(done);
    return result;
  } catch (error) {
    spin.error((error as Error).message);
    throw error;
  }
}
