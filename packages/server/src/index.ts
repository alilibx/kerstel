#!/usr/bin/env bun
/**
 * `kerstel-server`: the self-hostable sync server. Sync spec §9.1.
 *
 * Plain HTTP by default, for a reverse proxy that terminates TLS. With
 * `--tls self` it serves HTTPS with a certificate of its own, whose key devices
 * pin; with `--domain`, with a Let's Encrypt certificate it gets and renews.
 * The client refuses a non-https server URL other than 127.0.0.1 and localhost.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import pkg from "../package.json";
import { createApp, type App } from "./app";
import { openDatabase } from "./db";
import { formatPin } from "./pin";
import { LIMITS } from "./protocol";
import { encodeServerValue } from "./server-value";
import {
  AcmeManager,
  bindAgain,
  certificateName,
  createFileOnce,
  keepCertificate,
  loadSelfSigned,
  readSelfSignedPin,
  serveChallenges,
  tlsFiles,
  type AcmeCertificate,
} from "./tls";

declare const KERSTEL_SERVER_VERSION: string | undefined;

/** Set at build time by the release workflow; `-dev` from source. */
export const VERSION: string =
  typeof KERSTEL_SERVER_VERSION === "string" && KERSTEL_SERVER_VERSION ? KERSTEL_SERVER_VERSION : `${pkg.version}-dev`;

const HELP = `kerstel-server ${VERSION}
The Kerstel sync server. It stores only ciphertext: no key names, no values.

Usage: kerstel-server [options]
       kerstel-server value --url <url> [--url <url>]... [options]
       kerstel-server info [options]

Commands:
  value                      Print the server value (ks-server1-...) that sets up a device:
                             up to four --url addresses, the pin with --tls self, and the
                             enroll token from --enroll-token-file. Paste it only into Kerstel.
  info                       Print the version, the TLS mode and, with --tls self, the pin

Options:
  --db <file>                SQLite database (default ./kerstel-server.db, or KERSTEL_SERVER_DB)
  --listen <host:port>       Address to listen on (default 127.0.0.1:8787, or KERSTEL_SERVER_LISTEN)
  --enroll-token-file <file> Require the token in this file to create a vault, and create the
                             file with a new token when it does not exist (or
                             KERSTEL_SERVER_ENROLL_TOKEN_FILE, or KERSTEL_SERVER_ENROLL_TOKEN for
                             the token itself). Without one, anyone who can reach the server
                             can create a vault.
  --trust-proxy              Take the client address from X-Forwarded-For (only behind a proxy)
  --tls self                 Serve HTTPS with a certificate of its own, which devices pin
                             (or KERSTEL_SERVER_TLS=self). It prints the pin when it starts.
  --tls-name <name>          Another DNS name or IP address for that certificate; repeat it
                             for more (or KERSTEL_SERVER_TLS_NAMES, comma-separated)
  --domain <name>            Serve HTTPS with a Let's Encrypt certificate for this domain
                             (or KERSTEL_SERVER_DOMAIN). Listens on 0.0.0.0:443 by default.
  --acme-directory <url>     The ACME CA's directory (default Let's Encrypt, or
                             KERSTEL_SERVER_ACME_DIRECTORY)
  --acme-email <address>     A contact address for the ACME account (or KERSTEL_SERVER_ACME_EMAIL)
  --acme-http <host:port>    Where to answer the ACME challenge (default 0.0.0.0:80, or
                             KERSTEL_SERVER_ACME_HTTP)
  --version                  Print the version
  --help                     Print this help

Without --tls or --domain it speaks plain HTTP, for a reverse proxy that terminates TLS. With --domain you agree to the ACME CA's terms of service.`;

const LETS_ENCRYPT = "https://acme-v02.api.letsencrypt.org/directory";

export type TlsConfig =
  | { mode: "off" }
  | { mode: "self"; names: string[] }
  | { mode: "acme"; domain: string; directory: string; email: string | null; httpHostname: string; httpPort: number };

