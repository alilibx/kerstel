# Pair with one value Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ks sync add-device` prints one line, `ks sync join ks1-…`, and copies it to the clipboard; `ks sync join` takes that one value, as an argument or pasted at a hidden prompt (#108).

**Architecture:** A new module, `packages/cli/src/sync/join-value.ts`, encodes and parses the join value and the text a person pastes. A second new module, `packages/cli/src/clipboard.ts`, hands text to `pbcopy`, `wl-copy`, `xclip` or `xsel` on stdin. `addDevice` and `join` in `packages/cli/src/commands/sync.ts` use both. The pairing protocol, the pairing ID and the fingerprint confirmation don't change, so the server sees exactly what it sees today.

**Tech Stack:** TypeScript on Bun 1.4.2, `bun:test`, `node:crypto`. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-13-easy-sync-design.md` §7 and §12 (join value), §11 (build order: this PR defines the pin field before anything sets a pin). It updates sync spec `docs/superpowers/specs/2026-11-08-sync-between-devices-design.md` §7.1, §10 and §13 question 2.

## Global Constraints

- The value's prefix is `ks1-`. It carries one or more server URLs, the certificate pin when there is one, and the 120-bit pairing secret. The pairing ID is still `pairingIdOf(secret)`.
- The value is copy-safe in a terminal: no spaces and no shell-special characters.
- The value is a secret for its 10 minutes. It is never logged, and never passed to another process on the command line. The clipboard tool gets it on stdin.
- `ks sync join <url> <code>` keeps working, so a 0.4.0 device can join from an older one.
- The fingerprint confirmation of sync spec §7.1 is unchanged.
- Nothing in 0.4.0's #108 sets a pin. A value that carries one is refused until #112 adds the pin check, so a pin is never accepted and then ignored.
- Tests never touch the real clipboard. They never print a secret, and they clean up every temporary home.
- Copy uses `cliName()` for the command name. Status lines that aren't errors go through `console.log`, as the rest of `sync.ts` does.
- Every user-visible change gets a line in `CHANGELOG.md`'s unreleased section, and the website and README copy match the CLI source (AGENTS.md).

## Decisions for the maintainer

- **Encoding.** `ks1-` followed by unpadded base64url of a small binary record (Task 1), not base32: about 70 characters for one URL instead of about 85. base64url uses only letters, digits, `-` and `_`, and the value never starts with `-`, so it is safe as a shell word.
- **A checksum.** The record ends with 4 bytes of SHA-256 over the rest, so a value cut short by a bad copy is refused as incomplete rather than read as a shorter URL.
- **Several URLs.** The record holds up to four URLs in order of preference, for the local name and LAN IP of a home server (easy-sync spec §4). `add-device` writes one today. `join` tries them in order, moving on only when a server can't be reached, and saves the one that answered.

## Review Focus

1. **A value split by spaces** (a terminal wrap pasted as an argument, or the whole `ks sync join` line pasted at the prompt) still parses. A value cut at a hard line break at the hidden prompt arrives cut, because the prompt submits at the first line break; it is refused as incomplete and never sent. Test: Task 1, `pasted text with the command and a line break parses`.
2. **A value cut short by a bad copy.** It is refused as incomplete, never read as a shorter URL or secret, and no request is made. Tests: Task 1, `a truncated value is malformed`; Task 3, `join refuses a bad value before any request`.
3. **A value from a newer Kerstel** (`ks2-…`). It says to update this device, not that the value is wrong. Test: Task 1, `a newer version is reported as newer`.
4. **A value whose URL is not one Kerstel sends a vault to** (`http://` to another machine, or a URL with a password in it). It is refused before any request. Test: Task 3, `join refuses a bad value before any request`.
5. **A clipboard tool that fails or hangs** (`xclip` with no X server, `wl-copy` with no compositor). `add-device` carries on, says nothing about the clipboard, and never puts the value on a command line. Tests: Task 2, `a failing tool reports false`, `the text goes on stdin, never in argv`.

