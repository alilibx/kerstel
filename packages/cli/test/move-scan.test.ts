import { expect, test } from "bun:test";
import { join } from "node:path";
import type { LoadedEnvFile } from "../src/init/collect";
import { parseDotenv } from "../src/init/dotenv-file";
import { resolveProjectScope, scanRows } from "../src/move/scan";

/** Files in precedence order, highest first, as discoverEnvFiles returns them. */
function load(files: Record<string, string>): LoadedEnvFile[] {
  return Object.entries(files).map(([name, original], i) => ({
    info: { name, path: join("/project", name), rank: 100 - i },
    original,
    file: parseDotenv(original),
  }));
}

test("one row per key and reference (or plain text), each naming its files", () => {
  const loaded = load({
    ".env.local": "STRIPE_KEY=ks:global\nPORT=4000\n",
    ".env": "STRIPE_KEY=ks:whasal\nPORT=3000\nDB=ks:whasal\n",
  });
  const { rows, foreign } = scanRows(loaded, "whasal");

  expect(foreign).toEqual([]);
  expect(rows.map((r) => [r.id, r.files])).toEqual([
    ["STRIPE_KEY:ks:global/STRIPE_KEY", [".env.local"]],
    ["PORT:plaintext", [".env.local", ".env"]],
    ["STRIPE_KEY:ks:whasal/STRIPE_KEY", [".env"]],
    ["DB:ks:whasal/DB", [".env"]],
  ]);
  const port = rows.find((r) => r.id === "PORT:plaintext")!;
  expect(port.value).toBe("4000");
  expect(port.conflicts).toEqual([".env"]);
  expect(rows.find((r) => r.id === "DB:ks:whasal/DB")!.ref).toEqual({ scope: "whasal", key: "DB" });
});

test("a key with a reference in one file and a plain value in another gives two rows", () => {
  const { rows } = scanRows(load({ ".env.local": "K=plain\n", ".env": "K=ks:app\n" }), "app");
  expect(rows.map((r) => r.id)).toEqual(["K:plaintext", "K:ks:app/K"]);
});

test("two different project references for one key give two rows, each with its own reference and file", () => {
  const { rows } = scanRows(
    load({ ".env.local": "K=ks:app/K_LOCAL\n", ".env": "K=ks:app\n" }),
    "app",
  );
  expect(rows.map((r) => [r.id, r.place, r.ref, r.files])).toEqual([
    ["K:ks:app/K_LOCAL", "project", { scope: "app", key: "K_LOCAL" }, [".env.local"]],
    ["K:ks:app/K", "project", { scope: "app", key: "K" }, [".env"]],
  ]);
});

test("the last assignment in a file decides that file's row", () => {
  const { rows } = scanRows(load({ ".env": "K=first\nK=ks:app\n" }), "app");
  expect(rows.map((r) => r.id)).toEqual(["K:ks:app/K"]);
});

test("a reference to another project's scope is foreign, not a row", () => {
  const { rows, foreign } = scanRows(load({ ".env": "K=ks:other\n" }), "app");
  expect(rows).toEqual([]);
  expect(foreign).toEqual([{ key: "K", reference: "ks:other", files: [".env"] }]);
});

test("the project scope is the one non-global scope the files reference", () => {
  expect(resolveProjectScope(load({ ".env": "A=ks:custom\nB=ks:global\n" }), "derived")).toBe(
    "custom",
  );
  expect(resolveProjectScope(load({ ".env": "A=plain\n" }), "derived")).toBe("derived");
  expect(resolveProjectScope(load({ ".env": "A=ks:one\nB=ks:two\n" }), "derived")).toBe(
    "derived",
  );
});

test("ks: and kerstel:// spellings of one reference are one row", () => {
  const { rows } = scanRows(
    load({ ".env.local": "K=kerstel://app/K\n", ".env": "K=ks:app\n", ".env.example": "K=ks:app/K\n" }),
    "app",
  );
  expect(rows.map((r) => [r.id, r.files])).toEqual([["K:ks:app/K", [".env.local", ".env", ".env.example"]]]);
});