export interface ServerConfig {
  db: string;
  hostname: string;
  port: number;
  /** The token itself, from KERSTEL_SERVER_ENROLL_TOKEN. Null when `enrollTokenFile` is set. */
  enrollToken: string | null;
  /** The file that holds the token, read or created by `resolveEnrollToken`. */
  enrollTokenFile: string | null;
  trustProxy: boolean;
  tls: TlsConfig;
}

/** `host:port`, with the brackets taken off an IPv6 host. */
function hostPort(text: string, flag: string): { hostname: string; port: number } {
  const match = /^(.+):(\d{1,5})$/.exec(text);
  if (!match) throw new Error(`${flag} must be host:port, got ${text}.`);
  const port = Number(match[2]);
  if (port > 65535) throw new Error(`Port ${port} is out of range.`);
  return { hostname: match[1]!.replace(/^\[(.*)\]$/, "$1"), port };
}

/** `localhost`, `127.0.0.1`, the listen host when it is a specific address, then each extra name, once each. */
function selfSignedNames(hostname: string, extra: string[]): string[] {
  const names = ["localhost", "127.0.0.1"];
  const add = (name: string) => {
    if (!names.includes(name)) names.push(name);
  };
  const host = certificateName(hostname.replace(/%.*$/, "")); // a zone ID names a link, not the address
  if (host === null) throw new Error(`--listen ${hostname} cannot go in a certificate. Use an IP address or a DNS name.`);
  if (host !== "0.0.0.0" && host !== "::") add(host);
  for (const text of extra) {
    const name = certificateName(text);
    if (name === null) {
      throw new Error(
        `--tls-name ${text} is neither an IP address nor a DNS name (letters, digits, - and ., optionally starting with *.).`,
      );
    }
    add(name);
  }
  return names;
}

export function parseArgs(argv: string[], env: Record<string, string | undefined>): ServerConfig | "help" | "version" {
  let db = env.KERSTEL_SERVER_DB || "kerstel-server.db";
  let listen = env.KERSTEL_SERVER_LISTEN || "127.0.0.1:8787";
  let enrollToken: string | null = env.KERSTEL_SERVER_ENROLL_TOKEN || null;
  let enrollTokenFile: string | null = env.KERSTEL_SERVER_ENROLL_TOKEN_FILE || null;
  let trustProxy = false;
  let tls = env.KERSTEL_SERVER_TLS || null;
  let tlsFromFlag = false;
  const splitNames = (text: string) => text.split(",").map((n) => n.trim()).filter(Boolean);
  let tlsNames = splitNames(env.KERSTEL_SERVER_TLS_NAMES ?? "");
  let tlsNamesFromFlags = false;
  let domain = env.KERSTEL_SERVER_DOMAIN || null;
  let domainFromFlag = false;
  let acmeDirectory = env.KERSTEL_SERVER_ACME_DIRECTORY || LETS_ENCRYPT;
  let acmeEmail = env.KERSTEL_SERVER_ACME_EMAIL || null;
  let acmeHttp = env.KERSTEL_SERVER_ACME_HTTP || "0.0.0.0:80";
  let listenGiven = Boolean(env.KERSTEL_SERVER_LISTEN);

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
        listenGiven = true;
        break;
      case "--enroll-token-file":
        // The flag overrides both environment twins.
        enrollTokenFile = value();
        enrollToken = null;
        break;
      case "--trust-proxy":
        trustProxy = true;
        break;
      case "--tls":
        tls = value();
        tlsFromFlag = true;
        break;
      case "--tls-name":
        // Flags replace the environment's list rather than add to it.
        if (!tlsNamesFromFlags) tlsNames = [];
        tlsNamesFromFlags = true;
        tlsNames.push(value());
        break;
      case "--domain":
        domain = value();
        domainFromFlag = true;
        break;
      case "--acme-directory":
        acmeDirectory = value();
        break;
      case "--acme-email":
        acmeEmail = value();
        break;
      case "--acme-http":
        acmeHttp = value();
        break;
      default:
        throw new Error(`Unknown option ${arg}. Run kerstel-server --help.`);
    }
  }

  // Both from the environment: --enroll-token-file drops the token above.
  if (enrollToken && enrollTokenFile) {
    throw new Error("Set KERSTEL_SERVER_ENROLL_TOKEN or KERSTEL_SERVER_ENROLL_TOKEN_FILE, not both.");
  }

  // A flag overrides its environment twin, so a container's variables never
  // fight a command line: --domain drops the variables for --tls self, and
  // --tls self drops KERSTEL_SERVER_DOMAIN.
  if (domainFromFlag && !tlsFromFlag) {
    tls = null;
    if (!tlsNamesFromFlags) tlsNames = [];
  }
  if (tlsFromFlag && !domainFromFlag) domain = null;

  if (tls !== null && tls !== "self") throw new Error(`--tls takes only self, got ${tls}.`);
  if (tls && domain) {
    // Both from flags, or both from the environment: the other kind was dropped above.
    throw new Error(tlsFromFlag ? "Use --tls self or --domain, not both." : "Set KERSTEL_SERVER_TLS=self or KERSTEL_SERVER_DOMAIN, not both.");
  }
  if (!tls && tlsNames.length > 0) {
    throw new Error(tlsNamesFromFlags ? "--tls-name needs --tls self." : "KERSTEL_SERVER_TLS_NAMES needs --tls self (or KERSTEL_SERVER_TLS=self).");
  }
  if (domain && !listenGiven) listen = "0.0.0.0:443";

  const { hostname, port } = hostPort(listen, "--listen");
  let config: TlsConfig = { mode: "off" };
  if (tls) config = { mode: "self", names: selfSignedNames(hostname, tlsNames) };
  if (domain) {
    const name = certificateName(domain);
    if (name === null || name.startsWith("*.") || isIP(name)) throw new Error(`--domain must be a DNS name, got ${domain}.`);
    const http = hostPort(acmeHttp, "--acme-http");
    config = {
      mode: "acme",
      domain: name,
      directory: acmeDirectory,
      email: acmeEmail,
      httpHostname: http.hostname,
      httpPort: http.port,
    };
  }
  return { db, hostname, port, enrollToken, enrollTokenFile, trustProxy, tls: config };
}

