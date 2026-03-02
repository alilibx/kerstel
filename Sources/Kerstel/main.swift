import AppKit
import KerstelCore

let app = NSApplication.shared
NSApp.setActivationPolicy(.accessory)

let delegate = AppDelegate()
app.delegate = delegate

app.run()
