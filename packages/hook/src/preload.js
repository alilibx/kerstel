"use strict";

const path = require("node:path");
const { createBridge } = require("./bridge.js");
const { locateHook } = require("./locate.js");
const { parseReference } = require("./protocol.js");

// Guard against double installation (for example NODE_OPTIONS=--require plus bun's --preload).
if (!process.env.KERSTEL_ACTIVE) {
  install();
}

function install() {
  const socketPath = process.env.KERSTEL_SOCKET;
  // The PATH of the token file, never the token. A value in the environment
  // is inherited by every descendant of this process, shows up in `ps -E` and
  // in any `console.log(process.env)`, and would unlock the whole vault for as
  // long as it stayed valid. A path unlocks nothing: the worker reads the 0600
  // file when it needs it, and the file is the daemon's to rotate.
  const tokenFile = process.env.KERSTEL_TOKEN_FILE;

  if (!socketPath || !tokenFile) {
    // Nothing to resolve against. Leave process.env exactly as found so an
    // unconfigured machine behaves like a machine without Kerstel installed.
    return;
  }

  // Located ONCE, at runtime, from where this file really sits — never from
  // __dirname, which the bundler replaces with the build machine's source path
  // (see locate.js). Failing here means the install is broken; say so now
  // rather than leaving every later lookup to time out against a missing
  // worker, and leave process.env untouched so the app runs unhooked.
  let hook;
  try {
    hook = locateHook();
  } catch (error) {
    process.emitWarning(`Kerstel hook disabled: ${error.message}`);
    return;
  }
  const hookDir = hook.dir;

  const raw = process.env;
  const cache = new Map();
  let bridge = null;

  function resolveValue(name, value) {
    if (typeof value !== "string") return value;

    const ref = parseReference(value);
    if (!ref) return value;

    if (cache.has(name)) return cache.get(name);

    if (!bridge) {
      bridge = createBridge({
        socketPath,
        tokenFile,
        timeoutMs: Number(process.env.KERSTEL_TIMEOUT_MS) || 5_000,
        workerFile: hook.workerFile,
      });
    }

    const resolved = bridge.resolveSync(ref.scope, ref.key);
    cache.set(name, resolved);
    return resolved;
  }

  const proxy = new Proxy(raw, {
    get(target, property, receiver) {
      if (typeof property !== "string") return Reflect.get(target, property, receiver);
      return resolveValue(property, target[property]);
    },

    set(target, property, value) {
      if (typeof property === "string") cache.delete(property);
      target[property] = value;
      return true;
    },

    deleteProperty(target, property) {
      if (typeof property === "string") cache.delete(property);
      delete target[property];
      return true;
    },

    has(target, property) {
      return property in target;
    },

    ownKeys(target) {
      return Reflect.ownKeys(target);
    },

    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (!descriptor || typeof property !== "string") return descriptor;
      // Spread and Object.assign read through this descriptor, so it must carry
      // the resolved value rather than the reference.
      return { ...descriptor, value: resolveValue(property, descriptor.value) };
    },
  });

  // Bun.env is this same raw object, and it cannot be redirected at the
  // proxy: the property is non-configurable and non-writable, so is
  // globalThis.Bun, and Bun's env object rejects accessor descriptors
  // (measured on 1.4.2). The only way for `Bun.env.KEY` to be the value is
  // for the raw object to HOLD the value, so under Bun every reference in the
  // environment is resolved now and written back. process.env still gets the
  // proxy, so a reference assigned later (by a dotenv library, say) resolves
  // lazily as it does under Node. One that cannot resolve is left as it is,
  // named once, and the lazy read through process.env throws the same error
  // it always did: a stale reference the app never reads must not crash every
  // Bun process at startup.
  if (process.versions && process.versions.bun) {
    for (const name of Object.keys(raw)) {
      const value = raw[name];
      if (!parseReference(value)) continue;
      try {
        raw[name] = resolveValue(name, value);
      } catch (error) {
        process.emitWarning(
          `Kerstel could not resolve ${name} for Bun.env: ${error.message} Run \`kerstel doctor\`.`,
        );
      }
    }
  }

  // Children inherit the resolution wiring, so a variable they set or build
  // themselves resolves too. Variables already present are handed over
  // already resolved: building a child's envp reads process.env through the
  // same get trap application code uses, so there is no way to tell the two
  // apart, and a non-Node child could not resolve a reference anyway.
  raw.KERSTEL_ACTIVE = "1";
  raw.KERSTEL_SOCKET = socketPath;
  raw.KERSTEL_TOKEN_FILE = tokenFile;
  raw.KERSTEL_HOOK_DIR = hookDir;
  // Same reason as `kerstel exec`: a token left in this process's environment
  // by an older Kerstel is still live, and every child would inherit it.
  delete raw.KERSTEL_TOKEN;

  const preloadPath = path.join(hookDir, "preload.cjs");
  const requireFlag = `--require ${JSON.stringify(preloadPath)}`;
  if (!(raw.NODE_OPTIONS || "").includes(preloadPath)) {
    raw.NODE_OPTIONS = raw.NODE_OPTIONS ? `${raw.NODE_OPTIONS} ${requireFlag}` : requireFlag;
  }

  Object.defineProperty(process, "env", {
    value: proxy,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
