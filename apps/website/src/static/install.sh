#!/usr/bin/env bash
# Kerstel installer. https://kerstel.dev
#
#   curl -fsSL https://kerstel.dev/install.sh | bash
#
# Environment:
#   KERSTEL_VERSION        install this version (e.g. 0.1.0) instead of the latest
#   KERSTEL_INSTALL_DIR    install here instead of ~/.local/bin
#   KERSTEL_DOWNLOAD_BASE  download from here instead of GitHub Releases
#   NO_COLOR               print without colour
#
# Everything is inside main(), called on the last line, so a download cut off
# halfway cannot run half a script. It never uses sudo, never edits a shell
# profile, and never touches ~/.kerstel.
set -euo pipefail

REPO_URL="https://github.com/alilibx/kerstel"
DOCS_URL="https://kerstel.dev/docs/getting-started"
TMP_DIR=""
STAGED=""

# Colour and the progress bar need a terminal on stdout. Piped into a log
# (CI, `| tee`), every line below prints plain and once.
TTY=0
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then TTY=1; fi
paint() { # paint <sgr> <text>
  if [ "$TTY" = 1 ]; then printf '\033[%sm%s\033[0m' "$1" "$2"; else printf '%s' "$2"; fi
}
accent() { paint 32 "$1"; }
green() { paint 32 "$1"; }
dim() { paint 2 "$1"; }
bold() { paint 1 "$1"; }

say() { printf '%s\n' "$*"; }
ok() { printf '  %s %s\n' "$(green "✓")" "$*"; }
note() { printf '  %s %s\n' "$(dim "·")" "$*"; }
die() {
  printf 'kerstel install: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
  # A copy that failed partway leaves the hidden staged file next to the
  # destination. After a successful rename it no longer exists.
  if [ -n "$STAGED" ]; then rm -f "$STAGED"; fi
}

unsupported() {
  die "$1 is not supported yet. Build from source instead: ${REPO_URL}#build-from-source"
}

detect_asset() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) os="darwin" ;;
    Linux)
      os="linux"
      # musl's ldd exits 1 on --version, so capture its output rather than
      # piping it: under pipefail the pipe would fail even when grep matches.
      local ldd_out=""
      if command -v ldd >/dev/null 2>&1; then ldd_out="$(ldd --version 2>&1 || true)"; fi
      if [ -f /etc/alpine-release ] || printf '%s' "$ldd_out" | grep -qi musl; then
        unsupported "musl-based Linux (such as Alpine)"
      fi
      ;;
    *) unsupported "$os" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) unsupported "$os on $arch" ;;
  esac
  # A shell running under Rosetta reports x86_64 on Apple silicon.
  if [ "$os" = "darwin" ] && [ "$arch" = "x64" ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    arch="arm64"
  fi
  printf 'kerstel-%s-%s' "$os" "$arch"
}

# The asset name in words, for the download line.
platform_name() {
  case "$1" in
    kerstel-darwin-arm64) printf 'macOS (Apple Silicon)' ;;
    kerstel-darwin-x64) printf 'macOS (Intel)' ;;
    kerstel-linux-x64) printf 'Linux (x64)' ;;
    kerstel-linux-arm64) printf 'Linux (arm64)' ;;
    *) printf '%s' "$1" ;;
  esac
}

download_base() {
  if [ -n "${KERSTEL_DOWNLOAD_BASE:-}" ]; then
    printf '%s' "${KERSTEL_DOWNLOAD_BASE%/}"
  elif [ -n "${KERSTEL_VERSION:-}" ]; then
    printf '%s/releases/download/v%s' "$REPO_URL" "${KERSTEL_VERSION#v}"
  else
    printf '%s/releases/latest/download' "$REPO_URL"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "needs sha256sum or shasum to verify the download"
  fi
}

# "41.2 MB" or "312 KB", from a byte count.
human_size() {
  awk -v b="$1" 'BEGIN { if (b >= 1048576) printf "%.1f MB", b / 1048576; else printf "%d KB", b / 1024 }'
}

# Downloads $1 to $2. On a terminal, with a known size, it draws a bar from how
# much of the file has arrived; otherwise it prints one plain line. Failure
# still aborts before anything is installed.
download_with_progress() {
  local url="$1" dest="$2" total="$3" width=30 got filled pct
  if [ "$TTY" != 1 ] || [ -z "$total" ] || [ "$total" -le 0 ]; then
    curl -fsSL "$url" -o "$dest" || return 1
    return 0
  fi
  curl -fsSL "$url" -o "$dest" &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    got=0
    if [ -f "$dest" ]; then got=$(wc -c <"$dest" | tr -d ' '); fi
    if [ "$got" -gt "$total" ]; then got=$total; fi
    pct=$((got * 100 / total))
    filled=$((got * width / total))
    printf '\r  %s %3d%%  %s / %s' "$(accent "$(bar_of "$filled" "$width")")" "$pct" "$(human_size "$got")" "$(human_size "$total")"
    sleep 0.1
  done
  wait "$pid" || { printf '\r\033[2K'; return 1; }
  printf '\r  %s 100%%  %s / %s\n' "$(accent "$(bar_of "$width" "$width")")" "$(human_size "$total")" "$(human_size "$total")"
}

# $1 filled cells out of $2. Built by concatenation, not `tr`, because `tr`
# works on bytes and would shred a multibyte block character under the C locale
# that `curl | bash` often runs in.
bar_of() {
  local filled="$1" width="$2" i=0 out=""
  while [ "$i" -lt "$width" ]; do
    if [ "$i" -lt "$filled" ]; then out="${out}█"; else out="${out}░"; fi
    i=$((i + 1))
  done
  printf '%s' "$out"
}

