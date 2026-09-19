"use strict";

/**
 * Proves the bridge does not hold its host process open.
 *
 * Resolves one value and then simply returns, WITHOUT calling dispose(). If the
 * worker thread or its socket were not unref'd, this process would sit at the
 * end of its script forever instead of exiting, and the caller's bounded wait
 * would fail. Nothing here calls process.exit(): a clean natural exit is the
 * whole assertion.
 *
 * Usage: bun unref-probe.cjs <socketPath> <tokenFile>
 * Exits 0 on success, 2 if the resolved value was wrong.
 */
const path = require("node:path");
const { createBridge } = require(path.join(__dirname, "..", "..", "src", "bridge.js"));

const socketPath = process.argv[2];
const tokenFile = process.argv[3];

const bridge = createBridge({ socketPath, tokenFile, timeoutMs: 5_000 });
if (bridge.resolveSync("global", "K") !== "v") process.exitCode = 2;