/** The trimmed token in `file`. Throws ENOENT when there is no file, and when it is empty. */
function readTokenFile(file: string): string {
  const token = readFileSync(file, "utf8").trim();
  if (!token) throw new Error(`${file} is empty.`);
  return token;
}

/**
 * The enroll token in `file`, or a new one (32 random bytes, base64url) that
 * it writes there, mode `0600`, when there is no file. It never replaces a
 * file, and uses the token of another process that wrote one first.
 */
export function loadOrCreateEnrollToken(file: string): { token: string; created: boolean } {
  try {
    return { token: readTokenFile(file), created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("base64url");
  let created: boolean;
  try {
    created = createFileOnce(file, `${token}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Cannot create ${file}: its directory does not exist.`);
    throw error;
  }
  return created ? { token, created } : { token: readTokenFile(file), created };
}

/** The token a device needs to create a vault, or null when anyone may. `log` says when it made a token file. */
export function resolveEnrollToken(
  config: Pick<ServerConfig, "enrollToken" | "enrollTokenFile">,
  log: (line: string) => void,
): string | null {
  if (config.enrollTokenFile === null) return config.enrollToken;
  const { token, created } = loadOrCreateEnrollToken(config.enrollTokenFile);
  if (created) log(`Created a new enroll token in ${config.enrollTokenFile}. A device needs it to create a vault.`);
  return token;
}

/** A command's failure, with the exit code to leave with: 2 for a usage error, 1 otherwise. */
class CommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2,
  ) {
    super(message);
  }
}

/** `parseArgs` for a command, with its errors as usage errors. */
function commandConfig(argv: string[], env: Record<string, string | undefined>): ReturnType<typeof parseArgs> {
  try {
    return parseArgs(argv, env);
  } catch (error) {
    throw new CommandError((error as Error).message, 2);
  }
}

/**
 * `kerstel-server value`: the lines to print, which are the server value
 * alone. It reads the token file and the `--tls self` key and creates neither,
 * so it fails until the server has started once with the same options.
 */
