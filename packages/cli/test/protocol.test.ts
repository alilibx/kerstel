import { expect, test } from "bun:test";
import { LineDecoder, PROTOCOL_VERSION, encodeMessage, errorResponse } from "../src/daemon/protocol";

test("encodeMessage produces one newline-terminated JSON line", () => {
  const line = encodeMessage({ v: PROTOCOL_VERSION, id: "1", op: "status" });
  expect(line.endsWith("\n")).toBe(true);
  expect(line.indexOf("\n")).toBe(line.length - 1);
  expect(JSON.parse(line)).toEqual({ v: 1, id: "1", op: "status" });
});

test("LineDecoder reassembles messages split across chunks", () => {
  const decoder = new LineDecoder();
  expect(decoder.push(Buffer.from('{"a":'))).toEqual([]);
  expect(decoder.push(Buffer.from('1}\n{"b":2}'))).toEqual(['{"a":1}']);
  expect(decoder.push(Buffer.from("\n"))).toEqual(['{"b":2}']);
});

test("LineDecoder returns several messages from one chunk", () => {
  const decoder = new LineDecoder();
  expect(decoder.push(Buffer.from("a\nb\nc\n"))).toEqual(["a", "b", "c"]);
});

test("LineDecoder ignores empty lines", () => {
  const decoder = new LineDecoder();
  expect(decoder.push(Buffer.from("\n\nx\n"))).toEqual(["x"]);
});

test("LineDecoder throws when a single line exceeds the cap", () => {
  const decoder = new LineDecoder(64);
  expect(() => decoder.push(Buffer.from("x".repeat(65)))).toThrow(/too large/i);
});

test("errorResponse carries a code and a message and never succeeds", () => {
  const res = errorResponse("req-1", "not_found", "no such secret");
  expect(res).toEqual({
    v: 1,
    id: "req-1",
    ok: false,
    error: { code: "not_found", message: "no such secret" },
  });
});
