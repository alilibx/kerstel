import { expect, test } from "bun:test";
import {
  entries,
  lookup,
  parseDotenv,
  serializeDotenv,
  setLineValue,
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

/**
 * The decoded value is what the app would have received, so the only authority
 * is what the runtimes that read a `.env` actually do. Observed 2026-09-18 with
 * bun 1.3.10 and node v24.19.0 `--env-file`, one key per escape:
 *
 *   escape | bun            | node --env-file
 *   \\n     | newline        | newline
 *   \\r     | carriage ret.  | literal \\r
 *   \\t     | literal \\t     | literal \\t
 *   \\$     | $              | literal \\$
 *   \\"     | literal \\"     | ends the value at the quote
 *   \\\\     | literal \\\\     | literal \\\\
 *   \\U \\x  | literal        | literal
 *
 * Only `\\n` is decoded by both, so only `\\n` is decoded here. Everything else
 * keeps the bytes the developer typed, which is the answer that cannot turn
 * `C:\\Users\\x` into `C:Usersx` behind their back.
 */
test("a newline escape decodes inside double quotes only", () => {
  const file = parseDotenv(['DQ="line1\\nline2"', "SQ='line1\\nline2'"].join("\n"));
  expect(lookup(file, "DQ")).toBe("line1\nline2");
  expect(lookup(file, "SQ")).toBe("line1\\nline2");
});

test("every escape neither runtime decodes keeps its backslash", () => {
  const file = parseDotenv(
    [
      'WINDOWS_PATH="C:\\Users\\x"',
      'UNC="\\\\server\\share"',
      'TAB="a\\tb"',
      'DOLLAR="a\\$b"',
      'DOUBLE_BACKSLASH="a\\\\b"',
      'CARRIAGE="a\\rb"',
      'QUOTED="a\\"b"',
      'UNKNOWN="a\\Ub"',
    ].join("\n"),
  );
  expect(lookup(file, "WINDOWS_PATH")).toBe("C:\\Users\\x");
  expect(lookup(file, "UNC")).toBe("\\\\server\\share");
  expect(lookup(file, "TAB")).toBe("a\\tb");
  expect(lookup(file, "DOLLAR")).toBe("a\\$b");
  expect(lookup(file, "DOUBLE_BACKSLASH")).toBe("a\\\\b");
  expect(lookup(file, "CARRIAGE")).toBe("a\\rb");
  // The escaped quote does not close the value (bun agrees; node truncates).
  expect(lookup(file, "QUOTED")).toBe('a\\"b');
  expect(lookup(file, "UNKNOWN")).toBe("a\\Ub");
});

test("a rewritten value re-reads as itself, backslashes and all", () => {
  for (const value of ["C:\\Users\\x", "a\\tb", "line1\nline2", "has spaces", "plain"]) {
    const file = parseDotenv('A="old"\n');
    setValue(file, "A", value);
    expect(lookup(parseDotenv(serializeDotenv(file)), "A")).toBe(value);
  }
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

test("comments and blank lines are not reported; prose is, by line number and never by its text", () => {
  const file = parseDotenv("# a=b in a comment\n\n   \nnot a pair at all\nGOOD=1\n");
  expect(file.unsupported.map((u) => [u.key, u.line])).toEqual([["line 4", 4]]);
  expect(JSON.stringify(file.unsupported)).not.toContain("not a pair");
});

test("an unquoted PEM block is one unsupported value, and its body is never a key", () => {
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7PEMBODY";
  const tail = "kL0tuEJ6abcdEFGH1234567890abcdefghijklmnopqrstuvwxyz==";
  const source = [
    "GOOD=1",
    "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----",
    body,
    tail,
    "-----END PRIVATE KEY-----",
    "AFTER=2",
    "",
  ].join("\n");
  const file = parseDotenv(source);
  expect(entries(file).map((e) => e.key)).toEqual(["GOOD", "AFTER"]);
  expect(file.unsupported.map((u) => [u.key, u.line])).toEqual([["PRIVATE_KEY", 2]]);
  expect(file.unsupported[0]?.reason).toContain("PEM");
  expect(JSON.stringify(file.unsupported)).not.toContain("PEMBODY");
  expect(JSON.stringify(file.unsupported)).not.toContain("kL0tu");
  expect(serializeDotenv(file)).toBe(source);
});

test("a base64 line outside a PEM block is reported by line number, not read as a key", () => {
  const file = parseDotenv("GOOD=1\nkL0tuEJ6abcdEFGH1234567890abcdefghij==\na+b/c9Q==\neyJhbGciOi_JIUzI1NiJ9_abcDEF123==\n");
  expect(entries(file).map((e) => e.key)).toEqual(["GOOD"]);
  expect(file.unsupported.map((u) => u.key)).toEqual(["line 2", "line 3", "line 4"]);
  expect(JSON.stringify(file.unsupported)).not.toContain("kL0tu");
  expect(JSON.stringify(file.unsupported)).not.toContain("a+b");
  expect(JSON.stringify(file.unsupported)).not.toContain("eyJhbG");
});

test("a one-line value that merely starts with a PEM header is an ordinary pair", () => {
  const file = parseDotenv("TOKEN=-----BEGIN CUSTOM TOKEN-----abc123\nAFTER=2\nQUOTED=\"-----BEGIN X-----\"\n");
  expect(entries(file).map((e) => [e.key, e.value])).toEqual([
    ["TOKEN", "-----BEGIN CUSTOM TOKEN-----abc123"],
    ["AFTER", "2"],
    ["QUOTED", "-----BEGIN X-----"],
  ]);
  expect(file.unsupported).toEqual([]);
});

test("a PEM block with no footer is named as such, and nothing after it is mined", () => {
  const source = "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgPEMBODY\nkL0tuEJ6abcdEFGH1234567890abcdefghij==\nSTRIPE_SECRET=sk_live_after\n";
  const file = parseDotenv(source);
  expect(entries(file)).toEqual([]);
  expect(file.unsupported.map((u) => u.key)).toEqual(["PRIVATE_KEY"]);
  expect(file.unsupported[0]?.reason).toContain("-----END line is missing");
  expect(JSON.stringify(file.unsupported)).not.toContain("sk_live");
  expect(serializeDotenv(file)).toBe(source);
});

test("a name too long to be a variable is reported by line number", () => {
  const file = parseDotenv(`${"A".repeat(65)}=x\nSHORT_ENOUGH_${"B".repeat(40)}=y\n`);
  expect(entries(file).map((e) => e.key)).toEqual([`SHORT_ENOUGH_${"B".repeat(40)}`]);
  expect(file.unsupported.map((u) => u.key)).toEqual(["line 1"]);
});

test("ordinary names with digits and mixed case are still keys", () => {
  const file = parseDotenv("MyApp2Secret=x\nnpm_config_registry=y\nS3_BUCKET=z\nPath=w\n");
  expect(entries(file).map((e) => e.key)).toEqual(["MyApp2Secret", "npm_config_registry", "S3_BUCKET", "Path"]);
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

test("a lone carriage return ends a line, as dotenv treats it", () => {
  const source = "A=1\rB=2\r";
  const file = parseDotenv(source);
  expect(entries(file).map((e) => [e.key, e.value])).toEqual([
    ["A", "1"],
    ["B", "2"],
  ]);
  expect(file.unsupported).toEqual([]);
  expect(serializeDotenv(file)).toBe(source);
});

test("setLineValue rewrites only the targeted line and throws on non-pair lines", () => {
  const file = parseDotenv("K=one\nOTHER=x\nK=two\n# comment\n");
  // Rewrite only the second K (at index 2)
  setLineValue(file, 2, "kerstel://app/K");
  expect(serializeDotenv(file)).toBe("K=one\nOTHER=x\nK=kerstel://app/K\n# comment\n");

  // Throws on a non-pair line (comment at index 3)
  expect(() => setLineValue(file, 3, "value")).toThrow();
});

test("setLineValue preserves quoting style like setValue", () => {
  const file = parseDotenv(['A="old"', "B='old'"].join("\n"));
  setLineValue(file, 0, "kerstel://app/A");
  setLineValue(file, 1, "kerstel://app/B");
  expect(serializeDotenv(file)).toBe(
    ['A="kerstel://app/A"', "B='kerstel://app/B'"].join("\n"),
  );
});
