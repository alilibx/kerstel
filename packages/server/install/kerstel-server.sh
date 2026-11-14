#!/bin/sh
# kerstel-server.sh: sets up kerstel-server, the Kerstel sync server, on this
# host, with Docker or as a service, and later updates, stops or removes it.
#
#   sh kerstel-server.sh detect
#   sh kerstel-server.sh install --version <v> --install-id <id> --runtime docker|service
#        --reach self|domain|tailscale [--name <address>]... [--domain <name>]
#        [--port <port>] [--releases-url <url>] [--url <url>]...
#   sh kerstel-server.sh info
#   sh kerstel-server.sh value --url <url>...
#   sh kerstel-server.sh update --version <v> [--releases-url <url>] [--install-id <id>]
#   sh kerstel-server.sh stop [--install-id <id>]
#   sh kerstel-server.sh remove [--delete-data] [--install-id <id>]
#
# With --install-id, update, stop and remove act only on the server with that
# install ID, and exit 3 when the host runs another.
#
# Kerstel runs it over SSH or on this machine, or prints a command that
# downloads it, checks its SHA-256 and runs it. It never handles the enroll
# token: kerstel-server makes it on first start, and `kerstel-server value`
# reads it from its file to print the server value. So no token is ever an
# argument of any process.
#
# Docker: container kerstel-server, volume kerstel-server mounted at /data,
# restarted unless stopped, both labelled dev.kerstel.install-id. A
# kerstel-server volume without that label, or a container from the image
# that is not ours, is a server someone started by hand: nothing here touches
# it. A service keeps
# everything in ~/.kerstel-server and runs as this user, from
# /etc/systemd/system/kerstel-server.service on Linux or
# /Library/LaunchDaemons/dev.kerstel.server.plist on macOS.
#
# Progress goes to stderr, each line starting with "kerstel-server.sh: ".
# What a command reports (detect, info, the server value) goes to stdout.
# Exit codes: 0 done, 1 failed, 2 usage, 3 another device's server is here.
set -eu
umask 077

ME="kerstel-server.sh"
IMAGE_REPO="ghcr.io/alilibx/kerstel-server"
# A container's image is from IMAGE_REPO: the name, then a tag or a digest.
IMAGE_RE='^ghcr\.io/alilibx/kerstel-server([:@]|$)'
CONTAINER="kerstel-server"
VOLUME="kerstel-server"
LABEL="dev.kerstel"
LAUNCHD_LABEL="dev.kerstel.server"
DEFAULT_RELEASES_URL="https://github.com/alilibx/kerstel"
# Test-only: the installer tests set this to a temporary directory, so the
# files this script writes outside HOME (/etc/systemd/system,
# /Library/LaunchDaemons) and the systemd check (/run/systemd/system) happen
# under it. Never set it on a real host. Anything but an absolute path is ignored.
ROOT=""
case "${KERSTEL_INSTALL_ROOT:-}" in
  /*) ROOT="$KERSTEL_INSTALL_ROOT" ;;
esac
KH="$HOME/.kerstel-server"
UNIT="$ROOT/etc/systemd/system/kerstel-server.service"
PLIST="$ROOT/Library/LaunchDaemons/$LAUNCHD_LABEL.plist"

# What an error leaves behind, printed after the error. Each step that
# changes the host updates it.
LEFT="Nothing on this host was changed."
TMP=""
DOCKER_SUDO=""
SUDO_SAID=""
OS=""
ARCH=""
FOUND_RUNTIME=""
FOUND_ID=""
NAMED_CONTAINER=""
EXPECT_ID=""
VERSION=""
INSTALL_ID=""
RUNTIME=""
REACH=""
NAMES=""
DOMAIN=""
PORT="8787"
URLS=""
URL_COUNT=0
RELEASES_URL="$DEFAULT_RELEASES_URL"
CURL_PROTO="=https"
TS_NAME=""
VALUE=""
BINARY_CHANGED="no"
SERVICE_CHANGED="no"
DELETE_DATA="no"

say() { printf '%s: %s\n' "$ME" "$*" >&2; }
die() {
  say "$*"
  exit 1
}
usage_error() {
  say "$* Run: sh $ME detect|install|info|value|update|stop|remove [options]"
  exit 2
}

# Exits 3: the server here is not one this device, as this user, may change.
another_devices() {
  say "this host already runs a Kerstel server that another device set up."
  exit 3
}

on_exit() {
  code=$?
  if [ -n "$TMP" ]; then rm -rf "$TMP"; fi
  if [ "$code" -ne 0 ]; then say "$LEFT"; fi
}

# matches <ERE> <text>: the whole text is one line, and it matches.
matches() {
  case "$2" in
    *"
"*) return 1 ;;
  esac
  printf '%s\n' "$2" | grep -Eq "$1"
}

# need <args left> <option>: the option has a value after it.
need() {
  if [ "$1" -lt 2 ]; then usage_error "$2 needs a value."; fi
}

is_root() { [ "$(id -u)" = 0 ]; }

# Run through sudo with the user's HOME, this would leave root-owned files in
# it and a service running as root. The script asks for sudo itself.
refuse_sudo() {
  root_home=~root
  if is_root && [ -n "${SUDO_USER:-}" ] && [ "$HOME" != "$root_home" ]; then
    die "Run this as $SUDO_USER, without sudo. It asks for sudo itself when a step needs it."
  fi
}

# Runs a command as root: directly when this is root, through sudo otherwise.
as_root() {
  if is_root; then
    "$@"
  else
    command -v sudo >/dev/null 2>&1 || die "This step needs root, and sudo is not installed. Run this as root."
    sudo "$@"
  fi
}

# Says once, before the first sudo prompt, which step needs it and why.
explain_sudo() {
  if is_root || [ -n "$SUDO_SAID" ]; then return 0; fi
  say "$1"
  SUDO_SAID="yes"
}

# ---------------------------------------------------------------------------
# The host

os_arch() {
  case "$(uname -s)" in
    Linux) OS="linux" ;;
    Darwin) OS="darwin" ;;
    *) OS="$(uname -s | tr '[:upper:]' '[:lower:]')" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) ARCH="x64" ;;
    arm64 | aarch64) ARCH="arm64" ;;
    *) ARCH="$(uname -m)" ;;
  esac
  # A shell running under Rosetta reports x86_64 on Apple silicon.
  if [ "$OS" = darwin ] && [ "$ARCH" = x64 ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    ARCH="arm64"
  fi
}

check_supported() {
  case "$OS-$ARCH" in
    linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64) ;;
    *) die "kerstel-server runs on Linux and macOS, on x64 and arm64. This host is $OS $ARCH." ;;
  esac
}

has_systemd() { [ -d "$ROOT/run/systemd/system" ]; }

# The host's name, without the .local that macOS adds.
host_name() {
  name="$(hostname 2>/dev/null || uname -n)"
  printf '%s\n' "${name%.local}"
}

# One IPv4 address per line, without loopback.
ipv4s() {
  if command -v ip >/dev/null 2>&1; then
    ip -4 -o addr show 2>/dev/null |
      awk '{ for (i = 1; i < NF; i++) if ($i == "inet") { split($(i + 1), a, "/"); print a[1] } }'
  elif command -v ifconfig >/dev/null 2>&1; then
    ifconfig 2>/dev/null | awk '$1 == "inet" { sub(/^addr:/, "", $2); print $2 }'
  fi | grep -v '^127\.' || true
}

# This host's name on the tailnet, without the final dot. Fails when
# Tailscale is not installed, not running or has no name.
tailscale_name() {
  command -v tailscale >/dev/null 2>&1 || return 1
  status="$(tailscale status --json --peers=false 2>/dev/null)" || return 1
  printf '%s\n' "$status" | grep -Eq '"BackendState": *"Running"' || return 1
  name="$(printf '%s\n' "$status" | sed -n 's/.*"DNSName": *"\([^"]*\)".*/\1/p' | head -n 1)"
  name="${name%.}"
  [ -n "$name" ] || return 1
  printf '%s\n' "$name"
}

