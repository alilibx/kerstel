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
  const token = process.env.KERSTEL_TOKEN;

  if (!socketPath || !token) {
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
        token,
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

  // Children inherit the resolution wiring, so a variable they set or build
  // themselves resolves too. Variables already present are handed over
  // already resolved: building a child's envp reads process.env through the
  // same get trap application code uses, so there is no way to tell the two
  // apart, and a non-Node child could not resolve a reference anyway.
  raw.KERSTEL_ACTIVE = "1";
  raw.KERSTEL_SOCKET = socketPath;
  raw.KERSTEL_TOKEN = token;
  raw.KERSTEL_HOOK_DIR = hookDir;

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
