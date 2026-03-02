#!/bin/bash
set -euo pipefail

# Kerstel uninstaller

PLIST_LABEL="com.alilibx.kerstel"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
INSTALL_DIR="$HOME/.kerstel"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}Uninstalling Kerstel...${NC}"

# Stop launch agent
if [[ -f "$PLIST_PATH" ]]; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
fi

# Kill running process
pkill -f "\.kerstel/.build/release/Kerstel" 2>/dev/null || true

# Remove installation
rm -rf "$INSTALL_DIR"

echo -e "${GREEN}==>${NC} ${BOLD}Kerstel uninstalled.${NC}"
