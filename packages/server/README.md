# kerstel-server

The self-hostable sync server for Kerstel. It stores only ciphertext. It never sees a scope name, a key name, a value, a project path or a hostname. The design is in [`docs/superpowers/specs/2026-11-08-sync-between-devices-design.md`](../../docs/superpowers/specs/2026-11-08-sync-between-devices-design.md).

The [Sync docs](https://kerstel.dev/docs/sync) cover setup, pairing and conflicts.

## Install

Every [release](https://github.com/alilibx/kerstel/releases/latest) ships the server next to the CLI, with the same version: `kerstel-server-<platform>` binaries for Linux and macOS, covered by the release's `SHA256SUMS`, and an image:

```bash
docker run -d --restart unless-stopped -p 127.0.0.1:8787:8787 -v kerstel-server:/data ghcr.io/alilibx/kerstel-server:latest
```

The image is tagged with each version (`0.3.0`), each minor version (`0.3`) and `latest`.

The image has no shell, runs as a non-root user, and keeps its database in the `/data` volume. The settings below work as environment variables with `docker run -e`.

## Run it from source

```bash
bun run --cwd packages/server build        # dist/kerstel-server
./dist/kerstel-server --db /var/lib/kerstel/server.db --listen 127.0.0.1:8787
```

| Option | Environment | Default |
|---|---|---|
| `--db <file>` | `KERSTEL_SERVER_DB` | `./kerstel-server.db` |
| `--listen <host:port>` | `KERSTEL_SERVER_LISTEN` | `127.0.0.1:8787`, or `0.0.0.0:443` with `--domain` when neither this flag nor the variable is set |
| `--enroll-token-file <file>` | `KERSTEL_SERVER_ENROLL_TOKEN` | none: anyone who can reach the server can create a vault |
| `--trust-proxy` | | off: rate limits use the socket address, not `X-Forwarded-For` |
| `--tls self` | `KERSTEL_SERVER_TLS` | off: plain HTTP |
| `--tls-name <name>` | `KERSTEL_SERVER_TLS_NAMES` | none. Repeat the flag, or comma-separate the variable. |
| `--domain <name>` | `KERSTEL_SERVER_DOMAIN` | none |
| `--acme-email <address>` | `KERSTEL_SERVER_ACME_EMAIL` | none |
| `--acme-http <host:port>` | `KERSTEL_SERVER_ACME_HTTP` | `0.0.0.0:80` |
| `--acme-directory <url>` | `KERSTEL_SERVER_ACME_DIRECTORY` | Let's Encrypt |

## HTTPS

Kerstel sends a vault only to an `https://` URL, or `http://` to the same machine. The server serves HTTPS in two ways, and works behind a proxy or Tailscale too.

**Its own certificate, pinned.** `--tls self` makes an ECDSA certificate for `localhost`, `127.0.0.1`, the `--listen` host when it is a specific address, and each `--tls-name`. When it starts, it prints `Certificate pin: sha256/…`. Set up the first device with that pin:

```bash
kerstel-server --listen 0.0.0.0:8787 --tls self --tls-name 203.0.113.7
kerstel sync setup https://203.0.113.7:8787 --pin sha256/…
```

The pin travels in the join value, so other devices never type it. With Docker, set `-e KERSTEL_SERVER_TLS=self -e KERSTEL_SERVER_TLS_NAMES=203.0.113.7`, and read the pin with `docker logs`.

**Your domain, with Let's Encrypt.** `--domain sync.example.com` gets and renews a certificate. Ports 80 and 443 must reach the server. Binding them needs root, or `CAP_NET_BIND_SERVICE` on Linux. It renews when fewer than 30 days remain, checking every 12 hours. Running with `--domain` agrees to the CA's terms. With Docker, publish `-p 80:80 -p 443:443` and set `KERSTEL_SERVER_LISTEN=0.0.0.0:443`, because the image sets `8787`. Add `--restart unless-stopped`: a renewal restarts the HTTPS listener, and if that fails the server exits, so something must start it again.

**Files.** The key, certificate and ACME account key sit beside the database: `<db>.tls-key.pem` (mode `0600`), `<db>.tls-cert.pem` and `<db>.acme-account.pem` (mode `0600`). The key survives restarts, so the pin does too.

**Certificate request.** `GET /v1/certificate` returns `{ "certificate": "<base64 DER>" }` without authentication, or 404 when the server has no certificate of its own.

**Tailscale.** Run `kerstel-server --listen 127.0.0.1:8787`, then `tailscale serve --bg 8787`. Enable HTTPS Certificates for your tailnet in the Tailscale admin console, under DNS. Every device must be on the tailnet. The URL is `https://<machine>.<tailnet>.ts.net`, with no pin.

**Behind your own proxy.** Without `--tls` or `--domain` the server speaks plain HTTP. Put it behind a proxy that terminates TLS. With Caddy:

```
sync.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

Then start the server with `--trust-proxy`, so rate limits apply to each client rather than to the proxy.

## Develop

```bash
bun test packages/server
bun run --cwd packages/server typecheck
bun packages/server/src/index.ts --db /tmp/dev.db
```

`src/protocol.ts` holds the wire format and request signing, shared with the client. `src/app.ts` handles requests without a listener, so tests drive it with plain `Request` objects.
