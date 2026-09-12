part of '../ai_app_bridge_flutter.dart';

// IDs belong to live Elements, not snapshot traversal positions. The current
// target map is bounded by the operable-tree limit; identity metadata uses weak
// Expando keys and does not retain detached Elements or their controllers.
class _FlutterExecutionTargets {
  _FlutterExecutionTargets(this.bridge);
  static const schema = 'aab.flutter-target/v1';
  final AiAppBridge bridge;
  String runtimeEpoch =
      '${DateTime.now().microsecondsSinceEpoch}-${math.Random.secure().nextInt(1 << 32)}';
  final _identities = Expando<String>();
  final _guards = Expando<_FlutterTargetGuard>();
  final _current = <String, _BoundFlutterTarget>{};
  var _nextIdentity = 0;
  var _nextGuard = 0;

  void reset() {
    runtimeEpoch =
        '${DateTime.now().microsecondsSinceEpoch}-${math.Random.secure().nextInt(1 << 32)}';
    beginObservation();
  }

  void validateRequest(Map<String, Object?> request) {
    const fields = <String, List<String>>{
      'tapAt': ['x', 'y'],
      'tapText': ['text'],
      'tapTarget': ['selector', 'targetRef'],
      'inputText': ['text', 'selector', 'targetRef', 'x', 'y'],
      'swipe': ['startX', 'startY', 'endX', 'endY'],
      'scrollBy': ['delta', 'selector', 'targetRef'],
      'scrollUntilText': ['text', 'maxSwipes', 'selector', 'targetRef'],
      'hideKeyboard': [],
      'back': [],
      'openHarness': [],
      'h5Adapters': [],
      'h5Dom': ['adapterId'],
      'h5Eval': ['script', 'expectedPage'],
      'h5Control': ['operation', 'expectedTarget', 'expectedPage', 'text', 'deltaX', 'deltaY'],
    };
    final action = request['action'];
    if (action is! String || !fields.containsKey(action)) {
      throw const _FlutterTargetFailure('unknown_action', field: 'action');
    }
    final allowed = {'action', 'actionId', ...fields[action]!};
    for (final field in request.keys) {
      if (!allowed.contains(field))
        throw _FlutterTargetFailure('unsupported_argument', field: field);
    }
    for (final field in ['actionId', 'text', 'script']) {
      if (request.containsKey(field) &&
          (request[field] is! String ||
              (field != 'text' && (request[field] as String).trim().isEmpty))) {
        throw _FlutterTargetFailure('invalid_argument', field: field);
      }
    }
    if (['tapText', 'inputText', 'scrollUntilText'].contains(action) &&
        (!request.containsKey('text') ||
            (action != 'inputText' && request['text'] == ''))) {
      throw const _FlutterTargetFailure('invalid_argument', field: 'text');
    }
    if (action == 'h5Eval' && !request.containsKey('script')) {
      throw const _FlutterTargetFailure('invalid_argument', field: 'script');
    }
    if (['h5Dom', 'h5Eval', 'h5Control'].contains(action)) {
      _FlutterH5Targets.validate(request);
    }
    final coordinates = action == 'swipe'
        ? ['startX', 'startY', 'endX', 'endY']
        : action == 'tapAt' ||
                request.containsKey('x') ||
                request.containsKey('y')
            ? ['x', 'y']
            : <String>[];
    for (final field in coordinates) {
      final value = number(request, field);
      if (value < 0 || value > 2147483647)
        throw _FlutterTargetFailure('invalid_argument', field: field);
    }
    if (action == 'scrollBy' && number(request, 'delta').abs() > 2147483647) {
      throw const _FlutterTargetFailure('invalid_argument', field: 'delta');
    }
    if (request.containsKey('maxSwipes')) {
      final count = request['maxSwipes'];
      if (count is! int || count < 0 || count > 1000)
        throw const _FlutterTargetFailure('invalid_argument',
            field: 'maxSwipes');
    }
    if (action == 'tapTarget' && !request.containsKey('selector')) {
      throw const _FlutterTargetFailure('flutter_selector_required');
    }
    if (request.containsKey('selector')) {
      final selector = request['selector'];
      if (selector is! Map ||
          selector.length != 1 ||
          !['text', 'nodeId'].contains(selector.keys.single) ||
          selector.values.single is! String ||
          (selector.values.single as String).isEmpty ||
          request.containsKey('x') ||
          request.containsKey('y')) {
        throw const _FlutterTargetFailure('invalid_flutter_selector');
      }
    }
    if (request.containsKey('targetRef')) {
      final ref = request['targetRef'];
      if (!request.containsKey('selector') ||
          ref is! Map ||
          ref.length != 4 ||
          !['schemaVersion', 'runtimeEpoch', 'elementId', 'guard'].every(
              (key) => ref[key] is String && (ref[key] as String).isNotEmpty)) {
        throw const _FlutterTargetFailure('invalid_flutter_target_ref');
      }
    }
  }

