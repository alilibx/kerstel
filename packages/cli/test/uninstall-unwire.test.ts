import { expect, test } from "bun:test";
import { restoreGitignore, unwirePackageJson } from "../src/uninstall/unwire";
import { wirePackageJson } from "../src/init/wiring";

const ORIGINAL = `{
  "name": "demo",
  "scripts": {
    "dev": "next dev",
    "postinstall": "patch-package",
    "mine": "kerstel run -- node x.js"
  }
}
`;

test("unwiring reverses wiring byte for byte", () => {
  const wired = wirePackageJson(ORIGINAL).contents;
  const result = unwirePackageJson(wired);
  expect(result.changed).toBe(true);
  expect(result.unwrapped).toEqual(["dev"]);
  expect(result.contents).toBe(ORIGINAL);
});

test("a script the user wrote that calls kerstel is left alone", () => {
  const result = unwirePackageJson(ORIGINAL);
  expect(result.changed).toBe(false);
  expect(result.contents).toBe(ORIGINAL);
});

test("CRLF and a missing final newline survive unwiring", () => {
  const crlf = wirePackageJson(ORIGINAL.replace(/\n/g, "\r\n")).contents;
  expect(unwirePackageJson(crlf).contents).toBe(ORIGINAL.replace(/\n/g, "\r\n"));
  const bare = wirePackageJson(ORIGINAL.trimEnd()).contents;
  expect(unwirePackageJson(bare).contents).toBe(ORIGINAL.trimEnd());
});

test("invalid JSON throws", () => {
  expect(() => unwirePackageJson("{ nope")).toThrow();
});

test("restoreGitignore swaps init's note for env-file lines", () => {
  const source = "node_modules\n# Kerstel: .env files hold references, safe to commit\ndist\n";
  expect(restoreGitignore(source)).toEqual({
    changed: true,
    contents: "node_modules\n.env\n.env.*\ndist\n",
  });
  expect(restoreGitignore("a\r\n# Kerstel: .env files hold references, safe to commit\r\n").contents).toBe(
    "a\r\n.env\r\n.env.*\r\n",
  );
  expect(restoreGitignore("node_modules\n")).toEqual({ changed: false, contents: "node_modules\n" });
});
