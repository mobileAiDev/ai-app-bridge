import 'support/read_snapshot.dart';
import 'dart:async';
import 'dart:convert';

import 'package:ai_app_bridge_flutter/ai_app_bridge_flutter.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testBridge('navigation semantics and its label remain one target with live selected state', (h) async {
    var selected = 0, taps = 0;
    await h.tester.pumpWidget(MaterialApp(home: StatefulBuilder(builder: (context, update) => Scaffold(
      body: Column(children: [
        TextButton(onPressed: () {}, child: const Text('Open')),
        TextButton(onPressed: () {}, child: const Text('Open')),
      ]),
      bottomNavigationBar: NavigationBar(selectedIndex: selected,
        onDestinationSelected: (value) => update(() { selected = value; taps++; }),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home), label: 'Home'),
          NavigationDestination(icon: Icon(Icons.local_activity), label: 'Activities'),
        ]),
    ))));
    final before = await h.observe();
    final activities = before.where((node) => node['text'] == 'Activities').toList();
    expect(activities, hasLength(1));
    expect(activities.single['selected'], false);
    expect(activities.single['enabled'], true);
    expect(before.where((node) => node['text'] == 'Open'), hasLength(2), reason: 'separate same-label buttons stay distinct');
    final result = await h.action({'action': 'tapTarget', 'selector': {'text': 'Activities'}, 'targetRef': activities.single['targetRef']});
    expect(result['ok'], true, reason: '$result');
    expect(taps, 1);
    await h.tester.pumpAndSettle();
    final after = await h.observe();
    expect(after.singleWhere((node) => node['text'] == 'Activities')['selected'], true);
  });
  testBridge(
      'a long label reports its truncated preview and keeps explicit node selection',
      (h) async {
    var taps = 0;
    final label = '${List.filled(299, 'x').join()}😀suffix';
    await h.tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: TextButton(
      onPressed: () => taps++,
      child: Text(label, maxLines: 1),
    ))));
    final nodes = await h.observe();
    final observed = nodes.firstWhere((n) => n['textTruncated'] == true);
    expect(observed['text'], List.filled(299, 'x').join());
    expect(observed['textLength'], label.length);
    expect(h.snapshots.last['layout']['operable']['coverage']['status'],
        'partial');
    final incorrectExact = await h.action({
      'action': 'tapTarget',
      'selector': {'text': observed['text']}
    });
    expect(incorrectExact['ok'], false);
    expect(taps, 0);
    final selected = await h.action({
      'action': 'tapTarget',
      'selector': {'nodeId': observed['id']},
      'targetRef': observed['targetRef']
    });
    expect(selected['ok'], true, reason: '$selected');
    expect(taps, 1);
  });
  testBridge('a returned nodeId remains actionable in a truncated tree',
      (h) async {
    var taps = 0;
    await h.tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: Wrap(
      children: List.generate(
          650,
          (i) => SizedBox(
              width: 20,
              height: 16,
              child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => taps++,
                  child: Text('$i')))),
    ))));
    final nodes = await h.observe();
    expect(h.snapshots.last['layout']['operable']['truncated'], true);
    final first =
        nodes.firstWhere((node) => (node['actions'] as List).contains('tap'));
    final result = await h.action({
      'action': 'tapTarget',
      'selector': {'nodeId': first['id']},
      'targetRef': first['targetRef']
    });
    expect(result['ok'], true, reason: '$result');
    expect(taps, 1);
  });

  testBridge('transparent skeleton text is neither observed nor dispatched',
      (h) async {
    await h.tester.pumpWidget(const MaterialApp(
        home: Scaffold(
      body: Column(children: [
        DecoratedBox(
          decoration: BoxDecoration(color: Colors.grey),
          child: Text('Set 9', style: TextStyle(color: Colors.transparent)),
        ),
        DefaultTextStyle(
          style: TextStyle(color: Colors.transparent),
          child: Text('8 kg × 50'),
        ),
        Text.rich(TextSpan(style: TextStyle(color: Colors.black), children: [
          TextSpan(text: 'Visible'),
          TextSpan(
              text: ' hidden', style: TextStyle(color: Colors.transparent)),
        ])),
      ]),
    )));
    final nodes = await h.observe();
    final labels = nodes.map((n) => n['text']).whereType<String>();
    expect(labels, contains('Visible'));
    expect(
        labels.any((s) =>
            s.contains('Set 9') ||
            s.contains('8 kg × 50') ||
            s.contains('hidden')),
        false);
    final result = await h.action({'action': 'tapText', 'text': 'Set 9'});
    expect(result['ok'], false);
    expect(result['dispatched'], false);
  });

  testBridge('zero opacity and completed fade hide their controls', (h) async {
    var taps = 0;
    await h.tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: Column(children: [
      Opacity(
          opacity: 0,
          child: TextButton(
              onPressed: () => taps++, child: const Text('Zero opacity'))),
      FadeTransition(
          opacity: const AlwaysStoppedAnimation(0),
          child: TextButton(
              onPressed: () => taps++, child: const Text('Faded out'))),
      Opacity(
          opacity: 0.5,
          child: TextButton(
              onPressed: () => taps++, child: const Text('Still painted'))),
    ]))));
    final nodes = await h.observe();
    expect(
        nodes.where(
            (n) => n['text'] == 'Zero opacity' || n['text'] == 'Faded out'),
        isEmpty);
    expect(
        (await h
            .action({'action': 'tapText', 'text': 'Faded out'}))['dispatched'],
        false);
    expect(
        (await h.action({'action': 'tapText', 'text': 'Still painted'}))['ok'],
        true);
    expect(taps, 1);
  });

  testBridge(
      'editors expose their own Material label hint error and Cupertino placeholder',
      (h) async {
    final controllers = List.generate(3, (_) => TextEditingController());
    addTearDown(() {
      for (final c in controllers) c.dispose();
    });
    await h.tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: Column(children: [
      TextField(
          controller: controllers[0],
          decoration: const InputDecoration(
              labelText: 'Reps',
              hintText: '次数',
              errorText: 'Enter a positive number')),
      TextFormField(
          controller: controllers[1],
          decoration: const InputDecoration(labelText: 'Weight (kg)')),
      CupertinoTextField(
          controller: controllers[2], placeholder: 'Search exercises...'),
    ]))));
    final editors =
        (await h.observe()).where((n) => n['role'] == 'input').toList();
    expect(editors, hasLength(3));
    expect(editors[0]['label'], 'Reps');
    expect(editors[0]['hint'], '次数');
    expect(editors[0]['errorText'], 'Enter a positive number');
    expect(editors[1]['label'], 'Weight (kg)');
    expect(editors[1].containsKey('hint'), false);
    expect(editors[2]['hint'], 'Search exercises...');
    expect(editors[2].containsKey('label'), false);
    final result = await h.action({
      'action': 'inputText',
      'selector': {'nodeId': editors[1]['id']},
      'targetRef': editors[1]['targetRef'],
      'text': '42.5'
    });
    expect(result['ok'], true, reason: '$result');
    expect(controllers.map((c) => c.text), ['', '42.5', '']);
  });

  testBridge('changing the field meaning invalidates the old editor reference',
      (h) async {
    final editor = TextEditingController(text: '42.5');
    addTearDown(editor.dispose);
    var unit = 'kg';
    late StateSetter change;
    await h.tester
        .pumpWidget(MaterialApp(home: StatefulBuilder(builder: (_, setState) {
      change = setState;
      return Scaffold(
          body: TextField(
              controller: editor,
              decoration: InputDecoration(labelText: 'Weight ($unit)')));
    })));
    final original =
        (await h.observe()).singleWhere((n) => n['role'] == 'input');
    change(() => unit = 'lb');
    await h.tester.pump();
    final result = await h.action({
      'action': 'inputText',
      'selector': {'nodeId': original['id']},
      'targetRef': original['targetRef'],
      'text': '99'
    });
    expect(result['error'], 'flutter_target_changed');
    expect(result['dispatched'], false);
    expect(editor.text, '42.5');
  });

  testBridge(
      'native keyboard insets block covered Flutter controls and editors',
      (h) async {
    var taps = 0;
    final editor = TextEditingController(text: 'unchanged');
    addTearDown(editor.dispose);
    addTearDown(h.tester.view.resetViewInsets);
    await h.tester.pumpWidget(MaterialApp(
      home: Scaffold(
          resizeToAvoidBottomInset: false,
          body: Stack(children: [
            Positioned(
                top: 20,
                left: 20,
                child: TextButton(
                    onPressed: () => taps++, child: const Text('Visible'))),
            Positioned(
                bottom: 100,
                left: 20,
                child: TextButton(
                    onPressed: () => taps++, child: const Text('Covered'))),
            Positioned(
                bottom: 20,
                left: 20,
                width: 200,
                child: TextField(controller: editor)),
          ])),
    ));
    final original =
        (await h.observe()).singleWhere((n) => n['text'] == 'Covered');
    h.tester.view.viewInsets =
        FakeViewPadding(bottom: h.tester.view.physicalSize.height / 2);
    final nodes = await h.observe();
    expect(nodes.where((n) => n['text'] == 'Covered' || n['role'] == 'input'),
        isEmpty);
    final blocked = await h.action({
      'action': 'tapTarget',
      'selector': {'text': 'Covered'},
      'targetRef': original['targetRef']
    });
    expect(blocked['ok'], false);
    expect(blocked['dispatched'], false);
    expect(
        (await h
            .action({'action': 'inputText', 'text': 'wrong'}))['dispatched'],
        false);
    expect(editor.text, 'unchanged');
    expect(taps, 0);
    expect(
        (await h.action({'action': 'tapText', 'text': 'Visible'}))['ok'], true);
    h.tester.view.resetViewInsets();
    await h.tester.pump();
    expect(
        (await h.action({'action': 'tapText', 'text': 'Covered'}))['ok'], true);
    expect(taps, 2);
  });

  testBridge(
      'focusing an editor preserves its partially visible scroll container',
      (h) async {
    final editor = TextEditingController(text: 'original');
    addTearDown(editor.dispose);
    addTearDown(h.tester.view.resetViewInsets);
    await h.tester.pumpWidget(MaterialApp(
      home: Scaffold(
        resizeToAvoidBottomInset: false,
        body: ListView(children: [
          TextField(
            controller: editor,
            onTap: () => h.tester.view.viewInsets = FakeViewPadding(
                bottom: h.tester.view.physicalSize.height * 2 / 3),
          ),
          const SizedBox(height: 1200),
        ]),
      ),
    ));
    final before = (await h.observe()).singleWhere((n) => n['role'] == 'input');
    expect(before['scroll'], isNotNull);
    final result = await h.action({
      'action': 'inputText',
      'selector': {'nodeId': before['id']},
      'targetRef': before['targetRef'],
      'text': 'recorded',
    });
    expect(result['ok'], true, reason: '$result');
    expect(editor.text, 'recorded');
    final after = (await h.observe()).singleWhere((n) => n['role'] == 'input');
    final scroll = after['scroll'] as Map;
    expect(scroll['nodeId'], (before['scroll'] as Map)['nodeId']);
    final bounds = scroll['bounds'] as Map;
    expect(
        bounds['bottom'],
        closeTo(
            h.tester.view.physicalSize.height /
                h.tester.view.devicePixelRatio /
                3,
            0.01));
  });

  testBridge('a keyboard appearing during DOWN cancels the covered tap',
      (h) async {
    var taps = 0, cancels = 0;
    addTearDown(h.tester.view.resetViewInsets);
    await h.tester.pumpWidget(MaterialApp(
        home: Scaffold(
      resizeToAvoidBottomInset: false,
      body: Stack(children: [
        Positioned(
            bottom: 40,
            left: 20,
            child: Listener(
              onPointerDown: (_) => h.tester.view.viewInsets = FakeViewPadding(
                  bottom: h.tester.view.physicalSize.height / 2),
              onPointerCancel: (_) => cancels++,
              child: TextButton(
                  onPressed: () => taps++, child: const Text('Keyboard race')),
            ))
      ]),
    )));
    final result =
        await h.action({'action': 'tapText', 'text': 'Keyboard race'});
    expect(result['ok'], false);
    expect(result['dispatched'], true);
    expect(result['ambiguous'], false);
    expect([taps, cancels], [0, 1]);
  });

  testBridge('semantic tap does not inspect unrelated widgets while held',
      (h) async {
    var held = false, taps = 0, longPresses = 0, heldInspections = 0;
    await h.tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: Listener(
      onPointerDown: (_) => held = true,
      onPointerUp: (_) => held = false,
      onPointerCancel: (_) => held = false,
      child: Column(children: [
        GestureDetector(
          onTap: () => taps++,
          onLongPress: () => longPresses++,
          child: const Text('Short tap'),
        ),
        _DiagnosticsProbe(() {
          if (held) heldInspections++;
        }),
      ]),
    ))));
    final result = await h.action({'action': 'tapText', 'text': 'Short tap'});
    expect(result['ok'], true, reason: '$result');
    expect([taps, longPresses], [1, 0]);
    expect(heldInspections, 0,
        reason:
            'Whole-App observation must not lengthen an admitted short tap.');
  });

  testBridge('explicit snapshot rejects a held pointer and works after UP',
      (h) async {
    var held = false, heldInspections = 0, taps = 0;
    await h.tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: Listener(
      onPointerDown: (_) => held = true,
      onPointerUp: (_) => held = false,
      onPointerCancel: (_) => held = false,
      child: Column(children: [
        GestureDetector(onTap: () => taps++, child: const Text('Snapshot tap')),
        _DiagnosticsProbe(() {
          if (held) heldInspections++;
        }),
      ]),
    ))));
    await h.observe();
    AiAppBridge.instance.recordRoute(location: '/tap-timing', action: 'test');
    await h.tester.pump(const Duration(milliseconds: 100));
    final point = h.tester.getCenter(find.text('Snapshot tap'));
    final before = h.snapshots.length;
    final action = h.send({'action': 'tapAt', 'x': point.dx, 'y': point.dy});
    await h.tester.pump();
    expect(held, true);
    await h.tester.pump(const Duration(milliseconds: 25));
    expect(held, true);
    final busy = await readBridgeResponse(h.tester);
    expect(busy['error'], 'flutter_observation_busy');
    final during = h.snapshots.length;
    await h.tester.pump(const Duration(milliseconds: 40));
    await h.tester.pump(const Duration(milliseconds: 200));
    expect((await action)['ok'], true);
    expect(during, before, reason: 'Pending observation is deferred.');
    expect(taps, 1);
    expect(heldInspections, 0);
    expect(h.snapshots.length, before,
        reason: 'No automatic snapshots after UP.');
    await h.observe();
    expect(h.snapshots.length, greaterThan(before));
  });

  for (final changeKind in ['label', 'cover', 'move']) {
    testBridge('target $changeKind during DOWN cancels without an UP callback',
        (h) async {
      var changed = false, taps = 0, ups = 0, cancels = 0;
      late StateSetter change;
      await h.tester
          .pumpWidget(MaterialApp(home: StatefulBuilder(builder: (_, setState) {
        change = setState;
        return Scaffold(
            body: Listener(
          onPointerDown: (_) => change(() => changed = true),
          onPointerUp: (_) => ups++,
          onPointerCancel: (_) => cancels++,
          child: Stack(children: [
            Positioned(
                left: changed && changeKind == 'move' ? 300 : 20,
                top: 100,
                child: TextButton(
                    onPressed: () => taps++,
                    child: Text(changed && changeKind == 'label'
                        ? 'Changed'
                        : 'Original'))),
            if (changed && changeKind == 'cover')
              const Positioned.fill(child: ColoredBox(color: Colors.red)),
          ]),
        ));
      })));
      final result = await h.action({'action': 'tapText', 'text': 'Original'});
      expect(result['ok'], false);
      expect(result['dispatched'], true);
      expect(result['ambiguous'], false);
      expect([taps, ups, cancels], [0, 0, 1]);
    });
  }

  testBridge('input cannot write to a focus selected by an App tap callback',
      (harness) async {
    final tester = harness.tester;
    final first = TextEditingController(text: 'first original');
    final second = TextEditingController(text: 'second original');
    final secondFocus = FocusNode();
    addTearDown(() {
      first.dispose();
      second.dispose();
      secondFocus.dispose();
    });
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Column(children: [
          TextField(
            key: const Key('first'),
            controller: first,
            onTap: () => SchedulerBinding.instance
                .addPostFrameCallback((_) => secondFocus.requestFocus()),
          ),
          TextField(controller: second, focusNode: secondFocus),
        ]),
      ),
    ));
    final point = tester.getCenter(find.byKey(const Key('first')));
    final result = await harness.action({
      'action': 'inputText',
      'text': 'must not redirect',
      'x': point.dx,
      'y': point.dy,
      'actionId': 'focus-race',
    });
    expect(secondFocus.hasFocus, isTrue);
    expect(second.text, 'second original');
    expect(first.text, 'first original');
    expect(result['ok'], false);
    expect(result['error'], 'flutter_input_focus_changed');
    expect(result['dispatched'], true);
    expect(result['ambiguous'], false);
  });

  testBridge('the selected editor accepts Unicode and clearing', (h) async {
    final controller = TextEditingController(text: 'original');
    addTearDown(controller.dispose);
    await h.tester.pumpWidget(
        MaterialApp(home: Scaffold(body: TextField(controller: controller))));
    for (final value in ['中文🙂\nsecond line', '']) {
      final result = await h.action({'action': 'inputText', 'text': value});
      expect(result['ok'], true, reason: '$result');
      expect(result['targetValidation'], 'aab.flutter-target/v1');
      expect(controller.text, value.replaceAll('\n', ''));
    }
  });

  testBridge('direct editor input keeps formatters and callbacks without tapping or opening IME', (h) async {
    final controller = TextEditingController(), focus = FocusNode();
    final changed = <String>[];
    var taps = 0;
    addTearDown(() { controller.dispose(); focus.dispose(); });
    await h.tester.pumpWidget(MaterialApp(home: Scaffold(body: TextField(
      controller: controller, focusNode: focus,
      inputFormatters: [FilteringTextInputFormatter.digitsOnly],
      onChanged: changed.add, onTap: () => taps++,
    ))));
    final result = await h.action({'action': 'inputText', 'text': 'a12b3', 'focus': false});
    expect(result['ok'], true, reason: '$result');
    expect(controller.text, '123');
    expect(changed, ['123']);
    expect(taps, 0);
    expect(focus.hasFocus, false);
    expect(h.tester.testTextInput.isVisible, false);
    expect(result['inputMode'], 'direct');
    expect(result.containsKey('x'), false, reason: 'no tap coordinates are claimed');
  });

  testBridge('direct input does not redirect to another focused editor', (h) async {
    final first = TextEditingController(), second = TextEditingController();
    final otherFocus = FocusNode();
    addTearDown(() { first.dispose(); second.dispose(); otherFocus.dispose(); });
    await h.tester.pumpWidget(MaterialApp(home: Scaffold(body: Column(children: [
      TextField(controller: first, decoration: const InputDecoration(labelText: 'First')),
      TextField(controller: second, focusNode: otherFocus),
    ]))));
    otherFocus.requestFocus();
    await h.tester.pump();
    final result = await h.action({'action': 'inputText', 'text': '正确🙂', 'focus': false,
      'selector': {'label': 'First', 'role': 'input'}});
    expect(result['ok'], true, reason: '$result');
    expect(first.text, '正确🙂'); expect(second.text, '');
    expect(otherFocus.hasFocus, true);
  });

  testBridge('input can dismiss its keyboard in the same Flutter action', (h) async {
    final controller = TextEditingController();
    final focus = FocusNode();
    addTearDown(() { controller.dispose(); focus.dispose(); });
    await h.tester.pumpWidget(MaterialApp(home: Scaffold(
        body: TextField(controller: controller, focusNode: focus))));
    final kept = await h.action({'action': 'inputText', 'text': 'first', 'hideKeyboard': false});
    expect(kept['ok'], true, reason: '$kept');
    expect(focus.hasFocus, true);
    final hidden = await h.action({'action': 'inputText', 'text': '完成🙂', 'hideKeyboard': true});
    expect(hidden['ok'], true, reason: '$hidden');
    expect(controller.text, '完成🙂');
    expect(focus.hasFocus, false);
    expect(h.tester.testTextInput.isVisible, false);
    expect(hidden['keyboard'], {'ok': true, 'dismissalRequested': true, 'source': 'flutter-text-input'});
  });

  testBridge('keyboard dismissal refreshes platform insets instead of retaining a hidden IME rectangle', (h) async {
    addTearDown(h.tester.view.resetViewInsets);
    await h.tester.pumpWidget(MaterialApp(home: Scaffold(resizeToAvoidBottomInset: false,
      body: Stack(children: [Positioned(bottom: 30, left: 20,
        child: TextButton(onPressed: () {}, child: const Text('Bottom action')))]))));
    h.tester.view.viewInsets = FakeViewPadding(bottom: h.tester.view.physicalSize.height / 2);
    expect((await h.observe()).where((node) => node['text'] == 'Bottom action'), isEmpty);
    var refreshes = 0;
    h.refreshWindowInsets = () { refreshes++; h.tester.view.resetViewInsets(); };
    final hidden = await h.action({'action': 'hideKeyboard'});
    expect(hidden['ok'], true, reason: '$hidden');
    expect(refreshes, 1);
    expect((await h.observe()).where((node) => node['text'] == 'Bottom action'), hasLength(1));
  });

  testBridge('a keyboard hide request does not declare a still-covered target visible', (h) async {
    addTearDown(h.tester.view.resetViewInsets);
    await h.tester.pumpWidget(MaterialApp(home: Scaffold(resizeToAvoidBottomInset: false,
      body: Stack(children: [Positioned(bottom: 30, left: 20,
        child: TextButton(onPressed: () {}, child: const Text('Bottom action')))]))));
    h.tester.view.viewInsets = FakeViewPadding(bottom: h.tester.view.physicalSize.height / 2);
    final hidden = await h.action({'action': 'hideKeyboard'});
    expect(hidden['ok'], true, reason: '$hidden');
    expect(hidden['dismissalRequested'], true);
    expect(hidden.containsKey('dismissed'), false);
    expect((await h.observe()).where((node) => node['text'] == 'Bottom action'), isEmpty);
    h.tester.view.resetViewInsets();
    expect((await h.observe()).where((node) => node['text'] == 'Bottom action'), hasLength(1));
  });

  testBridge('compound editor labels bind directly without a separate node lookup', (h) async {
    final first = TextEditingController(), second = TextEditingController();
    addTearDown(() { first.dispose(); second.dispose(); });
    await h.tester.pumpWidget(MaterialApp(home: Scaffold(body: Column(children: [
      const Text('账号'),
      TextField(controller: first, decoration: const InputDecoration(labelText: '账号', hintText: '用户名')),
      TextField(controller: second, decoration: const InputDecoration(labelText: '账号', hintText: '邮箱')),
    ]))));
    final ambiguous = await h.action({'action': 'inputText', 'text': 'wrong', 'selector': {'label': '账号', 'role': 'input'}});
    expect(ambiguous['error'], 'flutter_selector_not_unique');
    expect(first.text, ''); expect(second.text, '');
    final result = await h.action({'action': 'inputText', 'text': '邮箱账号', 'selector': {'label': '账号', 'hint': '邮箱', 'role': 'input'}});
    expect(result['ok'], true, reason: '$result');
    expect(first.text, ''); expect(second.text, '邮箱账号');
  });

  testBridge('unfocused multiple editors are ambiguous and unchanged',
      (h) async {
    final a = TextEditingController(text: 'A');
    final b = TextEditingController(text: 'B');
    addTearDown(() {
      a.dispose();
      b.dispose();
    });
    await h.tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: Column(children: [
      TextField(controller: a),
      TextField(controller: b),
    ]))));
    final result =
        await h.action({'action': 'inputText', 'text': 'unexpected'});
    expect(result['error'], 'flutter_selector_not_unique');
    expect(result['dispatched'], false);
    expect([a.text, b.text], ['A', 'B']);
  });

  testBridge('read-only input is rejected before touching the field',
      (h) async {
    final controller = TextEditingController(text: 'fixed');
    addTearDown(controller.dispose);
    await h.tester.pumpWidget(MaterialApp(
        home:
            Scaffold(body: TextField(controller: controller, readOnly: true))));
    for (final focus in [true, false]) {
      final result = await h.action({'action': 'inputText', 'text': 'unexpected', 'focus': focus});
      expect(result['error'], 'flutter_input_not_editable');
      expect(result['dispatched'], false);
      expect(controller.text, 'fixed');
    }
  });

  testBridge(
      'moving the same Element preserves its ref and taps its new position',
      (h) async {
    var left = 20.0;
    var presses = 0;
    late StateSetter change;
    await h.tester
        .pumpWidget(MaterialApp(home: StatefulBuilder(builder: (_, setState) {
      change = setState;
      return Scaffold(
          body: Stack(children: [
        Positioned(
            left: left,
            top: 100,
            child: TextButton(
                key: const Key('moving'),
                onPressed: () => presses++,
                child: const Text('Move me')))
      ]));
    })));
    final original =
        (await h.observe()).singleWhere((n) => n['text'] == 'Move me');
    change(() => left = 300);
    await h.tester.pump();
    final current =
        (await h.observe()).singleWhere((n) => n['text'] == 'Move me');
    expect(current['targetRef'], original['targetRef']);
    final result = await h.action({
      'action': 'tapTarget',
      'selector': {'text': 'Move me'},
      'targetRef': original['targetRef']
    });
    expect(result['ok'], true, reason: '$result');
    expect(result['x'] as num, greaterThan(300));
    expect(presses, 1);
  });

  testBridge('a text tap cannot hit a button at its scroll ancestor center',
      (h) async {
    var presses = 0;
    final touches = <Offset>[];
    await h.tester.pumpWidget(MaterialApp(
        home: Scaffold(
      body: Listener(
          onPointerDown: (event) => touches.add(event.position),
          child: SingleChildScrollView(
              child: SizedBox(
            height: 1200,
            child: Stack(children: [
              const Positioned(top: 10, left: 30, child: Text('Exact label')),
              Positioned(
                  top: 275,
                  left: 350,
                  child: SizedBox(
                      width: 100,
                      height: 50,
                      child: TextButton(
                          onPressed: () => presses++,
                          child: const Text('Other')))),
            ]),
          ))),
    )));
    final result = await h.action({
      'action': 'tapTarget',
      'selector': {'text': 'Exact label'}
    });
    expect(presses, 0);
    expect(touches.single.dy, lessThan(50));
    expect(result['dispatched'], true);
    expect(result['ambiguous'], false);
  });
  testBridge('a replacement with the same text rejects the old reference',
      (h) async {
    var version = 0;
    var presses = 0;
    late StateSetter change;
    await h.tester
        .pumpWidget(MaterialApp(home: StatefulBuilder(builder: (_, setState) {
      change = setState;
      return Scaffold(
          body: TextButton(
              key: ValueKey(version),
              onPressed: () => presses++,
              child: const Text('Replace me')));
    })));
    final original =
        (await h.observe()).singleWhere((n) => n['text'] == 'Replace me');
    change(() => version++);
    await h.tester.pump();
    final result = await h.action({
      'action': 'tapTarget',
      'selector': {'text': 'Replace me'},
      'targetRef': original['targetRef']
    });
    expect(result['error'], 'flutter_target_replaced');
    expect(result['dispatched'], false);
    expect(presses, 0);
  });

  testBridge('semantic change on the same Element invalidates its guard',
      (h) async {
    var label = 'Before';
    var presses = 0;
    late StateSetter change;
    await h.tester
        .pumpWidget(MaterialApp(home: StatefulBuilder(builder: (_, setState) {
      change = setState;
      return Scaffold(
          body: TextButton(onPressed: () => presses++, child: Text(label)));
    })));
    final original =
        (await h.observe()).singleWhere((n) => n['text'] == 'Before');
    change(() => label = 'After');
    await h.tester.pump();
    final result = await h.action({
      'action': 'tapTarget',
      'selector': {'nodeId': original['id']},
      'targetRef': original['targetRef']
    });
    expect(result['error'], 'flutter_target_changed');
    expect(result['dispatched'], false);
    expect(presses, 0);
  });

  testBridge('a different runtime cannot reuse an Element reference',
      (h) async {
    var presses = 0;
    await h.tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: TextButton(
                onPressed: () => presses++, child: const Text('Target')))));
    final original =
        (await h.observe()).singleWhere((n) => n['text'] == 'Target');
    final result = await h.action({
      'action': 'tapTarget',
      'selector': {'text': 'Target'},
      'targetRef': {
        ...original['targetRef'] as Map,
        'runtimeEpoch': 'another-runtime'
      }
    });
    expect(result['error'], 'flutter_runtime_changed');
    expect(result['dispatched'], false);
    expect(presses, 0);
  });

  testBridge('a covering overlay never receives a stale semantic tap',
      (h) async {
    var covered = false;
    var presses = 0;
    late StateSetter change;
    await h.tester
        .pumpWidget(MaterialApp(home: StatefulBuilder(builder: (_, setState) {
      change = setState;
      return Scaffold(
          body: Stack(children: [
        TextButton(onPressed: () => presses++, child: const Text('Covered')),
        if (covered)
          Positioned.fill(
              child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => presses++,
                  child: const ColoredBox(color: Colors.red))),
      ]));
    })));
    final original =
        (await h.observe()).singleWhere((n) => n['text'] == 'Covered');
    change(() => covered = true);
    await h.tester.pump();
    final result = await h.action({
      'action': 'tapTarget',
      'selector': {'text': 'Covered'},
      'targetRef': original['targetRef']
    });
    expect(result['ok'], false);
    expect(result['dispatched'], false);
    expect(presses, 0);
  });

  testBridge('removal during DOWN cancels the stream before UP', (h) async {
    var visible = true;
    var presses = 0;
    var ups = 0;
    var cancels = 0;
    late StateSetter change;
    await h.tester
        .pumpWidget(MaterialApp(home: StatefulBuilder(builder: (_, setState) {
      change = setState;
      return Scaffold(
          body: Listener(
        onPointerDown: (_) => change(() => visible = false),
        onPointerUp: (_) => ups++,
        onPointerCancel: (_) => cancels++,
        child: visible
            ? TextButton(
                onPressed: () => presses++, child: const Text('Remove on down'))
            : const SizedBox(width: 200, height: 50),
      ));
    })));
    final result =
        await h.action({'action': 'tapText', 'text': 'Remove on down'});
    expect(result['error'], 'flutter_target_replaced');
    expect(result['dispatched'], true);
    expect([presses, ups, cancels], [0, 0, 1]);
  });

  testBridge('explicit scroll moves only the chosen live Scrollable',
      (h) async {
    final a = ScrollController();
    final b = ScrollController();
    addTearDown(() {
      a.dispose();
      b.dispose();
    });
    await h.tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: Row(children: [
      for (final controller in [a, b])
        Expanded(
            child: ListView(
                controller: controller,
                children: List.generate(
                    20, (i) => SizedBox(height: 100, child: Text('Item $i'))))),
    ]))));
    final containers =
        (await h.observe()).where((n) => n['role'] == 'scrollable').toList();
    expect(containers, hasLength(2));
    final ambiguous = await h.action({'action': 'scrollBy', 'delta': 200});
    expect(ambiguous['error'], 'flutter_selector_not_unique');
    expect([a.offset, b.offset], [0, 0]);
    final chosen = containers.first;
    final result = await h.action({
      'action': 'scrollBy',
      'delta': 200,
      'selector': {'nodeId': chosen['id']},
      'targetRef': chosen['targetRef']
    });
    expect(result['ok'], true, reason: '$result');
    expect([a.offset, b.offset], [200, 0]);
    final boundary = await h.action({
      'action': 'scrollBy',
      'delta': 0,
      'selector': {'nodeId': chosen['id']},
      'targetRef': chosen['targetRef']
    });
    expect(boundary['error'], 'flutter_scroll_boundary');
    expect(boundary['dispatched'], false);
  });
  testBridge('nested scroll containers with equal bounds remain distinct',
      (h) async {
    final pages = PageController();
    final list = ScrollController();
    addTearDown(() {
      pages.dispose();
      list.dispose();
    });
    await h.tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: PageView(
                controller: pages,
                physics: const NeverScrollableScrollPhysics(),
                children: [
          SingleChildScrollView(
              controller: list,
              child: Column(
                  children: List.generate(
                      20,
                      (i) => SizedBox(
                          height: 100, child: Text('Nested item $i'))))),
          const Text('Other page'),
        ]))));
    final containers =
        (await h.observe()).where((n) => n['role'] == 'scrollable').toList();
    expect(containers, hasLength(2));
    expect(containers[0]['bounds'], containers[1]['bounds']);
    expect(containers.map((n) => (n['scroll'] as Map)['axis']),
        ['horizontal', 'vertical']);
    final ambiguous = await h.action({'action': 'scrollBy', 'delta': 200});
    expect(ambiguous['error'], 'flutter_selector_not_unique');
    final inner = containers.last;
    final result = await h.action({
      'action': 'scrollBy',
      'selector': {'nodeId': inner['id']},
      'targetRef': inner['targetRef'],
      'delta': 200,
    });
    expect(result['ok'], true, reason: '$result');
    expect(list.offset, 200);
    expect(pages.offset, 0);
    final observed =
        (await h.observe()).singleWhere((n) => n['id'] == inner['id']);
    expect((observed['scroll'] as Map)['pixels'], 200);
  });
  testBridge('a replaced scroll position invalidates the observed reference',
      (h) async {
    var primary = true;
    late StateSetter change;
    await h.tester
        .pumpWidget(MaterialApp(home: StatefulBuilder(builder: (_, setState) {
      change = setState;
      return Scaffold(
          body: SingleChildScrollView(
        physics: primary
            ? const ClampingScrollPhysics()
            : const BouncingScrollPhysics(),
        child: const SizedBox(height: 2000, child: Text('Scroll position')),
      ));
    })));
    final original =
        (await h.observe()).singleWhere((n) => n['role'] == 'scrollable');
    change(() => primary = false);
    await h.tester.pump();
    final current =
        (await h.observe()).singleWhere((n) => n['role'] == 'scrollable');
    expect(current['id'], original['id']);
    expect(current['targetRef'], isNot(original['targetRef']));
    final result = await h.action({
      'action': 'scrollBy',
      'delta': 100,
      'selector': {'nodeId': original['id']},
      'targetRef': original['targetRef'],
    });
    expect(result['error'], 'flutter_target_changed');
    expect(result['dispatched'], false);
    expect((current['scroll'] as Map)['pixels'], 0);
  });
  testBridge(
      'removing the editor during its tap never writes to another editor',
      (h) async {
    final a = TextEditingController(text: 'A');
    final b = TextEditingController(text: 'B');
    final otherFocus = FocusNode();
    addTearDown(() {
      a.dispose();
      b.dispose();
      otherFocus.dispose();
    });
    var visible = true;
    late StateSetter change;
    await h.tester
        .pumpWidget(MaterialApp(home: StatefulBuilder(builder: (_, setState) {
      change = setState;
      return Scaffold(
          body: Column(children: [
        if (visible)
          TextField(
              key: const Key('removable'),
              controller: a,
              onTap: () {
                change(() => visible = false);
                otherFocus.requestFocus();
              }),
        TextField(controller: b, focusNode: otherFocus),
      ]));
    })));
    final point = h.tester.getCenter(find.byKey(const Key('removable')));
    final result = await h.action({
      'action': 'inputText',
      'text': 'unexpected',
      'x': point.dx,
      'y': point.dy
    });
    expect(result['error'], 'flutter_target_replaced');
    expect(result['dispatched'], true);
    expect([a.text, b.text], ['A', 'B']);
  });

  testBridge(
      'a replacement controller on the same editor rejects the pending input',
      (h) async {
    final a = TextEditingController(text: 'same');
    final b = TextEditingController(text: 'same');
    addTearDown(() {
      a.dispose();
      b.dispose();
    });
    var current = a;
    late StateSetter change;
    await h.tester
        .pumpWidget(MaterialApp(home: StatefulBuilder(builder: (_, setState) {
      change = setState;
      return Scaffold(
          body: TextField(
              controller: current, onTap: () => change(() => current = b)));
    })));
    final result =
        await h.action({'action': 'inputText', 'text': 'unexpected'});
    expect(result['error'], 'flutter_target_changed');
    expect(result['dispatched'], true);
    expect([a.text, b.text], ['same', 'same']);
  });

  testBridge('a pending Flutter action owns its input stream until it settles',
      (h) async {
    var presses = 0;
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    await h.tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: Column(children: [
      TextField(controller: controller),
      TextButton(onPressed: () => presses++, child: const Text('Other action')),
    ]))));
    await h.observe();
    final first = h.send({'action': 'inputText', 'text': 'owned'});
    await h.tester.pump(const Duration(milliseconds: 10));
    final second = h.send({'action': 'tapText', 'text': 'Other action'});
    await h.tester.pump();
    final rejection = await second;
    expect(rejection['error'], 'flutter_action_busy');
    expect(rejection['dispatched'], false);
    for (var i = 0; i < 12; i++) {
      await h.tester.pump(const Duration(milliseconds: 20));
    }
    expect((await first)['ok'], true);
    expect(controller.text, 'owned');
    expect(presses, 0);
  });

  testBridge('the SDK rejects malformed action fields before any input',
      (h) async {
    final controller = TextEditingController(text: 'unchanged');
    addTearDown(controller.dispose);
    await h.tester.pumpWidget(
        MaterialApp(home: Scaffold(body: TextField(controller: controller))));
    for (final request in <Map<String, Object?>>[
      {'action': 'tapAt', 'x': '1', 'y': 2},
      {'action': 'tapAt', 'x': -1, 'y': 2},
      {'action': 'inputText', 'text': 123},
      {'action': 'inputText', 'text': 'wrong', 'x': 1},
      {
        'action': 'inputText',
        'text': 'wrong',
        'selector': {'nodeId': 'e1'},
        'x': 1,
        'y': 2
      },
      {'action': 'inputText', 'text': 'wrong', 'targetRef': {}},
      {'action': 'inputText', 'text': 'wrong', 'typo': true},
      {'action': 'inputText', 'text': 'wrong', 'hideKeyboard': 'true'},
      {'action': 'inputText', 'text': 'wrong', 'focus': 'false'},
      {'action': 'scrollBy', 'delta': '100'},
    ]) {
      final result = await h.action(request);
      expect(result['ok'], false, reason: '$request');
      expect(result['dispatched'], false);
    }
    expect(controller.text, 'unchanged');
  });
  testBridge(
      'reinitializing the runtime invalidates previous Element references',
      (h) async {
    var presses = 0;
    await h.tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: TextButton(
                onPressed: () => presses++,
                child: const Text('Restart target')))));
    final original =
        (await h.observe()).singleWhere((n) => n['text'] == 'Restart target');
    AiAppBridge.instance.shutdown();
    AiAppBridge.instance.initialize(
        appName: 'new-runtime',
        captureDebugPrint: false,
        captureFlutterErrors: false,
        captureHttpClient: false);
    final result = await h.action({
      'action': 'tapTarget',
      'selector': {'text': 'Restart target'},
      'targetRef': original['targetRef']
    });
    expect(result['error'], 'flutter_runtime_changed');
    expect(result['dispatched'], false);
    expect(presses, 0);
  });
}

