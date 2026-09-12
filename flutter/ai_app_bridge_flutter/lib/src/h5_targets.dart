part of '../ai_app_bridge_flutter.dart';

// Registration identity is independent of an adapter's caller-supplied name.
// Re-registering the same name cannot revive an observation from the old view.
class _FlutterH5Registration {
  _FlutterH5Registration(this.adapter, this.generation);
  final AiAppBridgeH5Adapter adapter;
  final String generation;
}

class _FlutterH5Targets {
  _FlutterH5Targets(this.bridge);
  static const schema = 'aab.flutter-h5-target/v1';
  static const pageFields = [
    'schemaVersion',
    'runtimeEpoch',
    'adapterId',
    'adapterGeneration',
    'documentId',
    'url'
  ];
  static const elementFields = [
    'elementId',
    'tag',
    'id',
    'name',
    'type',
    'text',
    'ariaLabel',
    'href'
  ];
  final AiAppBridge bridge;
  final _registrations = <String, _FlutterH5Registration>{};
  var _sequence = 0;

  void register(AiAppBridgeH5Adapter adapter) {
    if (adapter.id.isEmpty || adapter.id.trim() != adapter.id) {
      throw ArgumentError.value(
          adapter.id, 'id', 'must be a nonempty exact ID');
    }
    if (_registrations.containsKey(adapter.id)) {
      throw StateError('flutter_h5_adapter_already_registered: ${adapter.id}');
    }
    _registrations[adapter.id] =
        _FlutterH5Registration(adapter, 'g${++_sequence}');
  }

  void unregister(String id) => _registrations.remove(id);

  List<Map<String, Object?>> get candidates => _registrations.values
      .map((entry) => <String, Object?>{
            'adapterId': entry.adapter.id,
            'adapterGeneration': entry.generation,
            'source': entry.adapter.source,
            'visible': entry.adapter.isVisible(),
          })
      .toList(growable: false);

  _FlutterH5Registration select(String? id) {
    if (id != null) {
      final entry = _registrations[id];
      if (entry == null) {
        throw const _FlutterTargetFailure('flutter_h5_adapter_not_found');
      }
      if (!entry.adapter.isVisible()) {
        throw const _FlutterTargetFailure('flutter_h5_adapter_hidden');
      }
      return entry;
    }
    final visible = _registrations.values
        .where((entry) => entry.adapter.isVisible())
        .toList();
    if (visible.length != 1) {
      throw _FlutterTargetFailure(visible.isEmpty
          ? 'flutter_h5_adapter_not_found'
          : 'flutter_h5_adapter_ambiguous');
    }
    return visible.single;
  }

  void current(_FlutterH5Registration entry, String epoch) {
    if (bridge._targets.runtimeEpoch != epoch ||
        !identical(_registrations[entry.adapter.id], entry)) {
      throw const _FlutterTargetFailure('reobserve_required');
    }
    if (!entry.adapter.isVisible()) {
      throw const _FlutterTargetFailure('flutter_h5_adapter_hidden');
    }
  }

  static Map<String, Object?> exactMap(
      Object? value, List<String> fields, String field,
      {bool nonempty = true}) {
    if (value is! Map ||
        value.length != fields.length ||
        !fields.every((key) =>
            value[key] is String &&
            (!nonempty || (value[key] as String).isNotEmpty))) {
      throw _FlutterTargetFailure('invalid_argument', field: field);
    }
    return Map<String, Object?>.from(value);
  }

  static Map<String, Object?> page(Object? value) {
    final result = exactMap(value, pageFields, 'expectedPage');
    if (result['schemaVersion'] != schema) {
      throw const _FlutterTargetFailure('flutter_h5_target_schema_required');
    }
    return result;
  }

  static void validate(Map<String, Object?> request) {
    final action = request['action'];
    if (request.containsKey('adapterId') &&
        (request['adapterId'] is! String ||
            (request['adapterId'] as String).isEmpty)) {
      throw const _FlutterTargetFailure('invalid_argument', field: 'adapterId');
    }
    if (action == 'h5Dom') return;
    if (action == 'h5Eval') {
      page(request['expectedPage']);
      return;
    }
    if (action != 'h5Control') return;
    final operation = request['operation'];
    if (!['click', 'input', 'scroll', 'scrollBy'].contains(operation)) {
      throw const _FlutterTargetFailure('invalid_argument', field: 'operation');
    }
    if (operation == 'scrollBy') {
      page(request['expectedPage']);
      if (request.containsKey('expectedTarget') ||
          request.containsKey('text')) {
        throw const _FlutterTargetFailure('invalid_argument',
            field: 'expectedTarget');
      }
      for (final field in ['deltaX', 'deltaY']) {
        final value = request[field];
        if (value is! num || !value.isFinite || value.abs() > 2147483647) {
          throw _FlutterTargetFailure('invalid_argument', field: field);
        }
      }
      if (request['deltaX'] == 0 && request['deltaY'] == 0) {
        throw const _FlutterTargetFailure('invalid_argument', field: 'deltaY');
      }
      return;
    }
    final target = request['expectedTarget'];
    if (target is! Map ||
        target.length != 2 ||
        !target.containsKey('pageRef') ||
        !target.containsKey('element')) {
      throw const _FlutterTargetFailure('invalid_argument',
          field: 'expectedTarget');
    }
    page(target['pageRef']);
    final element = exactMap(
        target['element'], elementFields, 'expectedTarget.element',
        nonempty: false);
    if ((element['elementId'] as String).isEmpty ||
        request.containsKey('expectedPage') ||
        request.containsKey('deltaX') ||
        request.containsKey('deltaY')) {
      throw const _FlutterTargetFailure('invalid_argument',
          field: 'expectedTarget');
    }
    if (operation == 'input') {
      if (request['text'] is! String ||
          (request['text'] as String).length > 16384) {
        throw const _FlutterTargetFailure('invalid_argument', field: 'text');
      }
    } else if (request.containsKey('text')) {
      throw const _FlutterTargetFailure('unsupported_argument', field: 'text');
    }
  }

