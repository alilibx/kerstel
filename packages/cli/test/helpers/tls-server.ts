import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { createApp, type App } from "../../../server/src/app";
import { openDatabase } from "../../../server/src/db";
import { pinOfCertificate } from "../../../server/src/pin";
import { selfSignedCertificate, toPem } from "../../../server/src/x509";

/** A P-256 key, as `kerstel-server --tls self` makes one. */
export const serverKey = (): KeyObject => generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;

export interface TlsServerOptions {
  /** The key the listener serves with. A new one by default. */
  key?: KeyObject;
  names?: string[];
  /** Makes the certificate the listener serves for `key`; self-signed by default. */
  issue?: (key: KeyObject, names: string[]) => Buffer;
  /** What `GET /v1/certificate` returns; the served certificate by default. */
  advertise?: (served: Buffer) => Buffer | null;
  /** Answers a request before the app does, when it returns a response. */
  intercept?: (request: Request) => Response | undefined;
  /** The server's clock; real time by default. */
  now?: () => number;
}

export interface TlsServer {
  url: string;
  port: number;
  key: KeyObject;
  /** The certificate the listener serves now. */
  certDer: Buffer;
  pin: Buffer;
  app: App;
  /** Every path the listener was asked for, in order. */
  paths: string[];
  /** Stops the listener and starts it again on the same port, with a new certificate for `names` and `key`. */
  restart(o: { key?: KeyObject; names: string[] }): void;
  stop(): void;
}

/**
 * `createApp` behind a real `Bun.serve` with TLS, as `kerstel-server --tls self`
 * runs it, on 127.0.0.1 with an in-memory database.
 */
export function startTlsServer(options: TlsServerOptions = {}): TlsServer {
  const db = openDatabase(":memory:");
  const state: { key: KeyObject; certDer: Buffer } = { key: options.key ?? serverKey(), certDer: Buffer.alloc(0) };
  const app = createApp({
    db,
    version: "test",
    now: options.now,
    certificate: () => (options.advertise ? options.advertise(state.certDer) : state.certDer),
  });
  const paths: string[] = [];

  const listen = (port: number) => {
    const keyPem = state.key.export({ type: "pkcs8", format: "pem" }) as string;
    return Bun.serve({
      hostname: "127.0.0.1",
      port,
      tls: { cert: toPem(state.certDer, "CERTIFICATE"), key: keyPem },
      fetch(request) {
        paths.push(new URL(request.url).pathname);
        return options.intercept?.(request) ?? app.fetch(request, "127.0.0.1");
      },
    });
  };

  const issue = options.issue ?? ((key, names) => selfSignedCertificate({ key, names }));
  state.certDer = issue(state.key, options.names ?? ["localhost", "127.0.0.1"]);
  let server = listen(0);
  const port = server.port!;

  return {
    url: `https://127.0.0.1:${port}`,
    port,
    get key() {
      return state.key;
    },
    get certDer() {
      return state.certDer;
    },
    get pin() {
      return pinOfCertificate(state.certDer);
    },
    app,
    paths,
    restart(o) {
      server.stop(true);
      if (o.key) state.key = o.key;
      state.certDer = issue(state.key, o.names);
      server = listen(port);
    },
    stop() {
      server.stop(true);
      db.close();
    },
  };
}
