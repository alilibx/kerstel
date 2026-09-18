import { expect, test } from "bun:test";
import { renderDiff, wireBunfig, wirePackageJson, wrapScript } from "../src/init/wiring";

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

test("wireBunfig creates the file when there is none", () => {
  const result = wireBunfig(null, "/home/dev/.kerstel/hook/preload.cjs");
  expect(result.created).toBe(true);
  expect(result.changed).toBe(true);
  expect(result.contents).toBe('preload = ["/home/dev/.kerstel/hook/preload.cjs"]\n');
});

test("wireBunfig adds a top-level preload above the first section", () => {
  const source = '# project config\n\n[test]\ncoverage = false\n';
  const result = wireBunfig(source, "/hook/preload.cjs");
  expect(result.created).toBe(false);
  expect(result.contents).toBe(
    '# project config\n\npreload = ["/hook/preload.cjs"]\n[test]\ncoverage = false\n',
  );
});

test("wireBunfig appends when the file has no sections", () => {
  const result = wireBunfig("telemetry = false\n", "/hook/preload.cjs");
  expect(result.contents).toBe('telemetry = false\npreload = ["/hook/preload.cjs"]\n');
});

test("wireBunfig merges into an existing preload array", () => {
  const source = 'preload = ["./setup.ts"]\n\n[test]\npreload = ["./test-setup.ts"]\n';
  const result = wireBunfig(source, "/hook/preload.cjs");
  expect(result.contents).toBe(
    'preload = ["./setup.ts", "/hook/preload.cjs"]\n\n[test]\npreload = ["./test-setup.ts"]\n',
  );
});

test("wireBunfig is idempotent", () => {
  const source = 'preload = ["/hook/preload.cjs"]\n';
  const result = wireBunfig(source, "/hook/preload.cjs");
  expect(result.changed).toBe(false);
  expect(result.contents).toBe(source);
});

test("wireBunfig fills an empty preload array", () => {
  expect(wireBunfig("preload = []\n", "/hook/preload.cjs").contents).toBe(
    'preload = ["/hook/preload.cjs"]\n',
  );
});

test("wireBunfig refuses a multi-line preload array rather than corrupting it", () => {
  const source = 'preload = [\n  "./setup.ts"\n]\n';
  expect(() => wireBunfig(source, "/hook/preload.cjs")).toThrow(/by hand/);
});

test("wireBunfig preserves CRLF line endings", () => {
  const result = wireBunfig("telemetry = false\r\n", "/hook/preload.cjs");
  expect(result.contents).toBe('telemetry = false\r\npreload = ["/hook/preload.cjs"]\r\n');
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
  const out = strip(renderDiff("bunfig.toml", "", 'preload = ["/hook/preload.cjs"]\n'));
  expect(out).toContain('+ preload = ["/hook/preload.cjs"]');
  expect(out).not.toContain("- ");
});
