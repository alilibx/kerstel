import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { pairingCode } from "../src/sync/crypto";
import {
  encodeJoinValue,
  JOIN_PREFIX,
  type JoinValue,
  parseJoinInput,
  parseJoinValue,
} from "../src/sync/join-value";

const secret = Buffer.from("0123456789abcde");
const pin = Buffer.alloc(32, 7);

function value(): string {
  return encodeJoinValue({ urls: ["https://sync.example.com"], pin: null, secret });
}

describe("join value", () => {
  test("round trip without a pin", () => {
    const input: JoinValue = { urls: ["https://sync.example.com"], pin: null, secret };
    const text = encodeJoinValue(input);
    expect(text.startsWith(JOIN_PREFIX)).toBe(true);
    expect(text).toMatch(/^ks1-[A-Za-z0-9_-]+$/);
    expect(text.length).toBeLessThan(80);
    expect(parseJoinValue(text)).toEqual(input);
  });

  test("round trip with a pin and two URLs", () => {
    const input: JoinValue = {
      urls: ["https://homebox.local:8787", "https://192.168.1.20:8787"],
      pin,
      secret,
    };
    expect(parseJoinValue(encodeJoinValue(input))).toEqual(input);
  });

  test("a truncated value is malformed", () => {
    const text = value();
    expect(parseJoinValue(text.slice(0, -1))).toBe("malformed");
    expect(parseJoinValue(text.slice(0, -4))).toBe("malformed");
    expect(parseJoinValue(JOIN_PREFIX)).toBe("malformed");
    const mid = Math.floor(text.length / 2);
    const swapped = text[mid] === "A" ? "B" : "A";
    expect(parseJoinValue(text.slice(0, mid) + swapped + text.slice(mid + 1))).toBe("malformed");
  });

  test("a newer version is reported as newer", () => {
    expect(parseJoinValue("ks2-AAAA")).toBe("newer");
    expect(parseJoinValue("ks0-AAAA")).toBe("malformed");
    expect(parseJoinValue("KS-7Q2M")).toBe("malformed");
  });

  test("a control character in a URL is malformed", () => {
    for (const url of ["https://sync.example.com\x1b[2J", "https://sync.example.com\t"]) {
      expect(parseJoinValue(encodeJoinValue({ urls: [url], pin: null, secret }))).toBe("malformed");
    }
  });

  test("a stray character or a space inside one word is malformed", () => {
    const text = value();
    const mid = Math.floor(text.length / 2);
    expect(parseJoinValue(text.slice(0, mid) + "!" + text.slice(mid + 1))).toBe("malformed");
    expect(parseJoinValue(text.slice(0, mid) + " " + text.slice(mid))).toBe("malformed");
  });

  test("an unknown flag is malformed", () => {
    const head = Buffer.concat([Buffer.from([0x02]), secret, Buffer.from("https://x.example")]);
    const sum = createHash("sha256").update(head).digest().subarray(0, 4);
    const text = JOIN_PREFIX + Buffer.concat([head, sum]).toString("base64url");
    expect(parseJoinValue(text)).toBe("malformed");
  });

  test("encode refuses bad input", () => {
    const ok = "https://sync.example.com";
    expect(() => encodeJoinValue({ urls: [], pin: null, secret })).toThrow();
    expect(() => encodeJoinValue({ urls: Array(5).fill(ok), pin: null, secret })).toThrow();
    expect(() => encodeJoinValue({ urls: [`${ok}\n/x`], pin: null, secret })).toThrow();
    expect(() =>
      encodeJoinValue({ urls: [ok], pin: null, secret: Buffer.alloc(14) }),
    ).toThrow();
    expect(() => encodeJoinValue({ urls: [ok], pin: Buffer.alloc(31), secret })).toThrow();
  });

  test("parseJoinInput takes the value, the old form, or nothing", () => {
    const text = value();
    const expected = { urls: ["https://sync.example.com"], pin: null, secret };
    expect(parseJoinInput([text])).toEqual(expected);
    expect(parseJoinInput(["ks", "sync", "join", text])).toEqual(expected);
    expect(
      parseJoinInput(["kerstel", "sync", "join", "https://sync.example.com/", pairingCode(secret)]),
    ).toEqual(expected);
    expect(parseJoinInput([])).toEqual({ error: "empty" });
    expect(parseJoinInput(["ks", "sync", "join"])).toEqual({ error: "empty" });
    expect(parseJoinInput(["https://x", "nope"])).toEqual({ error: "malformed" });
    expect(parseJoinInput(["ks2-AAAA"])).toEqual({ error: "newer" });
  });

  test("pasted text with the command and a line break parses", () => {
    const text = encodeJoinValue({
      urls: ["https://homebox.local:8787"],
      pin,
      secret,
    });
    const pasted = `ks sync join ${text.slice(0, 30)}\n${text.slice(30)}\n`;
    expect(parseJoinInput(pasted.split(/\s+/))).toEqual({
      urls: ["https://homebox.local:8787"],
      pin,
      secret,
    });
  });
});