---

### Task 1: Encode and parse the join value

**Files:**
- Create: `packages/cli/src/sync/join-value.ts`
- Test: `packages/cli/test/sync-join-value.test.ts`

**Interfaces:**
- Consumes: `PAIRING_SECRET_BYTES` (export it from `sync/crypto.ts` if it isn't), `parsePairingCode` from `sync/crypto.ts`, `normaliseServerUrl` from `sync/state.ts`.
- Produces:
  - `interface JoinValue { urls: string[]; pin: Buffer | null; secret: Buffer }`. `pin` is the 32-byte SHA-256 of the server certificate's public key (SPKI), which #112 defines.
  - `JOIN_PREFIX = "ks1-"`
  - `encodeJoinValue(v: JoinValue): string`. Throws on 0 or more than 4 URLs, a URL containing `\n`, a secret that isn't `PAIRING_SECRET_BYTES` long, or a pin that isn't 32 bytes.
  - `parseJoinValue(text: string): JoinValue | "malformed" | "newer"`
  - `type JoinInput = JoinValue | { error: "malformed" | "newer" | "empty" }`
  - `parseJoinInput(words: string[]): JoinInput`. `words` are the arguments after `join`, or a pasted line split on whitespace. It drops leading `ks`, `kerstel`, `sync` and `join` words. One remaining word, or several that together start with `ks` and a digit, is a join value: the words are joined with nothing between them, so a value the terminal wrapped still parses. Exactly two words where the first parses as a URL and the second as a pairing code is the old form, giving `{ urls: [normaliseServerUrl(url)], pin: null, secret }`. Nothing left is `empty`. Anything else is `malformed`.

The record, before base64url:

```
byte 0        flags: bit 0 set when a pin follows; any other bit set is malformed
15 bytes      the pairing secret
32 bytes      the pin, only when bit 0 is set
n bytes       the URLs, UTF-8, joined with "\n"; at least one, at most four
4 bytes       the first 4 bytes of SHA-256 over everything above
```

`parseJoinValue` trims whitespace and matches the prefix case-insensitively. `ks` followed by a version number other than 1 is `newer` when the number is greater than 1, and `malformed` otherwise. A bad base64url character, a short record, a checksum mismatch, a flag bit it doesn't know, or a URL list with an empty entry or more than four entries is `malformed`. It does not judge whether a URL is safe; `join` does that (Task 3).

- [ ] **Step 1: Write the failing tests** in `sync-join-value.test.ts`:
  - `round trip without a pin`: `parseJoinValue(encodeJoinValue({ urls: ["https://sync.example.com"], pin: null, secret }))` equals the input, the value starts with `ks1-`, matches `/^ks1-[A-Za-z0-9_-]+$/`, and is under 80 characters.
  - `round trip with a pin and two URLs`: `urls: ["https://homebox.local:8787", "https://192.168.1.20:8787"]` and a 32-byte pin come back equal and in order.
  - `a truncated value is malformed`: dropping the last character, the last 4, or everything after the prefix each gives `"malformed"`. So does changing one character in the middle.
  - `a newer version is reported as newer`: `"ks2-AAAA"` gives `"newer"`, and `"ks0-AAAA"` and `"KS-7Q2M"` give `"malformed"`.
  - `an unknown flag is malformed`: a hand-built record with flag byte `0x02` and a correct checksum gives `"malformed"`.
  - `encode refuses bad input`: no URLs, five URLs, a URL with `\n`, a 14-byte secret and a 31-byte pin each throw.
  - `parseJoinInput takes the value, the old form, or nothing`: `[value]` and `["ks", "sync", "join", value]` give the value; `["kerstel", "sync", "join", "https://sync.example.com/", code]` gives `urls: ["https://sync.example.com"]` and the code's secret; `[]` and `["ks", "sync", "join"]` give `{ error: "empty" }`; `["https://x", "nope"]` gives `{ error: "malformed" }`; `["ks2-AAAA"]` gives `{ error: "newer" }`.
  - `pasted text with the command and a line break parses`: `parseJoinInput("ks sync join ks1-abc\ndef\n".split(/\s+/))` with a real value split at character 30 gives the value.
- [ ] **Step 2: Run** `bun test packages/cli/test/sync-join-value.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `join-value.ts`. Use `Buffer.from(body, "base64url")`, and check that re-encoding the decoded bytes gives back `body`, since Node's decoder skips characters it doesn't know.
- [ ] **Step 4: Run** the same command, then `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(sync): encode a pairing as one join value`.

### Task 2: Copy text to the clipboard

**Files:**
- Create: `packages/cli/src/clipboard.ts`
- Modify: `scripts/test-tmpdir.ts` (the test preload)
- Test: `packages/cli/test/clipboard.test.ts`

**Interfaces:**
- Produces:
  - `interface ClipboardDeps { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; which: (cmd: string) => string | null; run: (argv: string[], stdin: string) => number }`
  - `clipboardCommand(deps: Pick<ClipboardDeps, "platform" | "env" | "which">): string[] | null`
  - `copyToClipboard(text: string, deps?: Partial<ClipboardDeps>): boolean`. True only when the tool exits 0. It never throws. The defaults are `process.platform`, `process.env`, `resolveHelper` from `vault/keychain/exec.ts` (root-owned system directories only, never `PATH`), and `Bun.spawnSync` with the text on stdin, stdout and stderr ignored, and a 2-second timeout. When `process.env.KERSTEL_TEST_NO_CLIPBOARD === "1"` and no `run` dep is given, it returns false without running anything.

`clipboardCommand` picks, in order: on `darwin`, `["pbcopy"]`; on `linux`, `["wl-copy"]` when `WAYLAND_DISPLAY` is set and `wl-copy` is found, then, when `DISPLAY` is set, `["xclip", "-selection", "clipboard"]` or `["xsel", "--clipboard", "--input"]`, whichever is found first. Each command's first word is the path `which` returned. Otherwise null.

- [ ] **Step 1: Write the failing tests** in `clipboard.test.ts`, with a fake `which` that knows a set of names and a fake `run` that records calls:
  - `macOS uses pbcopy`, `Wayland uses wl-copy`, `X uses xclip, then xsel`: each expected argv, with the path from `which`.
  - `no display, no clipboard`: on `linux` with neither `WAYLAND_DISPLAY` nor `DISPLAY`, `clipboardCommand` is null and `copyToClipboard` returns false without calling `run`. On `win32` it is null too.
  - `the text goes on stdin, never in argv`: `copyToClipboard("ks sync join ks1-SECRET", …)` calls `run` once, with the text as `stdin` and no argv element containing `ks1-SECRET`.
  - `a failing tool reports false`: `run` returning 1 gives false; `run` throwing gives false.
  - `test runs never copy`: `copyToClipboard("x")` with no deps, under the preload, returns false.
- [ ] **Step 2: Run** `bun test packages/cli/test/clipboard.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `clipboard.ts`, and set `process.env.KERSTEL_TEST_NO_CLIPBOARD = "1"` in `scripts/test-tmpdir.ts` beside the timer guard, with a one-line comment.
- [ ] **Step 4: Run** the same command, then `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `feat(cli): copy text to the clipboard through stdin`.

### Task 3: `add-device` prints the value; `join` takes it

**Files:**
- Modify: `packages/cli/src/commands/sync.ts` (`SyncDeps`, `USAGE`, `addDevice`, `join`)
- Test: `packages/cli/test/sync.test.ts`

**Interfaces:**
- Consumes: `encodeJoinValue`, `parseJoinInput`, `JoinValue` from Task 1; `copyToClipboard` from Task 2.
- Produces: `SyncDeps.clipboard?: (text: string) => boolean`, defaulting to `copyToClipboard`.

Behaviour to implement:
- **`USAGE`** lines become:
  - `` `  ${cliName()} sync add-device              Show a one-time line to pair another device` ``
  - `` `  ${cliName()} sync join [<value>]          Join a synced vault from this device` ``
- **`addDevice`** builds `line = \`${cliName()} sync join ${encodeJoinValue({ urls: [sync.config.server], pin: null, secret })}\``, prints it, and copies it:

  ```
  On the new device, run:

    <line>
    <dim: If the new device runs an older Kerstel, update it first with: <cli> update>

  <dim: [Copied to the clipboard. ]It works once and expires in 10 minutes. Waiting for the new device…>
  ```

  `Copied to the clipboard. ` appears only when `deps.clipboard(line)` returned true. The expiry message becomes `The pairing expired before a device used it. Run <cli> sync add-device for a new one.` and the forged-answer message becomes `A device answered without this pairing's secret, so it was not added. Nothing was changed.`
- **`join`** takes its words from `args`, or, when `args` is empty, from one hidden prompt: `(deps.prompter ?? new ClackPrompter()).text("Paste the line from sync add-device", { secret: true })`, split on whitespace. With no arguments and no terminal (`!isInteractive(deps)`), it fails with `` Usage: <cli> sync join [<value>] `` and returns 2. Any argument that starts with `-` still returns 2 with that usage line. Then `parseJoinInput`:
  - `empty`: the usage line, return 2.
  - `malformed`: `` That is not a join value, or it was cut short. Copy the whole line that <cli> sync add-device shows. ``, return 2.
  - `newer`: `` That join value is from a newer Kerstel. Update this device with <cli> update, then run it again. ``, return 2.
  - A value with `pin !== null`: `` That server pins its certificate, which this version of Kerstel can't check. Update this device with <cli> update. ``, return 2. (#112 replaces this branch with the pin check.)
  - Any URL failing `isSafeServerUrl`: today's `is not a server Kerstel will send your vault to` message for that URL, return 2.
- **Several URLs.** `join` answers the pairing slot at each URL in order and moves to the next only on a `SyncHttpError` with code `unreachable`. The first one that answers is the `server` it saves and polls. If none answers, it fails with the last error, as today.
- The rest of `join` (fingerprint, confirmation check, merge, `schedule`) is unchanged. The old `KS-…` messages that name "the code" change to "the pairing", so they read right for both forms: `That pairing expired or was already used. …` and `The pairing expired, or the other device said no. Nothing was changed.`

- [ ] **Step 1: Update the helpers and write the failing tests** in `sync.test.ts`. Change `pairUp` and the other two places that scrape `KS-…` from the output to scrape `/ks1-[A-Za-z0-9_-]+/` and join with `["join", value]`, and pass `clipboard: () => false` to `add-device` unless a test sets it. Add:
  - `add-device prints one line and copies it`: with `clipboard` recording its argument, the output has exactly one line matching `sync join ks1-`, the recorded text equals that line trimmed, and the output contains `Copied to the clipboard.` and `update it first with`.
  - `without a clipboard it says nothing about one`: with `clipboard: () => false`, the output doesn't contain `clipboard`.
  - `join takes the value pasted at a hidden prompt`: `join` with no args, `interactive: true` and a `ScriptedPrompter` answering the whole `kerstel sync join ks1-…` line pairs as `pairUp` does, and `prompter.asked` is `["Paste the line from sync add-device"]`.
  - `join still takes a URL and a code`: decode the printed value with `parseJoinValue`, then join with `["join", value.urls[0], pairingCode(value.secret)]`. It pairs.
  - `join refuses a bad value before any request`: with a `fetch` that records calls, each of `["join"]` (no terminal), `["join", "ks1-AAAA"]`, `["join", "ks2-AAAA"]`, a valid value whose URL is `http://sync.example.com`, and a valid value with a pin returns 2, makes no request, and leaves sync off. The output for `ks2-` contains `from a newer Kerstel`, and for the pinned value `pins its certificate`.
  - `join tries the next address when one can't be reached`: a value with `urls: ["http://127.0.0.1:1", SERVER]` and a `fetch` that throws for port 1 and passes through to the test server otherwise pairs, and `loadSync(...).server` is `SERVER`.
  - In the existing `add-device needs a terminal, and join refuses a bad code or URL` test, keep the `KS-NOPE` and bad-URL cases for the old form.
- [ ] **Step 2: Run** `bun test packages/cli/test/sync.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the behaviour above.
- [ ] **Step 4: Run** `bun test packages/cli/test/sync.test.ts`, then `bun run typecheck`. Expected: PASS. Check that no test output contains `ks1-` (`bun test packages/cli/test/sync.test.ts 2>&1 | grep -c ks1-` prints `0`).
- [ ] **Step 5: Commit** with the message `feat(sync): pair a device with one pasted value`.

### Task 4: Copy, specs, changelog and roadmap

**Files:**
- Modify: `apps/website/src/pages/docs/sync.md` ("Add a device")
- Modify: `apps/website/src/pages/docs/cli.md` (the `sync add-device` and `sync join` rows)
- Modify: `README.md` (the `ks sync add-device / ks sync join` line)
- Modify: `docs/superpowers/specs/2026-11-08-sync-between-devices-design.md` §7.1, §10 and §13 question 2
- Modify: `CHANGELOG.md` (the top unreleased section)
- Modify: `ROADMAP.md` (tick the #108 line)
- Regenerate: `docs/` with `bun run --cwd apps/website build`

- [ ] **Step 1: Rewrite "Add a device" in `sync.md`.** `add-device` prints one `kerstel sync join ks1-…` line and copies it to the clipboard when it can (`pbcopy`, `wl-copy`, `xclip` or `xsel`). On the new device, paste it as a command, or run `kerstel sync join` and paste it at the hidden prompt. It works once and expires in 10 minutes, so treat it as a secret until then. `kerstel sync join <url> <code>` still works, for pairing from a device on 0.3. A device older than 0.4.0 can't read the value: update it first. Keep the fingerprint paragraph and the merge paragraph as they are.
- [ ] **Step 2: Update `cli.md` and `README.md`** to match: `kerstel sync add-device` shows a `kerstel sync join ks1-…` line and copies it; `kerstel sync join [<value>]` takes it as an argument or at a hidden prompt, or a URL and code from an older device. Check each message against Task 3's source.
- [ ] **Step 3: Update the sync spec.** In §7.1, replace the `add-device` example with the new output and describe the value (prefix, contents, checksum, encoding), the hidden prompt and the old form. In §10, the `join` row becomes `` `ks sync join [<value>]` `` and `add-device` "Show a one-time join line and confirm the new device". In §13 question 2, add that 0.4.0 put the URL and the secret in one value, and short codes stay open.
- [ ] **Step 4: Add `CHANGELOG.md` lines** in the top unreleased section.
  - Under Added: ``Pair a device by pasting one value. `kerstel sync add-device` prints one `kerstel sync join ks1-…` line and copies it to the clipboard when it can, and `kerstel sync join` takes it as an argument or, with no arguments, at a hidden prompt. The fingerprint check is unchanged. A device on an older Kerstel can't read the value, so update it first; `kerstel sync join <url> <code>` still works for pairing from an older device. See [Sync](https://kerstel.dev/docs/sync).``
- [ ] **Step 5: Tick the #108 line** in `ROADMAP.md`.
- [ ] **Step 6: Run** `bun run --cwd apps/website build`, then `bun run test` and `bun run typecheck`. Expected: PASS, with `docs/` regenerated.
- [ ] **Step 7: Commit** with the message `docs(sync): pair with one value`, then open the PR as `feat(sync): pair a device with one pasted value` with `Closes #108` in the body.
