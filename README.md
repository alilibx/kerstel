<div align="center">

```
██╗  ██╗███████╗██████╗ ███████╗████████╗███████╗██╗
██║ ██╔╝██╔════╝██╔══██╗██╔════╝╚══██╔══╝██╔════╝██║
█████╔╝ █████╗  ██████╔╝███████╗   ██║   █████╗  ██║
██╔═██╗ ██╔══╝  ██╔══██╗╚════██║   ██║   ██╔══╝  ██║
██║  ██╗███████╗██║  ██║███████║   ██║   ███████╗███████╗
╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝   ╚═╝   ╚══════╝╚══════╝
```

**macOS menu bar system monitor**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![macOS 14+](https://img.shields.io/badge/macOS-14%2B-blue.svg)](https://www.apple.com/macos/sonoma/)
[![Swift](https://img.shields.io/badge/Swift-5.9%2B-orange.svg)](https://swift.org)
[![GitHub release](https://img.shields.io/github/v/release/alilibx/kerstel)](https://github.com/alilibx/kerstel/releases)

A lightweight native app that lives in your menu bar and shows your system vitals at a glance. No Electron. No web views. No telemetry. Just Swift reading system commands and showing you the numbers.

[Install](#install) · [Features](#features) · [CLI](#cli) · [Build from source](#build-from-source) · [Contributing](#contributing)

</div>

---

## Install

```bash
curl -fsSL https://alilibx.github.io/kerstel/install.sh | bash
```

Clones the repo, builds a release binary, installs the `kerstel` CLI to your PATH, and sets up a launch agent to start on login. The **K** icon appears in your menu bar immediately.

> **Requirements:** macOS 14 (Sonoma) or later · Swift (ships with [Xcode Command Line Tools](https://developer.apple.com/xcode/resources/))

## Features

| | Feature | Details |
|---|---------|---------|
| 🧠 | **Memory** | Total, used, free, active, wired, compressed, cached — with a usage bar |
| ⚡ | **CPU** | User / system / idle %, 1/5/15 min load averages, chip name |
| 💾 | **Disk** | Total / used / free GB, capacity percentage |
| 🎮 | **GPU** | Chip name, core count, Metal version, VRAM |
| 🔋 | **Battery** | Charge %, power source, charging state, time remaining |
| 📊 | **Processes** | Top 5 by CPU or memory — name, PID, usage. Kill with one click |
| 🌐 | **Ports** | Listening TCP ports — port, process name, full path, PID. Kill with one click |
| 🧹 | **Cleanup** | Purge memory, clear user caches, flush DNS (requests admin) |

Refreshes every 4 seconds. GPU info is cached (it doesn't change).

## CLI

The installer adds a `kerstel` command to your PATH:

```bash
kerstel open          # 🚀  Launch the menu bar app
kerstel stop          # 🛑  Stop the app
kerstel restart       # 🔄  Restart the app
kerstel status        # 📡  Check if it's running
kerstel update        # ⬆️   Pull latest version, rebuild, restart
kerstel version       # 🏷️   Show installed version
kerstel uninstall     # 🗑️   Remove everything
kerstel help          # 📖  Show all commands
```

> Closed the app by accident? Just run `kerstel open`.

## Build from source

```bash
git clone https://github.com/alilibx/kerstel.git
cd kerstel
swift build -c release
.build/release/Kerstel
```

## Run tests

28 tests covering metrics parsing, port parsing, and model logic.

```bash
swift test
```

<details>
<summary>Command Line Tools only (no Xcode)?</summary>

```bash
DYLD_FRAMEWORK_PATH=/Library/Developer/CommandLineTools/Library/Developer/Frameworks \
swift test \
  -Xswiftc -F/Library/Developer/CommandLineTools/Library/Developer/Frameworks \
  -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/Frameworks
```

</details>

## Project structure

```
Sources/
├── Kerstel/                  # Executable entry point
│   └── main.swift
├── KerstelCore/              # Library — all app logic
│   ├── AppDelegate.swift     # Menu bar setup, popover, timers
│   ├── IconGenerator.swift   # Draws the "K" icon
│   ├── Models/               # Data structs (metrics, ports, cleanup)
│   ├── Services/             # Shell execution, metrics, ports, cleanup
│   └── Views/                # SwiftUI views for each section
Tests/
└── KerstelTests/             # 28 tests with mock shell fixtures
```

## Update

```bash
kerstel update
```

Or manually:

```bash
cd ~/.kerstel && git pull && swift build -c release
```

## Uninstall

```bash
kerstel uninstall
sudo rm /usr/local/bin/kerstel
```

## Contributing

Contributions are welcome! Here's how:

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run the tests (`swift test`)
5. Commit (`git commit -m 'Add my feature'`)
6. Push (`git push origin feature/my-feature`)
7. Open a Pull Request

Please keep PRs focused — one feature or fix per PR.

## License

[MIT](LICENSE) — free to use, modify, and distribute.

---

<div align="center">

Built with Swift on macOS.

**[alilibx.github.io/kerstel](https://alilibx.github.io/kerstel)**

</div>