  String identity(Object object) =>
      _identities[object] ??= 'e${++_nextIdentity}';

  void beginObservation() => _current.clear();

  void observe(Element element, Map<String, Object?> node, _ActionTarget? tap,
      _ActionTarget? scroll) {
    final scrollState = scroll?.element is StatefulElement
        ? (scroll!.element as StatefulElement).state as ScrollableState
        : null;
    if (scrollState != null) {
      final position = scrollState.position;
      (node['scroll'] as Map<String, Object?>).addAll({
        'nodeId': identity(scroll!.element),
        'axis': axisDirectionToAxis(position.axisDirection).name,
        if (position.hasPixels) 'pixels': position.pixels,
        if (position.hasContentDimensions) ...{
          'minScrollExtent': position.minScrollExtent.isFinite
              ? position.minScrollExtent
              : null,
          'maxScrollExtent': position.maxScrollExtent.isFinite
              ? position.maxScrollExtent
              : null,
        },
      });
    }
    final signature = _signature(element, node['actions'], tap, scroll);
    var guard = _guards[element];
    if (guard == null || guard.signature != signature) {
      guard = _FlutterTargetGuard(signature, 'g${++_nextGuard}');
      _guards[element] = guard;
    }
    final ref = <String, Object?>{
      'schemaVersion': schema,
      'runtimeEpoch': runtimeEpoch,
      'elementId': identity(element),
      'guard': guard.token,
    };
    node['targetRef'] = ref;
    _current[identity(element)] =
        _BoundFlutterTarget(element, node, ref, tap, scroll, signature);
  }

  String _signature(Element element, Object? actions, _ActionTarget? tap,
      _ActionTarget? scroll) {
    final widget = element.widget;
    final description =
        widget is EditableText ? _editorDescription(element) : null;
    final scrollState = scroll?.element is StatefulElement
        ? (scroll!.element as StatefulElement).state as ScrollableState
        : null;
    return jsonEncode([
      widget.runtimeType.toString(),
      bridge._widgetText(element),
      bridge._widgetValue(widget),
      actions,
      if (tap != null) identity(tap.element),
      if (scroll != null) identity(scroll.element),
      if (scrollState != null) identity(scrollState.position),
      if (widget is EditableText) ...[
        identity(widget.controller),
        identity(widget.focusNode),
        widget.readOnly,
        widget.obscureText,
        widget.focusNode.canRequestFocus,
        description?.label,
        description?.hint,
      ],
      View.of(element).viewId,
    ]);
  }

