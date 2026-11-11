import { expect, test } from "bun:test";
import {
  describeValue,
  maskCommandForDisplay,
  maskForDisplay,
  maskPackageJsonForDisplay,
} from "../src/init/display";
import { GITIGNORE_NOTE, serializePackageJson } from "../src/init/wiring";

test("describeValue gives shape and size only", () => {
  expect(describeValue("")).toBe("empty");
  expect(describeValue("postgres://u:p@h/db")).toBe("19 chars, url");
  expect(describeValue("sk-abc")).toBe("6 chars, opaque");
});

test("maskForDisplay hides plaintext, keeps references, the shape of comments, and quoting", () => {
  const source = '# note\nA=secret-value\nB="quoted secret"\nC=ks:demo/C\n';
  const masked = maskForDisplay(source);
  expect(masked).not.toContain("secret-value");
  expect(masked).not.toContain("quoted secret");
  expect(masked).toContain("# «4-chars-comment»\n");
  expect(masked).toContain("A=«12-chars-opaque»\n");
  expect(masked).toContain('B="«13-chars-opaque»"\n');
  expect(masked).toContain("C=ks:demo/C\n");
});

test("maskForDisplay masks comment text, on its own line and after a value", () => {
  const source = [
    "# old key: sk-PARKED-0000",
    "  #   indented sk-INDENTED-0000  ",
    "#",
    "A=plain # was sk-INLINE-0000",
    'B="quoted" # was sk-AFTERQUOTE-0000',
    "C=ks:demo/C # was sk-AFTERREF-0000",
    "",
  ].join("\n");
  const masked = maskForDisplay(source);
  expect(masked).not.toContain("sk-");
  expect(masked).toBe(
    [
      "# «23-chars-comment»",
      "  #   «25-chars-comment»  ",
      "#",
      "A=«5-chars-opaque» # «18-chars-comment»",
      'B="«6-chars-opaque»" # «22-chars-comment»',
      "C=ks:demo/C # «20-chars-comment»",
      "",
    ].join("\n"),
  );
});

test("an unchanged comment masks the same on both sides, so it never shows as an edit", () => {
  expect(maskForDisplay("# keep me\nA=one\n").split("\n")[0]).toBe(maskForDisplay("# keep me\nA=ks:demo\n").split("\n")[0]);
});

test("maskCommandForDisplay masks what a script sets inline and keeps the commands", () => {
  expect(maskCommandForDisplay("API_TOKEN=tok-SECRET99 node index.js")).toBe("API_TOKEN=«12-chars-opaque» node index.js");
  expect(maskCommandForDisplay("A='two words' B=\"x y\" next dev")).toBe("A='«9-chars-opaque»' B=\"«3-chars-opaque»\" next dev");
  expect(maskCommandForDisplay("node copy.mjs && KEY=abc vite")).toBe("node copy.mjs && KEY=«3-chars-opaque» vite");
  expect(maskCommandForDisplay("OPENAI_API_KEY=ks:global node app.js")).toBe("OPENAI_API_KEY=ks:global node app.js");
  expect(maskCommandForDisplay("deploy --token abc123 --api-key=xyz --verbose")).toBe(
    "deploy --token «6-chars-opaque» --api-key=«3-chars-opaque» --verbose",
  );
  expect(maskCommandForDisplay("deploy --auth --verbose")).toBe("deploy --auth --verbose");
  // The whole shell word is masked, however it is escaped or quoted.
  for (const command of [
    "API_TOKEN=prefix\\ secret node app.js",
    "API_TOKEN=pre'fix secret'tail node app.js",
    "node app.js --token 'prefix''secret'",
    "node app.js --token=-secret",
    'node app.js "postgres://me:pa\'ss@db/app"',
  ]) {
    const masked = maskCommandForDisplay(command);
    expect(masked, command).not.toContain("secret");
    expect(masked, command).not.toContain("ss@");
    expect(masked, command).toContain("app");
  }
  expect(maskCommandForDisplay("node app.js --token=-secret")).toBe("node app.js --token=«7-chars-opaque»");
  expect(maskCommandForDisplay("psql postgres://me:hunter2@db/app")).toBe("psql postgres://me:«7-chars-opaque»@db/app");
  expect(maskCommandForDisplay("node .kerstel/exec.cjs -- next dev --port 3000")).toBe(
    "node .kerstel/exec.cjs -- next dev --port 3000",
  );
});

test("maskPackageJsonForDisplay masks script values and leaves every other byte alone", () => {
  const source = '{"name":"demo","scripts":{"dev":"API_TOKEN=tok-SECRET99 node index.js","x":"caf\\u00e9"}}\n';
  const masked = maskPackageJsonForDisplay(source);
  expect(masked).not.toContain("SECRET99");
  expect(masked).toBe('{"name":"demo","scripts":{"dev":"API_TOKEN=«12-chars-opaque» node index.js","x":"caf\\u00e9"}}\n');
  const pretty = '{\n  "scripts": {\n    "dev": "next dev"\n  }\n}\n';
  expect(maskPackageJsonForDisplay(pretty)).toBe(pretty);
});

test("serializePackageJson keeps indent, CRLF, and a missing final newline", () => {
  const crlf = '{\r\n    "name": "x"\r\n}\r\n';
  expect(serializePackageJson(JSON.parse(crlf), crlf)).toBe(crlf);
  const bare = '{\n  "name": "x"\n}';
  expect(serializePackageJson(JSON.parse(bare), bare)).toBe(bare);
});

test("GITIGNORE_NOTE is the line init writes", () => {
  expect(GITIGNORE_NOTE).toBe("# Kerstel: .env files hold references, safe to commit");
});