export function valueCommand(argv: string[], env: Record<string, string | undefined>): string[] {
  const urls: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--url") {
      rest.push(argv[i]!);
      continue;
    }
    const url = argv[++i];
    if (url === undefined || url.startsWith("--")) throw new CommandError("--url needs a value.", 2);
    urls.push(url);
  }
  const config = commandConfig(rest, env);
  if (config === "help") return [HELP];
  if (config === "version") return [VERSION];
  if (urls.length === 0) throw new CommandError("value needs at least one --url <url>.", 2);

  const file = config.enrollTokenFile;
  if (file === null) {
    throw new CommandError("value reads the enroll token from --enroll-token-file or KERSTEL_SERVER_ENROLL_TOKEN_FILE, and neither is set.", 1);
  }
  let token: string;
  try {
    token = readTokenFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new CommandError(`There is no enroll token in ${file} yet. Start kerstel-server with --enroll-token-file ${file} first.`, 1);
  }
  let pin: Buffer | null = null;
  if (config.tls.mode === "self") {
    pin = readSelfSignedPin(config.db);
    if (pin === null) {
      throw new CommandError(`There is no TLS key in ${tlsFiles(config.db).key} yet. Start kerstel-server with --tls self first.`, 1);
    }
  }
  return [encodeServerValue({ urls, pin, token })];
}

/** `kerstel-server info`: `version=`, `tls=` and, once a `--tls self` key exists, `pin=`. It never reads the token. */
export function infoCommand(argv: string[], env: Record<string, string | undefined>): string[] {
  const config = commandConfig(argv, env);
  if (config === "help") return [HELP];
  if (config === "version") return [VERSION];
  const lines = [`version=${VERSION}`, `tls=${config.tls.mode}`];
  if (config.tls.mode === "self") {
    const pin = readSelfSignedPin(config.db);
    if (pin) lines.push(`pin=${formatPin(pin)}`);
  }
  return lines;
}

