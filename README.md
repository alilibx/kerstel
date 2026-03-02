# Kerstel

A lightweight macOS menu bar app that shows your system vitals at a glance.

Lives in your menu bar as a **K** icon. Click it to see everything — memory, CPU, disk, GPU, battery, top processes, and listening ports. No Electron, no web views, no background daemons. Just a native Swift app that reads system commands and shows you the numbers.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/alilibx/kerstel/main/install.sh | bash
```

This clones the repo to `~/.kerstel`, builds a release binary, and sets up a launch agent so it starts on login. The **K** icon appears in your menu bar immediately.

Requires **macOS 14 (Sonoma)** or later and **Swift** (ships with [Xcode Command Line Tools](https://developer.apple.com/xcode/resources/)).

## Features

| Section | What it shows |
|---------|---------------|
| **Memory** | Total, used, free, active, wired, compressed, cached — with a usage bar |
| **CPU** | User/system/idle %, 1/5/15 min load averages, chip name |
| **Disk** | Total/used/free GB, capacity percentage |
| **GPU** | Chip name, core count, Metal version, VRAM |
| **Battery** | Charge %, power source, charging state, time remaining |
| **Processes** | Top 5 by CPU or memory — name, PID, usage. Kill any process with one click |
| **Ports** | All listening TCP ports — port number, process name, full path, PID. Kill any with one click |
| **Cleanup** | Purge memory, clear user caches, flush DNS (requests admin password) |

Refreshes every 4 seconds. GPU info is cached (it doesn't change).

## Build from source

```bash
git clone https://github.com/alilibx/kerstel.git
cd kerstel
swift build -c release
.build/release/Kerstel
```

## Run tests

```bash
swift test
```

> **Note:** If you only have Command Line Tools (no Xcode), tests use Swift Testing which requires extra flags:
> ```bash
> DYLD_FRAMEWORK_PATH=/Library/Developer/CommandLineTools/Library/Developer/Frameworks \
> swift test \
>   -Xswiftc -F/Library/Developer/CommandLineTools/Library/Developer/Frameworks \
>   -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/Frameworks
> ```

## Update

```bash
cd ~/.kerstel && git pull && swift build -c release
```

The launch agent will pick up the new binary next time it starts, or you can relaunch manually.

## Uninstall

```bash
~/.kerstel/uninstall.sh
```

Stops the app, removes the launch agent, and deletes `~/.kerstel`.

## Project structure

```
Sources/
├── Kerstel/              # Executable entry point
│   └── main.swift
├── KerstelCore/          # Library (all app logic)
│   ├── AppDelegate.swift
│   ├── IconGenerator.swift
│   ├── Models/
│   ├── Services/
│   └── Views/
Tests/
└── KerstelTests/         # 28 tests covering parsing, models, and services
```

## License

[MIT](LICENSE)
