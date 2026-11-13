import { describe, expect, test } from "bun:test";
import { X509Certificate, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { formatPin, parsePin, pinOfCertificate, pinOfSpki } from "../src/pin";
import { certificateNames, certificateRequest, issueCertificate, selfSignedCertificate, toPem } from "../src/x509";

const NAMES = ["localhost", "127.0.0.1", "::1", "homebox.local"];

const freshKey = (): KeyObject => generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
const spkiOf = (key: KeyObject): Buffer => createPublicKey(key).export({ type: "spki", format: "der" });

describe("self-signed certificate", () => {
  test("a self-signed certificate parses and verifies", () => {
    const key = freshKey();
    const der = selfSignedCertificate({ key, names: NAMES });
    const cert = new X509Certificate(der);
    expect(cert.verify(cert.publicKey)).toBe(true);
    const san = cert.subjectAltName ?? "";
    expect(san).toContain("DNS:localhost");
    expect(san).toContain("IP Address:127.0.0.1");
    expect(san).toContain("DNS:homebox.local");
    expect(cert.validTo).toContain("9999");
    expect(cert.subject).toContain("CN=kerstel-server");
    expect(cert.issuer).toContain("CN=kerstel-server");
    expect(cert.ca).toBe(false);
    expect(cert.keyUsage).toContain("1.3.6.1.5.5.7.3.1");
    // Valid from one day before `now`.
    expect(new Date(cert.validFrom).getTime()).toBeLessThan(Date.now() - 23 * 3600_000);
  });

  test("two certificates from one key have different serials", () => {
    const key = freshKey();
    const a = new X509Certificate(selfSignedCertificate({ key, names: NAMES }));
    const b = new X509Certificate(selfSignedCertificate({ key, names: NAMES }));
    expect(a.serialNumber).not.toBe(b.serialNumber);
  });

  test("Bun serves it", async () => {
    const key = freshKey();
    const cert = toPem(selfSignedCertificate({ key, names: NAMES }), "CERTIFICATE");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert, key: key.export({ type: "pkcs8", format: "pem" }) as string },
      fetch: () => new Response("ok"),
    });
    try {
      const res = await fetch(`https://127.0.0.1:${server.port}/`, { tls: { ca: cert } });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
    } finally {
      server.stop(true);
    }
  });

  test("a certificate issued by a CA serves under that CA", async () => {
    const caKey = freshKey();
    const caDer = issueCertificate({ subjectSpki: spkiOf(caKey), issuerKey: caKey, subjectName: "Test CA", issuerName: "Test CA", names: [], ca: true });
    const ca = new X509Certificate(caDer);
    expect(ca.ca).toBe(true);
    expect(ca.verify(ca.publicKey)).toBe(true);

    const key = freshKey();
    const leafDer = issueCertificate({ subjectSpki: spkiOf(key), issuerKey: caKey, issuerName: "Test CA", names: ["127.0.0.1"] });
    const leaf = new X509Certificate(leafDer);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.ca).toBe(false);

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: toPem(leafDer, "CERTIFICATE"), key: key.export({ type: "pkcs8", format: "pem" }) as string },
      fetch: () => new Response("ok"),
    });
    try {
      const res = await fetch(`https://127.0.0.1:${server.port}/`, { tls: { ca: toPem(caDer, "CERTIFICATE") } });
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      server.stop(true);
    }
  });

  test("keyUsage: none on a self-signed leaf, digitalSignature on an issued leaf, keyCertSign on a CA", () => {
    const openssl = Bun.which("openssl");
    if (!openssl) return;
    const show = (der: Buffer) => `${Bun.spawnSync([openssl, "x509", "-noout", "-text", "-inform", "DER"], { stdin: der }).stdout}`;
    const caKey = freshKey();
    const self = show(selfSignedCertificate({ key: freshKey(), names: ["localhost"] }));
    const issued = show(issueCertificate({ subjectSpki: spkiOf(freshKey()), issuerKey: caKey, names: ["localhost"] }));
    const ca = show(issueCertificate({ subjectSpki: spkiOf(caKey), issuerKey: caKey, names: [], ca: true }));
    expect(self).not.toContain("X509v3 Key Usage");
    expect(self).toContain("CA:FALSE");
    expect(self).toContain("TLS Web Server Authentication");
    expect(issued).toMatch(/X509v3 Key Usage: critical\s+Digital Signature\n/);
    expect(ca).toMatch(/X509v3 Key Usage: critical\s+Certificate Sign\n/);
    expect(ca).toContain("CA:TRUE");
    expect(ca).not.toContain("TLS Web Server Authentication");
  });

  test("certificateNames returns the names it was given", () => {
    const der = selfSignedCertificate({ key: freshKey(), names: NAMES });
    expect(certificateNames(der)).toEqual(NAMES);
  });
  test("validity uses UTCTime before 2050 and GeneralizedTime from 2050", () => {
    const key = freshKey();
    const at = (iso: string) => new X509Certificate(selfSignedCertificate({ key, names: [], now: Date.parse(iso) }));
    expect(new Date(at("2049-06-02T12:00:00Z").validFrom).toISOString()).toBe("2049-06-01T12:00:00.000Z");
    expect(new Date(at("2050-01-02T00:00:00Z").validFrom).toISOString()).toBe("2050-01-01T00:00:00.000Z");
    expect(new Date(at("2026-11-14T08:30:15.999Z").validTo).toISOString()).toBe("9999-12-31T23:59:59.000Z");
  });

  test("IP addresses come back in their RFC 5952 form", () => {
    const der = selfSignedCertificate({ key: freshKey(), names: ["2001:DB8:0:0:1:0:0:1", "fe80::", "10.0.0.2", "1:2:3:4:5:6:7:8"] });
    expect(certificateNames(der)).toEqual(["2001:db8::1:0:0:1", "fe80::", "10.0.0.2", "1:2:3:4:5:6:7:8"]);
    expect(new X509Certificate(der).subjectAltName).toContain("IP Address:10.0.0.2");
  });

  test("a certificate with no names has no subjectAltName", () => {
    expect(certificateNames(selfSignedCertificate({ key: freshKey(), names: [] }))).toEqual([]);
  });
});