/** Runs `value` or `info`, printing its lines, and exits non-zero on failure. */
function runCommand(command: (argv: string[], env: Record<string, string | undefined>) => string[], argv: string[]): void {
  let lines: string[];
  try {
    lines = command(argv, process.env);
  } catch (error) {
    console.error(`kerstel-server: ${(error as Error).message}`);
    process.exit(error instanceof CommandError ? error.exitCode : 1);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function clientAddress(request: Request, direct: string, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for");
    const first = forwarded?.split(",")[0]?.trim();
    if (first) return first;
  }
  return direct;
}

type Listener = ReturnType<typeof Bun.serve>;

/**
 * What listens for the app on `hostname`: plain HTTP, or HTTPS with `tls`. It
 * logs one line per request, with a fixed label per route.
 */
export function listener(o: { app: App; hostname: string; trustProxy: boolean; log?: (line: string) => void }) {
  const log = o.log ?? ((line: string) => console.log(line));
  return (port: number, tls?: { cert: string; key: string }): Listener =>
    Bun.serve({
      hostname: o.hostname,
      port,
      maxRequestBodySize: LIMITS.bodyBytes,
      ...(tls ? { tls } : {}),
      async fetch(request, srv) {
        const started = performance.now();
        const ip = clientAddress(request, srv.requestIP(request)?.address ?? "unknown", o.trustProxy);
        const response = await o.app.fetch(request, ip);
        // A fixed label per route, IDs as :id, and "(unknown)" for anything else,
        // so no text a caller puts in a path reaches the log.
        const route = o.app.routeLabel(request.method, new URL(request.url).pathname);
        log(`${request.method} ${route} ${response.status} ${Math.round(performance.now() - started)}ms`);
        return response;
      },
    });
}

/**
 * The HTTPS listener for `--domain`, for `keepCertificate` to serve each
 * certificate with. Bun.serve's reload keeps the old certificate, so a new one
 * restarts the listener on the same address. stop() lets requests in flight
 * finish, and the address may stay taken for a moment, so the new listener
 * tries again. `served` runs once the listener has the certificate; `serve`
 * rejects when it cannot listen again.
 */
export function certificateListener(o: {
  port: number;
  listen: (port: number, tls: { cert: string; key: string }) => Listener;
  served: (server: Listener, certificate: AcmeCertificate, first: boolean) => void;
  log: (line: string) => void;
}): { serve(certificate: AcmeCertificate): Promise<void>; server(): Listener | null } {
  let server: Listener | null = null;
  return {
    async serve(certificate) {
      const previous = server;
      const tls = { cert: certificate.certPem, key: certificate.keyPem };
      // Read before stop(): a stopped listener reports port 0, which would bind a new, random one.
      const port = previous?.port || o.port;
      previous?.stop();
      server = previous ? await bindAgain(() => o.listen(port, tls), { log: o.log }) : o.listen(port, tls);
      o.served(server, certificate, !previous);
    },
    server: () => server,
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === "value") return runCommand(valueCommand, argv.slice(1));
  if (argv[0] === "info") return runCommand(infoCommand, argv.slice(1));

  let config: ReturnType<typeof parseArgs>;
  try {
    config = parseArgs(argv, process.env);
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

  let enrollToken: string | null;
  try {
    enrollToken = resolveEnrollToken(config, (line) => console.log(line));
  } catch (error) {
    console.error(`kerstel-server: ${(error as Error).message}`);
    process.exit(1);
  }

  let self: ReturnType<typeof loadSelfSigned> | null = null;
  if (config.tls.mode === "self") {
    try {
      self = loadSelfSigned(config.db, config.tls.names);
    } catch (error) {
      console.error(`kerstel-server: ${(error as Error).message}`);
      process.exit(1);
    }
  }

  const db = openDatabase(config.db);
  let certDer = self?.certDer ?? null;
  const app = createApp({ db, version: VERSION, enrollToken, certificate: () => certDer });
  const { trustProxy } = config;

  const listen = listener({ app, hostname: config.hostname, trustProxy });
  const listening = (server: Listener, scheme: string) =>
    console.log(`kerstel-server ${VERSION} listening on ${scheme}://${server.hostname}:${server.port} (database ${config.db})`);

  let server: Listener | null = null;
  let stopAcme = () => {};
  if (config.tls.mode === "acme") {
    const acme = config.tls;
    const manager = new AcmeManager({
      db: config.db,
      domain: acme.domain,
      directory: acme.directory,
      email: acme.email,
      httpPort: acme.httpPort,
    });
    let challenges: ReturnType<typeof serveChallenges>;
    try {
      challenges = serveChallenges({ challenges: manager.challenges, hostname: acme.httpHostname, port: acme.httpPort });
    } catch (error) {
      console.error(`kerstel-server: cannot answer ACME challenges on ${acme.httpHostname}:${acme.httpPort}: ${(error as Error).message}`);
      process.exit(1);
    }
    console.log(`Answering ACME challenges for ${acme.domain} on http://${challenges.hostname}:${challenges.port}`);
    const https = certificateListener({
      port: config.port,
      listen,
      served: (next, certificate, first) => {
        server = next;
        certDer = certificate.certDer;
        if (first) listening(next, "https");
      },
      log: (line) => console.error(`kerstel-server: ${line}`),
    });
    const serve = (certificate: AcmeCertificate) =>
      https.serve(certificate).catch((error: unknown) => {
        console.error(`kerstel-server: ${(error as Error).message}`);
        process.exit(1);
      });
    const keeper = keepCertificate({ manager, serve, log: (line) => console.log(line) });
    stopAcme = () => {
      keeper.stop();
      challenges.stop();
    };
  } else {
    server = listen(config.port, self ? { cert: self.certPem, key: self.keyPem } : undefined);
    listening(server, self ? "https" : "http");
    if (self) console.log(`Certificate pin: ${formatPin(self.pin)}`);
  }

  app.maintain();
  const timer = setInterval(() => app.maintain(), 10 * 60_000);
  if (!enrollToken) {
    console.log("No enroll token: anyone who can reach this server can create a vault.");
  }

  const stop = () => {
    clearInterval(timer);
    stopAcme();
    server?.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (import.meta.main) main();
