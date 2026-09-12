part of '../ai_app_bridge_flutter.dart';

// The native SDK owns admission and the deadline while Dart is unable to run.
// A permission is requested before each new mutation. An admitted pointer
// sequence handles its terminal events locally, so transport latency cannot
// change the gesture; native admission stays occupied until it has terminated.
// Cancellation interrupts only Bridge-owned waits; App futures must settle.
class _FlutterActionLifetime {
  _FlutterActionLifetime(this.actionId, this.runtimeEpoch);
  static const schema = 'aab.flutter-execution/v1';
  static final zoneKey = Object();
  static _FlutterActionLifetime? get current =>
      Zone.current[zoneKey] as _FlutterActionLifetime?;

  final String actionId;
  final String runtimeEpoch;
  final _stopped = Completer<void>();
  final _clock = Stopwatch()..start();
  int? _expiresAtMicros;
  String? stopReason;
  Timer? _deadline;
  bool dispatched = false;

  Map<String, Object?> get identity => {
        'actionId': actionId,
        'runtimeEpoch': runtimeEpoch,
      };

  void stop(String reason) {
    if (stopReason != null) return;
    stopReason = reason;
    _stopped.complete();
  }

  void throwIfStopped() {
    if (stopReason == null &&
        _expiresAtMicros != null &&
        _clock.elapsedMicroseconds >= _expiresAtMicros!)
      stop('flutter_action_timeout');
    if (stopReason != null) throw _FlutterActionStopped(stopReason!);
  }

  Future<void> check() async {
    throwIfStopped();
    Object? decoded;
    final roundTrip = Stopwatch()..start();
    try {
      final value = await wait(AiAppBridge._channel
          .invokeMethod<String>('checkAction', jsonEncode(identity)));
      decoded = value == null ? null : jsonDecode(value);
    } catch (_) {
      stop('flutter_execution_check_failed');
      throwIfStopped();
    }
    throwIfStopped();
    if (decoded is! Map || decoded['ok'] != true) {
      stop(decoded is Map && decoded['error'] is String
          ? decoded['error'] as String
          : 'invalid_flutter_execution_permission');
      throwIfStopped();
    }
    final permission = decoded as Map;
    final remaining = permission['remainingMs'];
    if (permission['schemaVersion'] != schema ||
        permission['actionId'] != actionId ||
        permission['runtimeEpoch'] != runtimeEpoch ||
        remaining is! int ||
        remaining <= 0) {
      stop('invalid_flutter_execution_permission');
      throwIfStopped();
    }
    final budget = (remaining as int) - roundTrip.elapsedMilliseconds;
    if (budget <= 0) {
      stop('flutter_action_timeout');
      throwIfStopped();
    }
    _deadline?.cancel();
    _expiresAtMicros = _clock.elapsedMicroseconds + budget * 1000;
    _deadline = Timer(
        Duration(milliseconds: budget), () => stop('flutter_action_timeout'));
  }

  Future<T> wait<T>(Future<T> ownedWait) async {
    throwIfStopped();
    final result = await Future.any([
      ownedWait,
      _stopped.future.then<T>((_) => throw _FlutterActionStopped(stopReason!))
    ]);
    throwIfStopped();
    return result;
  }

  Future<void> delay(Duration duration) async {
    final elapsed = Completer<void>();
    final timer = Timer(duration, elapsed.complete);
    try {
      await wait(elapsed.future);
    } finally {
      timer.cancel();
    }
  }

  Map<String, Object?> receipt(Map<String, Object?> result) => {
        ...result,
        if (stopReason != null) ...{'ok': false, 'error': stopReason},
        'dispatched': dispatched,
        'ambiguous': dispatched && result['ambiguous'] == true,
        'execution': {'schemaVersion': schema, ...identity, 'settled': true},
      };

  void dispose() => _deadline?.cancel();
}

class _FlutterActionStopped implements Exception {
  const _FlutterActionStopped(this.code);
  final String code;
}