# ---------------------------------------------------------------------------
# Docker

dk() {
  if [ "$DOCKER_SUDO" = yes ]; then sudo docker "$@"; else docker "$@"; fi
}

# Whether Docker answers, as this user or through sudo. $1 names the step,
# for the line that says why sudo is needed before it asks.
docker_access() {
  case "$DOCKER_SUDO" in
    no | yes) return 0 ;;
    broken) return 1 ;;
  esac
  if docker info >/dev/null 2>&1; then
    DOCKER_SUDO="no"
    return 0
  fi
  if ! is_root && command -v sudo >/dev/null 2>&1; then
    say "$1 needs sudo, because your user cannot reach the Docker daemon."
    if sudo docker info >/dev/null; then
      DOCKER_SUDO="yes"
      return 0
    fi
  fi
  DOCKER_SUDO="broken"
  return 1
}

# The same without ever asking for a password.
docker_access_quiet() {
  case "$DOCKER_SUDO" in
    no | yes) return 0 ;;
    broken) return 1 ;;
  esac
  if docker info >/dev/null 2>&1; then
    DOCKER_SUDO="no"
    return 0
  fi
  if ! is_root && command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    DOCKER_SUDO="yes"
    return 0
  fi
  return 1
}

# "<image>|<reach>|<port>|<names>|<domain>|<running>" of the container.
docker_current() {
  dk container inspect --format "{{.Config.Image}}|{{index .Config.Labels \"$LABEL.reach\"}}|{{index .Config.Labels \"$LABEL.port\"}}|{{index .Config.Labels \"$LABEL.names\"}}|{{index .Config.Labels \"$LABEL.domain\"}}|{{.State.Running}}" "$CONTAINER"
}

load_docker_settings() {
  current="$(docker_current)"
  IFS='|' read -r CURRENT_IMAGE REACH PORT NAMES DOMAIN CURRENT_RUNNING <<EOF
$current
EOF
  if [ -z "$PORT" ]; then PORT="8787"; fi
}

docker_running() {
  [ "$(dk container inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ]
}

ensure_image() {
  if dk image inspect "$1" >/dev/null 2>&1; then return 0; fi
  say "Pulling $1."
  dk pull "$1" >/dev/null || die "Could not pull $1."
}

# Starts the container from image $1 with the settings in REACH, PORT, NAMES
# and DOMAIN, which it also keeps as labels for update.
docker_run() {
  # Labelled, so a later install knows the data is from this installer.
  if ! dk volume inspect "$VOLUME" >/dev/null 2>&1; then
    dk volume create --label "$LABEL.install-id=$INSTALL_ID" "$VOLUME" >/dev/null
  fi
  set -- run -d --name "$CONTAINER" --restart unless-stopped \
    --label "$LABEL.install-id=$INSTALL_ID" --label "$LABEL.reach=$REACH" --label "$LABEL.port=$PORT" \
    --label "$LABEL.names=$NAMES" --label "$LABEL.domain=$DOMAIN" \
    -v "$VOLUME:/data" -e KERSTEL_SERVER_ENROLL_TOKEN_FILE=/data/enroll-token
  case "$REACH" in
    self)
      set -- "$@" -p "$PORT:8787" -e KERSTEL_SERVER_TLS=self
      if [ -n "$NAMES" ]; then set -- "$@" -e "KERSTEL_SERVER_TLS_NAMES=$NAMES"; fi
      ;;
    domain)
      set -- "$@" -p 80:80 -p 443:443 -e "KERSTEL_SERVER_DOMAIN=$DOMAIN" -e KERSTEL_SERVER_LISTEN=0.0.0.0:443
      ;;
    tailscale)
      set -- "$@" -p "127.0.0.1:$PORT:8787"
      ;;
  esac
  dk "$@" "$IMAGE" >/dev/null
}

