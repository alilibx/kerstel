#!/bin/bash
set -euo pipefail

# Kerstel installer
# Usage: curl -fsSL https://kerstel.dev/install.sh | bash

REPO="https://github.com/alilibx/kerstel.git"
INSTALL_DIR="$HOME/.kerstel"
APP_DIR="$HOME/Applications"
APP_BUNDLE="$APP_DIR/Kerstel.app"
PLIST_LABEL="com.alilibx.kerstel"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
CLI_PATH="/usr/local/bin/kerstel"

# --- Colors & Symbols ---

DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'

PASS="${GREEN}\xE2\x9C\x94${NC}"
FAIL="${RED}\xE2\x9C\x98${NC}"
ARROW="${CYAN}\xE2\x96\xB6${NC}"

# --- Helpers ---

step()    { echo -e "\n ${ARROW}  ${BOLD}$1${NC}"; }
ok()      { echo -e " ${PASS}  $1"; }
fail()    { echo -e " ${FAIL}  ${RED}$1${NC}" >&2; exit 1; }
dim()     { echo -e "    ${DIM}$1${NC}"; }

spin() {
    local pid=$1 msg=$2
    local frames=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
    local i=0
    while kill -0 "$pid" 2>/dev/null; do
        printf "\r    ${CYAN}%s${NC}  %s" "${frames[i]}" "$msg"
        i=$(( (i + 1) % ${#frames[@]} ))
        sleep 0.1
    done
    wait "$pid" 2>/dev/null
    local exit_code=$?
    printf "\r\033[K"
    return $exit_code
}

# --- Header ---

echo ""
echo -e "  ${WHITE}┌─────────────────────────────────────┐${NC}"
echo -e "  ${WHITE}│${NC}                                     ${WHITE}│${NC}"
echo -e "  ${WHITE}│${NC}    ${BOLD}${WHITE}K E R S T E L${NC}                    ${WHITE}│${NC}"
echo -e "  ${WHITE}│${NC}    ${DIM}The Mac toolbar for developers${NC}    ${WHITE}│${NC}"
echo -e "  ${WHITE}│${NC}                                     ${WHITE}│${NC}"
echo -e "  ${WHITE}└─────────────────────────────────────┘${NC}"

# --- Preflight Checks ---

step "Checking requirements"

if [[ "$(uname)" != "Darwin" ]]; then
    fail "Kerstel only runs on macOS."
fi
ok "macOS detected"

MACOS_VERSION=$(sw_vers -productVersion | cut -d. -f1)
if [[ "$MACOS_VERSION" -lt 14 ]]; then
    fail "Requires macOS 14+. You have $(sw_vers -productVersion)."
fi
ok "macOS $(sw_vers -productVersion)"

if ! command -v swift &>/dev/null; then
    fail "Swift not found. Run: xcode-select --install"
fi
ok "Swift $(swift --version 2>&1 | head -1 | sed 's/.*version //' | cut -d' ' -f1)"

if ! command -v git &>/dev/null; then
    fail "Git not found. Run: xcode-select --install"
fi
ok "Git available"

# --- Download ---

step "Downloading"

if [[ -d "$INSTALL_DIR" ]]; then
    dim "Updating existing installation..."
    (git -C "$INSTALL_DIR" fetch --depth 1 origin main && git -C "$INSTALL_DIR" reset --hard origin/main) &>/dev/null &
    spin $! "Pulling latest changes..." || {
        rm -rf "$INSTALL_DIR"
        git clone --depth 1 "$REPO" "$INSTALL_DIR" &>/dev/null &
        spin $! "Fresh clone..." || fail "Clone failed."
    }
else
    git clone --depth 1 "$REPO" "$INSTALL_DIR" &>/dev/null &
    spin $! "Cloning repository..." || fail "Clone failed. Check your internet connection."
fi
ok "Source ready"

# --- Build ---

step "Building"

cd "$INSTALL_DIR"
swift build -c release 2>&1 >/dev/null &
spin $! "Compiling release build (this takes a minute)..." || fail "Build failed. Check Swift installation."

BINARY="$INSTALL_DIR/.build/release/Kerstel"
if [[ ! -f "$BINARY" ]]; then
    fail "Binary not found after build."
fi

VERSION=$(git -C "$INSTALL_DIR" describe --tags 2>/dev/null || git -C "$INSTALL_DIR" rev-parse --short HEAD)
ok "Built ${DIM}${VERSION}${NC}"

# --- App Bundle ---

step "Assembling app bundle"

# Stop existing instance
pkill -f "Kerstel.app/Contents/MacOS/Kerstel" 2>/dev/null || true
pkill -f "\.kerstel/.build/release/Kerstel" 2>/dev/null || true

mkdir -p "$APP_DIR"
rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$APP_BUNDLE/Contents/Resources"

# Copy binary
cp "$BINARY" "$APP_BUNDLE/Contents/MacOS/Kerstel"

# Copy Info.plist (inject version)
if [[ -f "$INSTALL_DIR/Resources/Info.plist" ]]; then
    sed "s/1\.3\.0/$VERSION/g" "$INSTALL_DIR/Resources/Info.plist" > "$APP_BUNDLE/Contents/Info.plist"
else
    cat > "$APP_BUNDLE/Contents/Info.plist" << INFOPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.alilibx.kerstel</string>
    <key>CFBundleName</key>
    <string>Kerstel</string>
    <key>CFBundleDisplayName</key>
    <string>Kerstel</string>
    <key>CFBundleExecutable</key>
    <string>Kerstel</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>CFBundleVersion</key>
    <string>${VERSION}</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
INFOPLIST
fi

# Copy icon
if [[ -f "$INSTALL_DIR/Resources/AppIcon.icns" ]]; then
    cp "$INSTALL_DIR/Resources/AppIcon.icns" "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
fi

# Ad-hoc code sign
codesign --force --sign - "$APP_BUNDLE" 2>/dev/null || true

# Register with Launch Services so Spotlight indexes it
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP_BUNDLE" 2>/dev/null || true

ok "Installed ${DIM}${APP_BUNDLE}${NC}"

# --- Install CLI ---

step "Installing CLI"

mkdir -p "$(dirname "$CLI_PATH")" 2>/dev/null || true

# Write the kerstel CLI script
sudo tee "$CLI_PATH" >/dev/null << 'CLISCRIPT'
#!/bin/bash
set -euo pipefail

INSTALL_DIR="$HOME/.kerstel"
APP_BUNDLE="$HOME/Applications/Kerstel.app"
APP_BINARY="$APP_BUNDLE/Contents/MacOS/Kerstel"
BINARY="$INSTALL_DIR/.build/release/Kerstel"
PLIST_LABEL="com.alilibx.kerstel"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
REPO="https://github.com/alilibx/kerstel.git"

DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'

PASS="${GREEN}\xE2\x9C\x94${NC}"
FAIL="${RED}\xE2\x9C\x98${NC}"
ARROW="${CYAN}\xE2\x96\xB6${NC}"

spin() {
    local pid=$1 msg=$2
    local frames=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
    local i=0
    while kill -0 "$pid" 2>/dev/null; do
        printf "\r  ${CYAN}%s${NC}  %s" "${frames[i]}" "$msg"
        i=$(( (i + 1) % ${#frames[@]} ))
        sleep 0.1
    done
    wait "$pid" 2>/dev/null
    local exit_code=$?
    printf "\r\033[K"
    return $exit_code
}

# Resolve which binary to use (prefer app bundle)
resolve_binary() {
    if [[ -x "$APP_BINARY" ]]; then
        echo "$APP_BINARY"
    elif [[ -x "$BINARY" ]]; then
        echo "$BINARY"
    else
        echo ""
    fi
}

# Match running process by either binary path
is_running() {
    pgrep -f "Kerstel.app/Contents/MacOS/Kerstel" >/dev/null 2>&1 || \
    pgrep -f "\.kerstel/.build/release/Kerstel" >/dev/null 2>&1
}

get_pid() {
    pgrep -f "Kerstel.app/Contents/MacOS/Kerstel" 2>/dev/null | head -1 || \
    pgrep -f "\.kerstel/.build/release/Kerstel" 2>/dev/null | head -1
}

cmd_open() {
    if is_running; then
        echo -e " ${PASS}  Kerstel is already running"
        return
    fi
    if [[ -d "$APP_BUNDLE" ]]; then
        open "$APP_BUNDLE"
    else
        local bin
        bin=$(resolve_binary)
        if [[ -z "$bin" ]]; then
            echo -e " ${FAIL}  Kerstel is not installed"
            return 1
        fi
        nohup "$bin" &>/dev/null &
        disown
    fi
    echo -e " ${PASS}  Kerstel started — look for ${BOLD}K${NC} in the menu bar"
}

cmd_stop() {
    if pkill -f "Kerstel.app/Contents/MacOS/Kerstel" 2>/dev/null || \
       pkill -f "\.kerstel/.build/release/Kerstel" 2>/dev/null; then
        echo -e " ${PASS}  Kerstel stopped"
    else
        echo -e " ${DIM}  Kerstel is not running${NC}"
    fi
}

cmd_restart() {
    cmd_stop
    sleep 0.5
    cmd_open
}

cmd_status() {
    if is_running; then
        local pid
        pid=$(get_pid)
        echo -e " ${PASS}  Kerstel is running ${DIM}(PID ${pid})${NC}"
    else
        echo -e " ${DIM}  Kerstel is not running${NC}"
    fi
}

cmd_version() {
    if [[ ! -d "$INSTALL_DIR" ]]; then
        echo -e " ${FAIL}  Kerstel is not installed"
        return 1
    fi
    local ver
    ver=$(git -C "$INSTALL_DIR" describe --tags 2>/dev/null || git -C "$INSTALL_DIR" rev-parse --short HEAD)
    echo -e " ${BOLD}Kerstel${NC} ${ver}"
}

cmd_update() {
    if [[ ! -d "$INSTALL_DIR" ]]; then
        echo -e " ${FAIL}  Kerstel is not installed. Run the install script first."
        return 1
    fi

    echo ""
    local current
    current=$(git -C "$INSTALL_DIR" describe --tags 2>/dev/null || git -C "$INSTALL_DIR" rev-parse --short HEAD)
    echo -e " ${ARROW}  ${BOLD}Checking for updates${NC} ${DIM}(current: ${current})${NC}"

    # Fetch latest
    (git -C "$INSTALL_DIR" fetch --depth 1 origin main) &>/dev/null &
    spin $! "Fetching..." || { echo -e " ${FAIL}  Fetch failed"; return 1; }

    local local_hash remote_hash
    local_hash=$(git -C "$INSTALL_DIR" rev-parse HEAD)
    remote_hash=$(git -C "$INSTALL_DIR" rev-parse origin/main)

    if [[ "$local_hash" == "$remote_hash" ]]; then
        echo -e " ${PASS}  Already up to date"
        return
    fi

    # Pull
    (git -C "$INSTALL_DIR" reset --hard origin/main) &>/dev/null &
    spin $! "Downloading update..." || { echo -e " ${FAIL}  Pull failed"; return 1; }

    # Rebuild
    echo -e " ${ARROW}  ${BOLD}Rebuilding${NC}"
    (cd "$INSTALL_DIR" && swift build -c release 2>&1 >/dev/null) &
    spin $! "Compiling..." || { echo -e " ${FAIL}  Build failed"; return 1; }

    local new_ver
    new_ver=$(git -C "$INSTALL_DIR" describe --tags 2>/dev/null || git -C "$INSTALL_DIR" rev-parse --short HEAD)

    # Reassemble app bundle
    if [[ -d "$APP_BUNDLE" ]]; then
        cp "$INSTALL_DIR/.build/release/Kerstel" "$APP_BUNDLE/Contents/MacOS/Kerstel"
        if [[ -f "$INSTALL_DIR/Resources/AppIcon.icns" ]]; then
            cp "$INSTALL_DIR/Resources/AppIcon.icns" "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
        fi
        codesign --force --sign - "$APP_BUNDLE" 2>/dev/null || true
    fi

    echo -e " ${PASS}  Updated to ${BOLD}${new_ver}${NC}"

    # Restart if running
    if is_running; then
        echo ""
        echo -e " ${ARROW}  ${BOLD}Restarting${NC}"
        cmd_stop
        sleep 0.5
        cmd_open
    fi
    echo ""
}

cmd_uninstall() {
    echo ""
    echo -e " ${ARROW}  ${BOLD}Uninstalling Kerstel${NC}"

    # Stop
    pkill -f "Kerstel.app/Contents/MacOS/Kerstel" 2>/dev/null || true
    pkill -f "\.kerstel/.build/release/Kerstel" 2>/dev/null || true

    # Remove launch agent
    if [[ -f "$PLIST_PATH" ]]; then
        launchctl unload "$PLIST_PATH" 2>/dev/null || true
        rm -f "$PLIST_PATH"
    fi

    # Remove app bundle
    rm -rf "$APP_BUNDLE"

    # Remove install dir
    rm -rf "$INSTALL_DIR"

    echo -e " ${PASS}  Kerstel uninstalled"
    echo ""
    echo -e " ${DIM}  To remove the CLI: sudo rm /usr/local/bin/kerstel${NC}"
    echo ""
}

cmd_help() {
    echo ""
    echo -e "  ${BOLD}${WHITE}kerstel${NC} — the Mac toolbar for developers"
    echo ""
    echo -e "  ${BOLD}Usage:${NC} kerstel <command>"
    echo ""
    echo -e "  ${BOLD}Commands:${NC}"
    echo -e "    ${GREEN}open${NC}        Launch Kerstel"
    echo -e "    ${GREEN}stop${NC}        Stop Kerstel"
    echo -e "    ${GREEN}restart${NC}     Restart Kerstel"
    echo -e "    ${GREEN}status${NC}      Check if Kerstel is running"
    echo -e "    ${GREEN}update${NC}      Update to the latest version"
    echo -e "    ${GREEN}version${NC}     Show installed version"
    echo -e "    ${GREEN}uninstall${NC}   Remove Kerstel"
    echo -e "    ${GREEN}help${NC}        Show this help"
    echo ""
}

case "${1:-help}" in
    open|start)     cmd_open ;;
    stop|kill)      cmd_stop ;;
    restart)        cmd_restart ;;
    status)         cmd_status ;;
    update|upgrade) cmd_update ;;
    version|-v|--version) cmd_version ;;
    uninstall|remove)     cmd_uninstall ;;
    help|-h|--help) cmd_help ;;
    *)
        echo -e " ${FAIL}  Unknown command: $1"
        cmd_help
        exit 1
        ;;
