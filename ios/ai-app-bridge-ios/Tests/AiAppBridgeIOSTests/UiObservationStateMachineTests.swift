import XCTest
@testable import AiAppBridgeIOS

final class UiObservationStateMachineTests: XCTestCase {
    func testChangeChannelsSeparateSemanticContentFromAnimationFrames() {
        XCTAssertEqual(
            UiChangeChannels.between(
                previousSemantic: "counter-20",
                currentSemantic: "counter-21",
                previousRender: "frame-a",
                currentRender: "frame-a",
                hasActiveAnimations: false
            ),
            UiChangeChannels(semanticChanged: true, renderChanged: false)
        )
        XCTAssertEqual(
            UiChangeChannels.between(
                previousSemantic: "dialog-closed",
                currentSemantic: "dialog-closed",
                previousRender: "frame-a",
                currentRender: "frame-b",
                hasActiveAnimations: true
            ),
            UiChangeChannels(semanticChanged: false, renderChanged: true)
        )
    }

    private let configuration = UiObservationStateMachine.Configuration(
        minChangeEmissionIntervalMs: 100,
        stableAfterMs: 300,
        maxCoalescedSamples: 3
    )

    func testFirstSampleEmitsChangedBaseline() {
        var machine = UiObservationStateMachine(configuration: configuration)

        let emission = machine.observe(
            fingerprint: "screen-a",
            atMs: 1_000,
            hasActiveAnimations: false
        )

        XCTAssertEqual(emission?.kind, .changed)
        XCTAssertEqual(emission?.fingerprint, "screen-a")
        XCTAssertNil(emission?.previousFingerprint)
        XCTAssertEqual(emission?.coalescedSamples, 0)
    }

    func testRapidChangesAreCoalescedAndEmitLatestFingerprint() {
        var machine = UiObservationStateMachine(configuration: configuration)
        _ = machine.observe(fingerprint: "a", atMs: 1_000, hasActiveAnimations: false)

        XCTAssertNil(machine.observe(fingerprint: "b", atMs: 1_020, hasActiveAnimations: true))
        XCTAssertNil(machine.observe(fingerprint: "c", atMs: 1_040, hasActiveAnimations: true))
        let emission = machine.observe(fingerprint: "c", atMs: 1_100, hasActiveAnimations: true)

        XCTAssertEqual(emission?.kind, .changed)
        XCTAssertEqual(emission?.fingerprint, "c")
        XCTAssertEqual(emission?.previousFingerprint, "a")
        XCTAssertEqual(emission?.coalescedSamples, 2)
        XCTAssertEqual(emission?.hasActiveAnimations, true)
    }

    func testSpacedChangeIsEmittedWithoutClaimingItWasCoalesced() {
        var machine = UiObservationStateMachine(configuration: configuration)
        _ = machine.observe(fingerprint: "a", atMs: 1_000, hasActiveAnimations: false)

        let emission = machine.observe(fingerprint: "b", atMs: 1_100, hasActiveAnimations: false)

        XCTAssertEqual(emission?.kind, .changed)
        XCTAssertEqual(emission?.fingerprint, "b")
        XCTAssertEqual(emission?.coalescedSamples, 0)
    }

    func testActiveAnimationPreventsStableUntilItStopsAndQuietPeriodPasses() {
        var machine = UiObservationStateMachine(configuration: configuration)
        _ = machine.observe(fingerprint: "a", atMs: 1_000, hasActiveAnimations: true)

        XCTAssertNil(machine.observe(fingerprint: "a", atMs: 1_400, hasActiveAnimations: true))
        XCTAssertEqual(
            machine.observe(fingerprint: "a", atMs: 1_500, hasActiveAnimations: false)?.kind,
            .changed
        )
        XCTAssertNil(machine.observe(fingerprint: "a", atMs: 1_799, hasActiveAnimations: false))
        let stable = machine.observe(fingerprint: "a", atMs: 1_800, hasActiveAnimations: false)

        XCTAssertEqual(stable?.kind, .stable)
        XCTAssertEqual(stable?.stableForMs, 300)
        XCTAssertEqual(stable?.hasActiveAnimations, false)
    }

    func testStableIsEmittedOnlyOnceUntilAnotherChange() {
        var machine = UiObservationStateMachine(configuration: configuration)
        _ = machine.observe(fingerprint: "a", atMs: 1_000, hasActiveAnimations: false)

        XCTAssertEqual(
            machine.observe(fingerprint: "a", atMs: 1_300, hasActiveAnimations: false)?.kind,
            .stable
        )
        XCTAssertNil(machine.observe(fingerprint: "a", atMs: 2_000, hasActiveAnimations: false))

        XCTAssertEqual(
            machine.observe(fingerprint: "b", atMs: 2_100, hasActiveAnimations: false)?.kind,
            .changed
        )
        XCTAssertEqual(
            machine.observe(fingerprint: "b", atMs: 2_400, hasActiveAnimations: false)?.kind,
            .stable
        )
    }

    func testCoalescedSampleCountIsBounded() {
        var machine = UiObservationStateMachine(configuration: configuration)
        _ = machine.observe(fingerprint: "a", atMs: 1_000, hasActiveAnimations: false)

        for index in 1...20 {
            _ = machine.observe(
                fingerprint: "pending-\(index)",
                atMs: Int64(1_000 + index),
                hasActiveAnimations: true
            )
        }
        let emission = machine.observe(
            fingerprint: "pending-20",
            atMs: 1_100,
            hasActiveAnimations: true
        )

        XCTAssertEqual(emission?.kind, .changed)
        XCTAssertEqual(emission?.fingerprint, "pending-20")
        XCTAssertEqual(emission?.coalescedSamples, 3)
    }

    func testOutOfOrderTimestampDoesNotProduceNegativeDurations() {
        var machine = UiObservationStateMachine(configuration: configuration)
        _ = machine.observe(fingerprint: "a", atMs: 1_000, hasActiveAnimations: false)

        XCTAssertNil(machine.observe(fingerprint: "b", atMs: 900, hasActiveAnimations: false))
        let emission = machine.observe(fingerprint: "b", atMs: 1_100, hasActiveAnimations: false)

        XCTAssertEqual(emission?.kind, .changed)
        XCTAssertEqual(emission?.observedAtMs, 1_100)
        XCTAssertGreaterThanOrEqual(emission?.coalescedSamples ?? -1, 0)
    }
}