void testBridge(String name, Future<void> Function(_BridgeHarness) body) {
  testWidgets(name, (tester) async {
    final harness = _BridgeHarness(tester);
    harness.start();
    try {
      await body(harness);
    } finally {
      AiAppBridge.instance.shutdown();
    }
  });
}

class _DiagnosticsProbe extends StatelessWidget {
  const _DiagnosticsProbe(this.inspected);
  final VoidCallback inspected;
  @override
  String toStringShort() {
    inspected();
    return super.toStringShort();
  }

  @override
  Widget build(BuildContext context) => const SizedBox(width: 1, height: 1);
}

class _BridgeHarness {
  _BridgeHarness(this.tester);
  final WidgetTester tester;
  final snapshots = <Map<String, dynamic>>[];
  int actionSequence = 0;
  void Function()? refreshWindowInsets;
  static const channel = MethodChannel('ai_app_bridge');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  void start() {
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'refreshWindowInsets') {
        refreshWindowInsets?.call();
        return {'ok': true};
      }
      if (call.method == 'checkAction') {
        final identity = jsonDecode(call.arguments as String) as Map;
        return jsonEncode({
          'ok': true,
          'schemaVersion': 'aab.flutter-execution/v1',
          ...identity,
          'remainingMs': 30000
        });
      }
      if (call.method == 'updateSnapshot') {
        snapshots.add(jsonDecode(call.arguments as String));
      }
      return {'ok': true};
    });
    addTearDown(() {
      AiAppBridge.instance.shutdown();
      messenger.setMockMethodCallHandler(channel, null);
    });
    AiAppBridge.instance.initialize(
      appName: 'execution-target-test',
      captureDebugPrint: false,
      captureFlutterErrors: false,
      captureHttpClient: false,
    );
  }

  Future<Map<dynamic, dynamic>> action(Map<String, Object?> request) async {
    if (snapshots.isEmpty) await observe();
    final future = send(request);
    var completed = false;
    unawaited(future.then((_) => completed = true));
    for (var i = 0; i < 50 && !completed; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
    expect(completed, isTrue,
        reason: 'The SDK action must finish through actual frames');
    return future;
  }

  Future<Map<dynamic, dynamic>> send(Map<String, Object?> request) async {
    final response = Completer<Object?>();
    expect(snapshots, isNotEmpty, reason: 'Observe before queuing an action.');
    final actionId = request['actionId'] ?? 'widget-action-${++actionSequence}';
    final managed = {
      ...request,
      'actionId': actionId,
      'execution': {
        'schemaVersion': 'aab.flutter-execution/v1',
        'actionId': actionId,
        'runtimeEpoch': snapshots.last['layout']['operable']['runtimeEpoch'],
        'timeoutMs': 30000,
      }
    };
    unawaited(messenger.handlePlatformMessage(
      'ai_app_bridge',
      channel.codec
          .encodeMethodCall(MethodCall('executeAction', jsonEncode(managed))),
      (data) => response.complete(channel.codec.decodeEnvelope(data!)),
    ));
    return (await response.future) as Map;
  }

  Future<List<Map<dynamic, dynamic>>> observe() async {
    snapshots.add(await readBridgeSnapshot(tester));
    expect(snapshots, isNotEmpty);
    final tree = snapshots.last['layout']['operable'];
    expect(tree['ok'], true, reason: '$tree');
    return (tree['nodes'] as List).cast<Map>();
  }
}