  _BoundFlutterTarget resolve(Map<String, Object?> request, String action) {
    final tree = bridge._operableTree();
    if (tree['ok'] != true || tree['truncated'] == true) {
      throw _FlutterTargetFailure('flutter_observation_incomplete');
    }
    final selector = request['selector'];
    List<_BoundFlutterTarget> candidates = _current.values
        .where((t) => (t.node['actions'] as List).contains(action))
        .toList();
    if (selector != null) {
      if (selector is! Map ||
          selector.length != 1 ||
          !['text', 'nodeId'].contains(selector.keys.single) ||
          selector.values.single is! String ||
          (selector.values.single as String).isEmpty) {
        throw _FlutterTargetFailure('invalid_flutter_selector');
      }
      candidates = candidates
          .where((t) => selector.containsKey('nodeId')
              ? t.node['id'] == selector['nodeId']
              : t.node['text'] == selector['text'] ||
                  t.node['value'] == selector['text'])
          .toList();
    } else if (action == 'input' &&
        (request.containsKey('x') || request.containsKey('y'))) {
      final x = number(request, 'x');
      final y = number(request, 'y');
      candidates = candidates.where((t) {
        final bounds = bridge._visibleGlobalBounds(t.element);
        return bounds != null &&
            bounds.contains(Offset(x, y)) &&
            bridge._isHitTestReachable(
                t.element.findRenderObject(), Offset(x, y));
      }).toList();
    } else if (action == 'input') {
      final focused =
          candidates.where((t) => t.editor!.widget.focusNode.hasFocus).toList();
      if (focused.isNotEmpty) candidates = focused;
    } else if (action == 'scroll') {
      candidates =
          candidates.where((t) => t.node['role'] == 'scrollable').toList();
    } else {
      throw _FlutterTargetFailure('flutter_selector_required');
    }
    if (candidates.length != 1) {
      throw _FlutterTargetFailure(candidates.isEmpty
          ? 'flutter_selector_not_found'
          : 'flutter_selector_not_unique');
    }
    final target = candidates.single;
    if (request.containsKey('targetRef')) {
      final ref = request['targetRef'];
      if (ref is! Map ||
          ref.length != 4 ||
          !target.ref.keys.every((key) => ref[key] is String)) {
        throw _FlutterTargetFailure('invalid_flutter_target_ref');
      }
      if (ref['schemaVersion'] != schema) {
        throw _FlutterTargetFailure('flutter_target_schema_mismatch');
      }
      if (ref['runtimeEpoch'] != runtimeEpoch) {
        throw _FlutterTargetFailure('flutter_runtime_changed');
      }
      if (ref['elementId'] != target.ref['elementId']) {
        throw _FlutterTargetFailure('flutter_target_replaced');
      }
      if (ref['guard'] != target.ref['guard']) {
        throw _FlutterTargetFailure('flutter_target_changed');
      }
    }
    return target;
  }

  void validate(_BoundFlutterTarget target, {required bool dispatched}) {
    if (!bridge._enabled || target.ref['runtimeEpoch'] != runtimeEpoch) {
      throw _FlutterTargetFailure('flutter_runtime_changed',
          dispatched: dispatched);
    }
    if (!target.element.mounted) {
      throw _FlutterTargetFailure('flutter_target_replaced',
          dispatched: dispatched);
    }
    final tree = bridge._operableTree();
    if (tree['ok'] != true || tree['truncated'] == true) {
      throw _FlutterTargetFailure('flutter_observation_incomplete',
          dispatched: dispatched);
    }
    final current = _current[target.ref['elementId']];
    if (current == null) {
      throw _FlutterTargetFailure('flutter_target_not_operable',
          dispatched: dispatched);
    }
    if (current.ref['guard'] != target.ref['guard']) {
      throw _FlutterTargetFailure('flutter_target_changed',
          dispatched: dispatched);
    }
  }

