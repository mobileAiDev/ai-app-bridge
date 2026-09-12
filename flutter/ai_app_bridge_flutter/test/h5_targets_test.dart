import 'dart:convert';
import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'action_lifetime_test.dart' as managed;

void main() {
  managed.managedTest('H5 requires one visible adapter or an exact explicit ID',
      (h) async {
    await h.mount(const Text('Adapter selection'));
    final a = Evaluator('a'), b = Evaluator('b');
    AiAppBridge.instance.registerH5Adapter(a.adapter);
    AiAppBridge.instance.registerH5Adapter(b.adapter);
    addTearDown(() {
      AiAppBridge.instance.unregisterH5Adapter('a');
      AiAppBridge.instance.unregisterH5Adapter('b');
    });
    final ambiguous = await h.finish(h.send({'action': 'h5Dom'}));
    expect(ambiguous['error'], 'flutter_h5_adapter_ambiguous');
    expect(ambiguous['dispatched'], false);
    expect((ambiguous['adapters'] as List).length, 2);
    expect(a.requests, isEmpty);
    expect(b.requests, isEmpty);
    final chosen =
        await h.finish(h.send({'action': 'h5Dom', 'adapterId': 'b'}));
    expect(chosen['pageRef']['adapterId'], 'b');
    expect(a.requests, isEmpty);
    b.visible = false;
    expect(
        (await h
            .finish(h.send({'action': 'h5Dom', 'adapterId': 'b'})))['error'],
        'flutter_h5_adapter_hidden');
    AiAppBridge.instance.unregisterH5Adapter('a');
    expect(
        (await h
            .finish(h.send({'action': 'h5Dom', 'adapterId': 'a'})))['error'],
        'flutter_h5_adapter_not_found');
    expect((await h.finish(h.send({'action': 'h5Dom'})))['error'],
        'flutter_h5_adapter_not_found');
  });

  managed.managedTest(
      'unregistered and re-registered adapter IDs cannot revive old page references',
      (h) async {
    await h.mount(const Text('Adapter replacement'));
    final old = Evaluator('article');
    AiAppBridge.instance.registerH5Adapter(old.adapter);
    addTearDown(() => AiAppBridge.instance.unregisterH5Adapter('article'));
    final observed = await h.finish(h.send({'action': 'h5Dom'}));
    expect(() => AiAppBridge.instance.registerH5Adapter(old.adapter),
        throwsStateError);
    AiAppBridge.instance.unregisterH5Adapter('article');
    final replacement = Evaluator('article');
    AiAppBridge.instance.registerH5Adapter(replacement.adapter);
    final result = await h.finish(h.send({
      'action': 'h5Control',
      'operation': 'click',
      'expectedTarget': target(observed)
    }));
    expect(result['error'], 'reobserve_required');
    expect(result['dispatched'], false);
    expect(replacement.requests, isEmpty);
  });

  managed.managedTest(
      'H5 rechecks adapter visibility after asynchronous prepare before any mutation',
      (h) async {
    await h.mount(const Text('Visibility'));
    final view = Evaluator('article');
    AiAppBridge.instance.registerH5Adapter(view.adapter);
    addTearDown(() => AiAppBridge.instance.unregisterH5Adapter('article'));
    final observed = await h.finish(h.send({'action': 'h5Dom'}));
    view.onPrepare = () => view.visible = false;
    final result = await h.finish(h.send({
      'action': 'h5Control',
      'operation': 'click',
      'expectedTarget': target(observed)
    }));
    expect(result['error'], 'flutter_h5_adapter_hidden');
    expect(result['dispatched'], false);
    expect(view.requests.where((r) => r['operation'] == 'action'), isEmpty);
  });

  managed.managedTest(
      'H5 typed input preserves empty text, exact target and original managed receipt',
      (h) async {
    await h.mount(const Text('Input'));
    final view = Evaluator('article');
    AiAppBridge.instance.registerH5Adapter(view.adapter);
    addTearDown(() => AiAppBridge.instance.unregisterH5Adapter('article'));
    final observed = await h.finish(h.send({'action': 'h5Dom'}));
    final bound = target(observed);
    final result = await h.finish(h.send({
      'action': 'h5Control',
      'operation': 'input',
      'expectedTarget': bound,
      'text': ''
    }));
    expect(result['ok'], true);
    expect(result['dispatched'], true);
    expect(result['execution']['actionId'], h.actionId);
    final action = view.requests.singleWhere((r) => r['operation'] == 'action');
    expect(action['text'], '');
    expect(action['pageRef'], bound['pageRef']);
    expect(action['element'], bound['element']);
    expect(action['geometry'], isNotNull);
    final malformed = await h.finish(h.send({
      'action': 'h5Eval',
      'script': '1',
      'expectedPage': {...observed['pageRef'] as Map, 'extra': true}
    }));
    expect(malformed['error'], 'invalid_argument');
    expect(malformed['dispatched'], false);
  });
}

Map<String, Object?> target(Map observed) => {
      'pageRef': observed['pageRef'],
      'element': Evaluator.element,
    };

class Evaluator {
  Evaluator(this.id);
  final String id;
  bool visible = true;
  void Function()? onPrepare;
  final requests = <Map>[];
  static const element = {
    'elementId': 'e1',
    'tag': 'input',
    'id': 'editor',
    'name': '',
    'type': 'text',
    'text': '',
    'ariaLabel': 'Editor',
    'href': ''
  };
  AiAppBridgeH5Adapter get adapter => AiAppBridgeH5Adapter(
      id: id,
      source: 'test',
      isVisible: () => visible,
      evaluateJavascript: evaluate);
  Object? evaluate(String script) {
    final start = script.lastIndexOf('\n(');
    final request =
        jsonDecode(script.substring(start + 2, script.length - 2)) as Map;
    requests.add(request);
    if (request['operation'] == 'snapshot') {
      return jsonEncode({
        'ok': true,
        'dom': {
          'documentId': 'document',
          'url': 'https://fixture.test/',
          'truncated': false,
          'controls': [
            {...element, 'visible': true, 'disabled': false, 'editable': true}
          ]
        }
      });
    }
    if (request['operation'] == 'prepare') {
      onPrepare?.call();
      return jsonEncode({
        'ok': true,
        'dispatched': false,
        'ambiguous': false,
        'geometry': {'x': 20, 'y': 20}
      });
    }
    return jsonEncode({'ok': true, 'dispatched': true, 'ambiguous': false});
  }
}
