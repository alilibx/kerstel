import { createInterface } from "node:readline/promises";
import { bold, dim } from "../output";

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

export interface Prompter {
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  choose(question: string, options: string[], defaultValue: string): Promise<string>;
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

export class TtyPrompter implements Prompter {
  private rl: ReturnType<typeof createInterface> | undefined;
  // Lines can arrive faster than we consume them (e.g. two answers written
  // back-to-back before the first question() call attaches its listener).
  // readline/promises' `question()` uses a one-shot `line` listener, so a
  // second line landing in the same event-loop tick would be silently
  // dropped. Queueing every `line` event here and resolving pending readers
  // FIFO makes reads order-safe regardless of how the input arrives.
  private readonly lineQueue: string[] = [];
  private readonly waiters: Array<(line: string) => void> = [];

  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {}

  private interface(): ReturnType<typeof createInterface> {
    if (!this.rl) {
      this.rl = createInterface({ input: this.input, output: this.output, terminal: true });
      this.rl.on("line", (line: string) => {
        const waiter = this.waiters.shift();
        if (waiter) waiter(line);
        else this.lineQueue.push(line);
      });
    }
    return this.rl;
  }

  private readLine(): Promise<string> {
    this.interface();
    const queued = this.lineQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private async ask(prompt: string, secret: boolean): Promise<string> {
    this.interface();
    if (!secret) {
      this.output.write(prompt);
      return (await this.readLine()).trim();
    }

    // readline echoes by writing to `output`. Write the prompt ourselves,
    // then mute the stream for the duration of the answer: the characters
    // typed never reach the terminal, the scrollback or a screen recording.
    this.output.write(prompt);
    const realWrite = this.output.write.bind(this.output);
    (this.output as { write: unknown }).write = () => true;
    try {
      return (await this.readLine()).trim();
    } finally {
      (this.output as { write: typeof realWrite }).write = realWrite;
      this.output.write("\n");
    }
  }

  async confirm(question: string, defaultValue: boolean): Promise<boolean> {
    const hint = defaultValue ? "[Y/n]" : "[y/N]";
    for (;;) {
      const answer = (await this.ask(`${question} ${dim(hint)} `, false)).toLowerCase();
      if (answer === "") return defaultValue;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      this.output.write(`Please answer y or n.\n`);
    }
  }

  async choose(question: string, options: string[], defaultValue: string): Promise<string> {
    for (;;) {
      const answer = await this.ask(
        `${question} ${dim(`(${options.join(" / ")})`)} ${dim(`[${defaultValue}]`)} `,
        false,
      );
      if (answer === "") return defaultValue;
      if (options.includes(answer)) return answer;
      this.output.write(`Please choose one of: ${options.join(", ")}.\n`);
    }
  }

  async text(question: string, options: TextOptions = {}): Promise<string> {
    return this.ask(`${bold(question)} `, options.secret === true);
  }

  /**
   * Release the underlying readline interface. Call this once the wizard is
   * done: an open `readline.Interface` on `process.stdin` keeps the event
   * loop alive, so without this the CLI process would never exit.
   */
  close(): void {
    this.rl?.close();
  }
}

/** Answers from a fixed list. Tests only -- it is what makes the wizard testable. */
export class ScriptedPrompter implements Prompter {
  readonly asked: string[] = [];
  private index = 0;

  constructor(private readonly answers: (string | boolean)[]) {}

  private next(question: string): string | boolean {
    this.asked.push(question);
    if (this.index >= this.answers.length) {
      throw new Error(
        `ScriptedPrompter ran out of scripted answers at question ${this.index + 1}: "${question}". ` +
          `Asked so far: ${this.asked.join(" | ")}`,
      );
    }
    return this.answers[this.index++] as string | boolean;
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

  async text(question: string, options: TextOptions = {}): Promise<string> {
    // A free-text answer has no default by definition. Inventing one here
    // would mean storing an empty secret and calling it success.
    throw new NonInteractiveError(question, options.flag ?? "--from-stdin");
  }
}
