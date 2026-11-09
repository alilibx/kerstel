#!/usr/bin/env bun
/**
 * `kerstel-server`: the self-hostable sync server. Sync spec §9.1.
 *
 * Plain HTTP on purpose: TLS belongs to a reverse proxy in front of it. The
 * client refuses a non-https server URL other than 127.0.0.1 and localhost.
 */
import { readFileSync } from "node:fs";
import pkg from "../package.json";
import { createApp } from "./app";
import { openDatabase } from "./db";
import { LIMITS } from "./protocol";

declare const KERSTEL_SERVER_VERSION: string | undefined;

/** Set at build time by the nightly and release workflows; `-dev` from source. */
export const VERSION: string =
  typeof KERSTEL_SERVER_VERSION === "string" && KERSTEL_SERVER_VERSION ? KERSTEL_SERVER_VERSION : `${pkg.version}-dev`;

const HELP = `kerstel-server ${VERSION}
The Kerstel sync server. It stores only ciphertext: no key names, no values.

Usage: kerstel-server [options]

Options:
  --db <file>                SQLite database (default ./kerstel-server.db, or KERSTEL_SERVER_DB)
  --listen <host:port>       Address to listen on (default 127.0.0.1:8787, or KERSTEL_SERVER_LISTEN)
  --enroll-token-file <file> Require the token in this file to create a vault
                             (or KERSTEL_SERVER_ENROLL_TOKEN). Without one, anyone who
                             can reach the server can create a vault.
  --trust-proxy              Take the client address from X-Forwarded-For (only behind a proxy)
  --version                  Print the version
  --help                     Print this help

Serve it behind a reverse proxy that terminates TLS.`;

export interface ServerConfig {
  db: string;
  hostname: string;
  port: number;
  enrollToken: string | null;
  trustProxy: boolean;
}

export function parseArgs(argv: string[], env: Record<string, string | undefined>): ServerConfig | "help" | "version" {
  let db = env.KERSTEL_SERVER_DB || "kerstel-server.db";
  let listen = env.KERSTEL_SERVER_LISTEN || "127.0.0.1:8787";
  let enrollToken: string | null = env.KERSTEL_SERVER_ENROLL_TOKEN || null;
  let trustProxy = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value.`);
      return v;
    };
    switch (arg) {
      case "--help":
      case "-h":
        return "help";
      case "--version":
      case "-v":
        return "version";
      case "--db":
        db = value();
        break;
      case "--listen":
        listen = value();
        break;
      case "--enroll-token-file": {
        const file = value();
        enrollToken = readFileSync(file, "utf8").trim();
        if (!enrollToken) throw new Error(`${file} is empty.`);
        break;
      }
      case "--trust-proxy":
        trustProxy = true;
        break;
      default:
        throw new Error(`Unknown option ${arg}. Run kerstel-server --help.`);
    }
  }

  const match = /^(.+):(\d{1,5})$/.exec(listen);
  if (!match) throw new Error(`--listen must be host:port, got ${listen}.`);
  const port = Number(match[2]);
  if (port > 65535) throw new Error(`Port ${port} is out of range.`);
  const hostname = match[1]!.replace(/^\[(.*)\]$/, "$1");
  return { db, hostname, port, enrollToken, trustProxy };
}

function clientAddress(request: Request, direct: string, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for");
    const first = forwarded?.split(",")[0]?.trim();
    if (first) return first;
  }
  return direct;
}

function main(): void {
  let config: ReturnType<typeof parseArgs>;
  try {
    config = parseArgs(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`kerstel-server: ${(error as Error).message}`);
    process.exit(2);
  }
  if (config === "help") {
    console.log(HELP);
    return;
  }
  if (config === "version") {
    console.log(VERSION);
    return;
  }

  const db = openDatabase(config.db);
  const app = createApp({ db, version: VERSION, enrollToken: config.enrollToken });
  const { trustProxy } = config;

  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    maxRequestBodySize: LIMITS.bodyBytes,
    async fetch(request, srv) {
      const started = performance.now();
      const ip = clientAddress(request, srv.requestIP(request)?.address ?? "unknown", trustProxy);
      const response = await app.fetch(request, ip);
      // A fixed label per route, IDs as :id, and "(unknown)" for anything else,
      // so no text a caller puts in a path reaches the log.
      const route = app.routeLabel(request.method, new URL(request.url).pathname);
      console.log(`${request.method} ${route} ${response.status} ${Math.round(performance.now() - started)}ms`);
      return response;
    },
  });

  app.maintain();
  const timer = setInterval(() => app.maintain(), 10 * 60_000);
  console.log(`kerstel-server ${VERSION} listening on http://${server.hostname}:${server.port} (database ${config.db})`);
  if (!config.enrollToken) {
    console.log("No enroll token: anyone who can reach this server can create a vault.");
  }

  const stop = () => {
    clearInterval(timer);
    server.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (import.meta.main) main();
