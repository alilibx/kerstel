#!/usr/bin/env bash
# Kerstel installer. https://kerstel.dev
#
#   curl -fsSL https://kerstel.dev/install.sh | bash
#
# Environment:
#   KERSTEL_VERSION        install this version (e.g. 0.1.0) instead of the latest
#   KERSTEL_INSTALL_DIR    install here instead of ~/.local/bin
#   KERSTEL_DOWNLOAD_BASE  download from here instead of GitHub Releases
#
# Everything is inside main(), called on the last line, so a download cut off
# halfway cannot run half a script. It never uses sudo, never edits a shell
# profile, and never touches ~/.kerstel.
set -euo pipefail

REPO_URL="https://github.com/alilibx/kerstel"
TMP_DIR=""

say() { printf '%s\n' "$*"; }
die() {
  printf 'kerstel install: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
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
      if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then
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

path_hint() {
  local dir="$1"
  case ":${PATH}:" in
    *":${dir}:"*) return 0 ;;
  esac
  say ""
  say "${dir} is not on your PATH. Add it with:"
  case "${SHELL:-}" in
    */zsh) say "  echo 'export PATH=\"${dir}:\$PATH\"' >> ~/.zshrc" ;;
    */fish) say "  fish_add_path ${dir}" ;;
    *) say "  echo 'export PATH=\"${dir}:\$PATH\"' >> ~/.bashrc" ;;
  esac
  say "Then open a new terminal."
}

main() {
  command -v curl >/dev/null 2>&1 || die "needs curl"

  local asset base dir expected actual version staged
  asset="$(detect_asset)"
  base="$(download_base)"
  dir="${KERSTEL_INSTALL_DIR:-$HOME/.local/bin}"
  if [ -n "${KERSTEL_DOWNLOAD_BASE:-}" ]; then say "Downloading from ${base}"; fi

  TMP_DIR="$(mktemp -d)"
  trap cleanup EXIT

  say "Downloading ${asset}..."
  curl -fsSL "${base}/${asset}" -o "${TMP_DIR}/kerstel" || die "could not download ${base}/${asset}"
  curl -fsSL "${base}/SHA256SUMS" -o "${TMP_DIR}/SHA256SUMS" || die "could not download ${base}/SHA256SUMS"

  expected="$(awk -v name="$asset" '$2 == name {print $1}' "${TMP_DIR}/SHA256SUMS")"
  [ -n "$expected" ] || die "SHA256SUMS has no entry for ${asset}; nothing was installed"
  actual="$(sha256_of "${TMP_DIR}/kerstel")"
  [ "$expected" = "$actual" ] || die "checksum mismatch for ${asset}; nothing was installed"

  # Stage next to the destination, then rename: an upgrade swaps the file in
  # one step, even when the temp directory is on another filesystem.
  mkdir -p "$dir"
  staged="${dir}/.kerstel-install.$$"
  cp "${TMP_DIR}/kerstel" "$staged"
  chmod 755 "$staged"
  mv -f "$staged" "${dir}/kerstel"

  version="$("${dir}/kerstel" --version)" || die "installed ${dir}/kerstel, but it did not run"
  say "Installed kerstel ${version} to ${dir}/kerstel"
  path_hint "$dir"
  say ""
  say "Next: run 'kerstel doctor', then 'kerstel init' inside a project."
}

main "$@"
