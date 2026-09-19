import { expect, test } from "bun:test";
import { interpretLookup } from "../src/vault/keychain/linux";

// The exact shapes `secret-tool lookup` produces, so the Linux backend's
// "is anything stored?" answer can be pinned on macOS CI too. A base64 key on
// stdout is present; exit 1 with an empty stderr is the one and only absent;
// every other failure is unknown, which the backend treats as present.

test("a key on stdout is present", () => {
  expect(interpretLookup({ code: 0, stdout: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n", stderr: "" })).toBe(
    "present",
  );
});

test("exit 1 with nothing on stderr is the only absent", () => {
  expect(interpretLookup({ code: 1, stdout: "", stderr: "" })).toBe("absent");
  expect(interpretLookup({ code: 1, stdout: "", stderr: "\n" })).toBe("absent");
});

test("a bus or agent failure is unknown, never absent", () => {
  const dbus =
    "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n";
  expect(interpretLookup({ code: 1, stdout: "", stderr: dbus })).toBe("unknown");
  expect(interpretLookup({ code: 1, stdout: "", stderr: "The name org.freedesktop.secrets was not provided by any .service files\n" })).toBe("unknown");
  expect(interpretLookup({ code: 2, stdout: "", stderr: "" })).toBe("unknown");
  expect(interpretLookup({ code: 127, stdout: "", stderr: "" })).toBe("unknown");
  // Success with nothing printed is not a key either.
  expect(interpretLookup({ code: 0, stdout: "", stderr: "" })).toBe("unknown");
});
