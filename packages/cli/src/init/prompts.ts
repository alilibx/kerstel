import * as clack from "@clack/prompts";
import { dim } from "../output";

/**
 * One question-asking interface with three implementations, so the wizard's
 * logic never branches on "are we interactive".
 *
 * A secret NEVER arrives on argv: `text({ secret: true })` reads it from the
 * terminal with the echo suppressed, and the non-interactive path reads JSON
 * from stdin instead. Anything on argv is in the shell history and in `ps`
 * output for every user on the machine -- see the warning `kerstel set
 * --value` prints for the same reason.
 */

export interface TextOptions {
  /** Suppress echo. Always true for a value that will become a secret. */
  secret?: boolean;
  /** The CLI flag that would supply this answer non-interactively. */
  flag?: string;
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

export interface Prompter {
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  choose(question: string, options: string[], defaultValue: string): Promise<string>;
  select<T extends string>(question: string, choices: Choice<T>[], defaultValue: T): Promise<T>;
  multiselect<T extends string>(question: string, choices: Choice<T>[], initial: T[]): Promise<T[]>;
  text(question: string, options?: TextOptions): Promise<string>;
}

/** Thrown when a non-interactive run reaches a question with no default. */
export class NonInteractiveError extends Error {
  constructor(
    public readonly question: string,
    public readonly flag: string,
  ) {
    super(
      `Kerstel needs an answer to "${question}" and this run is non-interactive. ` +
        `Supply it with ${flag}, or drop --yes / --non-interactive and answer at the prompt.`,
    );
    this.name = "NonInteractiveError";
  }
}

/** Thrown when the user cancels a clack prompt (Ctrl-C, Esc). */
export class CancelledError extends Error {
  constructor() {
    super("Cancelled. Nothing was changed.");
    this.name = "CancelledError";
  }
}

const MOVE_HINT = dim("↑/↓ to move · Enter to confirm");
const TOGGLE_HINT = dim("Space to toggle · Enter to confirm");

function settled<T>(value: T | symbol): T {
  if (clack.isCancel(value)) throw new CancelledError();
  return value as T;
}

/** The interactive default: arrow-key menus, checklists, masked input. Spec §4.4. */
export class ClackPrompter implements Prompter {
  async confirm(question: string, defaultValue: boolean): Promise<boolean> {
    return settled<boolean>(await clack.confirm({ message: question, initialValue: defaultValue }));
  }

  async choose(question: string, options: string[], defaultValue: string): Promise<string> {
    return this.select(
      question,
      options.map((value) => ({ value, label: value })),
      defaultValue,
    );
  }

  async select<T extends string>(question: string, choices: Choice<T>[], defaultValue: T): Promise<T> {
    // clack.select's `options` type is a conditional type keyed on its own
    // generic parameter, which TypeScript can't resolve against a
    // caller-supplied `T` it hasn't inferred from a concrete value -- the
    // shape below is exactly what that conditional resolves to for a string
    // value, so the cast is a type-system limitation, not a real mismatch.
    const options = choices.map((choice) => ({ value: choice.value, label: choice.label, hint: choice.hint }));
    return settled<T>(
      await clack.select({
        message: `${question}\n${MOVE_HINT}`,
        options: options as unknown as clack.Option<T>[],
        initialValue: defaultValue,
      }),
    );
  }

  async multiselect<T extends string>(question: string, choices: Choice<T>[], initial: T[]): Promise<T[]> {
    const options = choices.map((choice) => ({ value: choice.value, label: choice.label, hint: choice.hint }));
    return settled<T[]>(
      await clack.multiselect({
        message: `${question}\n${TOGGLE_HINT}`,
        options: options as unknown as clack.Option<T>[],
        initialValues: initial,
        required: false,
      }),
    );
  }

  async text(question: string, options: TextOptions = {}): Promise<string> {
    // A secret goes through clack's password prompt: every typed character is
    // drawn as a mask, never echoed. Same guarantee as the old readline mute.
    const answer = options.secret
      ? await clack.password({ message: question, mask: "•" })
      : await clack.text({ message: question });
    return settled<string>(answer).trim();
  }
}

/** Answers from a fixed list. Tests only -- it is what makes the wizard testable. */
export class ScriptedPrompter implements Prompter {
  readonly asked: string[] = [];
  private index = 0;

  constructor(private readonly answers: (string | boolean | string[])[]) {}

  private next(question: string): string | boolean | string[] {
    this.asked.push(question);
    if (this.index >= this.answers.length) {
      throw new Error(
        `ScriptedPrompter ran out of scripted answers at question ${this.index + 1}: "${question}". ` +
          `Asked so far: ${this.asked.join(" | ")}`,
      );
    }
    return this.answers[this.index++] as string | boolean | string[];
  }

  async confirm(question: string, _defaultValue: boolean): Promise<boolean> {
    const answer = this.next(question);
    if (typeof answer !== "boolean") {
      throw new Error(`ScriptedPrompter expected a boolean for "${question}", got ${JSON.stringify(answer)}`);
    }
    return answer;
  }

  async choose(question: string, options: string[], _defaultValue: string): Promise<string> {
    const answer = this.next(question);
    if (typeof answer !== "string" || !options.includes(answer)) {
      throw new Error(
        `ScriptedPrompter answer ${JSON.stringify(answer)} for "${question}" is not one of ${options.join(", ")}`,
      );
    }
    return answer;
  }

  async select<T extends string>(question: string, choices: Choice<T>[], _defaultValue: T): Promise<T> {
    const answer = this.next(question);
    const values = choices.map((choice) => choice.value as string);
    if (typeof answer !== "string" || !values.includes(answer)) {
      throw new Error(
        `ScriptedPrompter answer ${JSON.stringify(answer)} for "${question}" is not one of ${values.join(", ")}`,
      );
    }
    return answer as T;
  }

  async multiselect<T extends string>(question: string, choices: Choice<T>[], _initial: T[]): Promise<T[]> {
    const answer = this.next(question);
    const values = choices.map((choice) => choice.value as string);
    if (!Array.isArray(answer) || answer.some((item) => !values.includes(item))) {
      throw new Error(
        `ScriptedPrompter answer ${JSON.stringify(answer)} for "${question}" is not one of ${values.join(", ")}`,
      );
    }
    return answer as T[];
  }

  async text(question: string, _options: TextOptions = {}): Promise<string> {
    const answer = this.next(question);
    if (typeof answer !== "string") {
      throw new Error(`ScriptedPrompter expected a string for "${question}", got ${JSON.stringify(answer)}`);
    }
    return answer;
  }
}

/** `--yes` and `--non-interactive`: every default, no questions. */
export class DefaultsPrompter implements Prompter {
  async confirm(_question: string, defaultValue: boolean): Promise<boolean> {
    return defaultValue;
  }

  async choose(_question: string, _options: string[], defaultValue: string): Promise<string> {
    return defaultValue;
  }

  async select<T extends string>(_question: string, _choices: Choice<T>[], defaultValue: T): Promise<T> {
    return defaultValue;
  }

  async multiselect<T extends string>(_question: string, _choices: Choice<T>[], initial: T[]): Promise<T[]> {
    return initial;
  }

  async text(question: string, options: TextOptions = {}): Promise<string> {
    // A free-text answer has no default by definition. Inventing one here
    // would mean storing an empty secret and calling it success.
    throw new NonInteractiveError(question, options.flag ?? "--from-stdin");
  }
}