# ---------------------------------------------------------------------------
# The service

service_manager() {
  case "$OS" in
    linux) has_systemd || die "This host has no systemd, so kerstel-server cannot run as a service here. Use --runtime docker." ;;
    darwin) ;;
    *) check_supported ;;
  esac
}

setting() {
  if [ -f "$KH/settings" ]; then sed -n "s/^$1=//p" "$KH/settings" | head -n 1; fi
}

load_service_settings() {
  REACH="$(setting reach)"
  PORT="$(setting port)"
  NAMES="$(setting names)"
  DOMAIN="$(setting domain)"
  if [ -z "$PORT" ]; then PORT="8787"; fi
}

# write_file <file> <text>: replaces the file in one step.
write_file() {
  printf '%s\n' "$2" >"$1.new.$$"
  mv -f "$1.new.$$" "$1"
}

# The service's environment, one KEY=VALUE per line. No token: only the
# file that holds it.
service_env() {
  printf 'KERSTEL_SERVER_DB=%s\n' "$KH/kerstel-server.db"
  printf 'KERSTEL_SERVER_ENROLL_TOKEN_FILE=%s\n' "$KH/enroll-token"
  case "$REACH" in
    self)
      printf 'KERSTEL_SERVER_LISTEN=0.0.0.0:%s\n' "$PORT"
      printf 'KERSTEL_SERVER_TLS=self\n'
      if [ -n "$NAMES" ]; then printf 'KERSTEL_SERVER_TLS_NAMES=%s\n' "$NAMES"; fi
      ;;
    domain) printf 'KERSTEL_SERVER_DOMAIN=%s\n' "$DOMAIN" ;;
    tailscale) printf 'KERSTEL_SERVER_LISTEN=127.0.0.1:%s\n' "$PORT" ;;
  esac
}

# Runs the installed binary with the service's settings, as `value` and
# `info` need them.
service_run() {
  (
    unset KERSTEL_SERVER_ENROLL_TOKEN KERSTEL_SERVER_ENROLL_TOKEN_FILE KERSTEL_SERVER_DB \
      KERSTEL_SERVER_LISTEN KERSTEL_SERVER_TLS KERSTEL_SERVER_TLS_NAMES KERSTEL_SERVER_DOMAIN
    while IFS= read -r kv; do export "${kv?}"; done <<EOF
$(service_env)
EOF
    exec "$KH/bin/kerstel-server" "$@"
  )
}

# A value in double quotes, as systemd reads it.
systemd_quote() {
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g')"
}

systemd_unit() {
  printf '%s\n' "[Unit]" "Description=Kerstel sync server" "After=network-online.target" "Wants=network-online.target" "" "[Service]"
  printf 'User=%s\n' "$(id -un)"
  printf 'WorkingDirectory=%s\n' "$(printf '%s' "$KH" | sed 's/%/%%/g')"
  printf 'ExecStart=%s\n' "$(systemd_quote "$KH/bin/kerstel-server")"
  service_env | while IFS= read -r kv; do printf 'Environment=%s\n' "$(systemd_quote "$kv")"; done
  if [ "$REACH" = domain ]; then printf 'AmbientCapabilities=CAP_NET_BIND_SERVICE\n'; fi
  printf '%s\n' "Restart=on-failure" "RestartSec=5" "" "[Install]" "WantedBy=multi-user.target"
}

xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

launchd_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LAUNCHD_LABEL</string>
  <key>UserName</key>
  <string>$(xml "$(id -un)")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$KH/bin/kerstel-server")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml "$KH")</string>
  <key>EnvironmentVariables</key>
  <dict>
