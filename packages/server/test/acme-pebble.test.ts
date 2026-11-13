/**
 * `AcmeManager` against Pebble, Let's Encrypt's test CA. CI's `acme` job
 * starts Pebble with PEBBLE_VA_ALWAYS_VALID=1 and sets
 * KERSTEL_TEST_PEBBLE_DIRECTORY; without it this test skips.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { X509Certificate, createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcmeManager, tlsFiles } from "../src/tls";

const DIRECTORY = process.env.KERSTEL_TEST_PEBBLE_DIRECTORY;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kerstel-server-pebble-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test.skipIf(!DIRECTORY)(
  "Pebble issues a certificate",
  async () => {
    const logs: string[] = [];
    const db = join(dir, "s.db");
    const manager = new AcmeManager({
      db,
      domain: "sync.test",
      directory: DIRECTORY!,
      email: null,
      deps: {
        // Pebble serves its API with a certificate of its own. Test only.
        fetch: (request) => fetch(request, { tls: { rejectUnauthorized: false } }),
        log: (line) => logs.push(line),
      },
    });
    const result = await manager.ensure();
    expect(logs.filter((line) => !line.startsWith("Got a certificate"))).toEqual([]);
    expect(result).toBe("issued");
    const certificate = manager.current()!;
    const leaf = new X509Certificate(certificate.certDer);
    expect(leaf.subjectAltName).toBe("DNS:sync.test");
    const spki = createPublicKey(readFileSync(tlsFiles(db).key, "utf8")).export({ type: "spki", format: "der" });
    expect(leaf.publicKey.export({ type: "spki", format: "der" }).equals(spki)).toBe(true);
    expect(statSync(tlsFiles(db).account).mode & 0o777).toBe(0o600);
    // An order that names no profile gets one of Pebble's at random: 90 days, or
    // 6 days, which is already due for renewal.
    const remaining = Date.parse(leaf.validTo) - Date.now();
    expect(await manager.ensure()).toBe(remaining >= 30 * 86_400_000 ? "current" : "renewed");
  },
  60_000,
);
