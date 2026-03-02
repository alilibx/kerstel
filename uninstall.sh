#!/bin/bash
set -euo pipefail

# Delegates to the CLI if available, otherwise runs inline
if command -v kerstel &>/dev/null; then
    kerstel uninstall
    sudo rm -f /usr/local/bin/kerstel
    echo -e " \033[0;32m\xE2\x9C\x94\033[0m  CLI removed"
else
    PLIST_LABEL="com.alilibx.kerstel"
    PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
    INSTALL_DIR="$HOME/.kerstel"

    pkill -f "\.kerstel/.build/release/Kerstel" 2>/dev/null || true
    [[ -f "$PLIST_PATH" ]] && { launchctl unload "$PLIST_PATH" 2>/dev/null || true; rm -f "$PLIST_PATH"; }
    rm -rf "$INSTALL_DIR"
    sudo rm -f /usr/local/bin/kerstel 2>/dev/null || true

    echo -e " \033[0;32m\xE2\x9C\x94\033[0m  \033[1mKerstel uninstalled.\033[0m"
fi