describe("pins", () => {
  test("the pin is the key's, not the certificate's", () => {
    const key = freshKey();
    const a = selfSignedCertificate({ key, names: ["localhost"] });
    const b = selfSignedCertificate({ key, names: ["localhost", "10.0.0.2", "box.example"] });
    const other = selfSignedCertificate({ key: freshKey(), names: ["localhost"] });
    expect(pinOfCertificate(a).equals(pinOfCertificate(b))).toBe(true);
    expect(pinOfCertificate(a).equals(pinOfCertificate(other))).toBe(false);
    expect(pinOfCertificate(a).equals(pinOfSpki(spkiOf(key)))).toBe(true);
    expect(pinOfCertificate(a).length).toBe(32);
  });

  test("parsePin round-trips and refuses anything else", () => {
    const pin = pinOfSpki(spkiOf(freshKey()));
    const text = formatPin(pin);
    expect(text).toMatch(/^sha256\/[A-Za-z0-9_-]{43}$/);
    expect(parsePin(text)?.equals(pin)).toBe(true);
    expect(parsePin(`  ${text}\n`)?.equals(pin)).toBe(true);

    const body = text.slice("sha256/".length);
    expect(parsePin(body)).toBeNull();
    expect(parsePin(`sha1/${body}`)).toBeNull();
    expect(parsePin(`sha256/${body.slice(1)}`)).toBeNull();
    expect(parsePin(`sha256/${body}A`)).toBeNull();
    expect(parsePin(`sha256/+${body.slice(1)}`)).toBeNull();
    expect(parsePin(`sha256//${body.slice(1)}`)).toBeNull();
    expect(parsePin(`sha256/${body}=`)).toBeNull();
    expect(parsePin(`pin sha256/${body}`)).toBeNull();
    expect(parsePin(`sha256/${body} x`)).toBeNull();
    expect(parsePin("")).toBeNull();
  });

  test("parsePin refuses a body with stray bits in its last character", () => {
    // 43 characters carry 258 bits; the last 2 must be zero, so each pin has one spelling.
    const text = formatPin(Buffer.alloc(32));
    expect(parsePin(text)?.equals(Buffer.alloc(32))).toBe(true);
    expect(parsePin(`${text.slice(0, -1)}B`)).toBeNull();
  });
});

describe("certificate request", () => {
  test("a CSR parses", () => {
    const der = certificateRequest({ key: freshKey(), domain: "box.example.com" });
    expect(toPem(der, "CERTIFICATE REQUEST")).toStartWith("-----BEGIN CERTIFICATE REQUEST-----\n");
    const openssl = Bun.which("openssl");
    if (!openssl) return;
    const verify = Bun.spawnSync([openssl, "req", "-verify", "-noout", "-inform", "DER"], { stdin: der });
    expect(verify.exitCode).toBe(0);
    expect(`${verify.stdout}${verify.stderr}`).toContain("verify OK");
    const text = Bun.spawnSync([openssl, "req", "-noout", "-text", "-inform", "DER"], { stdin: der });
    expect(text.exitCode).toBe(0);
    expect(`${text.stdout}`).toContain("CN=box.example.com");
    expect(`${text.stdout}`).toContain("DNS:box.example.com");
  });
});

describe("PEM", () => {
  test("wraps base64 at 64 columns", () => {
    const der = Buffer.alloc(100, 7);
    const pem = toPem(der, "CERTIFICATE");
    const lines = pem.trimEnd().split("\n");
    expect(lines[0]).toBe("-----BEGIN CERTIFICATE-----");
    expect(lines.at(-1)).toBe("-----END CERTIFICATE-----");
    expect(lines.slice(1, -1).every((l) => l.length <= 64)).toBe(true);
    expect(Buffer.from(lines.slice(1, -1).join(""), "base64").equals(der)).toBe(true);
  });
});
