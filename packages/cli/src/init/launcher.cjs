// Kerstel launcher, format 1. Written by kerstel init; edits are overwritten on the next run.
//
// Runs the command after "--" through `kerstel exec` when Kerstel is installed
// on this machine, and unchanged when it is not, so the same package.json
// script works on a developer's machine and on a deploy host that has no
// Kerstel. It has no dependencies, installs nothing, and downloads nothing.
// https://kerstel.dev/docs/deploying
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const WINDOWS = process.platform === "win32";
const NOT_FOUND = 127;
const NOT_EXECUTABLE = 126;


/** Directories on PATH, minus every node_modules/.bin: a dependency's `kerstel` there must never be picked. */
function pathDirs() {
  return (process.env.PATH || "")
    .split(path.delimiter)
    .filter((dir) => dir !== "" && !/[\\/]node_modules[\\/]\.bin(?:[\\/]|$)/.test(dir));
}

function isExecutableFile(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The Kerstel binary on PATH, or null. */
function findKerstel() {
  const name = WINDOWS ? "kerstel.exe" : "kerstel";
  for (const dir of pathDirs()) {
    const file = path.join(dir, name);
    if (isExecutableFile(file)) return file;
  }
  return null;
}

/** Where `name` resolves on PATH (with PATHEXT on Windows), or null. A name with a path separator is taken as given. */
function resolveCommand(name) {
  if (/[\\/]/.test(name)) return name;
  const extensions = WINDOWS ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of pathDirs()) {
    for (const extension of extensions) {
      const file = path.join(dir, name + extension);
      if (isExecutableFile(file)) return file;
    }
  }
  return null;
}

/**
 * One argument, quoted for `cmd.exe /d /s /c`, the way npm's own run-script
 * does it: double quotes around it with inner quotes doubled, and cmd's
 * metacharacters escaped with a caret.
 */
function quoteForCmd(argument) {
  if (argument !== "" && !/[\s"&|<>^%!()]/.test(argument)) return argument;
  const quoted = `"${argument.replace(/"/g, '""')}"`;
  return quoted.replace(/[&|<>^%!()]/g, (character) => `^${character}`);
}

/** The command line for a .cmd or .bat shim on Windows. Exported for tests through module.exports below. */
function windowsCommandLine(file, rest) {
  return [file, ...rest].map(quoteForCmd).join(" ");
}

function launch(executable, rest) {
  if (WINDOWS) {
    const resolved = resolveCommand(executable);
    if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
      // Node refuses to spawn a .cmd or .bat without a shell, and every
      // node_modules/.bin entry on Windows is one.
      const shell = process.env.comspec || "cmd.exe";
      return spawn(shell, ["/d", "/s", "/c", `"${windowsCommandLine(resolved, rest)}"`], {
        stdio: "inherit",
        windowsVerbatimArguments: true,
      });
    }
  }
  return spawn(executable, rest, { stdio: "inherit" });
}

function run() {
  const args = process.argv.slice(2);
  const separator = args.indexOf("--");
  const command = separator === -1 ? args : args.slice(separator + 1);
  if (command.length === 0) {
    process.stderr.write("Usage: node .kerstel/exec.cjs -- <command> [args...]\n");
    process.exit(2);
  }

  const kerstel = findKerstel();
  let child;
  if (kerstel) {
    child = spawn(kerstel, ["exec", "--", ...command], { stdio: "inherit" });
  } else {
    process.stderr.write(`kerstel: not installed here, running without it: ${command.join(" ")}\n`);
    child = launch(command[0], command.slice(1));
  }

  const forward = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // The child is already gone.
    }
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => forward(signal));

  child.on("error", (error) => {
    if (error.code === "ENOENT") {
      process.stderr.write(`kerstel: "${command[0]}" was not found on PATH.\n`);
      process.exit(NOT_FOUND);
    }
    if (error.code === "EACCES") {
      process.stderr.write(`kerstel: "${command[0]}" exists but cannot be run.\n`);
      process.exit(NOT_EXECUTABLE);
    }
    process.stderr.write(`kerstel: could not start "${command[0]}": ${error.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.exit(128 + (os.constants.signals[signal] || 0));
    process.exit(code === null ? 1 : code);
  });
}

module.exports = { quoteForCmd, windowsCommandLine };

// Run only when this file is the script (`node .kerstel/exec.cjs -- ...`), not
// when a test requires it for the helpers above.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) run();
