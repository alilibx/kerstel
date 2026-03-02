#!/bin/bash
set -euo pipefail

# Kerstel installer
# Usage: curl -fsSL https://raw.githubusercontent.com/alilibx/kerstel/main/install.sh | bash

REPO="https://github.com/alilibx/kerstel.git"
INSTALL_DIR="$HOME/.kerstel"
APP_NAME="Kerstel"
PLIST_LABEL="com.alilibx.kerstel"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${BLUE}==>${NC} ${BOLD}$1${NC}"; }
ok()    { echo -e "${GREEN}==>${NC} ${BOLD}$1${NC}"; }
err()   { echo -e "${RED}error:${NC} $1" >&2; exit 1; }

# --- Checks ---

if [[ "$(uname)" != "Darwin" ]]; then
    err "Kerstel only runs on macOS."
fi

if ! command -v swift &>/dev/null; then
    err "Swift is required. Install Xcode Command Line Tools:\n  xcode-select --install"
fi

MACOS_VERSION=$(sw_vers -productVersion | cut -d. -f1)
if [[ "$MACOS_VERSION" -lt 14 ]]; then
    err "Kerstel requires macOS 14 (Sonoma) or later. You have $(sw_vers -productVersion)."
fi

# --- Install ---

info "Installing Kerstel..."

# Clone or update
if [[ -d "$INSTALL_DIR" ]]; then
    info "Updating existing installation..."
    git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || {
        rm -rf "$INSTALL_DIR"
        git clone --depth 1 "$REPO" "$INSTALL_DIR"
    }
else
    info "Cloning repository..."
    git clone --depth 1 "$REPO" "$INSTALL_DIR"
fi

# Build
info "Building (this may take a minute)..."
cd "$INSTALL_DIR"
swift build -c release 2>&1 | tail -1

BINARY="$INSTALL_DIR/.build/release/Kerstel"
if [[ ! -f "$BINARY" ]]; then
    err "Build failed. Check that Swift toolchain is installed correctly."
fi

# --- Launch Agent ---

info "Setting up launch agent..."

# Stop existing instance if running
if launchctl list "$PLIST_LABEL" &>/dev/null; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# Kill any running Kerstel process
pkill -f "$BINARY" 2>/dev/null || true

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
        <string>${BINARY}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>
PLIST

launchctl load "$PLIST_PATH"

ok "Kerstel installed successfully!"
echo ""
echo "  Look for the ${BOLD}K${NC} icon in your menu bar."
echo ""
echo "  Commands:"
echo "    Update:    cd ~/.kerstel && git pull && swift build -c release"
echo "    Uninstall: ~/.kerstel/uninstall.sh"
echo ""