$(service_env | while IFS= read -r kv; do printf '    <key>%s</key>\n    <string>%s</string>\n' "$(xml "${kv%%=*}")" "$(xml "${kv#*=}")"; done)
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$(xml "$KH/kerstel-server.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml "$KH/kerstel-server.log")</string>
</dict>
</plist>
EOF
}

service_file() {
  if [ "$OS" = linux ]; then printf '%s' "$UNIT"; else printf '%s' "$PLIST"; fi
}

sudo_reason() {
  if [ "$OS" = linux ]; then
    printf 'Installing the service needs sudo once, because %s belongs to root and systemd starts it.' "$UNIT"
  else
    printf 'Installing the service needs sudo once, because %s belongs to root and launchd starts it.' "$PLIST"
  fi
}

# Writes the unit or plist when it is missing or different. Sets SERVICE_CHANGED.
write_service_file() {
  target="$(service_file)"
  if [ "$OS" = linux ]; then systemd_unit >"$TMP/service"; else launchd_plist >"$TMP/service"; fi
  if [ -f "$target" ] && cmp -s "$TMP/service" "$target"; then
    SERVICE_CHANGED="no"
    return 0
  fi
  explain_sudo "$(sudo_reason)"
  as_root mkdir -p "$(dirname "$target")"
  as_root cp "$TMP/service" "$target"
  as_root chmod 644 "$target"
  SERVICE_CHANGED="yes"
}

service_running() {
  if [ "$OS" = linux ]; then
    systemctl is-active --quiet kerstel-server.service 2>/dev/null
  else
    launchctl print "system/$LAUNCHD_LABEL" 2>/dev/null | grep -q 'state = running'
  fi
}

# Enables the service and (re)starts it when its file or binary changed or it
# is not running, so a rerun leaves a healthy server alone.
start_service() {
  if [ "$SERVICE_CHANGED" = no ] && [ "$BINARY_CHANGED" = no ] && service_running; then
    say "kerstel-server is already running."
    return 0
  fi
  explain_sudo "$(sudo_reason)"
  if [ "$OS" = linux ]; then
    if [ "$SERVICE_CHANGED" = yes ]; then as_root systemctl daemon-reload; fi
    as_root systemctl enable --quiet kerstel-server.service
    as_root systemctl restart kerstel-server.service
    return 0
  fi
  as_root launchctl enable "system/$LAUNCHD_LABEL"
  if launchctl print "system/$LAUNCHD_LABEL" >/dev/null 2>&1; then
    if [ "$SERVICE_CHANGED" = no ]; then
      as_root launchctl kickstart -k "system/$LAUNCHD_LABEL"
      return 0
    fi
    as_root launchctl bootout "system/$LAUNCHD_LABEL"
  fi
  # launchd may still be letting go of the old job for a moment.
  tries=0
  until as_root launchctl bootstrap system "$PLIST"; do
    tries=$((tries + 1))
    if [ "$tries" -ge 5 ]; then die "launchctl could not load $PLIST."; fi
    sleep 1
  done
}

stop_service() {
  if [ "$OS" = linux ]; then
    as_root systemctl disable --now --quiet kerstel-server.service
  else
    if launchctl print "system/$LAUNCHD_LABEL" >/dev/null 2>&1; then
      as_root launchctl bootout "system/$LAUNCHD_LABEL"
    fi
    as_root launchctl disable "system/$LAUNCHD_LABEL"
  fi
}

service_logs_hint() {
  if [ "$OS" = linux ]; then
    printf 'See: journalctl -u kerstel-server'
  else
    printf 'See: %s' "$KH/kerstel-server.log"
  fi
}

# ---------------------------------------------------------------------------
# Downloads

# The scheme curl may use for a releases URL, or nothing when it is refused.
# Plain HTTP would let anyone on the path swap the binary and SHA256SUMS
# together, so it is allowed only to this machine.
proto_for() {
  case "$1" in
    https://*) printf '=https' ;;
    http://*)
      # The host is everything up to the first / ? or #, and must be exactly
      # a loopback name with an optional port: http://localhost:x@evil.example
      # is evil.example to curl.
      authority="${1#http://}"
      authority="${authority%%[/?#]*}"
      if matches '^(127\.0\.0\.1|localhost)(:[0-9]+)?$' "$authority"; then printf '=http'; fi
      ;;
    *) ;;
  esac
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl --proto "$CURL_PROTO" --proto-redir "$CURL_PROTO" -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    if [ "$CURL_PROTO" = "=http" ]; then
      wget -q -O "$2" "$1"
      return
    fi
    # wget documents --https-only for recursive mode, so the headers of every
    # hop are checked too: a redirect to plain HTTP fails the download.
    wget --help 2>&1 | grep -q -- '--https-only' || die "This wget cannot be limited to HTTPS. Install curl, then run this again."
    wget -S --https-only -O "$2" "$1" 2>"$TMP/wget.headers" || return 1
    if grep -Eqi '^ *Location: *http:' "$TMP/wget.headers"; then
      rm -f "$2"
      die "A download from $1 was redirected to plain HTTP."
    fi
  else
    die "Downloading kerstel-server needs curl or wget."
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "Checking the download needs sha256sum or shasum."
  fi
}

# Downloads kerstel-server $VERSION for this host into $TMP and checks it
# against the release's SHA256SUMS. Sets BINARY_CHANGED to no, and downloads
# nothing, when that version is already installed.
fetch_binary() {
  installed="$KH/bin/kerstel-server"
  if [ -x "$installed" ] && [ "$("$installed" --version 2>/dev/null || true)" = "$VERSION" ]; then
    say "kerstel-server $VERSION is already installed."
    BINARY_CHANGED="no"
    return 0
  fi
  asset="kerstel-server-$OS-$ARCH"
  base="${RELEASES_URL%/}/releases/download/v$VERSION"
  say "Downloading $asset $VERSION."
  fetch "$base/$asset" "$TMP/$asset" || die "Could not download $base/$asset."
  fetch "$base/SHA256SUMS" "$TMP/SHA256SUMS" || die "Could not download $base/SHA256SUMS."
  expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$TMP/SHA256SUMS")"
  [ -n "$expected" ] || die "SHA256SUMS has no entry for $asset."
  actual="$(sha256_of "$TMP/$asset")"
  [ "$expected" = "$actual" ] || die "The checksum of $asset does not match SHA256SUMS."
  say "Checksum verified."
  if [ -f "$installed" ] && cmp -s "$TMP/$asset" "$installed"; then
    BINARY_CHANGED="no"
  else
    BINARY_CHANGED="yes"
  fi
}

# Moves the checked binary into place in one step.
place_binary() {
  if [ "$BINARY_CHANGED" = no ]; then return 0; fi
  mkdir -p "$KH/bin"
  cp "$TMP/kerstel-server-$OS-$ARCH" "$KH/bin/.kerstel-server.new"
  chmod 700 "$KH/bin/.kerstel-server.new"
  mv -f "$KH/bin/.kerstel-server.new" "$KH/bin/kerstel-server"
}

# ---------------------------------------------------------------------------
# Tailscale

# Runs a command, showing its output and keeping a copy in $TMP/tailscale.out.
tailscale_try() {
  {
    code=0
    "$@" 2>&1 || code=$?
    printf '%s\n' "$code" >"$TMP/tailscale.code"
  } | tee "$TMP/tailscale.out" >&2
  [ "$(cat "$TMP/tailscale.code")" = 0 ]
}

# Runs tailscale with these arguments, again through sudo when this user may
# not change its settings.
tailscale_run() {
  if tailscale_try tailscale "$@"; then return 0; fi
  if ! is_root && command -v sudo >/dev/null 2>&1 && grep -Eqi 'denied|permission|operator' "$TMP/tailscale.out"; then
    say "Changing what Tailscale serves needs sudo, because your user is not a Tailscale operator."
    tailscale_try sudo tailscale "$@"
    return
  fi
  return 1
}

tailscale_serve() {
  say "Serving it on your tailnet at https://$TS_NAME."
  if tailscale_run serve --bg "$PORT"; then return 0; fi
  if grep -Eq 'HTTPS|[Cc]ert|not enabled' "$TMP/tailscale.out"; then
    say "Tailscale cannot serve HTTPS on your tailnet yet. Turn on MagicDNS and HTTPS Certificates under DNS in the Tailscale admin console (https://login.tailscale.com/admin/dns), then run this again."
  fi
  die "tailscale serve --bg $PORT failed."
}

tailscale_unserve() {
  if ! command -v tailscale >/dev/null 2>&1; then return 0; fi
  if ! tailscale_run serve --https=443 off; then
    say "Could not stop serving on your tailnet. Run: tailscale serve --https=443 off"
  fi
}

# ---------------------------------------------------------------------------
# What is installed

# Sets FOUND_RUNTIME (docker, service or empty), FOUND_ID and NAMED_CONTAINER
# (yes when the container kerstel-server exists).
# With "ask" it may use sudo to reach Docker, after saying why; with "quiet"
# it never asks. A unit or plist without this user's install-id file is a
# service another user set up, and a server started by hand from the image is
# someone else's too: each counts as installed, with no ID, so nothing here
# touches it.
find_install() {
  FOUND_RUNTIME=""
  FOUND_ID=""
  NAMED_CONTAINER=""
  if [ -f "$KH/install-id" ]; then
    FOUND_RUNTIME="service"
    FOUND_ID="$(cat "$KH/install-id")"
    return 0
  fi
  case "$OS" in
    linux | darwin)
      if [ -f "$(service_file)" ]; then
        FOUND_RUNTIME="service"
        return 0
      fi
      ;;
  esac
  command -v docker >/dev/null 2>&1 || return 0
  if [ "$1" = ask ]; then
    checked=0
    docker_access "Checking for a Kerstel server in Docker" || checked=1
  else
    checked=0
    docker_access_quiet || checked=1
  fi
  if [ "$checked" != 0 ]; then
    say "could not check Docker for a Kerstel server."
    return 0
  fi
  if found="$(dk container inspect --format "{{index .Config.Labels \"$LABEL.install-id\"}}" "$CONTAINER" 2>/dev/null)"; then
    FOUND_RUNTIME="docker"
    NAMED_CONTAINER="yes"
    if [ "$found" != "<no value>" ]; then FOUND_ID="$found"; fi
  elif docker_by_hand; then
    FOUND_RUNTIME="docker"
  fi
}

# Whether Docker holds a server that is not in our container: a container from
# the image under another name, or a kerstel-server volume this installer did
# not make. The volume our remove keeps carries our label, so data kept by
# remove comes back with the next install.
docker_by_hand() {
  if dk ps -a --format '{{.Image}}' 2>/dev/null | grep -Eq "$IMAGE_RE"; then return 0; fi
  label="$(dk volume inspect --format "{{index .Labels \"$LABEL.install-id\"}}" "$VOLUME" 2>/dev/null)" || return 1
  [ -z "$label" ] || [ "$label" = "<no value>" ]
}

detect_lines() {
  printf 'os=%s\narch=%s\n' "$OS" "$ARCH"
  if command -v docker >/dev/null 2>&1; then echo "docker=yes"; else echo "docker=no"; fi
  if has_systemd; then echo "systemd=yes"; else echo "systemd=no"; fi
  printf 'tailscale=%s\n' "$(tailscale_name || echo no)"
  printf 'hostname=%s\n' "$(host_name)"
  ipv4s | while IFS= read -r ip; do printf 'ipv4=%s\n' "$ip"; done
  if [ -n "$FOUND_RUNTIME" ]; then
    printf 'installed=%s\n' "$FOUND_RUNTIME"
    if [ -n "$FOUND_ID" ]; then printf 'install-id=%s\n' "$FOUND_ID"; fi
  else
    echo "installed=no"
  fi
}

# Uses FOUND_RUNTIME and FOUND_ID from find_install.
check_owner() {
  if [ -z "$FOUND_RUNTIME" ]; then return 0; fi
  if [ "$FOUND_ID" != "$INSTALL_ID" ]; then another_devices; fi
  if [ "$FOUND_RUNTIME" != "$RUNTIME" ]; then
    die "This host already runs the server this device set up, with $FOUND_RUNTIME. Remove it first to run it with $RUNTIME."
  fi
}

# Exits 3 when the server found here is not this user's to manage, or, with
# --install-id, not the one with that ID.
require_own_install() {
  if [ "$FOUND_RUNTIME" = service ] && [ ! -f "$KH/install-id" ]; then another_devices; fi
  if [ "$FOUND_RUNTIME" = docker ] && [ "$NAMED_CONTAINER" != yes ]; then another_devices; fi
  if [ -n "$EXPECT_ID" ] && [ -n "$FOUND_RUNTIME" ] && [ "$FOUND_ID" != "$EXPECT_ID" ]; then another_devices; fi
}

# --install-id <id> for update, stop and remove.
expect_id() {
  matches '^[A-Za-z0-9_-]{1,64}$' "$1" || usage_error "--install-id must be letters, digits, - and _, got $1."
  EXPECT_ID="$1"
}

require_install() {
  if [ -z "$FOUND_RUNTIME" ]; then die "No Kerstel server is installed on this host."; fi
  require_own_install
  RUNTIME="$FOUND_RUNTIME"
  INSTALL_ID="$FOUND_ID"
  if [ "$RUNTIME" = service ]; then load_service_settings; fi
}

# ---------------------------------------------------------------------------
# The server value

# Prints the server value for the addresses in URLS, from kerstel-server,
# which reads the token from its file.
server_value() {
  set -f
  set --
  for url in $URLS; do set -- "$@" --url "$url"; done
  set +f
  if [ "$RUNTIME" = docker ]; then
    dk exec "$CONTAINER" /usr/local/bin/kerstel-server value "$@"
  else
    service_run value "$@"
  fi
}

# Waits up to 30 seconds for the server's first start, which makes the token
# file and the TLS key that the value needs, and then up to 15 more for the
# server to answer.
wait_for_value() {
  tries=0
  while :; do
    if VALUE="$(server_value 2>"$TMP/value.err")"; then
      wait_answering
      return 0
    fi
    if [ "$RUNTIME" = docker ] && ! docker_running; then
      die "The container $CONTAINER stopped. See: docker logs $CONTAINER"
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge 30 ]; then
      cat "$TMP/value.err" >&2
      if [ "$RUNTIME" = docker ]; then
        die "kerstel-server did not start within 30 seconds. See: docker logs $CONTAINER"
      fi
      die "kerstel-server did not start within 30 seconds. $(service_logs_hint)"
    fi
    sleep 1
  done
}

server_running() {
  if [ "$RUNTIME" = docker ]; then docker_running; else service_running; fi
}

logs_hint() {
  if [ "$RUNTIME" = docker ]; then printf 'See: docker logs %s' "$CONTAINER"; else service_logs_hint; fi
}

# Whether a GET of $1 succeeds. Only to this host's loopback, so the
# certificate is not checked: the pin is what devices check.
answers() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSk --max-time 2 -o /dev/null "$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -q --no-check-certificate -T 2 -t 1 -O /dev/null "$1" 2>/dev/null
  else
    server_running
  fi
}