# HEAD the asset once: the last Content-Length is the file's size (after any
# redirect), and a redirect through /releases/download/v<x>/ names the version
# when it was not pinned. Both are optional: without them the download still
# works, just without a bar or a version in the line above it.
probe_asset() { # sets ASSET_SIZE and ASSET_VERSION
  local headers
  headers="$(curl -sIL "$1" 2>/dev/null | tr -d '\r' || true)"
  ASSET_SIZE="$(printf '%s\n' "$headers" | awk 'tolower($1) == "content-length:" { size = $2 } END { print size }')"
  ASSET_VERSION="$(printf '%s\n' "$headers" | grep -o '/releases/download/v[^/]*' | head -1 | sed 's|.*/v||' || true)"
}

path_hint() {
  local dir="$1"
  case ":${PATH}:" in
    *":${dir}:"*) return 0 ;;
  esac
  say ""
  say "  $(bold "${dir} is not on your PATH.") Add it with:"
  case "${SHELL:-}" in
    */zsh) say "    echo 'export PATH=\"${dir}:\$PATH\"' >> ~/.zshrc" ;;
    */fish) say "    fish_add_path ${dir}" ;;
    *) say "    echo 'export PATH=\"${dir}:\$PATH\"' >> ~/.bashrc" ;;
  esac
  say "  Then open a new terminal."
}

# Links ks -> kerstel next to the binary, never over someone else's ks. A
# failure here is never fatal: kerstel is already installed and works.
link_shortcut() {
  local dir="$1" found
  if [ -L "${dir}/ks" ]; then
    case "$(readlink "${dir}/ks")" in
      kerstel | "${dir}/kerstel")
        if ln -sf kerstel "${dir}/ks" 2>/dev/null; then
          ok "Shortcut: ks (linked to kerstel)"
        else
          note "could not create ${dir}/ks, so use kerstel"
        fi
        return
        ;;
    esac
  fi
  if [ -e "${dir}/ks" ] || [ -L "${dir}/ks" ]; then
    note "ks is already taken by ${dir}/ks, so use kerstel"
    return
  fi
  found="$(command -v ks 2>/dev/null || true)"
  if [ -n "$found" ]; then
    note "ks is already taken by ${found}, so use kerstel"
    return
  fi
  if ln -s kerstel "${dir}/ks" 2>/dev/null; then
    ok "Shortcut: ks (linked to kerstel)"
  else
    note "could not create ${dir}/ks, so use kerstel"
  fi
}

# ~/.local/bin/kerstel rather than /Users/me/.local/bin/kerstel.
tilde() {
  case "$1" in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

main() {
  command -v curl >/dev/null 2>&1 || die "needs curl"

  local asset base dir expected actual version label cmd
  asset="$(detect_asset)"
  base="$(download_base)"
  dir="${KERSTEL_INSTALL_DIR:-$HOME/.local/bin}"

  say ""
  say "  $(accent "◆") $(bold "Kerstel installer")"
  say ""
  if [ -n "${KERSTEL_DOWNLOAD_BASE:-}" ]; then note "Downloading from ${base}"; fi

  TMP_DIR="$(mktemp -d)"
  trap cleanup EXIT

  ASSET_SIZE=""
  ASSET_VERSION="${KERSTEL_VERSION:-}"
  probe_asset "${base}/${asset}"
  label="kerstel"
  if [ -n "$ASSET_VERSION" ]; then label="kerstel ${ASSET_VERSION#v}"; fi
  say "  Downloading ${label} for $(platform_name "$asset")"
  download_with_progress "${base}/${asset}" "${TMP_DIR}/kerstel" "$ASSET_SIZE" ||
    die "could not download ${base}/${asset}"
  curl -fsSL "${base}/SHA256SUMS" -o "${TMP_DIR}/SHA256SUMS" || die "could not download ${base}/SHA256SUMS"

  expected="$(awk -v name="$asset" '$2 == name {print $1}' "${TMP_DIR}/SHA256SUMS")"
  [ -n "$expected" ] || die "SHA256SUMS has no entry for ${asset}; nothing was installed"
  actual="$(sha256_of "${TMP_DIR}/kerstel")"
  [ "$expected" = "$actual" ] || die "checksum mismatch for ${asset}; nothing was installed"
  ok "Checksum verified"

  # Stage next to the destination, then rename: an upgrade swaps the file in
  # one step, even when the temp directory is on another filesystem.
  mkdir -p "$dir"
  STAGED="${dir}/.kerstel-install.$$"
  cp "${TMP_DIR}/kerstel" "$STAGED" || die "could not write to ${dir}; nothing was installed"
  chmod 755 "$STAGED"
  mv -f "$STAGED" "${dir}/kerstel"

  version="$("${dir}/kerstel" --version)" || die "installed ${dir}/kerstel, but it did not run"
  ok "Installed kerstel ${version} to $(tilde "${dir}/kerstel")"
  link_shortcut "$dir"
  path_hint "$dir"

  cmd="kerstel"
  if [ -L "${dir}/ks" ] && [ "$(readlink "${dir}/ks")" = "kerstel" ]; then
    cmd="ks"
  fi

  say ""
  say "  $(bold "What Kerstel does")"
  say "  Your .env files keep only kerstel:// references. The real values live in"
  say "  an encrypted vault on this machine, and your scripts read them as usual."
  say ""
  say "  $(bold "Next steps")"
  say "  1. cd into a project and run:  ${cmd} init"
  say "  2. Run your app as usual:      npm run dev"
  say "  3. Check everything any time:  ${cmd} doctor"
  say ""
  say "  $(dim "Docs: ${DOCS_URL}")"
  say ""
}

main "$@"
