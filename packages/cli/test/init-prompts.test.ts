import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  DefaultsPrompter,
  NonInteractiveError,
  ScriptedPrompter,
  TtyPrompter,
} from "../src/init/prompts";

test("ScriptedPrompter answers in order and records the questions", async () => {
  const prompter = new ScriptedPrompter([true, "global", "sk-typed-value", false]);
  expect(await prompter.confirm("Continue?", false)).toBe(true);
  expect(await prompter.choose("Where?", ["project", "global", "plaintext"], "project")).toBe("global");
  expect(await prompter.text("Value for OPENAI_API_KEY?", { secret: true })).toBe("sk-typed-value");
  expect(await prompter.confirm("Update .gitignore?", false)).toBe(false);
  expect(prompter.asked).toEqual([
    "Continue?",
    "Where?",
    "Value for OPENAI_API_KEY?",
    "Update .gitignore?",
  ]);
});

test("ScriptedPrompter throws when its answers run out", async () => {
  const prompter = new ScriptedPrompter([true]);
  await prompter.confirm("First?", false);
  await expect(prompter.confirm("Second?", false)).rejects.toThrow(/ran out of scripted answers/i);
});

test("ScriptedPrompter rejects an answer of the wrong shape", async () => {
  await expect(new ScriptedPrompter(["yes"]).confirm("Sure?", false)).rejects.toThrow(/boolean/i);
  await expect(new ScriptedPrompter([true]).text("Value?")).rejects.toThrow(/string/i);
  await expect(
    new ScriptedPrompter(["nope"]).choose("Where?", ["project", "global"], "project"),
  ).rejects.toThrow(/not one of/i);
});

test("DefaultsPrompter returns every default without asking", async () => {
  const prompter = new DefaultsPrompter();
  expect(await prompter.confirm("Continue?", true)).toBe(true);
  expect(await prompter.confirm("Update .gitignore?", false)).toBe(false);
  expect(await prompter.choose("Where?", ["project", "global"], "project")).toBe("project");
});

test("DefaultsPrompter refuses a question that has no default, naming the flag", async () => {
  const prompter = new DefaultsPrompter();
  const failure = prompter.text("Value for OPENAI_API_KEY?", { secret: true, flag: "--from-stdin" });
  await expect(failure).rejects.toBeInstanceOf(NonInteractiveError);
  await expect(failure).rejects.toThrow(/--from-stdin/);
});

test("TtyPrompter reads a line and applies the default on an empty answer", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const prompter = new TtyPrompter(input, output);

  const answer = prompter.confirm("Continue?", true);
  input.write("\n");
  expect(await answer).toBe(true);

  const no = prompter.confirm("Continue?", true);
  input.write("n\n");
  expect(await no).toBe(false);
});

test("TtyPrompter's choose rejects an answer outside the options", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const prompter = new TtyPrompter(input, output);

  const answer = prompter.choose("Where?", ["project", "global", "plaintext"], "project");
  input.write("nowhere\n");
  input.write("global\n");
  expect(await answer).toBe("global");
});

test("TtyPrompter never echoes a secret", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const seen: string[] = [];
  output.on("data", (chunk: Buffer) => seen.push(chunk.toString("utf8")));

  const prompter = new TtyPrompter(input, output);
  const answer = prompter.text("Value for OPENAI_API_KEY?", { secret: true });
  input.write("sk-super-secret\n");
  expect(await answer).toBe("sk-super-secret");

  const printed = seen.join("");
  expect(printed).toContain("Value for OPENAI_API_KEY?");
  expect(printed).not.toContain("sk-super-secret");
});