  // Admission already resolved a unique target against a complete observation.
  // While DOWN is held, recheck only that exact Element and its live action
  // ancestors; traversing the whole App here changes the gesture's duration.
  void validatePointer(_BoundFlutterTarget target, Offset point) {
    if (!bridge._enabled || target.ref['runtimeEpoch'] != runtimeEpoch) {
      throw const _FlutterTargetFailure('flutter_runtime_changed',
          dispatched: true);
    }
    if (!target.element.mounted) {
      throw const _FlutterTargetFailure('flutter_target_replaced',
          dispatched: true);
    }
    final bounds = bridge._visibleGlobalBounds(target.element);
    if (bounds == null ||
        !bounds.contains(point) ||
        !bridge._isHitTestReachable(target.element.findRenderObject(), point)) {
      throw const _FlutterTargetFailure('flutter_target_not_operable',
          dispatched: true);
    }
    _ActionTarget? tap;
    _ActionTarget? scroll;
    void inspect(Element element) {
      final widgetType = element.widget.runtimeType.toString();
      final isTap = tap == null && bridge._isTapWidget(widgetType);
      final isScroll = scroll == null && element.widget is Scrollable;
      if (!isTap && !isScroll) return;
      final bounds = bridge._visibleGlobalBounds(element);
      if (bounds == null) return;
      final action = _ActionTarget(
          element: element, widgetType: widgetType, bounds: bounds);
      if (isTap) tap = action;
      if (isScroll) scroll = action;
    }

    inspect(target.element);
    target.element.visitAncestorElements((element) {
      inspect(element);
      return tap == null || scroll == null;
    });
    final widget = target.element.widget;
    final actions = <String>[
      if (bridge._widgetText(target.element).isNotEmpty) 'tap',
      if (widget is EditableText) 'input',
      if (scroll != null) 'scroll',
    ]..sort();
    if (_signature(target.element, actions, tap, scroll) != target.signature) {
      throw const _FlutterTargetFailure('flutter_target_changed',
          dispatched: true);
    }
  }

  double number(Map<String, Object?> request, String field) {
    final value = request[field];
    if (value is! num || !value.isFinite) {
      throw _FlutterTargetFailure('invalid_argument', field: field);
    }
    return value.toDouble();
  }

  Map<String, Object?> receipt(
          _BoundFlutterTarget target, Map<String, Object?> values) =>
      {
        'ok': true,
        'dispatched': true,
        'ambiguous': false,
        'targetValidation': schema,
        'targetRef': target.ref,
        ...values,
      };

  Future<Map<String, Object?>> tap(Map<String, Object?> request) async {
    final target = resolve(request, 'tap');
    final point = bridge._visibleGlobalBounds(target.element)?.center;
    if (point == null)
      throw _FlutterTargetFailure('flutter_target_not_operable');
    final tapped = await bridge._dispatchTap(point, target: target);
    final result = receipt(target, {'x': tapped.dx, 'y': tapped.dy});
    bridge.recordEvent(
        category: 'ui.interaction', name: 'target.tap', data: result);
    return result;
  }

