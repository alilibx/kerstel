"use strict";

/**
 * Wire constants mirrored from packages/cli/src/daemon/protocol.ts.
 * The hook cannot import from the CLI package because it is bundled standalone
 * and written to ~/.kerstel/hook/. Task 13 asserts the two stay in step.
 */
const PROTOCOL_VERSION = 1;

/**
 * Maximum line length in UTF-16 code units (JavaScript string length).
 * Bounds the in-memory buffer from a malicious or buggy peer. Not a byte-denominated wire limit.
 * One megabyte is far beyond any legitimate request or secret.
 *
 * Mirrors MAX_LINE_CHARS in packages/cli/src/daemon/protocol.ts.
 */
const MAX_LINE_CHARS = 1_048_576;

const REFERENCE_PROTOCOL = "kerstel://";
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Mirrors parseReference() in packages/cli/src/reference.ts. */
function parseReference(value) {
  if (typeof value !== "string") return null;
  if (!value.startsWith(REFERENCE_PROTOCOL)) return null;

  const body = value.slice(REFERENCE_PROTOCOL.length);
  const slash = body.indexOf("/");
  if (slash <= 0) return null;

  const scope = body.slice(0, slash);
  const key = body.slice(slash + 1);
  if (scope.length === 0 || scope.length > 64 || !SCOPE_PATTERN.test(scope)) return null;
  if (key.length === 0 || key.length > 128 || !KEY_PATTERN.test(key)) return null;

  return { scope, key };
}

function isReference(value) {
  return parseReference(value) !== null;
}

module.exports = {
  PROTOCOL_VERSION,
  MAX_LINE_CHARS,
  REFERENCE_PROTOCOL,
  parseReference,
  isReference,
};
