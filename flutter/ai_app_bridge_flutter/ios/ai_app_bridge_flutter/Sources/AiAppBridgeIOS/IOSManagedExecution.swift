import CoreFoundation
import CryptoKit
import Foundation

// Construction/start only enqueue work. Each mutation must obtain permission
// immediately before dispatch; stop cannot manufacture an App completion.
protocol IOSManagedTask: AnyObject {
    func start(check: @escaping () -> [String: Any], complete: @escaping ([String: Any]) -> Void)
    func stop(reason: String)
}

final class IOSManagedExecution {
    typealias Reply = ([String: Any]) -> Void
    private let queue = DispatchQueue(label: "io.github.mobileaidev.aiappbridge.ios.execution")
    private let queueKey = DispatchSpecificKey<Bool>()
    private let receipts: IOSExecutionReceiptStore
    private let epoch: (String) -> String?
    private let graceMs: Int
    private var active: Operation?
    private var lastIdentity: String?

    init(receipts: IOSExecutionReceiptStore, graceMs: Int = 1500, epoch: @escaping (String) -> String?) {
        self.receipts = receipts
        self.epoch = epoch
        self.graceMs = graceMs
        queue.setSpecific(key: queueKey, value: true)
    }

    static func schema(_ kind: String) -> String { "aab.\(kind)-execution/v1" }

    func submit(kind: String, body: [String: Any], task: @escaping () -> IOSManagedTask, reply: @escaping Reply) {
        queue.async { [self] in
            guard ["h5", "flutter"].contains(kind), let execution = body["execution"] as? [String: Any],
                  Set(execution.keys) == ["schemaVersion", "actionId", "runtimeEpoch", "timeoutMs"],
                  execution["schemaVersion"] as? String == Self.schema(kind),
                  let id = Self.text(execution["actionId"]), let runtime = Self.text(execution["runtimeEpoch"]),
                  body["actionId"] as? String == id, let timeout = Self.integer(execution["timeoutMs"]),
                  timeout > 0, timeout <= 2_147_483_647 else { reply(Self.failure("invalid_ios_execution")); return }
            guard epoch(kind) == runtime else { reply(Self.failure("\(kind)_runtime_changed")); return }
            guard active == nil else { reply(Self.failure("ios_action_busy")); return }
            let key = "\(kind):\(runtime):\(id)"
            guard key != lastIdentity else { reply(Self.failure("ios_action_id_reused")); return }
            let op = Operation(kind: kind, actionId: id, epoch: runtime, timeout: timeout, task: task(), reply: reply)
            active = op
            let deadline = DispatchWorkItem { [weak self, weak op] in
                if let self, let op { self.stop(op, reason: "\(kind)_action_timeout") }
            }
            op.deadlineTimer = deadline
            queue.asyncAfter(deadline: .now() + .milliseconds(timeout), execute: deadline)
            receipts.ready { ready in
                self.queue.async {
                    guard self.active === op, op.candidate == nil else { return }
                    guard ready else {
                        self.rejectUnstarted(op, result: Self.failure("ios_completion_store_unavailable")); return
                    }
                    guard op.stopReason == nil else { return }
                    op.task.start(check: { self.permission(kind: kind, actionId: id, epoch: runtime) }, complete: { result in
                        self.queue.async { self.complete(op, result: result) }
                    })
                }
            }
        }
    }

    func permission(kind: String, actionId: String, epoch expectedEpoch: String) -> [String: Any] {
        state {
            guard let op = active, op.kind == kind, op.actionId == actionId, op.epoch == expectedEpoch else {
                return Self.failure("\(kind)_action_not_active")
            }
            guard op.candidate == nil, op.stopReason == nil else { return Self.failure(op.stopReason ?? "ios_action_finishing") }
            guard epoch(kind) == op.epoch else {
                stop(op, reason: "\(kind)_runtime_changed"); return Self.failure("\(kind)_runtime_changed")
            }
            let now = DispatchTime.now().uptimeNanoseconds
            let remaining = Int((op.deadline.uptimeNanoseconds > now
                ? op.deadline.uptimeNanoseconds - now : 0) / 1_000_000)
            guard remaining > 0 else {
                stop(op, reason: "\(kind)_action_timeout"); return Self.failure("\(kind)_action_timeout")
            }
            op.permissionIssued = true
            return identity(op).merging(["ok": true, "remainingMs": remaining]) { _, new in new }
        }
    }

