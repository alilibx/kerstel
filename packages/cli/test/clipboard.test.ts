import { describe, expect, test } from "bun:test";
import { clipboardCommand, copyToClipboard } from "../src/clipboard";

const whichOf =
  (...names: string[]) =>
  (cmd: string) =>
    names.includes(cmd) ? `/usr/bin/${cmd}` : null;

describe("clipboardCommand", () => {
  test("macOS uses pbcopy", () => {
    expect(clipboardCommand({ platform: "darwin", env: {}, which: whichOf("pbcopy") })).toEqual([
      "/usr/bin/pbcopy",
    ]);
  });

  test("Wayland uses wl-copy", () => {
    const cmd = clipboardCommand({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
      which: whichOf("wl-copy", "xclip"),
    });
    expect(cmd).toEqual(["/usr/bin/wl-copy"]);
  });

  test("X uses xclip, then xsel", () => {
    const env = { DISPLAY: ":0" };
    expect(clipboardCommand({ platform: "linux", env, which: whichOf("xclip", "xsel") })).toEqual([
      "/usr/bin/xclip",
      "-selection",
      "clipboard",
    ]);
    expect(clipboardCommand({ platform: "linux", env, which: whichOf("xsel") })).toEqual([
      "/usr/bin/xsel",
      "--clipboard",
      "--input",
    ]);
  });

  test("no display, no clipboard", () => {
    const which = whichOf("wl-copy", "xclip", "xsel");
    expect(clipboardCommand({ platform: "linux", env: {}, which })).toBeNull();
    expect(clipboardCommand({ platform: "win32", env: {}, which })).toBeNull();
    const calls: string[][] = [];
    const ok = copyToClipboard("x", {
      platform: "linux",
      env: {},
      which,
      run: (argv) => (calls.push(argv), 0),
    });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("copyToClipboard", () => {
  const deps = { platform: "darwin" as const, env: {}, which: whichOf("pbcopy") };

  test("the text goes on stdin, never in argv", () => {
    const calls: { argv: string[]; stdin: string }[] = [];
    const ok = copyToClipboard("ks sync join ks1-SECRET", {
      ...deps,
      run: (argv, stdin) => (calls.push({ argv, stdin }), 0),
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.stdin).toBe("ks sync join ks1-SECRET");
    expect(calls[0]!.argv.some((a) => a.includes("ks1-SECRET"))).toBe(false);
  });

  test("a failing tool reports false", () => {
    expect(copyToClipboard("x", { ...deps, run: () => 1 })).toBe(false);
    expect(
      copyToClipboard("x", {
        ...deps,
        run: () => {
          throw new Error("boom");
        },
      }),
    ).toBe(false);
  });

  test("test runs never copy", () => {
    expect(process.env.KERSTEL_TEST_NO_CLIPBOARD).toBe("1");
    expect(copyToClipboard("x")).toBe(false);
  });
});
