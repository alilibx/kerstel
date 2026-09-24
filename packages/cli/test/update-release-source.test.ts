import { afterEach, expect, test } from "bun:test";
import { displayUrl, githubReleases, releaseBaseProblem } from "../src/update/release-source";

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

function withReleasesUrl<T>(value: string, body: () => T): T {
  const before = process.env.KERSTEL_RELEASES_URL;
  process.env.KERSTEL_RELEASES_URL = value;
  try {
    return body();
  } finally {
    if (before === undefined) delete process.env.KERSTEL_RELEASES_URL;
    else process.env.KERSTEL_RELEASES_URL = before;
  }
}

test("releaseBaseProblem accepts https and loopback http, and refuses everything else by variable name", () => {
  expect(releaseBaseProblem("https://mirror.example.com/kerstel", "KERSTEL_RELEASES_URL")).toBeNull();
  expect(releaseBaseProblem("http://127.0.0.1:9", "KERSTEL_RELEASES_URL")).toBeNull();
  expect(releaseBaseProblem("http://localhost:8080/m", "KERSTEL_RELEASES_URL")).toBeNull();
  expect(releaseBaseProblem("http://[::1]:8080", "KERSTEL_RELEASES_URL")).toBeNull();

  const plain = releaseBaseProblem("http://mirror.example.com/kerstel", "KERSTEL_RELEASES_URL");
  expect(plain).toContain("KERSTEL_RELEASES_URL");
  expect(plain).toContain("https://");
  expect(releaseBaseProblem("ftp://mirror.example.com", "KERSTEL_RELEASES_URL")).toContain("KERSTEL_RELEASES_URL");
  expect(releaseBaseProblem("not a url", "KERSTEL_RELEASES_URL")).toContain("KERSTEL_RELEASES_URL");
  // A lookalike of a loopback name is not loopback.
  expect(releaseBaseProblem("http://127.0.0.1.evil.example", "KERSTEL_RELEASES_URL")).not.toBeNull();
});

test("the refusal never echoes the URL, so credentials in it stay out of the terminal", () => {
  const problem = releaseBaseProblem("http://user:hunter2@mirror.example.com", "KERSTEL_RELEASES_URL");
  expect(problem).not.toContain("hunter2");
});

test("an http:// KERSTEL_RELEASES_URL makes the source refuse without making a request", async () => {
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    throw new Error("no request expected");
  }) as unknown as typeof fetch;
  try {
    const source = withReleasesUrl("http://mirror.example.com", () => githubReleases());
    expect(source.problem).toContain("KERSTEL_RELEASES_URL");
    expect(await source.latestVersion()).toBeNull();
    expect(requests).toBe(0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the default source is not a mirror; an override is, and says where", () => {
  const before = process.env.KERSTEL_RELEASES_URL;
  delete process.env.KERSTEL_RELEASES_URL;
  try {
    expect(githubReleases().mirror).toBeNull();
    expect(githubReleases().problem).toBeNull();
  } finally {
    if (before !== undefined) process.env.KERSTEL_RELEASES_URL = before;
  }
  const source = withReleasesUrl("https://mirror.example.com/kerstel/", () => githubReleases());
  expect(source.mirror).toBe("https://mirror.example.com/kerstel");
  expect(source.problem).toBeNull();
});

test("displayUrl drops a mirror's credentials, and the mirror line never shows them", () => {
  expect(displayUrl("https://user:hunter2@mirror.example.com/kerstel/")).toBe("https://mirror.example.com/kerstel");
  expect(displayUrl("https://mirror.example.com/kerstel")).toBe("https://mirror.example.com/kerstel");
  expect(displayUrl("nope")).toBe("(not a URL)");
  const source = withReleasesUrl("https://user:hunter2@mirror.example.com/kerstel", () => githubReleases());
  expect(source.mirror).toBe("https://mirror.example.com/kerstel");
  expect(source.assetUrl("0.1.0", "a")).toContain("hunter2");
});
