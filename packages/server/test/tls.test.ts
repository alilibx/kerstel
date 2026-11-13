import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { X509Certificate, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinOfCertificate } from "../src/pin";
import { certificateName, loadSelfSigned, tlsFiles } from "../src/tls";
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

describe("certificateName", () => {
  test("a malformed IPv4 address is not a DNS name", () => {
    for (const text of ["192.168.1.256", "127.1", "1.2.3.4.5", "010.0.0.1", "8080", "*.10"]) {
      expect(certificateName(text)).toBeNull();
    }
    expect(certificateName("192.168.1.20")).toBe("192.168.1.20");
    expect(certificateName("host1.example")).toBe("host1.example");
    expect(certificateName("10.example")).toBe("10.example");
    expect(certificateName("1.2.3.4.nip.io")).toBe("1.2.3.4.nip.io");
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
    // Compared without toBe, so a failure never prints a private key.
    expect(first.keyPem === readFileSync(tlsFiles(db).key, "utf8")).toBe(true);
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
    expect(readFileSync(tlsFiles(db).key, "utf8") === keyPem).toBe(true);
    expect(loaded.keyPem === keyPem).toBe(true);
    const spki = createPublicKey(key).export({ type: "spki", format: "der" });
    expect(new X509Certificate(loaded.certDer).publicKey.export({ type: "spki", format: "der" }).equals(spki)).toBe(true);
  });

  test("an empty key file is an error that says so, and is left alone", () => {
    writeFileSync(tlsFiles(db).key, "", { mode: 0o600 });
    expect(() => loadSelfSigned(db, NAMES)).toThrow(
      `${tlsFiles(db).key} is empty. If no device has pinned this server yet, delete it and start again.`,
    );
    expect(statSync(tlsFiles(db).key).size).toBe(0);
  });

  test("leaves no temporary file behind", () => {
    loadSelfSigned(db, NAMES);
    expect(readdirSync(dir).sort()).toEqual(["s.db.tls-cert.pem", "s.db.tls-key.pem"]);
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
