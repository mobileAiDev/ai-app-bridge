import Foundation
import CoreFoundation

/// Owns only the selected SDK application's idle timer, while that app is active.
/// The Host renews a short platform TTL independently of the longer work lease.
final class IOSPowerLeaseController {
    private let readIdleDisabled: () -> Bool
    private let writeIdleDisabled: (Bool) -> Void
    private let isForeground: () -> Bool
    private let now: () -> TimeInterval
    private let automaticallySchedule: Bool
    private var deadlines: [String: TimeInterval] = [:]
    private var originalIdleDisabled: Bool?
    private var timer: DispatchWorkItem?
    var backgroundObserver: NSObjectProtocol?

    init(readIdleDisabled: @escaping () -> Bool, writeIdleDisabled: @escaping (Bool) -> Void,
         isForeground: @escaping () -> Bool, now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         automaticallySchedule: Bool = true) {
        self.readIdleDisabled = readIdleDisabled
        self.writeIdleDisabled = writeIdleDisabled
        self.isForeground = isForeground
        self.now = now
        self.automaticallySchedule = automaticallySchedule
    }

    deinit {
        timer?.cancel()
        if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
    }

    private var coverage: [String: Any] {
        ["mechanism": "UIApplication.isIdleTimerDisabled", "scope": "selected-sdk-app-foreground",
         "supportedModes": ["display"], "system": false, "display": true, "externalApps": false,
         "manualSleep": "not_prevented", "unlock": false]
    }

    private func failure(_ error: String, _ message: String) -> [String: Any] {
        ["ok": false, "error": error, "message": message, "coverage": coverage, "dispatched": false, "ambiguous": false]
    }

    func control(_ request: [String: Any]) -> [String: Any] {
        precondition(Thread.isMainThread)
        expire()
        guard let operation = request["operation"] as? String, let leaseId = request["leaseId"] as? String,
              UUID(uuidString: leaseId) != nil, ["acquire", "renew", "release", "status"].contains(operation) else {
            return failure("invalid_power_request", "Supply a power operation and UUID leaseId.")
        }
        let allowed: Set<String> = operation == "acquire" ? ["operation", "leaseId", "mode", "ttlMs"] :
            operation == "renew" ? ["operation", "leaseId", "ttlMs"] : ["operation", "leaseId"]
        guard Set(request.keys).isSubset(of: allowed) else {
            return failure("invalid_power_request", "The power request contains unsupported fields.")
        }
        if operation == "release" {
            deadlines.removeValue(forKey: leaseId)
            reconcile()
            return ["ok": true, "released": true, "leaseId": leaseId, "coverage": coverage]
        }
        if operation == "status" {
            return ["ok": true, "leaseId": leaseId, "active": deadlines[leaseId] != nil,
                    "remainingMs": max(0, (deadlines[leaseId] ?? now()) - now()) * 1000,
                    "idleTimerDisabled": readIdleDisabled(), "foreground": isForeground(), "coverage": coverage]
        }
        if operation == "acquire" && request["mode"] as? String != "display" {
            return failure("power_mode_unsupported", "The iOS SDK supports display mode only for its active foreground app.")
        }
        guard let ttl = request["ttlMs"] as? NSNumber, CFGetTypeID(ttl) != CFBooleanGetTypeID(),
              ttl.doubleValue.rounded() == ttl.doubleValue, ttl.doubleValue >= 1, ttl.doubleValue <= 300000 else {
            return failure("invalid_power_request", "ttlMs must be an integer from 1 to 300000.")
        }
        guard isForeground() else {
            releaseAll()
            return failure("power_ios_app_not_foreground", "Open the selected SDK app before acquiring its display lease.")
        }
        if operation == "acquire" && deadlines[leaseId] != nil {
            return failure("power_lease_exists", "This lease already exists. Use renew to extend its platform TTL.")
        }
        if operation == "renew" && deadlines[leaseId] == nil {
            return failure("power_lease_ended", "The iOS display lease expired or was released. Acquire a new work lease.")
        }
        if deadlines.isEmpty { originalIdleDisabled = readIdleDisabled() }
        deadlines[leaseId] = now() + ttl.doubleValue / 1000
        writeIdleDisabled(true)
        reconcile()
        return ["ok": true, "leaseId": leaseId, "coverage": coverage, "remainingMs": ttl.intValue]
    }

    func releaseAll() {
        precondition(Thread.isMainThread)
        deadlines.removeAll()
        reconcile()
    }

    private func expire() {
        let instant = now()
        deadlines = deadlines.filter { $0.value > instant }
        reconcile()
    }

    private func reconcile() {
        timer?.cancel()
        timer = nil
        if deadlines.isEmpty {
            if let originalIdleDisabled { writeIdleDisabled(originalIdleDisabled) }
            originalIdleDisabled = nil
        } else if automaticallySchedule, let next = deadlines.values.min() {
            let task = DispatchWorkItem { [weak self] in self?.expire() }
            timer = task
            DispatchQueue.main.asyncAfter(deadline: .now() + max(0, next - now()), execute: task)
        }
    }
}

#if canImport(UIKit)
import UIKit

extension IOSPowerLeaseController {
    static func application() -> IOSPowerLeaseController {
        let controller = IOSPowerLeaseController(readIdleDisabled: { UIApplication.shared.isIdleTimerDisabled },
            writeIdleDisabled: { UIApplication.shared.isIdleTimerDisabled = $0 },
            isForeground: { UIApplication.shared.applicationState == .active })
        controller.backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification,
            object: nil, queue: .main) { [weak controller] _ in controller?.releaseAll() }
        return controller
    }
}
#endif