# Waits up to 15 seconds for the server to answer /v1/health on its port. A server with a domain answers only at that name,
# so there it must be running.
wait_answering() {
  case "$REACH" in
    self) health="https://127.0.0.1:$PORT/v1/health" ;;
    tailscale) health="http://127.0.0.1:$PORT/v1/health" ;;
    *) health="" ;;
  esac
  tries=0
  while :; do
    if [ -n "$health" ]; then
      if answers "$health"; then return 0; fi
    elif server_running; then
      return 0
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge 15 ]; then
      if [ -n "$health" ]; then die "kerstel-server started, but it is not answering on port $PORT. $(logs_hint)"; fi
      die "kerstel-server is not running. $(logs_hint)"
    fi
    sleep 1
  done
}

wait_running() {
  tries=0
  while :; do
    if [ "$RUNTIME" = docker ]; then
      if docker_running; then return 0; fi
    elif service_running; then
      return 0
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge 30 ]; then die "kerstel-server did not start within 30 seconds."; fi
    sleep 1
  done
}

print_value() {
  printf 'Server value (paste it only into Kerstel): %s\n' "$VALUE"
}

add_url() {
  matches '^https?://[][A-Za-z0-9._~:/%-]+$' "$1" || usage_error "--url must be an http:// or https:// address, got $1."
  URL_COUNT=$((URL_COUNT + 1))
  if [ "$URL_COUNT" -gt 4 ]; then usage_error "A server value holds up to four --url addresses."; fi
  URLS="${URLS:+$URLS }$1"
}