    func cancel(kind: String, actionId: String, epoch: String, reply: @escaping Reply) {
        queue.async { [self] in
            guard let op = active, op.kind == kind, op.actionId == actionId, op.epoch == epoch else {
                receipts.lookup(kind: kind, actionId: actionId, epoch: epoch, reply: reply); return
            }
            guard op.cancelReply == nil else { reply(pending(op, "ios_action_cancel_pending")); return }
            op.cancelReply = reply
            if op.persistFailed { persist(op); return }
            stop(op, reason: "\(kind)_action_cancelled")
            if op.cleanupExpired {
                op.cancelReply?(pending(op, "ios_action_cancel_pending")); op.cancelReply = nil
            }
        }
    }

    func status() -> [String: Any] {
        state {
            guard let op = active else { return ["ok": true, "active": NSNull()] }
            return ["ok": true, "active": identity(op).merging([
                "kind": op.kind, "settled": false, "permissionIssued": op.permissionIssued,
                "stopReason": op.stopReason as Any? ?? NSNull(), "persisting": op.persisting,
                "persistenceFailed": op.persistFailed
            ]) { _, new in new }]
        }
    }

    private func stop(_ op: Operation, reason: String) {
        guard active === op else { return }
        if op.candidate != nil { scheduleCleanup(op); return }
        guard op.stopReason == nil else { return }
        op.stopReason = reason
        op.task.stop(reason: reason)
        if !op.permissionIssued {
            // A late main-thread block or Dart callback will fail permission.
            finish(op, result: Self.failure(reason))
        } else { scheduleCleanup(op) }
    }

    private func scheduleCleanup(_ op: Operation) {
        guard op.cleanupTimer == nil else { return }
        let cleanup = DispatchWorkItem { [weak self, weak op] in
            guard let self, let op, self.active === op else { return }
            op.cleanupExpired = true
            op.reply?(self.pending(op, op.stopReason ?? "ios_completion_pending")); op.reply = nil
            op.cancelReply?(self.pending(op, "ios_action_cancel_pending")); op.cancelReply = nil
        }
        op.cleanupTimer = cleanup
        queue.asyncAfter(deadline: .now() + .milliseconds(graceMs), execute: cleanup)
    }

    private func complete(_ op: Operation, result: [String: Any]) {
        guard active === op, op.candidate == nil else { return }
        guard Self.validOutcome(result), op.kind != "flutter" || Self.validExecution(result["execution"],
            kind: op.kind, actionId: op.actionId, epoch: op.epoch) else {
            stop(op, reason: "invalid_\(op.kind)_execution_receipt"); return
        }
        finish(op, result: result)
    }

    private func finish(_ op: Operation, result: [String: Any]) {
        guard active === op, op.candidate == nil else { return }
        var final = result
        if let reason = op.stopReason { final["ok"] = false; final["error"] = reason }
        final["actionId"] = op.actionId
        final["runtimeEpoch"] = op.epoch
        final["settled"] = true
        final["execution"] = identity(op).merging(["settled": true]) { _, new in new }
        let bytes = JSONSerialization.isValidJSONObject(final)
            ? try? JSONSerialization.data(withJSONObject: final, options: [.sortedKeys]) : nil
        if bytes == nil || bytes!.count > 64 * 1024 {
            // The callback did finish, but the requested result cannot be
            // retained. Persist an explicit terminal failure, preserving the
            // dispatch outcome rather than leaving a completed task occupied.
            final = ["ok": false, "error": bytes == nil ? "invalid_ios_execution_result" : "ios_action_result_too_large", "dispatched": final["dispatched"]!,
                     "ambiguous": final["ambiguous"]!, "actionId": op.actionId, "runtimeEpoch": op.epoch,
                     "settled": true, "execution": final["execution"]!]
            if let bytes {
                final["originalResultSha256"] = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            }
        }
        op.candidate = final
        persist(op)
    }

