import { expect, test } from "bun:test";

// scripts/test-tmpdir.ts must be preloaded however `bun test` is started (from
// the repo root or from this package): without it, sync tests install real
// launch agents or systemd timers on the developer's machine.
test("the test preload is active", () => {
  expect(process.env.KERSTEL_TEST_NO_SYNC_TIMER).toBe("1");
  expect(process.env.KERSTEL_TEST_NO_CLIPBOARD).toBe("1");
});