# The addresses devices use, when no --url names them.
default_urls() {
  if [ -n "$URLS" ]; then return 0; fi
  case "$REACH" in
    domain) add_url "https://$DOMAIN" ;;
    tailscale) add_url "https://$TS_NAME" ;;
    self)
      old_ifs="$IFS"
      IFS=","
      set -f
      for name in $NAMES; do
        case "$name" in
          *:*) add_url "https://[$name]:$PORT" ;;
          *) add_url "https://$name:$PORT" ;;
        esac
      done
      set +f
      IFS="$old_ifs"
      ;;
  esac
}

check_version() {
  VERSION="${VERSION#v}"
  matches '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$' "$VERSION" || usage_error "--version must be a version like 0.4.0, got $VERSION."
}

check_releases_url() {
  CURL_PROTO="$(proto_for "$RELEASES_URL")"
  if [ -z "$CURL_PROTO" ]; then
    usage_error "--releases-url must be https://, or http:// to 127.0.0.1 or localhost: plain HTTP would let anyone on the network path replace the binary and its checksum together."
  fi
  RELEASES_URL="${RELEASES_URL%/}"
}

# ---------------------------------------------------------------------------
# Commands

cmd_detect() {
  if [ $# -gt 0 ]; then usage_error "detect takes no options."; fi
  find_install quiet
  detect_lines
}

cmd_install() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) need $# "$1"; VERSION="$2"; shift 2 ;;
      --install-id) need $# "$1"; INSTALL_ID="$2"; shift 2 ;;
      --runtime) need $# "$1"; RUNTIME="$2"; shift 2 ;;
      --reach) need $# "$1"; REACH="$2"; shift 2 ;;
      --name)
        need $# "$1"
        matches '^[A-Za-z0-9.:*-]+$' "$2" || usage_error "--name must be a DNS name or an IP address, got $2."
        NAMES="${NAMES:+$NAMES,}$2"
        shift 2
        ;;
      --domain)
        need $# "$1"
        matches '^[A-Za-z0-9.-]+$' "$2" || usage_error "--domain must be a DNS name, got $2."
        DOMAIN="$2"
        shift 2
        ;;
      --port) need $# "$1"; PORT="$2"; shift 2 ;;
      --releases-url) need $# "$1"; RELEASES_URL="$2"; shift 2 ;;
      --url) need $# "$1"; add_url "$2"; shift 2 ;;
      *) usage_error "install does not take $1." ;;
    esac
  done
  [ -n "$VERSION" ] || usage_error "install needs --version <version>."
  check_version
  matches '^[A-Za-z0-9_-]{1,64}$' "$INSTALL_ID" || usage_error "install needs --install-id <id>: letters, digits, - and _."
  case "$RUNTIME" in
    docker | service) ;;
    *) usage_error "install needs --runtime docker or --runtime service." ;;
  esac
  case "$REACH" in
    self | tailscale) ;;
    domain) matches '^[A-Za-z0-9.-]+$' "$DOMAIN" || usage_error "--reach domain needs --domain <name>." ;;
    *) usage_error "install needs --reach self, domain or tailscale." ;;
  esac
  if ! matches '^[0-9]{1,5}$' "$PORT" || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    usage_error "--port must be a port number, got $PORT."
  fi
  if [ "$REACH" = self ] && [ -z "$URLS" ] && [ -z "$NAMES" ]; then
    usage_error "--reach self needs --url <url> or --name <address>, for the addresses devices use."
  fi
  check_releases_url
  check_supported

  if [ "$REACH" = tailscale ]; then
    TS_NAME="$(tailscale_name)" || die "Tailscale is not running on this host, so --reach tailscale cannot work. Run tailscale up first."
  fi
  default_urls
  if [ "$RUNTIME" = docker ]; then install_docker; else install_service; fi
}

