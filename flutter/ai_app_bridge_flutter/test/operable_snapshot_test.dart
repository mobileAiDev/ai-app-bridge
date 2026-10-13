import 'dart:async';
import 'dart:convert';
import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'support/read_snapshot.dart';

void main() {
  testWidgets('one observation hit-tests each point once and refreshes after an overlay changes', (tester) async {
    final bridge = AiAppBridge.instance;
    const channel = MethodChannel('ai_app_bridge');
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (_) async => {'ok': true});
    addTearDown(() { bridge.shutdown(); messenger.setMockMethodCallHandler(channel, null); });
    bridge.initialize(appName: 'hit-test-cost', captureDebugPrint: false, captureFlutterErrors: false, captureHttpClient: false);
    final hits = <Offset, int>{};
    var covered = false;
    late StateSetter update;
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: _CountHits(hits: hits,
      child: StatefulBuilder(builder: (context, setState) {
        update = setState;
        return Stack(children: [
          Center(child: TextButton(onPressed: () {}, child: const Text('Underlying action'))),
          if (covered) Positioned.fill(child: GestureDetector(behavior: HitTestBehavior.opaque,
            onTap: () {}, child: const ColoredBox(color: Colors.white, child: Center(child: Text('Cover'))))),
        ]);
      })))));
    await tester.pumpAndSettle();
    Future<List> read() async {
      hits.clear();
      final result = await readBridgeResponse(tester, scope: 'operable');
      expect(result['ok'], true);
      expect(hits, isNotEmpty);
      expect(hits.values.every((count) => count == 1), true,
        reason: 'A synchronous read must not traverse the same hit-test path repeatedly: $hits');
      return result['snapshot']['layout']['operable']['nodes'] as List;
    }
    expect((await read()).any((node) => node['text'] == 'Underlying action'), true);
    update(() { covered = true; });
    await tester.pumpAndSettle();
    final overlay = await read();
    expect(overlay.any((node) => node['text'] == 'Cover'), true);
    expect(overlay.any((node) => node['text'] == 'Underlying action'), false,
      reason: 'The prior observation cannot make a now-covered target reachable');
    update(() { covered = false; });
    await tester.pumpAndSettle();
    expect((await read()).any((node) => node['text'] == 'Underlying action'), true);
  });

  testWidgets('operable reads capture the committed layout without requesting another frame', (tester) async {
    final bridge = AiAppBridge.instance;
    const channel = MethodChannel('ai_app_bridge');
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (_) async => {'ok': true});
    addTearDown(() { bridge.shutdown(); messenger.setMockMethodCallHandler(channel, null); });
    bridge.initialize(appName: 'current-layout', captureDebugPrint: false, captureFlutterErrors: false, captureHttpClient: false);
    var value = 'Before';
    late StateSetter update;
    await tester.pumpWidget(MaterialApp(home: StatefulBuilder(builder: (context, setState) {
      update = setState;
      return TextButton(onPressed: () {}, child: Text(value));
    })));
    await tester.pumpAndSettle();
    Future<Map<String, dynamic>> readWithoutFrame() async {
      final done = Completer<Map<String, dynamic>>();
      unawaited(messenger.handlePlatformMessage('ai_app_bridge', channel.codec.encodeMethodCall(
        const MethodCall('readSnapshot', '{"scope":"operable"}')), (data) {
        done.complete(Map<String, dynamic>.from(channel.codec.decodeEnvelope(data!) as Map));
      }));
      await tester.idle();
      expect(done.isCompleted, true, reason: 'Reading committed UI does not require another rendered frame');
      return done.future;
    }
    List<String> labels(Map<String, dynamic> response) {
      expect(response['ok'], true);
      return (response['snapshot']['layout']['operable']['nodes'] as List)
          .map((n) => n['text']).whereType<String>().toList();
    }
    expect(tester.binding.hasScheduledFrame, false);
    expect(labels(await readWithoutFrame()), contains('Before'));
    expect(tester.binding.hasScheduledFrame, false);
    update(() { value = 'After'; });
    expect(tester.binding.hasScheduledFrame, true);
    expect(labels(await readWithoutFrame()), contains('Before'), reason: 'Pending state has not yet changed the displayed layout');
    await tester.pump();
    final after = labels(await readWithoutFrame());
    expect(after, contains('After')); expect(after, isNot(contains('Before')));
    expect(tester.binding.hasScheduledFrame, false);
  });

  testWidgets('operable state distinguishes checked, toggled and disabled controls after real taps', (tester) async {
    final bridge = AiAppBridge.instance;
    const channel = MethodChannel('ai_app_bridge');
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (_) async => {'ok': true});
    addTearDown(() { bridge.shutdown(); messenger.setMockMethodCallHandler(channel, null); });
    bridge.initialize(appName: 'control-state', captureDebugPrint: false, captureFlutterErrors: false, captureHttpClient: false);
    var checked = false, toggled = true;
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: StatefulBuilder(builder: (context, update) => Column(children: [
      CheckboxListTile(title: const Text('Agree'), value: checked, onChanged: (value) => update(() { checked = value!; })),
      SwitchListTile(title: const Text('Notifications'), value: toggled, onChanged: (value) => update(() { toggled = value; })),
      const CheckboxListTile(title: Text('Unavailable'), value: null, tristate: true, onChanged: null),
      Semantics(label: 'Custom toggle', checked: true, enabled: false,
        child: const ColoredBox(color: Colors.blue, child: SizedBox(width: 40, height: 40))),
    ])))));
    Future<List> nodes() async => (await readBridgeResponse(tester, scope: 'operable'))['snapshot']['layout']['operable']['nodes'] as List;
    final before = await nodes();
    expect(before.any((n) => n['text'] == 'Agree' && n['checked'] == false), true);
    expect(before.any((n) => n['text'] == 'Notifications' && n['toggled'] == true), true);
    expect(before.any((n) => n['text'] == 'Unavailable' && n.containsKey('checked') && n['checked'] == null && n['enabled'] == false), true);
    expect(before.any((n) => n['text'] == 'Custom toggle' && n['checked'] == true && n['enabled'] == false), true);
    await tester.tap(find.text('Agree'));
    await tester.tap(find.text('Notifications'));
    await tester.pumpAndSettle();
    final after = await nodes();
    expect(after.any((n) => n['text'] == 'Agree' && n['checked'] == true), true);
    expect(after.any((n) => n['text'] == 'Notifications' && n['toggled'] == false), true);
  });

  testWidgets('operable reads keep live controls and bindings without full diagnostic or H5 collection', (tester) async {
    final bridge = AiAppBridge.instance;
    const channel = MethodChannel('ai_app_bridge');
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (_) async => {'ok': true});
    final text = TextEditingController(text: 'private-password');
    addTearDown(() { bridge.shutdown(); text.dispose(); messenger.setMockMethodCallHandler(channel, null); });
    bridge.initialize(appName: 'operable-only', captureDebugPrint: false, captureFlutterErrors: false, captureHttpClient: false);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: Column(children: [
      TextField(controller: text, obscureText: true, decoration: const InputDecoration(labelText: 'Password')),
      TextButton(onPressed: () {}, child: const Text('Continue')),
    ]))));
    final response = await readBridgeResponse(tester, scope: 'operable');
    expect(response['ok'], true);
    final snapshot = response['snapshot'] as Map;
    expect(snapshot['scope'], 'operable');
    expect(snapshot.containsKey('h5'), false);
    expect((snapshot['layout'] as Map).keys, ['operable']);
    final nodes = snapshot['layout']['operable']['nodes'] as List;
    expect(nodes.any((node) => node['text'] == 'Continue' && node['targetRef'] != null), true);
    expect(nodes.any((node) => node['label'] == 'Password' && node['value'] == '[secure:length=16]'), true);
    expect(jsonEncode(snapshot), isNot(contains('private-password')));
    final full = await readBridgeResponse(tester);
    expect(full['snapshot']['layout'].containsKey('widgetInspector'), true);
    final invalid = await readBridgeResponse(tester, scope: 'unknown');
    expect(invalid['error'], 'invalid_flutter_snapshot_scope');
  });
}

class _CountHits extends SingleChildRenderObjectWidget {
  const _CountHits({required this.hits, required super.child});
  final Map<Offset, int> hits;
  @override
  RenderObject createRenderObject(BuildContext context) => _HitCounter(hits);
}

class _HitCounter extends RenderProxyBox {
  _HitCounter(this.hits);
  final Map<Offset, int> hits;
  @override
  bool hitTest(BoxHitTestResult result, {required Offset position}) {
    hits.update(position, (value) => value + 1, ifAbsent: () => 1);
    return super.hitTest(result, position: position);
  }
}
