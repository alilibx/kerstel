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

test("one row per key and place, each naming its files", () => {
  const loaded = load({
    ".env.local": "STRIPE_KEY=kerstel://global/STRIPE_KEY\nPORT=4000\n",
    ".env": "STRIPE_KEY=kerstel://whasal/STRIPE_KEY\nPORT=3000\nDB=kerstel://whasal/DB\n",
  });
  const { rows, foreign } = scanRows(loaded, "whasal");

  expect(foreign).toEqual([]);
  expect(rows.map((r) => [r.id, r.files])).toEqual([
    ["STRIPE_KEY:global", [".env.local"]],
    ["PORT:plaintext", [".env.local", ".env"]],
    ["STRIPE_KEY:project", [".env"]],
    ["DB:project", [".env"]],
  ]);
  const port = rows.find((r) => r.id === "PORT:plaintext")!;
  expect(port.value).toBe("4000");
  expect(port.conflicts).toEqual([".env"]);
  expect(rows.find((r) => r.id === "DB:project")!.ref).toEqual({ scope: "whasal", key: "DB" });
});

test("a key with a reference in one file and a plain value in another gives two rows", () => {
  const { rows } = scanRows(load({ ".env.local": "K=plain\n", ".env": "K=kerstel://app/K\n" }), "app");
  expect(rows.map((r) => r.id)).toEqual(["K:plaintext", "K:project"]);
});

test("the last assignment in a file decides that file's row", () => {
  const { rows } = scanRows(load({ ".env": "K=first\nK=kerstel://app/K\n" }), "app");
  expect(rows.map((r) => r.id)).toEqual(["K:project"]);
});

test("a reference to another project's scope is foreign, not a row", () => {
  const { rows, foreign } = scanRows(load({ ".env": "K=kerstel://other/K\n" }), "app");
  expect(rows).toEqual([]);
  expect(foreign).toEqual([{ key: "K", reference: "kerstel://other/K", files: [".env"] }]);
});

test("the project scope is the one non-global scope the files reference", () => {
  expect(resolveProjectScope(load({ ".env": "A=kerstel://custom/A\nB=kerstel://global/B\n" }), "derived")).toBe(
    "custom",
  );
  expect(resolveProjectScope(load({ ".env": "A=plain\n" }), "derived")).toBe("derived");
  expect(resolveProjectScope(load({ ".env": "A=kerstel://one/A\nB=kerstel://two/B\n" }), "derived")).toBe(
    "derived",
  );
});
