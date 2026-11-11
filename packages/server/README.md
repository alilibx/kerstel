# kerstel-server

The self-hostable sync server for Kerstel. It stores only ciphertext. It never sees a scope name, a key name, a value, a project path or a hostname. The design is in [`docs/superpowers/specs/2026-11-08-sync-between-devices-design.md`](../../docs/superpowers/specs/2026-11-08-sync-between-devices-design.md).

The [Sync docs](https://kerstel.dev/docs/sync) cover setup, pairing and conflicts.

## Install

Every [release](https://github.com/alilibx/kerstel/releases/latest) ships the server next to the CLI, with the same version: `kerstel-server-<platform>` binaries for Linux and macOS, covered by the release's `SHA256SUMS`, and an image:

```bash
docker run -d -p 127.0.0.1:8787:8787 -v kerstel-server:/data ghcr.io/alilibx/kerstel-server:latest
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
| `--listen <host:port>` | `KERSTEL_SERVER_LISTEN` | `127.0.0.1:8787` |
| `--enroll-token-file <file>` | `KERSTEL_SERVER_ENROLL_TOKEN` | none: anyone who can reach the server can create a vault |
| `--trust-proxy` | | off: rate limits use the socket address, not `X-Forwarded-For` |

The server speaks plain HTTP. Put it behind a proxy that terminates TLS. With Caddy:

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
