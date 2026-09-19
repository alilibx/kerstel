import { afterEach, expect, test } from "bun:test";
import { githubReleases } from "../src/update/release-source";

const servers: ReturnType<typeof Bun.serve>[] = [];

function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

afterEach(() => {
  while (servers.length) servers.pop()!.stop(true);
});

test("latestVersion reads the version from the /releases/latest redirect", async () => {
  const base = serve((req) => {
    if (new URL(req.url).pathname === "/releases/latest") {
      return new Response(null, { status: 302, headers: { location: `${base}/releases/tag/v0.1.1` } });
    }
    return new Response("not found", { status: 404 });
  });
  const source = githubReleases({ baseUrl: base });
  expect(await source.latestVersion()).toBe("0.1.1");
});

test("latestVersion is null when the page does not redirect to a tag", async () => {
  const base = serve(() => new Response("<html>releases</html>", { status: 200 }));
  expect(await githubReleases({ baseUrl: base }).latestVersion()).toBeNull();
});

test("latestVersion is null when the host is unreachable", async () => {
  // A server that has already stopped: the port refuses connections.
  const base = serve(() => new Response("never"));
  servers.pop()!.stop(true);
  expect(await githubReleases({ baseUrl: base }).latestVersion()).toBeNull();
});

test("latestVersion gives up after the timeout instead of hanging", async () => {
  const base = serve(() => new Promise<Response>(() => {}));
  const started = Date.now();
  expect(await githubReleases({ baseUrl: base, timeoutMs: 200 }).latestVersion()).toBeNull();
  expect(Date.now() - started).toBeLessThan(2000);
});

test("asset and checksum URLs point at the tagged release's download path", () => {
  const source = githubReleases({ baseUrl: "https://github.com/alilibx/kerstel" });
  expect(source.assetUrl("0.1.1", "kerstel-darwin-arm64")).toBe(
    "https://github.com/alilibx/kerstel/releases/download/v0.1.1/kerstel-darwin-arm64",
  );
  expect(source.checksumsUrl("0.1.1")).toBe("https://github.com/alilibx/kerstel/releases/download/v0.1.1/SHA256SUMS");
});

test("the default base is the Kerstel repository", () => {
  expect(githubReleases().checksumsUrl("0.1.0")).toBe(
    "https://github.com/alilibx/kerstel/releases/download/v0.1.0/SHA256SUMS",
  );
});

test("KERSTEL_RELEASES_URL redirects the default source, so tests and mirrors never hit github.com", () => {
  const before = process.env.KERSTEL_RELEASES_URL;
  process.env.KERSTEL_RELEASES_URL = "http://127.0.0.1:1/mirror/";
  try {
    expect(githubReleases().checksumsUrl("0.1.0")).toBe("http://127.0.0.1:1/mirror/releases/download/v0.1.0/SHA256SUMS");
  } finally {
    if (before === undefined) delete process.env.KERSTEL_RELEASES_URL;
    else process.env.KERSTEL_RELEASES_URL = before;
  }
});
