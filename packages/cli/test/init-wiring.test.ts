import { expect, test } from "bun:test";
import { renderDiff, wirePackageJson, wrapScript } from "../src/init/wiring";

const strip = (text: string): string => text.replace(/\[[0-9;]*m/g, "");

const NPM_PACKAGE = `{
  "name": "demo",
  "version": "1.0.0",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "postinstall": "patch-package",
    "lint": "kerstel exec -- eslint ."
  },
  "dependencies": {
    "next": "^15.0.0"
  }
}
`;

const NPM_PACKAGE_WIRED = `{
  "name": "demo",
  "version": "1.0.0",
  "scripts": {
    "dev": "kerstel exec -- next dev",
    "build": "kerstel exec -- next build",
    "postinstall": "patch-package",
    "lint": "kerstel exec -- eslint ."
  },
  "dependencies": {
    "next": "^15.0.0"
  }
}
`;

test("wrapScript builds the shim invocation", () => {
  expect(wrapScript("next dev")).toBe("kerstel exec -- next dev");
});

test("wirePackageJson rewrites scripts and preserves key order and formatting", () => {
  const result = wirePackageJson(NPM_PACKAGE);
  expect(result.changed).toBe(true);
  expect(result.contents).toBe(NPM_PACKAGE_WIRED);
  expect(result.rewrites.map((r) => r.name)).toEqual(["dev", "build"]);
  expect(result.skipped).toEqual([
    { name: "postinstall", reason: "lifecycle" },
    { name: "lint", reason: "already-wired" },
  ]);
});

test("wirePackageJson never wraps an npm lifecycle hook", () => {
  const source = `{
  "scripts": {
    "preinstall": "node check.js",
    "install": "node-gyp rebuild",
    "postinstall": "patch-package",
    "prepare": "husky",
    "prepublishOnly": "npm test",
    "start": "node server.js"
  }
}
`;
  const result = wirePackageJson(source);
  expect(result.rewrites.map((r) => r.name)).toEqual(["start"]);
  expect(result.contents).toContain('"preinstall": "node check.js"');
  expect(result.contents).toContain('"prepublishOnly": "npm test"');
  expect(result.contents).toContain('"start": "kerstel exec -- node server.js"');
});

test("wirePackageJson is idempotent and leaves an already-wired file byte-identical", () => {
  const once = wirePackageJson(NPM_PACKAGE);
  const twice = wirePackageJson(once.contents);
  expect(twice.changed).toBe(false);
  expect(twice.contents).toBe(once.contents);
  expect(twice.rewrites).toEqual([]);
});

test("wirePackageJson preserves a tab indent", () => {
  const source = '{\n\t"scripts": {\n\t\t"dev": "vite"\n\t}\n}\n';
  expect(wirePackageJson(source).contents).toBe(
    '{\n\t"scripts": {\n\t\t"dev": "kerstel exec -- vite"\n\t}\n}\n',
  );
});

test("wirePackageJson preserves a four-space indent", () => {
  const source = '{\n    "scripts": {\n        "dev": "vite"\n    }\n}\n';
  expect(wirePackageJson(source).contents).toBe(
    '{\n    "scripts": {\n        "dev": "kerstel exec -- vite"\n    }\n}\n',
  );
});

test("wirePackageJson handles a file with no scripts at all", () => {
  const source = '{\n  "name": "demo"\n}\n';
  const result = wirePackageJson(source);
  expect(result.changed).toBe(false);
  expect(result.contents).toBe(source);
});

test("wirePackageJson skips a non-string script value instead of mangling it", () => {
  const source = '{\n  "scripts": {\n    "weird": null,\n    "dev": "vite"\n  }\n}\n';
  const result = wirePackageJson(source);
  expect(result.skipped).toEqual([{ name: "weird", reason: "not-a-string" }]);
  expect(result.contents).toContain('"weird": null');
});

test("renderDiff shows the changed lines with context", () => {
  const before = "a\nb\nc\nd\ne\n";
  const after = "a\nb\nCHANGED\nd\ne\n";
  const out = strip(renderDiff("package.json", before, after)).split("\n");
  expect(out[0]).toBe("package.json");
  expect(out).toContain("  b");
  expect(out).toContain("- c");
  expect(out).toContain("+ CHANGED");
  expect(out).toContain("  d");
  // Unchanged lines far from the edit are not printed.
  expect(out.join("\n")).not.toContain("  a");
});

test("renderDiff handles pure insertion", () => {
  const out = strip(renderDiff("package.json", "", '{\n  "name": "site"\n}\n'));
  expect(out).toContain('+   "name": "site"');
  expect(out).not.toContain("- ");
});


test("wiring keeps CRLF line endings", () => {
  const source = NPM_PACKAGE.replace(/\n/g, "\r\n");
  const wired = wirePackageJson(source);
  expect(wired.changed).toBe(true);
  expect(wired.contents.replace(/\r\n/g, "")).not.toContain("\n");
  expect(wired.contents.endsWith("}\r\n")).toBe(true);
});

test("wiring keeps a missing final newline missing", () => {
  const wired = wirePackageJson(NPM_PACKAGE.trimEnd());
  expect(wired.changed).toBe(true);
  expect(wired.contents.endsWith("}")).toBe(true);
});

test("renderDiff leaves an unchanged line between two edits out of the diff", () => {
  const out = strip(renderDiff(".env", "A=1\nB=2\nC=3\n", "A=x\nB=2\nC=y\n"));
  expect(out).toContain("- A=1");
  expect(out).toContain("+ A=x");
  expect(out).toContain("- C=3");
  expect(out).toContain("+ C=y");
  expect(out).not.toContain("- B=2");
  expect(out).not.toContain("+ B=2");
});

test("wirePackageJson wires each command of a compound script, after its assignments", () => {
  const source = `{
  "scripts": {
    "dev": "node scripts/copy.mjs && next dev --port 3020",
    "start": "NODE_ENV=production next start",
    "half": "kerstel exec -- node a.js && next dev",
    "postbuild": "cd out && node fix.js",
    "clean": "rm -rf dist"
  }
}
`;
  const result = wirePackageJson(source);
  expect(result.rewrites.map((r) => [r.name, r.after])).toEqual([
    ["dev", "kerstel exec -- node scripts/copy.mjs && kerstel exec -- next dev --port 3020"],
    ["start", "NODE_ENV=production kerstel exec -- next start"],
    ["half", "kerstel exec -- node a.js && kerstel exec -- next dev"],
  ]);
  expect(result.skipped).toEqual([
    { name: "postbuild", reason: "changes-directory" },
    { name: "clean", reason: "nothing-to-wire" },
  ]);
  expect(wirePackageJson(result.contents).changed).toBe(false);
});