esac
CLISCRIPT

sudo chmod +x "$CLI_PATH"
ok "Installed ${DIM}${CLI_PATH}${NC}"

# --- Launch Agent ---

step "Setting up auto-start"

# Stop existing
if launchctl list "$PLIST_LABEL" &>/dev/null; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${APP_BUNDLE}/Contents/MacOS/Kerstel</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>
PLIST

launchctl load "$PLIST_PATH"
ok "Starts on login"

# --- Launch ---

sleep 0.5
open "$APP_BUNDLE" 2>/dev/null || nohup "$APP_BUNDLE/Contents/MacOS/Kerstel" &>/dev/null &
disown 2>/dev/null || true

# --- Done ---

echo ""
echo -e "  ${WHITE}┌─────────────────────────────────────┐${NC}"
echo -e "  ${WHITE}│${NC}                                     ${WHITE}│${NC}"
echo -e "  ${WHITE}│${NC}  ${GREEN}${BOLD}\xE2\x9C\x94  Kerstel installed${NC}               ${WHITE}│${NC}"
echo -e "  ${WHITE}│${NC}                                     ${WHITE}│${NC}"
echo -e "  ${WHITE}│${NC}  Look for the ${BOLD}K${NC} in your menu bar    ${WHITE}│${NC}"
echo -e "  ${WHITE}│${NC}  or search ${BOLD}Kerstel${NC} in Spotlight     ${WHITE}│${NC}"
echo -e "  ${WHITE}│${NC}                                     ${WHITE}│${NC}"
echo -e "  ${WHITE}│${NC}  ${DIM}kerstel open${NC}       ${DIM}launch app${NC}       ${WHITE}│${NC}"
echo -e "  ${WHITE}│${NC}  ${DIM}kerstel update${NC}     ${DIM}get latest${NC}       ${WHITE}│${NC}"
echo -e "  ${WHITE}│${NC}  ${DIM}kerstel version${NC}    ${DIM}show version${NC}     ${WHITE}│${NC}"
echo -e "  ${WHITE}│${NC}  ${DIM}kerstel help${NC}       ${DIM}all commands${NC}     ${WHITE}│${NC}"
echo -e "  ${WHITE}│${NC}                                     ${WHITE}│${NC}"
echo -e "  ${WHITE}└─────────────────────────────────────┘${NC}"
echo ""
