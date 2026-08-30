enum AiAppBridgeUiPhase { started, changed, stable }

class AiAppBridgeUiTransition {
  const AiAppBridgeUiTransition({
    required this.phase,
    required this.burstId,
    required this.frameCount,
    required this.elapsedMs,
  });

  final AiAppBridgeUiPhase phase;
  final int burstId;
  final int frameCount;
  final int elapsedMs;
}

class AiAppBridgeUiBurstTracker {
  AiAppBridgeUiBurstTracker({
    this.stableAfterMs = 250,
    this.sampleIntervalMs = 100,
  });

  final int stableAfterMs;
  final int sampleIntervalMs;

  int _burstId = 0;
  int _frameCount = 0;
  int? _startedAtMs;
  int? _lastFrameAtMs;
  int? _lastSampleAtMs;
  bool _stableEmitted = true;

  int get burstId => _burstId;
  int get frameCount => _frameCount;
  int? get lastFrameAtMs => _lastFrameAtMs;

  List<AiAppBridgeUiTransition> addFrames({
    required int nowMs,
    required int count,
  }) {
    if (count < 1) return const <AiAppBridgeUiTransition>[];
    final bool startsBurst = _lastFrameAtMs == null ||
        _stableEmitted ||
        nowMs - _lastFrameAtMs! >= stableAfterMs;
    final List<AiAppBridgeUiTransition> transitions =
        <AiAppBridgeUiTransition>[];
    if (startsBurst) {
      _burstId += 1;
      _frameCount = 0;
      _startedAtMs = nowMs;
      _lastSampleAtMs = null;
      _stableEmitted = false;
      transitions.add(_transition(AiAppBridgeUiPhase.started, nowMs));
    }
    _frameCount += count;
    _lastFrameAtMs = nowMs;
    if (_lastSampleAtMs == null ||
        nowMs - _lastSampleAtMs! >= sampleIntervalMs) {
      _lastSampleAtMs = nowMs;
      transitions.add(_transition(AiAppBridgeUiPhase.changed, nowMs));
    }
    return transitions;
  }

  AiAppBridgeUiTransition? settle(int nowMs) {
    final int? lastFrameAtMs = _lastFrameAtMs;
    if (_stableEmitted || lastFrameAtMs == null) return null;
    if (nowMs - lastFrameAtMs < stableAfterMs) return null;
    _stableEmitted = true;
    return _transition(AiAppBridgeUiPhase.stable, nowMs);
  }

  AiAppBridgeUiTransition _transition(
    AiAppBridgeUiPhase phase,
    int nowMs,
  ) {
    return AiAppBridgeUiTransition(
      phase: phase,
      burstId: _burstId,
      frameCount: _frameCount,
      elapsedMs: _startedAtMs == null ? 0 : nowMs - _startedAtMs!,
    );
  }
}
