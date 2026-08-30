import 'package:ai_app_bridge_flutter/src/ui_observation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('samples a frame burst and emits stable only once', () {
    final AiAppBridgeUiBurstTracker tracker = AiAppBridgeUiBurstTracker();

    final List<AiAppBridgeUiTransition> first =
        tracker.addFrames(nowMs: 1000, count: 2);
    expect(
      first.map((AiAppBridgeUiTransition item) => item.phase),
      <AiAppBridgeUiPhase>[
        AiAppBridgeUiPhase.started,
        AiAppBridgeUiPhase.changed,
      ],
    );
    expect(first.last.frameCount, 2);

    expect(tracker.addFrames(nowMs: 1050, count: 3), isEmpty);
    final List<AiAppBridgeUiTransition> sampled =
        tracker.addFrames(nowMs: 1110, count: 1);
    expect(sampled.single.phase, AiAppBridgeUiPhase.changed);
    expect(sampled.single.frameCount, 6);

    expect(tracker.settle(1300), isNull);
    final AiAppBridgeUiTransition stable = tracker.settle(1360)!;
    expect(stable.phase, AiAppBridgeUiPhase.stable);
    expect(stable.frameCount, 6);
    expect(tracker.settle(2000), isNull);
  });

  test('a frame after stability starts a new burst', () {
    final AiAppBridgeUiBurstTracker tracker = AiAppBridgeUiBurstTracker();
    tracker.addFrames(nowMs: 1000, count: 1);
    expect(tracker.settle(1250)?.burstId, 1);

    final List<AiAppBridgeUiTransition> next =
        tracker.addFrames(nowMs: 1300, count: 1);
    expect(next.first.phase, AiAppBridgeUiPhase.started);
    expect(next.first.burstId, 2);
  });
}
