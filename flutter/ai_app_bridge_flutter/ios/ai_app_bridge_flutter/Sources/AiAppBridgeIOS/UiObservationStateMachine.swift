import Foundation

struct UiChangeChannels: Equatable {
    let semanticChanged: Bool
    let renderChanged: Bool

    static func between(
        previousSemantic: String,
        currentSemantic: String,
        previousRender: String,
        currentRender: String,
        hasActiveAnimations: Bool
    ) -> UiChangeChannels {
        UiChangeChannels(
            semanticChanged: previousSemantic != currentSemantic,
            renderChanged: previousRender != currentRender || hasActiveAnimations
        )
    }
}

struct UiObservationEmission: Equatable {
    enum Kind: String {
        case changed
        case stable
    }

    let kind: Kind
    let fingerprint: String
    let previousFingerprint: String?
    let observedAtMs: Int64
    let stableForMs: Int64
    let coalescedSamples: Int
    let hasActiveAnimations: Bool
}

struct UiObservationStateMachine {
    struct Configuration {
        let minChangeEmissionIntervalMs: Int64
        let stableAfterMs: Int64
        let maxCoalescedSamples: Int

        init(
            minChangeEmissionIntervalMs: Int64 = 100,
            stableAfterMs: Int64 = 300,
            maxCoalescedSamples: Int = 1_000
        ) {
            self.minChangeEmissionIntervalMs = max(1, minChangeEmissionIntervalMs)
            self.stableAfterMs = max(1, stableAfterMs)
            self.maxCoalescedSamples = max(1, maxCoalescedSamples)
        }
    }

    private let configuration: Configuration
    private var currentFingerprint: String?
    private var currentHasActiveAnimations = false
    private var lastObservedAtMs: Int64?
    private var lastChangeAtMs: Int64?
    private var lastEmissionAtMs: Int64?
    private var lastEmittedFingerprint: String?
    private var pendingChange = false
    private var coalescedSamples = 0
    private var dirty = false

    init(configuration: Configuration = Configuration()) {
        self.configuration = configuration
    }

    mutating func observe(
        fingerprint: String,
        atMs: Int64,
        hasActiveAnimations: Bool
    ) -> UiObservationEmission? {
        let observedAtMs = max(atMs, lastObservedAtMs ?? atMs)
        lastObservedAtMs = observedAtMs

        guard let previousSampleFingerprint = currentFingerprint else {
            currentFingerprint = fingerprint
            currentHasActiveAnimations = hasActiveAnimations
            lastChangeAtMs = observedAtMs
            dirty = true
            return emitChanged(atMs: observedAtMs)
        }

        let sampleChanged = previousSampleFingerprint != fingerprint
            || currentHasActiveAnimations != hasActiveAnimations
        currentFingerprint = fingerprint
        currentHasActiveAnimations = hasActiveAnimations

        if sampleChanged {
            lastChangeAtMs = observedAtMs
            dirty = true
            if !pendingChange,
               elapsed(since: lastEmissionAtMs, at: observedAtMs) >= configuration.minChangeEmissionIntervalMs {
                return emitChanged(atMs: observedAtMs)
            }
            pendingChange = true
            coalescedSamples = min(coalescedSamples + 1, configuration.maxCoalescedSamples)
        } else if hasActiveAnimations {
            // A static model-layer fingerprint can still have an active presentation-layer
            // animation. Keep the observation dirty until motion actually stops.
            lastChangeAtMs = observedAtMs
            dirty = true
        }

        if pendingChange, elapsed(since: lastEmissionAtMs, at: observedAtMs) >= configuration.minChangeEmissionIntervalMs {
            return emitChanged(atMs: observedAtMs)
        }

        guard dirty,
              !pendingChange,
              !hasActiveAnimations,
              let lastChangeAtMs,
              observedAtMs - lastChangeAtMs >= configuration.stableAfterMs,
              elapsed(since: lastEmissionAtMs, at: observedAtMs) >= configuration.minChangeEmissionIntervalMs else {
            return nil
        }

        dirty = false
        lastEmissionAtMs = observedAtMs
        return UiObservationEmission(
            kind: .stable,
            fingerprint: fingerprint,
            previousFingerprint: nil,
            observedAtMs: observedAtMs,
            stableForMs: max(0, observedAtMs - lastChangeAtMs),
            coalescedSamples: 0,
            hasActiveAnimations: false
        )
    }

    private mutating func emitChanged(atMs: Int64) -> UiObservationEmission {
        let fingerprint = currentFingerprint ?? ""
        let emission = UiObservationEmission(
            kind: .changed,
            fingerprint: fingerprint,
            previousFingerprint: lastEmittedFingerprint,
            observedAtMs: atMs,
            stableForMs: 0,
            coalescedSamples: coalescedSamples,
            hasActiveAnimations: currentHasActiveAnimations
        )
        lastEmissionAtMs = atMs
        lastEmittedFingerprint = fingerprint
        pendingChange = false
        coalescedSamples = 0
        return emission
    }

    private func elapsed(since previous: Int64?, at current: Int64) -> Int64 {
        guard let previous else { return Int64.max }
        return max(0, current - previous)
    }
}