install_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is not installed on this host. Install it, or run the server as a service with --runtime service."
  docker_access "Running Docker" || die "Docker is installed, but it does not answer (docker info failed). Start it, then run this again."
  find_install ask
  check_owner
  IMAGE="$IMAGE_REPO:$VERSION"
  WANT_REACH="$REACH"
  WANT_PORT="$PORT"
  WANT_NAMES="$NAMES"
  WANT_DOMAIN="$DOMAIN"
  keep="no"
  if [ "$FOUND_RUNTIME" = docker ]; then
    load_docker_settings
    if [ "$CURRENT_IMAGE|$REACH|$PORT|$NAMES|$DOMAIN" = "$IMAGE|$WANT_REACH|$WANT_PORT|$WANT_NAMES|$WANT_DOMAIN" ]; then keep="yes"; fi
    REACH="$WANT_REACH"
    PORT="$WANT_PORT"
    NAMES="$WANT_NAMES"
    DOMAIN="$WANT_DOMAIN"
  fi
  if [ "$keep" = yes ]; then
    if [ "$CURRENT_RUNNING" = true ]; then
      say "The container $CONTAINER already runs $IMAGE with these settings."
    else
      say "Starting the container $CONTAINER."
      LEFT="Left in place: the container $CONTAINER, stopped, and its volume $VOLUME. Run the same command again to continue."
      dk start "$CONTAINER" >/dev/null
    fi
  else
    ensure_image "$IMAGE"
    if [ "$FOUND_RUNTIME" = docker ]; then
      say "Replacing the container $CONTAINER that this device set up, keeping its data."
      dk rm -f "$CONTAINER" >/dev/null
      LEFT="Left in place: the volume $VOLUME, which holds the server's data. Run the same command again to continue."
    fi
    say "Starting $IMAGE in the container $CONTAINER."
    LEFT="Left in place: the volume $VOLUME, and the container $CONTAINER if Docker created it. Run the same command again to continue."
    docker_run
  fi
  LEFT="Left in place: the container $CONTAINER and its volume $VOLUME. Run the same command again to continue."
  if [ "$REACH" = tailscale ]; then tailscale_serve; fi
  wait_for_value
  say "kerstel-server $VERSION is running in Docker, and starts again with the host."
  print_value
}

install_service() {
  service_manager
  if [ "$OS" = linux ] && [ -f "$ROOT/etc/alpine-release" ]; then
    die "kerstel-server needs glibc, so it cannot run as a service on musl-based Linux such as Alpine. Use --runtime docker."
  fi
  find_install ask
  check_owner
  fetch_binary
  mkdir -p "$KH"
  write_file "$KH/install-id" "$INSTALL_ID"
  write_file "$KH/settings" "$(printf 'reach=%s\nport=%s\nnames=%s\ndomain=%s' "$REACH" "$PORT" "$NAMES" "$DOMAIN")"
  LEFT="Left in place: $KH, with the install ID. Run the same command again to continue."
  place_binary
  LEFT="Left in place: kerstel-server in $KH. Run the same command again to continue."
  write_service_file
  LEFT="Left in place: kerstel-server in $KH and $(service_file). Run the same command again to continue."
  start_service
  if [ "$REACH" = tailscale ]; then tailscale_serve; fi
  wait_for_value
  say "kerstel-server $VERSION is running as a service, and starts again with the host."
  print_value
}

cmd_info() {
  if [ $# -gt 0 ]; then usage_error "info takes no options."; fi
  find_install ask
  detect_lines
  require_install
  if [ "$RUNTIME" = docker ]; then
    if docker_running; then
      running="yes"
      dk exec "$CONTAINER" /usr/local/bin/kerstel-server info | grep -E '^(version|pin)=' || true
    else
      running="no"
      image="$(dk container inspect --format '{{.Config.Image}}' "$CONTAINER")"
      printf 'version=%s\n' "${image##*:}"
    fi
  else
    service_run info | grep -E '^(version|pin)=' || true
    if service_running; then running="yes"; else running="no"; fi
  fi
  printf 'running=%s\n' "$running"
}

cmd_value() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --url) need $# "$1"; add_url "$2"; shift 2 ;;
      *) usage_error "value does not take $1." ;;
    esac
  done
  [ -n "$URLS" ] || usage_error "value needs at least one --url <url>."
  find_install ask
  require_install
  VALUE="$(server_value)" || die "kerstel-server could not print the server value."
  print_value
}

