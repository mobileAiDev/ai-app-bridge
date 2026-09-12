import 'dart:async';
import 'dart:convert';

import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

const schema = 'aab.flutter-execution/v1';

void main() {
  managedTest('a blocked Dart callback cannot outrun the monotonic deadline',
      (h) async {
    final touches = <String>[];
    await h.mount(Listener(
        behavior: HitTestBehavior.opaque,
        onPointerDown: (_) {
          touches.add('down');
          final blocked = Stopwatch()..start();
          while (blocked.elapsedMilliseconds < 80) {
            /* Simulate an App blocking this isolate. */
          }
        },
        onPointerUp: (_) => touches.add('up'),
        onPointerCancel: (_) => touches.add('cancel'),
        child: const SizedBox(width: 500, height: 500)));
    h.remainingMs = 30;
    final result =
        await h.finish(h.send({'action': 'tapAt', 'x': 100, 'y': 100}));
    expect(result['error'], 'flutter_action_timeout');
    expect(touches, ['down', 'cancel']);
  });

  managedTest(
      'tap terminal cannot become a long press while waiting for a channel reply',
      (h) async {
    var taps = 0, longPresses = 0;
    await h.mount(GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => taps++,
        onLongPress: () => longPresses++,
        child: const SizedBox(width: 500, height: 500)));
    final delayed = Completer<String>();
    h.permission = (_) async {
      if (h.checks > 2) return await delayed.future;
      return h.grant();
    };
    final action = h.send({'action': 'tapAt', 'x': 100, 'y': 100});
    await h.tester.pump();
    await h.tester.pump(const Duration(milliseconds: 60));
    await h.tester.pump(const Duration(milliseconds: 550));
    delayed.complete(h.grant());
    await h.finish(action);
    expect(longPresses, 0);
    expect(taps, 1);
  });

  managedTest(
      'cancel before admission prevents a late permission from touching UI',
      (h) async {
    final touches = <String>[];
    await h.mount(touchSurface(touches));
    final held = Completer<String>();
    h.permission = (_) => held.future;
    final action = h.send({'action': 'tapAt', 'x': 100, 'y': 100});
    await h.tester.idle();
    expect(h.checks, 1);
    await h.cancel();
    final result = await h.finish(action);
    expect(result['error'], 'flutter_action_cancelled');
    expect(result['dispatched'], false);
    held.complete(h.grant());
    await h.tester.pump(const Duration(milliseconds: 200));
    expect(touches, isEmpty);
  });

  managedTest('cancel after DOWN sends CANCEL and never UP or a tap callback',
      (h) async {
    final touches = <String>[];
    var presses = 0;
    await h.mount(touchSurface(touches, onTap: () => presses++));
    final action = h.send({'action': 'tapAt', 'x': 100, 'y': 100});
    await h.until(() => touches.isNotEmpty);
    expect(touches, ['down']);
    await h.cancel();
    final result = await h.finish(action);
    expect(result['dispatched'], true);
    expect(result['ambiguous'], false);
    expect(touches, ['down', 'cancel']);
    await h.tester.pump(const Duration(milliseconds: 300));
    expect(touches, ['down', 'cancel']);
    expect(presses, 0);
    final settled =
        h.events.singleWhere((e) => e['name'] == 'flutter.action.settled');
    expect(settled['actionId'], h.actionId);
  });

  managedTest(
      'swipe cancellation terminates the original pointer before more moves',
      (h) async {
    final touches = <String>[];
    await h.mount(touchSurface(touches));
    final action = h.send({
      'action': 'swipe',
      'startX': 100,
      'startY': 100,
      'endX': 150,
      'endY': 400
    });
    await h.until(() => touches.contains('move'));
    await h.cancel();
    final result = await h.finish(action);
    expect(result['error'], 'flutter_action_cancelled');
    expect(touches.last, 'cancel');
    expect(touches, isNot(contains('up')));
    final count = touches.length;
    await h.tester.pump(const Duration(milliseconds: 400));
    expect(touches.length, count);
  });

  managedTest('native revocation after editor tap prevents the text write',
      (h) async {
    final editor = TextEditingController(text: 'original');
    addTearDown(editor.dispose);
    await h.mount(Listener(
        onPointerUp: (_) => h.revoked = true,
        child: TextField(controller: editor)));
    final result =
        await h.finish(h.send({'action': 'inputText', 'text': 'late write'}));
    expect(result['error'], 'flutter_action_cancelled');
    expect(result['dispatched'], true);
    expect(editor.text, 'original');
    await h.tester.pump(const Duration(milliseconds: 400));
    expect(editor.text, 'original');
  });

  managedTest('owned frame wait can stop without delivering another frame',
      (h) async {
    final scroll = ScrollController();
    addTearDown(scroll.dispose);
    await h.mount(SingleChildScrollView(
        controller: scroll,
        child: const SizedBox(height: 3000, child: Text('Scroll surface'))));
    final action = h.send({'action': 'scrollBy', 'delta': 200});
    await h.tester.idle();
    expect(scroll.offset, 200);
    await h.cancel();
    final result = await action;
    expect(result['execution'], containsPair('settled', true));
    expect(result['error'], 'flutter_action_cancelled');
    expect(scroll.offset, 200);
    await h.tester.pump();
  });

  managedTest('cancel scrollUntilText prevents all subsequent jumps',
      (h) async {
    final scroll = ScrollController();
    addTearDown(scroll.dispose);
    await h.mount(SingleChildScrollView(
        controller: scroll,
        child: const SizedBox(height: 50000, child: Text('Start'))));
    final action = h.send(
        {'action': 'scrollUntilText', 'text': 'Absent', 'maxSwipes': 1000});
    await h.tester.idle();
    final stoppedAt = scroll.offset;
    expect(stoppedAt, greaterThan(0));
    await h.cancel();
    final result = await h.finish(action);
    expect(result['dispatched'], true);
    await h.tester.pump(const Duration(seconds: 1));
    expect(scroll.offset, stoppedAt);
  });

  managedTest('the native remaining budget times out a held tap with CANCEL',
      (h) async {
    final touches = <String>[];
    await h.mount(touchSurface(touches));
    h.remainingMs = 20;
    final result =
        await h.finish(h.send({'action': 'tapAt', 'x': 100, 'y': 100}));
    expect(result['error'], 'flutter_action_timeout');
    expect(touches, ['down', 'cancel']);
    expect(result['dispatched'], true);
  });

  managedTest('a stale cancel identity cannot stop the active action',
      (h) async {
    final touches = <String>[];
    await h.mount(touchSurface(touches));
    final action = h.send({'action': 'tapAt', 'x': 100, 'y': 100});
    await h.until(() => touches.isNotEmpty);
    expect((await h.cancel(id: 'stale'))['error'], 'flutter_action_not_active');
    expect((await h.cancel(epoch: 'old-runtime'))['error'],
        'flutter_action_not_active');
    expect((await h.finish(action))['ok'], true);
    expect(touches, ['down', 'up']);
  });

  managedTest(
      'an App future remains busy until it actually completes after cancellation',
      (h) async {
    await h.mount(const Text('H5'));
    final appFuture = Completer<Object?>();
    var entered = false;
    AiAppBridge.instance.registerH5Adapter(AiAppBridgeH5Adapter(
        id: 'held',
        source: 'test',
        isVisible: () => true,
        evaluateJavascript: (script) {
          final start = script.lastIndexOf('\n(');
          final request =
              jsonDecode(script.substring(start + 2, script.length - 2)) as Map;
          if (request['action'] == 'eval' && request['script'] == 'hold') {
            entered = true;
            return appFuture.future;
          }
          return jsonEncode({
            'ok': true,
            'dom': {
              'documentId': 'document',
              'url': 'https://fixture.test/',
              'controls': [],
              'truncated': false,
            }
          });
        }));
    addTearDown(() => AiAppBridge.instance.unregisterH5Adapter('held'));
    final observed =
        await h.finish(h.send({'action': 'h5Dom', 'adapterId': 'held'}));
    final action = h.send({
      'action': 'h5Eval',
      'script': 'hold',
      'expectedPage': observed['pageRef']
    });
    var completed = false;
    unawaited(action.then((_) => completed = true));
    await h.tester.idle();
    expect(entered, true);
    await h.cancel();
    await h.tester.pump(const Duration(milliseconds: 100));
    expect(completed, false);
    final concurrent = await h.send({'action': 'back'}, id: 'second-action');
    expect(concurrent['error'], 'flutter_action_busy');
    expect(concurrent['dispatched'], false);
    appFuture.complete(jsonEncode({
      'ok': true,
      'dispatched': true,
      'ambiguous': false,
      'result': 'done'
    }));
    final result = await h.finish(action);
    expect(result['error'], 'flutter_action_cancelled');
    expect(result['dispatched'], true);
  });

  managedTest('input rechecks focus after the asynchronous native permission',
      (h) async {
    final a = TextEditingController(text: 'A');
    final b = TextEditingController(text: 'B');
    final focus = FocusNode();
    addTearDown(() {
      a.dispose();
      b.dispose();
      focus.dispose();
    });
    await h.mount(Column(children: [
      TextField(key: const Key('a'), controller: a),
      TextField(controller: b, focusNode: focus)
    ]));
    h.permission = (_) async {
      if (h.checks == 3) {
        focus.requestFocus();
        await Future<void>.value();
      }
      return h.grant();
    };
    final p = h.tester.getCenter(find.byKey(const Key('a')));
    final result = await h.finish(
        h.send({'action': 'inputText', 'text': 'wrong', 'x': p.dx, 'y': p.dy}));
    expect(result['error'], 'flutter_input_focus_changed');
    expect([a.text, b.text], ['A', 'B']);
  });

  managedTest('runtime mismatch and malformed execution fail before permission',
      (h) async {
    final touches = <String>[];
    await h.mount(touchSurface(touches));
    final changed = await h
        .send({'action': 'tapAt', 'x': 100, 'y': 100}, epoch: 'old-runtime');
    expect(changed['error'], 'flutter_runtime_changed');
    for (final execution in [
      null,
      {...h.execution(), 'extra': true},
      {...h.execution(), 'timeoutMs': '100'}
    ]) {
      final response = await h.call('executeAction',
          {'action': 'back', 'actionId': h.actionId, 'execution': execution});
      expect(response['error'], 'invalid_flutter_execution');
    }
    expect(h.checks, 0);
    expect(touches, isEmpty);
  });

  managedTest('unmanaged method channel actions cannot bypass admission',
      (h) async {
    final touches = <String>[];
    await h.mount(touchSurface(touches));
    final response = await h.call('runAction',
        {'action': 'tapAt', 'x': 100, 'y': 100, 'actionId': h.actionId});
    expect(response['error'], 'flutter_execution_required');
    expect(h.checks, 0);
    expect(touches, isEmpty);
  });

  managedTest(
      'shutdown cancels a held pointer and closes the execution receipt',
      (h) async {
    final touches = <String>[];
    await h.mount(touchSurface(touches));
    final action = h.send({'action': 'tapAt', 'x': 100, 'y': 100});
    await h.until(() => touches.isNotEmpty);
    AiAppBridge.instance.shutdown();
    expect((await h.finish(action))['error'], 'flutter_runtime_shutdown');
    expect(touches, ['down', 'cancel']);
  });
}

