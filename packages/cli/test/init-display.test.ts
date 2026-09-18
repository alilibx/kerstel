import { expect, test } from "bun:test";
import { describeValue, maskForDisplay } from "../src/init/display";
import { GITIGNORE_NOTE, serializePackageJson } from "../src/init/wiring";

test("describeValue gives shape and size only", () => {
  expect(describeValue("")).toBe("empty");
  expect(describeValue("postgres://u:p@h/db")).toBe("19 chars, url");
  expect(describeValue("sk-abc")).toBe("6 chars, opaque");
});

test("maskForDisplay hides plaintext, keeps references, comments, and quoting", () => {
  const source = '# note\nA=secret-value\nB="quoted secret"\nC=kerstel://demo/C\n';
  const masked = maskForDisplay(source);
  expect(masked).not.toContain("secret-value");
  expect(masked).not.toContain("quoted secret");
  expect(masked).toContain("# note\n");
  expect(masked).toContain("A=«12-chars-opaque»\n");
  expect(masked).toContain('B="«13-chars-opaque»"\n');
  expect(masked).toContain("C=kerstel://demo/C\n");
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
