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

// A secret with a non-ASCII character is perfectly ordinary, and the socket is
// free to split a read anywhere -- including between the two bytes of "é"
// (0xC3 0xA9). Decoding each chunk on its own turns that into two U+FFFD
// replacement characters and hands back a corrupted value that nothing
// downstream can recognise as wrong: it is a well-formed string, just not the
// one that was sent.
test("LineDecoder reassembles a multi-byte character split across chunks", () => {
  const decoder = new LineDecoder();
  const full = Buffer.from('{"v":1,"id":"1","ok":true,"value":"é"}\n');

  // Split INSIDE the é, between its lead byte and its continuation byte.
  const split = full.indexOf(0xc3) + 1;
  expect(full[split]).toBe(0xa9);

  expect(decoder.push(full.subarray(0, split))).toEqual([]);
  const lines = decoder.push(full.subarray(split));

  expect(lines).toEqual(['{"v":1,"id":"1","ok":true,"value":"é"}']);
  expect(JSON.parse(lines[0]!)).toMatchObject({ value: "é" });
  expect(lines[0]).not.toContain("�");
});

test("LineDecoder reassembles a 4-byte character split across three chunks", () => {
  const decoder = new LineDecoder();
  // An emoji is 4 UTF-8 bytes, so a chunk boundary can land in two places.
  const full = Buffer.from('{"value":"🔐"}\n');
  const start = full.indexOf(0xf0);

  expect(decoder.push(full.subarray(0, start + 1))).toEqual([]);
  expect(decoder.push(full.subarray(start + 1, start + 3))).toEqual([]);
  const lines = decoder.push(full.subarray(start + 3));

  expect(JSON.parse(lines[0]!)).toMatchObject({ value: "🔐" });
});
