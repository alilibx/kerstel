import { expect, test } from "bun:test";
import { humanSize, progressLine, ProgressBar } from "../src/update/progress";

const plain = (s: string) => s;

test("humanSize matches install.sh: MB to one decimal from 1 MiB, whole KB below", () => {
  expect(humanSize(0)).toBe("0 KB");
  expect(humanSize(1023)).toBe("0 KB");
  expect(humanSize(512 * 1024)).toBe("512 KB");
  expect(humanSize(1048576)).toBe("1.0 MB");
  expect(humanSize(59 * 1048576 + 300_000)).toBe("59.3 MB");
});

test("progressLine draws a bar, the percentage, and received over total", () => {
  const line = progressLine(30 * 1048576, 60 * 1048576, { width: 10, accent: plain });
  expect(line).toBe("  █████░░░░░  50%  30.0 MB / 60.0 MB");
});

test("progressLine clamps at 100% when more arrives than the header promised", () => {
  const line = progressLine(70 * 1048576, 60 * 1048576, { width: 10, accent: plain });
  expect(line).toBe("  ██████████ 100%  60.0 MB / 60.0 MB");
});

test("progressLine shows only what has arrived when the total is unknown", () => {
  expect(progressLine(3 * 1048576, null, { width: 10, accent: plain })).toBe("  3.0 MB received");
});

test("progressLine colours the bar with the accent and nothing else", () => {
  const line = progressLine(5, 10, { width: 4, accent: (s) => `<${s}>` });
  expect(line).toBe("  <██░░>  50%  0 KB / 0 KB");
});

test("ProgressBar redraws in place and ends the line once", () => {
  const writes: string[] = [];
  const bar = new ProgressBar((s) => writes.push(s), { width: 10, accent: plain, minIntervalMs: 0 });
  bar.update(0, 100);
  bar.update(50, 100);
  bar.update(100, 100);
  bar.finish();
  expect(writes[0]!.startsWith("\r")).toBe(true);
  expect(writes.filter((w) => w.includes("\n"))).toHaveLength(1);
  expect(writes.at(-1)).toBe("\n");
  expect(writes.some((w) => w.includes(" 50%"))).toBe(true);
});

test("ProgressBar rate-limits redraws but always draws the first and a completed one", () => {
  const writes: string[] = [];
  let now = 1_000;
  const bar = new ProgressBar((s) => writes.push(s), { width: 10, accent: plain, minIntervalMs: 100, now: () => now });
  bar.update(0, 1000);
  now += 10;
  bar.update(100, 1000);
  now += 10;
  bar.update(200, 1000);
  expect(writes).toHaveLength(1);
  now += 100;
  bar.update(300, 1000);
  expect(writes).toHaveLength(2);
  now += 1;
  bar.update(1000, 1000);
  expect(writes).toHaveLength(3);
  expect(writes.at(-1)).toContain("100%");
});

test("ProgressBar.finish draws a rate-limited final update first, so an unknown-total download ends on its true size", () => {
  const writes: string[] = [];
  let now = 1_000;
  const bar = new ProgressBar((s) => writes.push(s), { width: 10, accent: plain, minIntervalMs: 100, now: () => now });
  bar.update(0, null);
  now += 10;
  bar.update(5 * 1048576, null);
  expect(writes).toHaveLength(1);
  bar.finish();
  expect(writes).toHaveLength(3);
  expect(writes[1]).toBe("\r  5.0 MB received");
  expect(writes[2]).toBe("\n");
});

test("ProgressBar.finish without any update writes nothing", () => {
  const writes: string[] = [];
  new ProgressBar((s) => writes.push(s), { width: 10, accent: plain }).finish();
  expect(writes).toHaveLength(0);
});
