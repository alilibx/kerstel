import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { X509Certificate, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinOfCertificate } from "../src/pin";
import { loadSelfSigned, tlsFiles } from "../src/tls";
import { certificateNames } from "../src/x509";

let dir: string;
let db: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kerstel-server-tls-"));
  db = join(dir, "s.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NAMES = ["localhost", "127.0.0.1"];

describe("tlsFiles", () => {
  test("names each file beside the database", () => {
    expect(tlsFiles("/data/s.db")).toEqual({
      key: "/data/s.db.tls-key.pem",
      cert: "/data/s.db.tls-cert.pem",
      account: "/data/s.db.acme-account.pem",
    });
  });
});

describe("loadSelfSigned", () => {
  test("creates a key once, mode 0600", () => {
    const first = loadSelfSigned(db, NAMES);
    expect(statSync(tlsFiles(db).key).mode & 0o777).toBe(0o600);
    const second = loadSelfSigned(db, NAMES);
    expect(second.pin.equals(first.pin)).toBe(true);
    expect(second.certDer.equals(first.certDer)).toBe(true); // same names: no reissue
    expect(pinOfCertificate(first.certDer).equals(first.pin)).toBe(true);
    expect(first.certPem).toBe(readFileSync(tlsFiles(db).cert, "utf8"));
    expect(new X509Certificate(first.certPem).raw.equals(first.certDer)).toBe(true);
    expect(first.keyPem).toBe(readFileSync(tlsFiles(db).key, "utf8"));
  });

  test("new names reissue with the same key", () => {
    const first = loadSelfSigned(db, NAMES);
    const second = loadSelfSigned(db, [...NAMES, "homebox.local"]);
    expect(second.certDer.equals(first.certDer)).toBe(false);
    expect(certificateNames(second.certDer)).toContain("homebox.local");
    expect(second.pin.equals(first.pin)).toBe(true);
  });

  test("the same names in another order or spelling do not reissue", () => {
    const first = loadSelfSigned(db, [...NAMES, "::1", "2001:db8::1"]);
    const second = loadSelfSigned(db, ["2001:0db8:0:0:0:0:0:1", "0:0:0:0:0:0:0:1", "127.0.0.1", "localhost"]);
    expect(second.certDer.equals(first.certDer)).toBe(true);
  });

  test("an existing key is never replaced", () => {
    const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const keyPem = key.export({ type: "pkcs8", format: "pem" }) as string;
    writeFileSync(tlsFiles(db).key, keyPem, { mode: 0o600 });
    const loaded = loadSelfSigned(db, NAMES);
    expect(readFileSync(tlsFiles(db).key, "utf8")).toBe(keyPem);
    expect(loaded.keyPem).toBe(keyPem);
    const spki = createPublicKey(key).export({ type: "spki", format: "der" });
    expect(new X509Certificate(loaded.certDer).publicKey.export({ type: "spki", format: "der" }).equals(spki)).toBe(true);
  });

  test("a certificate for another key, or one that does not parse, is reissued", () => {
    const first = loadSelfSigned(db, NAMES);
    rmSync(tlsFiles(db).key);
    const second = loadSelfSigned(db, NAMES);
    expect(second.pin.equals(first.pin)).toBe(false);
    expect(pinOfCertificate(second.certDer).equals(second.pin)).toBe(true);

    writeFileSync(tlsFiles(db).cert, "not a certificate");
    const third = loadSelfSigned(db, NAMES);
    expect(third.pin.equals(second.pin)).toBe(true);
    expect(pinOfCertificate(third.certDer).equals(third.pin)).toBe(true);
  });
});
