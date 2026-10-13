import AppKit
import CoreGraphics
import Foundation
import IOKit

// Independent observations, not an assertion that the emulator can run at full speed.
let root = IORegistryGetRootEntry(kIOMainPortDefault)
let consoleLocked = IORegistryEntryCreateCFProperty(
    root, "IOConsoleLocked" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
IOObjectRelease(root)
let session = CGSessionCopyCurrentDictionary() as? [String: Any]
let frontmost = NSWorkspace.shared.frontmostApplication
var displayCount: UInt32 = 0
var displayError = CGGetOnlineDisplayList(0, nil, &displayCount)
var displays: [[String: Any]] = []
if displayError == .success && displayCount > 0 {
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
    displayError = CGGetOnlineDisplayList(displayCount, &ids, &displayCount)
    if displayError == .success {
        displays = ids.prefix(Int(displayCount)).map {
            ["id": $0, "active": CGDisplayIsActive($0) != 0,
             "asleep": CGDisplayIsAsleep($0) != 0]
        }
    }
}
var result: [String: Any] = [
    "atMs": Int64(Date().timeIntervalSince1970 * 1000),
    "monotonicMs": DispatchTime.now().uptimeNanoseconds / 1_000_000,
    "ioConsoleLocked": consoleLocked as? Bool ?? NSNull() as Any,
    "sessionScreenLocked": session?["CGSSessionScreenIsLocked"] as? Bool ?? NSNull() as Any,
    "sessionOnConsole": session?["kCGSSessionOnConsoleKey"] as? Bool ?? NSNull() as Any,
    "frontmostBundleId": frontmost?.bundleIdentifier ?? NSNull() as Any,
    "frontmostPid": frontmost?.processIdentifier ?? NSNull() as Any,
    "displays": displays,
    "displayQueryError": displayError.rawValue,
]
if CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]) {
    let app = NSRunningApplication(processIdentifier: pid)
    result["emulator"] = [
        "pid": pid,
        "active": app?.isActive ?? NSNull() as Any,
        "hidden": app?.isHidden ?? NSNull() as Any,
        "launchedAtMs": app?.launchDate.map { Int64($0.timeIntervalSince1970 * 1000) } ?? NSNull() as Any,
    ]
}
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data([10]))
