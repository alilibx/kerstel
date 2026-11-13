import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { encodeServerValue, parseServerValue, SERVER_VALUE_PREFIX, type ServerValue } from "../src/server-value";

const token = "Zm9vYmFyYmF6cXV4LXRlc3QtdG9rZW4tbm90LWEtcmVhbA";
const pin = Buffer.alloc(32, 7);

/** Compares without letting a failed assertion print the token. */
function expectSame(parsed: ReturnType<typeof parseServerValue>, input: ServerValue): void {
  expect(typeof parsed).toBe("object");
  const value = parsed as ServerValue;
  expect(value.urls).toEqual(input.urls);
  expect(value.pin === null ? null : value.pin.toString("hex")).toEqual(input.pin === null ? null : input.pin.toString("hex"));
  expect(value.token === input.token).toBe(true);
}

/** A value built by hand from `head`, with a correct checksum. */
function handMade(head: Buffer): string {
  const sum = createHash("sha256").update(head).digest().subarray(0, 4);
  return SERVER_VALUE_PREFIX + Buffer.concat([head, sum]).toString("base64url");
}

function tokenBytes(t: string): Buffer {
  const bytes = Buffer.from(t, "utf8");
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}

describe("server value", () => {
  test("round trip without a pin", () => {
    const input: ServerValue = { urls: ["https://sync.example.com"], pin: null, token };
    const text = encodeServerValue(input);
    expect(text).toMatch(/^ks-server1-[A-Za-z0-9_-]+$/);
    expectSame(parseServerValue(text), input);
  });

  test("round trip with a pin and two URLs", () => {
    const input: ServerValue = { urls: ["https://homebox.local:8787", "https://192.168.1.20:8787"], pin, token };
    expectSame(parseServerValue(encodeServerValue(input)), input);
    // Whitespace around a pasted value is ignored.
    expectSame(parseServerValue(`  ${encodeServerValue(input)}\n`), input);
  });

  test("a truncated or changed value is malformed", () => {
    const text = encodeServerValue({ urls: ["https://sync.example.com"], pin, token });
    expect(parseServerValue(text.slice(0, -1))).toBe("malformed");
    expect(parseServerValue(text.slice(0, -4))).toBe("malformed");
    expect(parseServerValue(SERVER_VALUE_PREFIX)).toBe("malformed");
    const mid = Math.floor(text.length / 2);
    expect(parseServerValue(text.slice(0, mid) + (text[mid] === "A" ? "B" : "A") + text.slice(mid + 1))).toBe("malformed");
    expect(parseServerValue(text.slice(0, mid) + "!" + text.slice(mid + 1))).toBe("malformed");
    expect(parseServerValue(text.slice(0, mid) + " " + text.slice(mid))).toBe("malformed");
    expect(parseServerValue(`ks1-${text.slice(SERVER_VALUE_PREFIX.length)}`)).toBe("malformed");
  });

  test("a newer version is reported as newer", () => {
    expect(parseServerValue("ks-server2-AAAA")).toBe("newer");
    expect(parseServerValue("ks-server0-AAAA")).toBe("malformed");
    expect(parseServerValue("ks-server-AAAA")).toBe("malformed");
  });

  test("a value from elsewhere with bad fields is malformed", () => {
    const url = Buffer.from("https://x.example");
    // An unknown flag.
    expect(parseServerValue(handMade(Buffer.concat([Buffer.from([0x02]), tokenBytes(token), url])))).toBe("malformed");
    // An empty token.
    expect(parseServerValue(handMade(Buffer.concat([Buffer.from([0]), Buffer.from([0]), url])))).toBe("malformed");
    // A token longer than what is left.
    expect(parseServerValue(handMade(Buffer.concat([Buffer.from([0, 200]), Buffer.from("abc"), url])))).toBe("malformed");
    // No URL.
    expect(parseServerValue(handMade(Buffer.concat([Buffer.from([0]), tokenBytes(token)])))).toBe("malformed");
    // A control character in a URL.
    const tab = Buffer.from("https://x.example\t");
    expect(parseServerValue(handMade(Buffer.concat([Buffer.from([0]), tokenBytes(token), tab])))).toBe("malformed");
    // Five URLs.
    const five = Buffer.from(Array(5).fill("https://x.example").join("\n"));
    expect(parseServerValue(handMade(Buffer.concat([Buffer.from([0]), tokenBytes(token), five])))).toBe("malformed");
    // The same fields, well formed, parse.
    expect(typeof parseServerValue(handMade(Buffer.concat([Buffer.from([0]), tokenBytes(token), url])))).toBe("object");
  });

  test("encoding refuses bad input", () => {
    const urls = ["https://sync.example.com"];
    expect(() => encodeServerValue({ urls, pin: null, token: "" })).toThrow();
    expect(() => encodeServerValue({ urls, pin: null, token: "a".repeat(256) })).toThrow();
    expect(() => encodeServerValue({ urls, pin: null, token: "a".repeat(255) })).not.toThrow();
    expect(() => encodeServerValue({ urls: [], pin: null, token })).toThrow();
    expect(() => encodeServerValue({ urls: Array(5).fill(urls[0]), pin: null, token })).toThrow();
    expect(() => encodeServerValue({ urls: ["https://sync.example.com\t"], pin: null, token })).toThrow();
    expect(() => encodeServerValue({ urls: [""], pin: null, token })).toThrow();
    expect(() => encodeServerValue({ urls, pin: Buffer.alloc(31), token })).toThrow();
  });

  test("an encoding error never names the token", () => {
    const long = "s".repeat(300);
    try {
      encodeServerValue({ urls: ["https://sync.example.com"], pin: null, token: long });
      throw new Error("encodeServerValue accepted a 300-byte token");
    } catch (error) {
      expect((error as Error).message.includes(long)).toBe(false);
    }
  });
});
