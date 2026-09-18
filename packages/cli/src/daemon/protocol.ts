export const PROTOCOL_VERSION = 1;

/**
 * Maximum line length in UTF-16 code units (JavaScript string length).
 * Bounds the in-memory buffer from a malicious or buggy peer. Not a byte-denominated wire limit.
 * One megabyte is far beyond any legitimate request or secret.
 *
 * It caps SUSTAINED growth, not peak allocation: `LineDecoder.push` appends the
 * whole chunk before checking, so a single enormous chunk is held in memory
 * once before it is rejected. Bounding the peak would require checking the
 * incoming chunk's size before concatenation.
 */
export const MAX_LINE_CHARS = 1_048_576;

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "locked"
  | "unsupported_version"
  | "internal";

interface Envelope {
  v: typeof PROTOCOL_VERSION;
  id: string;
  /** Per-session bearer token read from ~/.kerstel/session.token. */
  token: string;
}

export interface ResolveRequest extends Envelope {
  op: "resolve";
  scope: string;
  key: string;
  /** Caller metadata, recorded in the audit log. v2 gates on these. */
  pid: number | null;
  processName: string | null;
}

export interface StatusRequest extends Envelope {
  op: "status";
}

export interface LockRequest extends Envelope {
  op: "lock";
}

export interface ShutdownRequest extends Envelope {
  op: "shutdown";
}

export type Request = ResolveRequest | StatusRequest | LockRequest | ShutdownRequest;

export interface ResolveOk {
  v: typeof PROTOCOL_VERSION;
  id: string;
  ok: true;
  op: "resolve";
  value: string;
}

export interface StatusOk {
  v: typeof PROTOCOL_VERSION;
  id: string;
  ok: true;
  op: "status";
  pid: number;
  unlocked: boolean;
  backend: string;
  secretCount: number;
  uptimeMs: number;
}

export interface AckOk {
  v: typeof PROTOCOL_VERSION;
  id: string;
  ok: true;
  op: "lock" | "shutdown";
}

export interface ErrorResponse {
  v: typeof PROTOCOL_VERSION;
  id: string;
  ok: false;
  error: { code: ErrorCode; message: string };
}

export type Response = ResolveOk | StatusOk | AckOk | ErrorResponse;

export function encodeMessage(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

export function errorResponse(id: string, code: ErrorCode, message: string): ErrorResponse {
  return { v: PROTOCOL_VERSION, id, ok: false, error: { code, message } };
}

/** Accumulates socket chunks and yields complete newline-delimited lines. */
export class LineDecoder {
  private buffer = "";

  constructor(private readonly maxChars: number = MAX_LINE_CHARS) {}

  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

    const lines: string[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) lines.push(line);
      newline = this.buffer.indexOf("\n");
    }

    if (this.buffer.length > this.maxChars) {
      this.buffer = "";
      throw new Error(`Kerstel protocol line too large (> ${this.maxChars} characters)`);
    }
    return lines;
  }
}