Widget touchSurface(List<String> touches, {VoidCallback? onTap}) => Listener(
    behavior: HitTestBehavior.opaque,
    onPointerDown: (_) => touches.add('down'),
    onPointerUp: (_) => touches.add('up'),
    onPointerMove: (_) => touches.add('move'),
    onPointerCancel: (_) => touches.add('cancel'),
    child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: const SizedBox(width: 500, height: 500)));

void managedTest(String name, Future<void> Function(_Harness) test) {
  testWidgets(name, (tester) async {
    final h = _Harness(tester)..start();
    try {
      await test(h);
    } finally {
      AiAppBridge.instance.shutdown();
      h.messenger.setMockMethodCallHandler(_Harness.channel, null);
    }
  });
}

class _Harness {
  _Harness(this.tester);
  final WidgetTester tester;
  static const channel = MethodChannel('ai_app_bridge');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  final snapshots = <Map<String, dynamic>>[];
  final events = <Map<String, dynamic>>[];
  final actionId = 'managed-action';
  String runtimeEpoch = '';
  int remainingMs = 30000;
  int checks = 0;
  bool revoked = false;
  Future<String> Function(Map)? permission;

  void start() {
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'checkAction') {
        checks++;
        if (permission != null)
          return permission!(jsonDecode(call.arguments as String) as Map);
        return revoked
            ? jsonEncode({'ok': false, 'error': 'flutter_action_cancelled'})
            : grant();
      }
      if (call.method == 'updateSnapshot')
        snapshots.add(jsonDecode(call.arguments as String));
      if (call.method == 'recordEvent')
        events.add(jsonDecode(call.arguments as String));
      return {'ok': true};
    });
    AiAppBridge.instance.initialize(
        appName: 'lifetime-test',
        captureDebugPrint: false,
        captureFlutterErrors: false,
        captureHttpClient: false);
  }

  Future<void> mount(Widget widget) async {
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: widget)));
    await tester.pump(const Duration(milliseconds: 1200));
    await tester.pump(const Duration(milliseconds: 150));
    runtimeEpoch =
        snapshots.last['layout']['operable']['runtimeEpoch'] as String;
  }

  Map<String, Object?> execution({String? id, String? epoch}) => {
        'schemaVersion': schema,
        'actionId': id ?? actionId,
        'runtimeEpoch': epoch ?? runtimeEpoch,
        'timeoutMs': remainingMs,
      };
  String grant() => jsonEncode({
        'schemaVersion': schema,
        'actionId': actionId,
        'runtimeEpoch': runtimeEpoch,
        'ok': true,
        'remainingMs': remainingMs
      });
  Future<Map> send(Map<String, Object?> action, {String? id, String? epoch}) =>
      call('executeAction', {
        ...action,
        'actionId': id ?? actionId,
        'execution': execution(id: id, epoch: epoch),
      });
  Future<Map> cancel({String? id, String? epoch}) async {
    if ((id == null || id == actionId) &&
        (epoch == null || epoch == runtimeEpoch)) revoked = true;
    return call('cancelAction', {
      'schemaVersion': schema,
      'actionId': id ?? actionId,
      'runtimeEpoch': epoch ?? runtimeEpoch,
      'reason': 'flutter_action_cancelled'
    });
  }

  Future<Map> call(String method, Map<String, Object?> body) async {
    final result = Completer<Object?>();
    unawaited(messenger.handlePlatformMessage(
        'ai_app_bridge',
        channel.codec.encodeMethodCall(MethodCall(method, jsonEncode(body))),
        (data) => result.complete(channel.codec.decodeEnvelope(data!))));
    return (await result.future) as Map;
  }

  Future<void> until(bool Function() predicate) async {
    for (var i = 0; i < 50 && !predicate(); i++) {
      await tester.pump(const Duration(milliseconds: 5));
    }
    expect(predicate(), true);
  }

  Future<Map> finish(Future<Map> future) async {
    var completed = false;
    unawaited(future.then((_) => completed = true));
    await until(() => completed);
    final result = await future;
    expect(result['execution'], containsPair('settled', true));
    return result;
  }
}
