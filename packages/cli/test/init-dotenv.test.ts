import { expect, test } from "bun:test";
import {
  entries,
  lookup,
  parseDotenv,
  serializeDotenv,
  setValue,
} from "../src/init/dotenv-file";

const GNARLY = [
  "# Leading comment",
  "",
  "DATABASE_URL=postgres://user:pw@localhost:5432/app",
  'API_KEY="sk-quoted-value"',
  "LITERAL='single $NOT_EXPANDED'",
  "export EXPORTED=exported-value",
  "  INDENTED=indented-value",
  "WITH_COMMENT=value # trailing note",
  "HASH_IN_VALUE=a#b",
  "EMPTY=",
  "ONLY_COMMENT=# nothing before me",
  "SPACED =  spaced-value  ",
  "not a pair at all",
  "",
].join("\n");

test("parse then serialize is byte-identical", () => {
  expect(serializeDotenv(parseDotenv(GNARLY))).toBe(GNARLY);
});

test("parse then serialize is byte-identical for CRLF and a missing final newline", () => {
  const source = "A=1\r\n# c\r\nB=2";
  expect(serializeDotenv(parseDotenv(source))).toBe(source);
});

test("parse then serialize is byte-identical for mixed line endings", () => {
  const source = "A=1\r\nB=2\nC=3\r\n";
  expect(serializeDotenv(parseDotenv(source))).toBe(source);
});

test("parse then serialize is byte-identical for an empty file", () => {
  expect(serializeDotenv(parseDotenv(""))).toBe("");
  expect(serializeDotenv(parseDotenv("\n"))).toBe("\n");
});

test("values decode per quoting style", () => {
  const file = parseDotenv(GNARLY);
  expect(lookup(file, "DATABASE_URL")).toBe("postgres://user:pw@localhost:5432/app");
  expect(lookup(file, "API_KEY")).toBe("sk-quoted-value");
  expect(lookup(file, "LITERAL")).toBe("single $NOT_EXPANDED");
  expect(lookup(file, "EXPORTED")).toBe("exported-value");
  expect(lookup(file, "INDENTED")).toBe("indented-value");
  expect(lookup(file, "WITH_COMMENT")).toBe("value");
  expect(lookup(file, "HASH_IN_VALUE")).toBe("a#b");
  expect(lookup(file, "EMPTY")).toBe("");
  expect(lookup(file, "ONLY_COMMENT")).toBe("");
  expect(lookup(file, "SPACED")).toBe("spaced-value");
  expect(lookup(file, "MISSING")).toBeNull();
});

test("escape sequences decode inside double quotes only", () => {
  const file = parseDotenv(['DQ="line1\\nline2\\t\\"quoted\\""', "SQ='line1\\nline2'"].join("\n"));
  expect(lookup(file, "DQ")).toBe('line1\nline2\t"quoted"');
  expect(lookup(file, "SQ")).toBe("line1\\nline2");
});

test("entries keeps key order and every occurrence", () => {
  const file = parseDotenv("B=1\nA=2\nB=3\n");
  expect(entries(file).map((e) => e.key)).toEqual(["B", "A", "B"]);
  // dotenv semantics: the last assignment in a file wins.
  expect(lookup(file, "B")).toBe("3");
});

test("setValue rewrites only the value bytes", () => {
  const file = parseDotenv(GNARLY);
  expect(setValue(file, "WITH_COMMENT", "kerstel://app/WITH_COMMENT")).toBe(1);
  const out = serializeDotenv(file);
  expect(out).toContain("WITH_COMMENT=kerstel://app/WITH_COMMENT # trailing note");
  // Everything else survives untouched.
  expect(out).toContain("# Leading comment");
  expect(out).toContain("  INDENTED=indented-value");
  expect(out).toContain("not a pair at all");
});

test("setValue preserves the original quoting style", () => {
  const file = parseDotenv(['A="old"', "B='old'", "C=old", "export D=old"].join("\n"));
  setValue(file, "A", "kerstel://app/A");
  setValue(file, "B", "kerstel://app/B");
  setValue(file, "C", "kerstel://app/C");
  setValue(file, "D", "kerstel://app/D");
  expect(serializeDotenv(file)).toBe(
    ['A="kerstel://app/A"', "B='kerstel://app/B'", "C=kerstel://app/C", "export D=kerstel://app/D"].join("\n"),
  );
});

test("setValue quotes an unquoted value that would otherwise change meaning", () => {
  const file = parseDotenv("A=old\n");
  setValue(file, "A", "has spaces # and a hash");
  expect(serializeDotenv(file)).toBe('A="has spaces # and a hash"\n');
});

test("setValue rewrites every occurrence of a duplicated key", () => {
  const file = parseDotenv("K=one\nOTHER=x\nK=two\n");
  expect(setValue(file, "K", "kerstel://app/K")).toBe(2);
  expect(serializeDotenv(file)).toBe("K=kerstel://app/K\nOTHER=x\nK=kerstel://app/K\n");
});

test("a value whose quote never closes is reported, not parsed", () => {
  const file = parseDotenv('GOOD=1\nMULTI="line one\nstill going"\n');
  expect(file.unsupported.map((u) => u.key)).toEqual(["MULTI"]);
  expect(entries(file).map((e) => e.key)).toEqual(["GOOD"]);
  // And it still round-trips: an unparsed line is carried as raw text.
  expect(serializeDotenv(file)).toBe('GOOD=1\nMULTI="line one\nstill going"\n');
});

test("a key whose name the parser does not support is reported, not silently kept", () => {
  const source = "GOOD=1\nMY-KEY=dash-secret\nmy.key=dotted-secret\n";
  const file = parseDotenv(source);
  expect(file.unsupported.map((u) => u.key)).toEqual(["MY-KEY", "my.key"]);
  expect(file.unsupported.map((u) => u.line)).toEqual([2, 3]);
  for (const entry of file.unsupported) {
    expect(entry.reason).toContain("key");
    expect(entry.reason).not.toContain("secret");
  }
  expect(entries(file).map((e) => e.key)).toEqual(["GOOD"]);
  // Still raw text, so the file round-trips byte for byte.
  expect(serializeDotenv(file)).toBe(source);
});

test("comments, blank lines and prose are not reported as unsupported keys", () => {
  const file = parseDotenv("# a=b in a comment\n\n   \nnot a pair at all\nGOOD=1\n");
  expect(file.unsupported).toEqual([]);
});

test("the continuation lines of an unclosed quote are never mined for key names", () => {
  // Base64 key material pads with "=", which a naive "text before =" reader
  // would report as a key -- printing the secret it exists to hide.
  const source = 'K="-----BEGIN KEY-----\nMIIEowIBAAKCAQEAsecretkeymaterial==\n-----END KEY-----"\n';
  const file = parseDotenv(source);
  expect(file.unsupported.map((u) => u.key)).toEqual(["K"]);
  expect(JSON.stringify(file.unsupported)).not.toContain("MIIEow");
  expect(serializeDotenv(file)).toBe(source);
});