    private func persist(_ op: Operation) {
        guard active === op, !op.persisting, let result = op.candidate else { return }
        op.persisting = true; op.persistFailed = false
        scheduleCleanup(op)
        receipts.commit(kind: op.kind, result: result) { committed in
            self.queue.async {
                guard self.active === op else { return }
                op.persisting = false
                guard committed else {
                    op.persistFailed = true
                    op.reply?(self.pending(op, "ios_completion_persistence_failed")); op.reply = nil
                    op.cancelReply?(self.pending(op, "ios_completion_persistence_failed")); op.cancelReply = nil
                    return
                }
                op.deadlineTimer?.cancel(); op.cleanupTimer?.cancel()
                self.lastIdentity = "\(op.kind):\(op.epoch):\(op.actionId)"
                self.active = nil
                op.reply?(result); op.reply = nil
                op.cancelReply?(["ok": true, "actionId": op.actionId, "runtimeEpoch": op.epoch, "executionResult": result]); op.cancelReply = nil
            }
        }
    }

    private func rejectUnstarted(_ op: Operation, result: [String: Any]) {
        guard active === op, !op.permissionIssued else { return }
        op.deadlineTimer?.cancel(); active = nil
        op.reply?(result); op.reply = nil
    }

    private func identity(_ op: Operation) -> [String: Any] {
        ["schemaVersion": Self.schema(op.kind), "actionId": op.actionId, "runtimeEpoch": op.epoch]
    }

    private func pending(_ op: Operation, _ error: String) -> [String: Any] {
        identity(op).merging(["ok": false, "error": error, "settled": false,
                             "dispatched": NSNull(), "ambiguous": true]) { _, new in new }
    }

    private func state<T>(_ body: () -> T) -> T {
        DispatchQueue.getSpecific(key: queueKey) == true ? body() : queue.sync(execute: body)
    }

    static func validTerminal(_ value: [String: Any], kind: String, actionId: String, epoch: String) -> Bool {
        validOutcome(value) && bool(value["settled"]) == true && value["actionId"] as? String == actionId
            && value["runtimeEpoch"] as? String == epoch && validExecution(value["execution"], kind: kind, actionId: actionId, epoch: epoch)
    }

    private static func validExecution(_ raw: Any?, kind: String, actionId: String, epoch: String) -> Bool {
        guard let value = raw as? [String: Any], Set(value.keys) == ["schemaVersion", "actionId", "runtimeEpoch", "settled"] else { return false }
        return value["schemaVersion"] as? String == schema(kind) && value["actionId"] as? String == actionId
            && value["runtimeEpoch"] as? String == epoch && bool(value["settled"]) == true
    }

    private static func validOutcome(_ value: [String: Any]) -> Bool {
        guard let ok = bool(value["ok"]), bool(value["dispatched"]) != nil, let ambiguous = bool(value["ambiguous"]) else { return false }
        return ok ? !ambiguous : text(value["error"]) != nil
    }

    static func bool(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue >= 0, number.doubleValue <= 9_007_199_254_740_991,
              number.doubleValue == Double(number.int64Value) else { return nil }
        return Int(number.int64Value)
    }

    static func text(_ value: Any?) -> String? {
        guard let text = value as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf8.count <= 256 else { return nil }
        return text
    }

    static func failure(_ error: String) -> [String: Any] {
        ["ok": false, "error": error, "dispatched": false, "ambiguous": false]
    }

    private final class Operation {
        let kind: String, actionId: String, epoch: String
        let deadline: DispatchTime
        let task: IOSManagedTask
        var reply: Reply?, cancelReply: Reply?
        var deadlineTimer: DispatchWorkItem?, cleanupTimer: DispatchWorkItem?
        var stopReason: String?
        var permissionIssued = false, cleanupExpired = false, persisting = false, persistFailed = false
        var candidate: [String: Any]?
        init(kind: String, actionId: String, epoch: String, timeout: Int, task: IOSManagedTask, reply: @escaping Reply) {
            self.kind = kind; self.actionId = actionId; self.epoch = epoch; self.task = task; self.reply = reply
            deadline = .now() + .milliseconds(timeout)
        }
    }
}