  // This records a result of a renderer call already submitted after permission.
  // Cancellation during that App-owned future cannot erase its actual effects.
  void recordRendererDispatch() {
    final lifetime = _FlutterActionLifetime.current;
    if (lifetime != null) lifetime.dispatched = true;
  }

  Future<Map<String, Object?>> render(
      _FlutterH5Registration entry, Map<String, Object?> request,
      {required bool managed, bool mutation = false}) async {
    final epoch = bridge._targets.runtimeEpoch;
    if (managed) await bridge._checkAction();
    current(entry, epoch);
    Object? raw;
    try {
      raw = await entry.adapter.evaluateJavascript(
          'JSON.stringify(($_flutterH5Renderer)\n(${jsonEncode(request)}))');
    } catch (_) {
      // An evaluator exception cannot prove that the submitted mutation stopped.
      if (mutation) recordRendererDispatch();
      rethrow;
    }
    final result = bridge._decodeJavascriptObject(raw);
    if (result['ok'] is! bool ||
        (result['ok'] == false && result['error'] is! String) ||
        (mutation &&
            (result['dispatched'] is! bool || result['ambiguous'] is! bool))) {
      if (mutation) recordRendererDispatch();
      throw StateError('invalid_flutter_h5_renderer_result');
    }
    if (mutation && result['dispatched'] == true) recordRendererDispatch();
    if (managed) await bridge._checkAction();
    // A mutation may legitimately navigate or unregister its own view. The
    // renderer result records that original outcome; only reads require survival.
    if (!mutation) current(entry, epoch);
    return result;
  }

  Future<Map<String, Object?>> snapshot(String? adapterId,
      {bool managed = true}) async {
    final entry = select(adapterId);
    final epoch = bridge._targets.runtimeEpoch;
    final result = await render(
        entry,
        {
          'operation': 'snapshot',
          'seed':
              '$epoch:${entry.generation}:${DateTime.now().microsecondsSinceEpoch}',
        },
        managed: managed);
    if (result['ok'] != true) return result;
    final rawDom = result['dom'];
    if (rawDom is! Map ||
        rawDom['documentId'] is! String ||
        rawDom['url'] is! String ||
        rawDom['controls'] is! List ||
        rawDom['truncated'] is! bool) {
      throw StateError('invalid_flutter_h5_snapshot');
    }
    final metadata = await entry.adapter.metadata?.call();
    if (managed) await bridge._checkAction();
    current(entry, epoch);
    return {
      if (metadata != null) 'metadata': metadata,
      'ok': true,
      'h5TargetSchema': schema,
      'pageRef': {
        'schemaVersion': schema,
        'runtimeEpoch': epoch,
        'adapterId': entry.adapter.id,
        'adapterGeneration': entry.generation,
        'documentId': rawDom['documentId'],
        'url': rawDom['url'],
      },
      'dom': Map<String, Object?>.from(rawDom),
      'source': entry.adapter.source,
    };
  }

  Future<Map<String, Object?>> control(Map<String, Object?> request) async {
    validate(request);
    final target = request['expectedTarget'] as Map?;
    final expectedPage = page(target?['pageRef'] ?? request['expectedPage']);
    final entry = select(expectedPage['adapterId'] as String);
    if (expectedPage['runtimeEpoch'] != bridge._targets.runtimeEpoch ||
        expectedPage['adapterGeneration'] != entry.generation) {
      throw const _FlutterTargetFailure('reobserve_required');
    }
    final action =
        request['action'] == 'h5Eval' ? 'eval' : request['operation'];
    final rendererRequest = <String, Object?>{
      'operation': 'action',
      'action': action,
      'pageRef': expectedPage,
      if (target != null) 'element': target['element'],
      for (final field in ['text', 'deltaX', 'deltaY', 'script'])
        if (request.containsKey(field)) field: request[field],
    };
    if (action == 'click' || action == 'input') {
      final prepared = await render(
          entry, {...rendererRequest, 'operation': 'prepare'},
          managed: true);
      if (prepared['ok'] != true) return prepared;
      if (prepared['geometry'] is! Map) {
        throw StateError('invalid_flutter_h5_geometry');
      }
      rendererRequest['geometry'] = prepared['geometry'];
    }
    return render(entry, rendererRequest, managed: true, mutation: true);
  }
}