  Future<Map<String, Object?>> input(Map<String, Object?> request) async {
    final text = request['text'];
    if (text is! String)
      throw _FlutterTargetFailure('invalid_argument', field: 'text');
    final target = resolve(request, 'input');
    final editor = target.editor!;
    final controller = editor.widget.controller;
    final focus = editor.widget.focusNode;
    if (editor.widget.readOnly || !focus.canRequestFocus) {
      throw _FlutterTargetFailure('flutter_input_not_editable');
    }
    final point = bridge._visibleGlobalBounds(target.element)!.center;
    final tapped = await bridge._dispatchTap(point, target: target);
    await bridge._waitForFrame();
    await bridge._checkAction();
    validate(target, dispatched: true);
    if (!identical(editor.widget.controller, controller) ||
        !identical(editor.widget.focusNode, focus)) {
      throw _FlutterTargetFailure('flutter_target_changed', dispatched: true);
    }
    if (!focus.hasFocus ||
        !identical(FocusManager.instance.primaryFocus, focus)) {
      throw _FlutterTargetFailure('flutter_input_focus_changed',
          dispatched: true);
    }
    // Address this exact TextInputClient. A global TextInput update would write
    // to whichever client became active while the tap and frames were awaited.
    bridge._markActionDispatched();
    editor.updateEditingValue(TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    ));
    final result = receipt(
        target, {'textLength': text.length, 'x': tapped.dx, 'y': tapped.dy});
    await bridge._waitForFrame();
    bridge.recordEvent(
        category: 'ui.interaction', name: 'input.changed', data: result);
    return result;
  }

  Future<Map<String, Object?>> scroll(Map<String, Object?> request) async {
    final delta = number(request, 'delta');
    final target = resolve(request, 'scroll');
    return scrollTarget(target, delta);
  }

  Future<Map<String, Object?>> scrollTarget(
      _BoundFlutterTarget target, double delta) async {
    await bridge._checkAction();
    validate(target, dispatched: false);
    final state = target.scrollState;
    if (state == null ||
        !state.mounted ||
        !state.position.hasPixels ||
        !state.position.hasContentDimensions) {
      throw _FlutterTargetFailure('flutter_scroll_not_ready');
    }
    final position = state.position;
    final before = position.pixels;
    final next = (before + delta)
        .clamp(position.minScrollExtent, position.maxScrollExtent);
    if (next == before) throw _FlutterTargetFailure('flutter_scroll_boundary');
    bridge._markActionDispatched();
    position.jumpTo(next);
    final result = receipt(
        target, {'delta': delta, 'before': before, 'after': position.pixels});
    await bridge._waitForFrame();
    bridge.recordEvent(
        category: 'ui.interaction', name: 'scroll.changed', data: result);
    return result;
  }

  Future<Map<String, Object?>> scrollUntilText(
      Map<String, Object?> request) async {
    final text = request['text'];
    final maxSwipes = request['maxSwipes'] ?? 12;
    if (text is! String ||
        text.isEmpty ||
        maxSwipes is! int ||
        maxSwipes < 0 ||
        maxSwipes > 1000) {
      throw _FlutterTargetFailure('invalid_argument');
    }
    _BoundFlutterTarget? container;
    for (var index = 0; index <= maxSwipes; index++) {
      bridge._operableTree();
      final matches = _current.values
          .where((t) => t.node['text'] == text || t.node['value'] == text)
          .toList();
      if (matches.length > 1)
        throw _FlutterTargetFailure('flutter_selector_not_unique',
            dispatched: index > 0);
      if (matches.length == 1)
        return {
          'ok': true,
          'text': text,
          'swipes': index,
          'targetRef': matches.single.ref,
          'dispatched': index > 0,
          'ambiguous': false,
        };
      if (index == maxSwipes) break;
      container ??= resolve(request, 'scroll');
      try {
        await scrollTarget(container, 420);
      } on _FlutterTargetFailure catch (error) {
        throw _FlutterTargetFailure(error.code,
            dispatched: index > 0 || error.dispatched);
      }
    }
    throw _FlutterTargetFailure('flutter_selector_not_found',
        dispatched: maxSwipes > 0);
  }
}

class _FlutterTargetGuard {
  const _FlutterTargetGuard(this.signature, this.token);
  final String signature;
  final String token;
}

class _BoundFlutterTarget {
  const _BoundFlutterTarget(
      this.element, this.node, this.ref, this.tap, this.scroll, this.signature);
  final Element element;
  final Map<String, Object?> node;
  final Map<String, Object?> ref;
  final _ActionTarget? tap;
  final _ActionTarget? scroll;
  final String signature;
  EditableTextState? get editor => element is StatefulElement &&
          (element as StatefulElement).state is EditableTextState
      ? (element as StatefulElement).state as EditableTextState
      : null;
  ScrollableState? get scrollState => scroll?.element is StatefulElement &&
          (scroll!.element as StatefulElement).state is ScrollableState
      ? (scroll!.element as StatefulElement).state as ScrollableState
      : null;
}

class _FlutterTargetFailure implements Exception {
  const _FlutterTargetFailure(this.code, {this.dispatched = false, this.field});
  final String code;
  final bool dispatched;
  final String? field;
  Map<String, Object?> toJson() => {
        'ok': false,
        'error': code,
        'dispatched': dispatched,
        'ambiguous': false,
        if (field != null) 'field': field,
      };
}