cmd_update() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --version) need $# "$1"; VERSION="$2"; shift 2 ;;
      --releases-url) need $# "$1"; RELEASES_URL="$2"; shift 2 ;;
      --install-id) need $# "$1"; expect_id "$2"; shift 2 ;;
      *) usage_error "update does not take $1." ;;
    esac
  done
  [ -n "$VERSION" ] || usage_error "update needs --version <version>."
  check_version
  check_releases_url
  find_install ask
  require_install
  if [ "$RUNTIME" = docker ]; then update_docker; else update_service; fi
}

update_docker() {
  load_docker_settings
  IMAGE="$IMAGE_REPO:$VERSION"
  if [ "$CURRENT_IMAGE" = "$IMAGE" ] && [ "$CURRENT_RUNNING" = true ]; then
    say "kerstel-server $VERSION is already running."
    return 0
  fi
  ensure_image "$IMAGE"
  say "Replacing the container $CONTAINER with $IMAGE, keeping its data and settings."
  dk rm -f "$CONTAINER" >/dev/null
  LEFT="Left in place: the volume $VOLUME, which holds the server's data, and the container $CONTAINER if Docker created it. Run install again to finish."
  docker_run
  LEFT="Left in place: the container $CONTAINER, running $IMAGE, and its volume $VOLUME."
  wait_running
  say "kerstel-server is now $VERSION."
}

update_service() {
  service_manager
  check_supported
  fetch_binary
  if [ "$BINARY_CHANGED" = no ] && service_running; then
    say "kerstel-server $VERSION is already running."
    return 0
  fi
  place_binary
  LEFT="Left in place: kerstel-server $VERSION in $KH, with the server's data and settings. Run the same command again to start it."
  BINARY_CHANGED="yes"
  start_service
  wait_running
  say "kerstel-server is now $VERSION."
}

cmd_stop() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --install-id) need $# "$1"; expect_id "$2"; shift 2 ;;
      *) usage_error "stop does not take $1." ;;
    esac
  done
  find_install ask
  require_install
  if [ "$RUNTIME" = docker ]; then
    dk stop "$CONTAINER" >/dev/null
    say "Stopped the container $CONTAINER. Its data stays in the volume $VOLUME."
  else
    service_manager
    explain_sudo "Stopping the service needs sudo, because $(service_file) belongs to root."
    stop_service
    say "Stopped kerstel-server. Its data stays in $KH."
  fi
}

cmd_remove() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --delete-data) DELETE_DATA="yes"; shift ;;
      --install-id) need $# "$1"; expect_id "$2"; shift 2 ;;
      *) usage_error "remove does not take $1." ;;
    esac
  done
  find_install ask
  require_own_install
  case "$FOUND_RUNTIME" in
    docker) remove_docker ;;
    service) remove_service ;;
    *)
      say "No Kerstel server is installed on this host."
      if [ "$DELETE_DATA" = yes ]; then delete_leftover_data; fi
      ;;
  esac
}

remove_docker() {
  RUNTIME="docker"
  load_docker_settings
  dk rm -f "$CONTAINER" >/dev/null
  LEFT="Left in place: the volume $VOLUME, which holds the server's data."
  if [ "$REACH" = tailscale ]; then tailscale_unserve; fi
  if [ "$DELETE_DATA" = yes ]; then
    dk volume rm "$VOLUME" >/dev/null
    say "Removed the container $CONTAINER and the volume $VOLUME with the server's data."
  else
    say "Removed the container $CONTAINER. Its data stays in the volume $VOLUME."
  fi
}

remove_service() {
  RUNTIME="service"
  load_service_settings
  service_manager
  target="$(service_file)"
  if [ -f "$target" ]; then
    explain_sudo "Removing the service needs sudo, because $target belongs to root."
    stop_service
    as_root rm -f "$target"
    if [ "$OS" = linux ]; then as_root systemctl daemon-reload; fi
  fi
  LEFT="Left in place: $KH, with the install ID. Run the same command again to finish."
  if [ "$REACH" = tailscale ]; then tailscale_unserve; fi
  rm -f "$KH/bin/kerstel-server" "$KH/settings"
  rmdir "$KH/bin" 2>/dev/null || true
  rm -f "$KH/install-id"
  LEFT="Left in place: the server's data in $KH."
  if [ "$DELETE_DATA" = yes ]; then
    delete_service_data
    say "Removed kerstel-server and its data."
  else
    say "Removed kerstel-server. Its data stays in $KH."
  fi
}

delete_service_data() {
  rm -f "$KH/enroll-token" "$KH/kerstel-server.log" "$KH"/kerstel-server.db*
}

delete_leftover_data() {
  delete_service_data
  if command -v docker >/dev/null 2>&1 && docker_access "Deleting the Docker volume $VOLUME" &&
    dk volume inspect "$VOLUME" >/dev/null 2>&1; then
    dk volume rm "$VOLUME" >/dev/null
    say "Deleted the volume $VOLUME."
  fi
}

main() {
  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # A dropped `ssh -t` session hangs up: exit, so the EXIT trap still cleans up.
  trap 'exit 129' HUP
  if [ $# -eq 0 ]; then usage_error "Name a command."; fi
  command="$1"
  shift
  TMP="$(mktemp -d "${TMPDIR:-/tmp}/kerstel-server.XXXXXX")"
  refuse_sudo
  os_arch
  case "$command" in
    detect) cmd_detect "$@" ;;
    install) cmd_install "$@" ;;
    info) cmd_info "$@" ;;
    value) cmd_value "$@" ;;
    update) cmd_update "$@" ;;
    stop) cmd_stop "$@" ;;
    remove) cmd_remove "$@" ;;
    *) usage_error "Unknown command $command." ;;
  esac
}

main "$@"
