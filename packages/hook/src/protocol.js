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
const SHORT_PROTOCOL = "ks:";
const SCOPE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Mirrors parseReference() in packages/cli/src/reference.ts: `ks:<scope>/<KEY>`,
 * `kerstel://<scope>/<KEY>`, and `ks:<scope>`, whose key is `name`, the
 * variable holding the value. The parity test runs both on every fixture.
 */
function parseReference(value, name) {
  if (typeof value !== "string") return null;

  let scope;
  let key;
  if (value.startsWith(REFERENCE_PROTOCOL)) {
    const body = value.slice(REFERENCE_PROTOCOL.length);
    const slash = body.indexOf("/");
    if (slash <= 0) return null;
    scope = body.slice(0, slash);
    key = body.slice(slash + 1);
  } else if (value.slice(0, SHORT_PROTOCOL.length).toLowerCase() === SHORT_PROTOCOL) {
    const body = value.slice(SHORT_PROTOCOL.length);
    const slash = body.indexOf("/");
    if (slash === -1) {
      scope = body;
      key = name;
    } else {
      scope = body.slice(0, slash);
      key = body.slice(slash + 1);
    }
  } else {
    return null;
  }

  if (typeof key !== "string") return null;
  if (scope.length === 0 || scope.length > 64 || !SCOPE_PATTERN.test(scope)) return null;
  if (key.length === 0 || key.length > 128 || !KEY_PATTERN.test(key)) return null;

  return { scope, key };
}

/** True for `ks:<scope>`, the form whose key comes from the variable's name. */
function isShorthand(value) {
  if (typeof value !== "string") return false;
  if (value.slice(0, SHORT_PROTOCOL.length).toLowerCase() !== SHORT_PROTOCOL) return false;
  const body = value.slice(SHORT_PROTOCOL.length);
  return !body.includes("/") && body.length > 0 && body.length <= 64 && SCOPE_PATTERN.test(body);
}

function isReference(value, name) {
  return parseReference(value, name) !== null;
}

module.exports = {
  PROTOCOL_VERSION,
  MAX_LINE_CHARS,
  REFERENCE_PROTOCOL,
  SHORT_PROTOCOL,
  parseReference,
  isShorthand,
  isReference,
};
