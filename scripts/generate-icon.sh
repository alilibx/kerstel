#!/bin/bash
set -euo pipefail

# Generate Kerstel app icon (AppIcon.icns) from a programmatic "K" design
# Uses sips to resize a base PNG into all required sizes

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RESOURCES_DIR="$PROJECT_DIR/Resources"
ICONSET_DIR="$RESOURCES_DIR/AppIcon.iconset"

mkdir -p "$ICONSET_DIR"

# Generate the base 1024x1024 icon using a Swift script
swift - << 'SWIFT'
import AppKit

let size: CGFloat = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

// Background: dark rounded rect
let bgRect = NSRect(x: 0, y: 0, width: size, height: size)
let bgPath = NSBezierPath(roundedRect: bgRect, xRadius: size * 0.22, yRadius: size * 0.22)
NSColor(red: 0.1, green: 0.1, blue: 0.12, alpha: 1.0).setFill()
bgPath.fill()

// Subtle border
let borderRect = bgRect.insetBy(dx: 4, dy: 4)
let borderPath = NSBezierPath(roundedRect: borderRect, xRadius: size * 0.21, yRadius: size * 0.21)
NSColor(red: 0.2, green: 0.2, blue: 0.22, alpha: 1.0).setStroke()
borderPath.lineWidth = 8
borderPath.stroke()

// "K" letter
let font = NSFont.systemFont(ofSize: size * 0.6, weight: .heavy)
let attrs: [NSAttributedString.Key: Any] = [
    .font: font,
    .foregroundColor: NSColor.white
]
let str = NSAttributedString(string: "K", attributes: attrs)
let strSize = str.size()
let point = NSPoint(
    x: (size - strSize.width) / 2,
    y: (size - strSize.height) / 2
)
str.draw(at: point)

image.unlockFocus()

// Save as PNG
guard let tiffData = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiffData),
      let pngData = bitmap.representation(using: .png, properties: [:]) else {
    fputs("Failed to generate icon\n", stderr)
    exit(1)
}

let outputPath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : ProcessInfo.processInfo.environment["ICON_OUTPUT"] ?? "/tmp/kerstel_icon_1024.png"

try pngData.write(to: URL(fileURLWithPath: outputPath))
print("Generated: \(outputPath)")
SWIFT

BASE_PNG="/tmp/kerstel_icon_1024.png"
ICON_OUTPUT="$BASE_PNG" swift - < /dev/null 2>/dev/null || true

# If the Swift script didn't produce the file via env var, check default location
if [[ ! -f "$BASE_PNG" ]]; then
    echo "Error: Failed to generate base icon" >&2
    exit 1
fi

# Generate all required sizes
declare -a SIZES=(16 32 128 256 512)
for sz in "${SIZES[@]}"; do
    sips -z "$sz" "$sz" "$BASE_PNG" --out "$ICONSET_DIR/icon_${sz}x${sz}.png" >/dev/null 2>&1
    double=$((sz * 2))
    sips -z "$double" "$double" "$BASE_PNG" --out "$ICONSET_DIR/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1
done

# 512@2x is just 1024
cp "$BASE_PNG" "$ICONSET_DIR/icon_512x512@2x.png"

# Convert to icns
iconutil --convert icns "$ICONSET_DIR" --output "$RESOURCES_DIR/AppIcon.icns"

# Cleanup
rm -rf "$ICONSET_DIR" "$BASE_PNG"

echo "Generated: $RESOURCES_DIR/AppIcon.icns"
