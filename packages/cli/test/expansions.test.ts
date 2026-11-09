import { expect, test } from "bun:test";
import { expandedNames } from "../src/expansions";

test("finds $NAME, ${NAME} and ${NAME:-default} across files", () => {
  const names = expandedNames([
    "OPENAI_KEY=${OPENAI_API_KEY}\nURL=postgres://$DB_USER@host\n",
    "FALLBACK=${TOKEN:-none}\n",
  ]);
  expect([...names].sort()).toEqual(["DB_USER", "OPENAI_API_KEY", "TOKEN"]);
});

test("counts a $NAME in a comment or single quotes too, erring toward the full form", () => {
  expect(expandedNames(["# see $LEGACY\nLITERAL='single $NOT_EXPANDED'\n"])).toEqual(
    new Set(["LEGACY", "NOT_EXPANDED"]),
  );
});

test("a file without expansions names nothing", () => {
  expect(expandedNames(["A=1\nB=ks:global\nPRICE=5$\n"]).size).toBe(0);
});
