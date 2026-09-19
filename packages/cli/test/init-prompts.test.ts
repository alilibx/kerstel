import { expect, test } from "bun:test";
import { CancelledError, DefaultsPrompter, NonInteractiveError, ScriptedPrompter } from "../src/init/prompts";

const DESTINATIONS = [
  { value: "project", label: "Vault, for this project only" },
  { value: "global", label: "Vault, shared by all your projects" },
  { value: "plaintext", label: "Keep as plain text" },
] as const;

test("ScriptedPrompter answers in order and records the questions", async () => {
  const prompter = new ScriptedPrompter(["global", "sk-typed-value", ["A"]]);
  expect(await prompter.select("Where?", [...DESTINATIONS], "project")).toBe("global");
  expect(await prompter.text("Value for OPENAI_API_KEY?", { secret: true })).toBe("sk-typed-value");
  expect(await prompter.multiselect("Which?", [{ value: "A", label: "A" }], [])).toEqual(["A"]);
  expect(prompter.asked).toEqual(["Where?", "Value for OPENAI_API_KEY?", "Which?"]);
});

test("ScriptedPrompter throws when its answers run out", async () => {
  const prompter = new ScriptedPrompter(["global"]);
  await prompter.select("First?", [...DESTINATIONS], "project");
  await expect(prompter.select("Second?", [...DESTINATIONS], "project")).rejects.toThrow(
    /ran out of scripted answers/i,
  );
});

test("ScriptedPrompter rejects an answer of the wrong shape", async () => {
  await expect(new ScriptedPrompter([["A"]]).text("Value?")).rejects.toThrow(/string/i);
  await expect(new ScriptedPrompter([["A"]]).select("Where?", [...DESTINATIONS], "project")).rejects.toThrow(
    /not one of/,
  );
  await expect(new ScriptedPrompter(["A"]).multiselect("Which?", [{ value: "A", label: "A" }], [])).rejects.toThrow(
    /not one of/,
  );
});

test("ScriptedPrompter answers select and multiselect from its queue", async () => {
  const prompter = new ScriptedPrompter(["global", ["A", "C"]]);
  expect(await prompter.select("Where?", [...DESTINATIONS], "project")).toBe("global");
  expect(
    await prompter.multiselect(
      "Which?",
      [
        { value: "A", label: "A" },
        { value: "B", label: "B" },
        { value: "C", label: "C" },
      ],
      [],
    ),
  ).toEqual(["A", "C"]);
});

test("ScriptedPrompter rejects an answer that is not one of the choices", async () => {
  await expect(new ScriptedPrompter(["nope"]).select("Where?", [...DESTINATIONS], "project")).rejects.toThrow(
    /not one of/,
  );
  await expect(
    new ScriptedPrompter([["A", "Z"]]).multiselect("Which?", [{ value: "A", label: "A" }], []),
  ).rejects.toThrow(/not one of/);
});

test("DefaultsPrompter returns the default choice and the initial selection", async () => {
  const prompter = new DefaultsPrompter();
  expect(await prompter.select("Where?", [...DESTINATIONS], "plaintext")).toBe("plaintext");
  expect(await prompter.multiselect("Which?", [{ value: "A", label: "A" }], ["A"])).toEqual(["A"]);
});

test("DefaultsPrompter refuses a question that has no default, naming the flag", async () => {
  const prompter = new DefaultsPrompter();
  const failure = prompter.text("Value for OPENAI_API_KEY?", { secret: true, flag: "--from-stdin" });
  await expect(failure).rejects.toBeInstanceOf(NonInteractiveError);
  await expect(failure).rejects.toThrow(/--from-stdin/);
});

test("CancelledError says nothing was changed", () => {
  expect(new CancelledError().message).toBe("Cancelled. Nothing was changed.");
});
