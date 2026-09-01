import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui';

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';

import 'src/ui_observation.dart';

typedef AiAppBridgeH5Evaluator = FutureOr<Object?> Function(String script);
typedef AiAppBridgeH5MetadataProvider = FutureOr<Map<String, Object?>>
    Function();

class AiAppBridgeH5Adapter {
  const AiAppBridgeH5Adapter({
    required this.id,
    required this.source,
    required this.evaluateJavascript,
    this.metadata,
  });

  final String id;
  final String source;
  final AiAppBridgeH5Evaluator evaluateJavascript;
  final AiAppBridgeH5MetadataProvider? metadata;
}

class AiAppBridge {
  AiAppBridge._();

  static final AiAppBridge instance = AiAppBridge._();

  static const MethodChannel _channel = MethodChannel('ai_app_bridge');
  static const String _baseEndpoint = 'http://127.0.0.1:18080';
  static const String _snapshotPath = '/v1/flutter/snapshot';
  static const int _maxDumpLength = 200000;
  static const int _maxSemanticsDepth = 24;
  static const int _maxSemanticsNodes = 600;
  static const int _maxOperableDepth = 140;
  static const int _maxOperableNodes = 600;
  static const int _maxAutoCaptureBodyChars = 12000;
  static const int _maxAutoCaptureMessageChars = 4000;
  static const String _h5DomSnapshotScript = r'''
        (function() {
          function text(value) {
            return value == null ? '' : String(value);
          }
          function cut(value, max) {
            var raw = text(value);
            return raw.length > max ? raw.slice(0, max) : raw;
          }
          function bounds(element) {
            var rect = element.getBoundingClientRect();
            return {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height
            };
          }
          function sensitive(element) {
            var probe = [
              element.type,
              element.id,
              element.name,
              element.autocomplete,
              element.getAttribute('data-sensitive'),
              element.getAttribute('data-private')
            ].join(' ').toLowerCase();
            return /password|passwd|pwd|passcode/.test(probe);
          }
          var selector = 'a,button,input,textarea,select,[role],[onclick],[aria-label]';
          var controls = Array.prototype.slice.call(document.querySelectorAll(selector), 0, 200)
            .map(function(element, index) {
              return {
                index: index,
                tag: text(element.tagName).toLowerCase(),
                id: text(element.id),
                name: text(element.getAttribute('name')),
                type: text(element.getAttribute('type')),
                role: text(element.getAttribute('role')),
                ariaLabel: text(element.getAttribute('aria-label')),
                placeholder: text(element.getAttribute('placeholder')),
                text: sensitive(element)
                  ? '[redacted:length=' + text(element.value).length + ']'
                  : cut(element.innerText || element.value || element.title || element.getAttribute('aria-label'), 300),
                href: cut(element.href, 500),
                disabled: !!element.disabled,
                bounds: bounds(element)
              };
            });
          return JSON.stringify({
            ok: true,
            title: document.title,
            url: location.href,
            readyState: document.readyState,
            bodyText: cut(document.body && document.body.innerText, 20000),
            controls: controls,
            controlCount: controls.length,
            updatedAtMs: Date.now()
          });
        })()
  ''';
  static const String _h5ConsoleInstallScript =
      "(function(){if(window.__aabConsoleHook)return 0;window.__aabConsoleHook=true;"
      "window.__aabConsoleBuf=[];var names=['log','info','warn','error','debug'];"
      "names.forEach(function(name){var original=console[name];console[name]=function(){"
      "var args=Array.prototype.slice.call(arguments);var buf=window.__aabConsoleBuf;"
      "buf.push({method:name,message:args.map(function(value){return value==null?'':String(value);}).join(' '),atMs:Date.now()});"
      "if(buf.length>1000)buf.shift();if(original)return original.apply(console,arguments);};});return 1;})()";
  static final Object _autoCaptureSuppressionKey = Object();

  bool _enabled = false;
  bool _debugPrintCaptureInstalled = false;
  bool _flutterErrorCaptureInstalled = false;
  bool _httpClientCaptureInstalled = false;
  bool _uiObservationInstalled = false;
  Timer? _postTimer;
  Timer? _layoutTimer;
  Timer? _uiStableTimer;
  Timer? _animationSnapshotTimer;
  OverlayEntry? _harnessOverlayEntry;
  SemanticsHandle? _semanticsHandle;
  DebugPrintCallback? _previousDebugPrint;
  FlutterExceptionHandler? _previousFlutterErrorHandler;
  bool Function(Object error, StackTrace stackTrace)?
      _previousPlatformErrorHandler;
  HttpOverrides? _previousHttpOverrides;
  Map<String, Object?> _app = const <String, Object?>{};
  Map<String, Object?> _route = const <String, Object?>{};
  Map<String, Object?> _h5 = const <String, Object?>{'active': false};
  final Map<String, AiAppBridgeH5Adapter> _h5Adapters =
      <String, AiAppBridgeH5Adapter>{};
  String? _activeH5AdapterId;
  final AiAppBridgeUiBurstTracker _uiBurstTracker = AiAppBridgeUiBurstTracker();
  final Map<int, int> _pointerDownAtMs = <int, int>{};
  int _lastAnimationSnapshotAtMs = 0;
  bool _snapshotInFlight = false;
  bool _snapshotPending = false;

  late final NavigatorObserver navigatorObserver =
      AiAppBridgeNavigatorObserver._(this);

  void initialize({
    required String appName,
    bool captureDebugPrint = true,
    bool captureFlutterErrors = true,
    bool captureHttpClient = true,
  }) {
    if (!kDebugMode) {
      return;
    }
    _enabled = true;
    _app = <String, Object?>{
      'name': appName,
      'mode': 'debug',
      'platform': Platform.operatingSystem,
      'initializedAtMs': DateTime.now().millisecondsSinceEpoch,
    };
    _installAutoCapture(
      captureDebugPrint: captureDebugPrint,
      captureFlutterErrors: captureFlutterErrors,
      captureHttpClient: captureHttpClient,
    );
    _installUiObservation();
    _semanticsHandle ??= SemanticsBinding.instance.ensureSemantics();
    _channel.setMethodCallHandler(_handleNativeCall);
    _layoutTimer ??= Timer.periodic(const Duration(milliseconds: 1200), (_) {
      _schedulePost();
    });
    _schedulePost();
  }

  void shutdown() {
    if (!_uiObservationInstalled) {
      _enabled = false;
      return;
    }
    SchedulerBinding.instance.removeTimingsCallback(_handleFrameTimings);
    GestureBinding.instance.pointerRouter
        .removeGlobalRoute(_handlePointerEvent);
    _uiStableTimer?.cancel();
    _animationSnapshotTimer?.cancel();
    _postTimer?.cancel();
    _layoutTimer?.cancel();
    _uiStableTimer = null;
    _animationSnapshotTimer = null;
    _postTimer = null;
    _layoutTimer = null;
    _pointerDownAtMs.clear();
    _semanticsHandle?.dispose();
    _semanticsHandle = null;
    _uiObservationInstalled = false;
    _enabled = false;
  }

  void _installUiObservation() {
    if (_uiObservationInstalled) return;
    SchedulerBinding.instance.addTimingsCallback(_handleFrameTimings);
    GestureBinding.instance.pointerRouter.addGlobalRoute(_handlePointerEvent);
    _uiObservationInstalled = true;
  }

  void _handleFrameTimings(List<FrameTiming> timings) {
    if (!_enabled || timings.isEmpty) return;
    final int nowMs = DateTime.now().millisecondsSinceEpoch;
    final List<AiAppBridgeUiTransition> transitions =
        _uiBurstTracker.addFrames(nowMs: nowMs, count: timings.length);
    final Map<String, Object?> timingSummary = _frameTimingSummary(timings);
    for (final AiAppBridgeUiTransition transition in transitions) {
      _recordUiTransition(transition, timingSummary: timingSummary);
    }
    _uiStableTimer?.cancel();
    _uiStableTimer = Timer(const Duration(milliseconds: 275), () {
      if (!_enabled) return;
      final AiAppBridgeUiTransition? stable = _uiBurstTracker.settle(
        DateTime.now().millisecondsSinceEpoch,
      );
      if (stable != null) {
        _recordUiTransition(stable);
        _schedulePost();
      }
    });
  }

  Map<String, Object?> _frameTimingSummary(List<FrameTiming> timings) {
    int maxBuildUs = 0;
    int maxRasterUs = 0;
    int maxTotalUs = 0;
    for (final FrameTiming timing in timings) {
      maxBuildUs = math.max(maxBuildUs, timing.buildDuration.inMicroseconds);
      maxRasterUs = math.max(maxRasterUs, timing.rasterDuration.inMicroseconds);
      maxTotalUs = math.max(maxTotalUs, timing.totalSpan.inMicroseconds);
    }
    return <String, Object?>{
      'batchFrames': timings.length,
      'maxBuildUs': maxBuildUs,
      'maxRasterUs': maxRasterUs,
      'maxTotalUs': maxTotalUs,
    };
  }

  void _recordUiTransition(
    AiAppBridgeUiTransition transition, {
    Map<String, Object?> timingSummary = const <String, Object?>{},
  }) {
    final String name = switch (transition.phase) {
      AiAppBridgeUiPhase.started => 'ui.animation.started',
      AiAppBridgeUiPhase.changed => 'ui.changed',
      AiAppBridgeUiPhase.stable => 'ui.stable',
    };
    recordEvent(
      category: 'ui',
      name: name,
      data: <String, Object?>{
        'platform': 'flutter',
        'burstId': transition.burstId,
        'frameCount': transition.frameCount,
        'elapsedMs': transition.elapsedMs,
        'semanticChanged': false,
        'renderChanged': transition.phase != AiAppBridgeUiPhase.stable,
        'interactionObserved': false,
        ...timingSummary,
      },
    );
    if (transition.phase == AiAppBridgeUiPhase.changed) {
      _scheduleAnimationSnapshot();
    }
  }

  void _scheduleAnimationSnapshot() {
    final int nowMs = DateTime.now().millisecondsSinceEpoch;
    final int remainingMs = 250 - (nowMs - _lastAnimationSnapshotAtMs);
    if (remainingMs <= 0) {
      _lastAnimationSnapshotAtMs = nowMs;
      unawaited(_postSnapshot());
      return;
    }
    _animationSnapshotTimer ??= Timer(
      Duration(milliseconds: remainingMs),
      () {
        _animationSnapshotTimer = null;
        if (!_enabled) return;
        _lastAnimationSnapshotAtMs = DateTime.now().millisecondsSinceEpoch;
        unawaited(_postSnapshot());
      },
    );
  }

  void _handlePointerEvent(PointerEvent event) {
    if (!_enabled) return;
    final int nowMs = DateTime.now().millisecondsSinceEpoch;
    if (event is PointerDownEvent) {
      _pointerDownAtMs[event.pointer] = nowMs;
      return;
    }
    if (event is PointerCancelEvent) {
      _pointerDownAtMs.remove(event.pointer);
      return;
    }
    if (event is! PointerUpEvent) return;
    final int? downAtMs = _pointerDownAtMs.remove(event.pointer);
    recordEvent(
      category: 'ui.interaction',
      name: 'pointer.tap',
      data: <String, Object?>{
        'x': event.position.dx.round(),
        'y': event.position.dy.round(),
        'kind': event.kind.name,
        'semanticChanged': false,
        'renderChanged': false,
        'interactionObserved': true,
        if (downAtMs != null) 'durationMs': nowMs - downAtMs,
      },
    );
  }

  Future<Object?> _handleNativeCall(MethodCall call) async {
    if (call.method != 'runAction') {
      throw MissingPluginException('No handler for ${call.method}');
    }
    final Object? arguments = call.arguments;
    return _runAction(arguments?.toString() ?? '{}');
  }

  void _installAutoCapture({
    required bool captureDebugPrint,
    required bool captureFlutterErrors,
    required bool captureHttpClient,
  }) {
    if (captureDebugPrint && !_debugPrintCaptureInstalled) {
      _previousDebugPrint = debugPrint;
      debugPrint = (String? message, {int? wrapWidth}) {
        _previousDebugPrint?.call(message, wrapWidth: wrapWidth);
        if (!_enabled || _isAutoCaptureSuppressed || message == null) {
          return;
        }
        recordLog(
          level: 'debug',
          tag: 'FlutterDebugPrint',
          message: _trimCaptureText(message),
          data: <String, Object?>{
            'source': 'debugPrint',
            'wrapWidth': wrapWidth,
          },
        );
      };
      _debugPrintCaptureInstalled = true;
    }

    if (captureFlutterErrors && !_flutterErrorCaptureInstalled) {
      _previousFlutterErrorHandler = FlutterError.onError;
      FlutterError.onError = (FlutterErrorDetails details) {
        _recordAutomaticError(
          tag: 'FlutterError',
          source: 'FlutterError.onError',
          message: details.exceptionAsString(),
          error: details.exception,
          stackTrace: details.stack,
          data: <String, Object?>{
            if (details.library != null) 'library': details.library,
            if (details.context != null) 'context': details.context.toString(),
          },
        );
        final FlutterExceptionHandler? previous = _previousFlutterErrorHandler;
        if (previous != null) {
          previous(details);
        } else {
          FlutterError.presentError(details);
        }
      };

      _previousPlatformErrorHandler = PlatformDispatcher.instance.onError;
      PlatformDispatcher.instance.onError =
          (Object error, StackTrace stackTrace) {
        _recordAutomaticError(
          tag: 'FlutterPlatformError',
          source: 'PlatformDispatcher.onError',
          message: error.toString(),
          error: error,
          stackTrace: stackTrace,
        );
        return _previousPlatformErrorHandler?.call(error, stackTrace) ?? false;
      };
      _flutterErrorCaptureInstalled = true;
    }

    if (captureHttpClient && !_httpClientCaptureInstalled) {
      _previousHttpOverrides = HttpOverrides.current;
      HttpOverrides.global = _AiAppDebugHttpOverrides(
        previous: _previousHttpOverrides,
        bridge: this,
      );
      _httpClientCaptureInstalled = true;
    }
  }

  bool get _isAutoCaptureSuppressed =>
      Zone.current[_autoCaptureSuppressionKey] == true;

  void _recordAutomaticError({
    required String tag,
    required String source,
    required String message,
    Object? error,
    StackTrace? stackTrace,
    Map<String, Object?> data = const <String, Object?>{},
  }) {
    if (!_enabled || _isAutoCaptureSuppressed) {
      return;
    }
    recordLog(
      level: 'error',
      tag: tag,
      message: _trimCaptureText(message),
      data: <String, Object?>{
        'source': source,
        if (error != null) 'errorType': error.runtimeType.toString(),
        if (stackTrace != null)
          'stackTrace': _trimCaptureText(stackTrace.toString()),
        ...data,
      },
    );
  }

  void recordRoute({
    required String location,
    required String action,
    Object? extra,
  }) {
    if (!_enabled) {
      return;
    }
    _route = <String, Object?>{
      'location': location,
      'action': action,
      'extraType': extra?.runtimeType.toString(),
      'updatedAtMs': DateTime.now().millisecondsSinceEpoch,
    };
    recordEvent(
      category: 'ui',
      name: 'ui.route.changed',
      data: <String, Object?>{
        'location': location,
        'action': action,
        'extraType': extra?.runtimeType.toString(),
        'semanticChanged': true,
        'renderChanged': false,
        'interactionObserved': false,
      },
    );
    _schedulePost();
  }

  void recordH5({
    required bool active,
    String? source,
    String? currentUrl,
    String? title,
    bool? isLoading,
    Object? dom,
  }) {
    if (!_enabled) {
      return;
    }
    _h5 = <String, Object?>{
      'active': active,
      if (source != null) 'source': source,
      if (currentUrl != null) 'currentUrl': currentUrl,
      if (title != null) 'title': title,
      if (isLoading != null) 'isLoading': isLoading,
      if (dom != null) 'dom': dom,
      'updatedAtMs': DateTime.now().millisecondsSinceEpoch,
    };
    _schedulePost();
  }

  void clearH5() {
    recordH5(active: false);
  }

  void registerH5Adapter(
    AiAppBridgeH5Adapter adapter, {
    bool activate = true,
  }) {
    final String id = adapter.id.trim();
    if (id.isEmpty) {
      throw ArgumentError.value(adapter.id, 'id', 'must not be empty');
    }
    _h5Adapters[id] = adapter;
    if (activate || _activeH5AdapterId == null) {
      _activeH5AdapterId = id;
    }
    if (_enabled) {
      _schedulePost();
    }
  }

  void unregisterH5Adapter(String id) {
    _h5Adapters.remove(id);
    if (_activeH5AdapterId == id) {
      _activeH5AdapterId = _h5Adapters.isEmpty ? null : _h5Adapters.keys.first;
    }
    if (!_enabled) {
      return;
    }
    if (_h5Adapters.isEmpty) {
      clearH5();
    } else {
      _schedulePost();
    }
  }

  void recordLog({
    String level = 'info',
    required String tag,
    required String message,
    Object? data,
  }) {
    if (!_enabled) {
      return;
    }
    final Map<String, Object?> payload = <String, Object?>{
      'level': level,
      'tag': tag,
      'message': message,
      if (data != null) 'data': data,
    };
    unawaited(_sendCapture('recordLog', '/v1/logs', payload));
  }

  void recordNetwork({
    String source = 'flutter-sdk',
    required String method,
    required String url,
    int? statusCode,
    int? durationMs,
    String? requestBody,
    String? responseBody,
    Object? requestHeaders,
    Object? responseHeaders,
    String? error,
  }) {
    if (!_enabled) {
      return;
    }
    final Map<String, Object?> payload = <String, Object?>{
      'source': source,
      'method': method,
      'url': url,
      if (statusCode != null) 'statusCode': statusCode,
      if (durationMs != null) 'durationMs': durationMs,
      if (requestBody != null) 'requestBody': requestBody,
      if (responseBody != null) 'responseBody': responseBody,
      if (requestHeaders != null) 'requestHeaders': requestHeaders,
      if (responseHeaders != null) 'responseHeaders': responseHeaders,
      if (error != null) 'error': error,
    };
    unawaited(_sendCapture('recordNetwork', '/v1/network', payload));
  }

  void recordState({
    String namespace = 'app',
    required String key,
    required Object? value,
  }) {
    if (!_enabled) {
      return;
    }
    final Map<String, Object?> payload = <String, Object?>{
      'namespace': namespace,
      'key': key,
      'value': value,
    };
    unawaited(_sendCapture('recordState', '/v1/state', payload));
  }

  void recordEvent({
    String category = 'app',
    required String name,
    Object? data,
  }) {
    if (!_enabled) {
      return;
    }
    final Map<String, Object?> payload = <String, Object?>{
      'category': category,
      'name': name,
      if (data != null) 'data': data,
    };
    unawaited(_sendCapture('recordEvent', '/v1/events', payload));
  }

  void _schedulePost() {
    if (!_enabled) {
      return;
    }
    _postTimer?.cancel();
    _postTimer = Timer(const Duration(milliseconds: 120), () {
      unawaited(_postSnapshot());
    });
  }

  Map<String, Object?> _snapshot() {
    return <String, Object?>{
      'app': _app,
      'route': _route,
      'h5': _h5,
      'layout': _layoutSnapshot(),
      'updatedAtMs': DateTime.now().millisecondsSinceEpoch,
    };
  }

  AiAppBridgeH5Adapter? get _activeH5Adapter {
    final String? id = _activeH5AdapterId;
    if (id != null) {
      final AiAppBridgeH5Adapter? adapter = _h5Adapters[id];
      if (adapter != null) {
        return adapter;
      }
    }
    return _h5Adapters.isEmpty ? null : _h5Adapters.values.first;
  }

  Future<void> _refreshH5Snapshot() async {
    final AiAppBridgeH5Adapter? adapter = _activeH5Adapter;
    if (!_enabled || adapter == null) {
      return;
    }
    try {
      _h5 = await _buildH5Snapshot(
        adapter,
      ).timeout(const Duration(milliseconds: 800));
    } catch (error) {
      _h5 = <String, Object?>{
        'active': true,
        'adapterId': adapter.id,
        'source': adapter.source,
        'error': error.toString(),
        'updatedAtMs': DateTime.now().millisecondsSinceEpoch,
      };
    }
  }

  Future<Map<String, Object?>> _buildH5Snapshot(
    AiAppBridgeH5Adapter adapter,
  ) async {
    await adapter.evaluateJavascript(_h5ConsoleInstallScript);
    final Object? raw = await adapter.evaluateJavascript(_h5DomSnapshotScript);
    final Map<String, Object?> dom = _decodeJavascriptObject(raw);
    final Map<String, Object?> metadata = await _adapterMetadata(adapter);
    return <String, Object?>{
      'active': true,
      'adapterId': adapter.id,
      'source': adapter.source,
      ...metadata,
      'currentUrl': metadata['currentUrl'] ?? dom['url'],
      'title': metadata['title'] ?? dom['title'],
      'dom': dom,
      'updatedAtMs': DateTime.now().millisecondsSinceEpoch,
    };
  }

  Future<Map<String, Object?>> _adapterMetadata(
    AiAppBridgeH5Adapter adapter,
  ) async {
    final AiAppBridgeH5MetadataProvider? provider = adapter.metadata;
    if (provider == null) {
      return <String, Object?>{};
    }
    final Map<String, Object?> raw = await provider();
    final Map<String, Object?> metadata = <String, Object?>{};
    final Object? currentUrl = raw['currentUrl'] ?? raw['url'];
    if (currentUrl != null) {
      metadata['currentUrl'] = currentUrl;
    }
    for (final String key in <String>[
      'title',
      'isLoading',
      'progress',
      'className',
      'package',
    ]) {
      if (raw[key] != null) {
        metadata[key] = raw[key];
      }
    }
    return metadata;
  }

  Map<String, Object?> _decodeJavascriptObject(Object? raw) {
    final Object? first = _decodeJavascriptValue(raw);
    if (first is Map) {
      return _stringKeyMap(first);
    }
    if (first is String) {
      final Object? second = _decodeJavascriptValue(first);
      if (second is Map) {
        return _stringKeyMap(second);
      }
    }
    return <String, Object?>{'value': first};
  }

  Object? _decodeJavascriptValue(Object? raw) {
    if (raw == null) {
      return null;
    }
    if (raw is! String) {
      return raw;
    }
    final String trimmed = raw.trim();
    if (trimmed.isEmpty || trimmed == 'undefined') {
      return null;
    }
    try {
      return jsonDecode(trimmed);
    } catch (_) {
      return trimmed;
    }
  }

  Map<String, Object?> _stringKeyMap(Map<dynamic, dynamic> value) {
    return value.map<String, Object?>(
      (dynamic key, dynamic mapValue) =>
          MapEntry<String, Object?>(key.toString(), mapValue),
    );
  }

  Map<String, Object?> _layoutSnapshot() {
    final List<Map<String, Object?>> secureInputs = _secureInputSummaries();
    final bool hasSecureInputs = secureInputs.isNotEmpty;
    final Map<String, Object?> result = <String, Object?>{
      // Flutter's diagnostic trees include TextEditingController values even
      // when an EditableText is obscured. Suppress both raw diagnostic sources
      // while a secure input exists; the semantic and operable trees below
      // already expose only a length placeholder.
      'widgetInspector': hasSecureInputs
          ? <String, Object?>{
              'ok': false,
              'error': 'suppressed_secure_input',
            }
          : _widgetInspectorTree(),
      'widgetDump': hasSecureInputs
          ? <String, Object?>{
              'ok': false,
              'error': 'suppressed_secure_input',
            }
          : _widgetDump(),
      'semantics': _semanticsTree(),
      'operable': _operableTree(),
      if (hasSecureInputs)
        'privacy': <String, Object?>{
          'secureInputCount': secureInputs.length,
          'rawTextCaptured': false,
          'inputs': secureInputs,
        },
    };
    return result;
  }

  List<Map<String, Object?>> _secureInputSummaries() {
    final Element? rootElement = WidgetsBinding.instance.rootElement;
    if (rootElement == null) {
      return const <Map<String, Object?>>[];
    }
    final List<Map<String, Object?>> inputs = <Map<String, Object?>>[];
    final Set<Element> visited = HashSet<Element>.identity();

    void visit(Element element) {
      if (!visited.add(element)) {
        return;
      }
      final Widget widget = element.widget;
      if (widget is EditableText && widget.obscureText) {
        inputs.add(<String, Object?>{
          'value': '[secure:length=${widget.controller.text.length}]',
          'textLength': widget.controller.text.length,
          'rawTextCaptured': false,
        });
      }
      element.visitChildren(visit);
    }

    visit(rootElement);
    return inputs;
  }

  Map<String, Object?> _operableTree() {
    try {
      final Element? rootElement = WidgetsBinding.instance.rootElement;
      if (rootElement == null) {
        return <String, Object?>{'ok': false, 'error': 'no_root_element'};
      }
      final dynamic view =
          WidgetsBinding.instance.platformDispatcher.views.first;
      final double devicePixelRatio = view.devicePixelRatio;
      final Size physicalSize = view.physicalSize;
      final Size logicalSize = physicalSize / devicePixelRatio;
      final List<Map<String, Object?>> nodes = <Map<String, Object?>>[];
      final List<String> sampleWidgetTypes = <String>[];
      bool truncated = false;
      var nextId = 0;
      var visitedCount = 0;
      var textCount = 0;
      var actionCount = 0;
      final Set<Element> visited = HashSet<Element>.identity();

      void collectNode({
        required int depth,
        required Widget widget,
        required Rect? bounds,
        required _ActionTarget? tapTarget,
        required _ActionTarget? scrollTarget,
      }) {
        final String widgetType = widget.runtimeType.toString();
        if (sampleWidgetTypes.length < 40) {
          sampleWidgetTypes.add(widgetType);
        }
        final _ActionTarget? currentTapTarget =
            _isTapWidget(widgetType) && bounds != null
                ? _ActionTarget(widgetType: widgetType, bounds: bounds)
                : tapTarget;
        final _ActionTarget? currentScrollTarget =
            _isScrollWidget(widgetType) && bounds != null
                ? _ActionTarget(widgetType: widgetType, bounds: bounds)
                : scrollTarget;

        final String text = _widgetText(widget);
        final String value = _widgetValue(widget);
        if (text.isNotEmpty || value.isNotEmpty) {
          textCount += 1;
        }
        final Set<String> actions = <String>{};
        final Rect? tapBounds = currentTapTarget?.bounds ?? bounds;
        if (tapBounds != null && text.isNotEmpty) {
          actions.add('tap');
        }
        if (_isInputWidget(widgetType)) {
          actions.add('input');
        }
        if (currentScrollTarget != null) {
          actions.add('scroll');
        }
        if (actions.isNotEmpty) {
          actionCount += 1;
        }

        final bool isActionNode =
            (text.isNotEmpty || value.isNotEmpty) && actions.isNotEmpty;
        final bool isStandaloneScrollNode =
            _isScrollWidget(widgetType) && currentScrollTarget != null;

        if (isActionNode || isStandaloneScrollNode) {
          nodes.add(<String, Object?>{
            'id': nextId++,
            'widgetType': widgetType,
            if (text.isNotEmpty) 'text': _trimNodeText(text),
            if (value.isNotEmpty) 'value': _trimNodeText(value),
            if (bounds != null) 'bounds': _rectToJson(bounds),
            'actions': actions.toList()..sort(),
            if (tapBounds != null && text.isNotEmpty)
              'tap': <String, Object?>{
                'widgetType': currentTapTarget?.widgetType ?? widgetType,
                'bounds': _rectToJson(tapBounds),
              },
            if (_isInputWidget(widgetType) && bounds != null)
              'input': <String, Object?>{'bounds': _rectToJson(bounds)},
            if (currentScrollTarget != null)
              'scroll': <String, Object?>{
                'widgetType': currentScrollTarget.widgetType,
                'bounds': _rectToJson(currentScrollTarget.bounds),
              },
            'depth': depth,
          });
        }
      }

      void visitInspector(
        Map<String, Object?> node, {
        required int depth,
        _ActionTarget? tapTarget,
        _ActionTarget? scrollTarget,
      }) {
        if (depth > _maxOperableDepth) {
          return;
        }
        if (nodes.length >= _maxOperableNodes) {
          truncated = true;
          return;
        }
        final Element? element = _elementFromInspectorNode(node);
        if (element != null && !visited.add(element)) {
          return;
        }
        visitedCount += 1;
        final Widget? widget = element?.widget;
        final Rect? bounds = _visibleGlobalBounds(element);
        _ActionTarget? nextTapTarget = tapTarget;
        _ActionTarget? nextScrollTarget = scrollTarget;
        if (widget != null) {
          collectNode(
            depth: depth,
            widget: widget,
            bounds: bounds,
            tapTarget: tapTarget,
            scrollTarget: scrollTarget,
          );
          final String widgetType = widget.runtimeType.toString();
          if (_isTapWidget(widgetType) && bounds != null) {
            nextTapTarget = _ActionTarget(
              widgetType: widgetType,
              bounds: bounds,
            );
          }
          if (_isScrollWidget(widgetType) && bounds != null) {
            nextScrollTarget = _ActionTarget(
              widgetType: widgetType,
              bounds: bounds,
            );
          }
        }
        for (final Map<String, Object?> child in _inspectorChildren(node)) {
          visitInspector(
            child,
            depth: depth + 1,
            tapTarget: nextTapTarget,
            scrollTarget: nextScrollTarget,
          );
        }
      }

      void visitElement(
        Element element, {
        required int depth,
        _ActionTarget? tapTarget,
        _ActionTarget? scrollTarget,
      }) {
        if (depth > _maxOperableDepth) {
          return;
        }
        if (!visited.add(element)) {
          return;
        }
        if (nodes.length >= _maxOperableNodes) {
          truncated = true;
          return;
        }

        visitedCount += 1;
        final Widget widget = element.widget;
        final String widgetType = widget.runtimeType.toString();
        final Rect? bounds = _visibleGlobalBounds(element);
        final _ActionTarget? currentTapTarget =
            _isTapWidget(widgetType) && bounds != null
                ? _ActionTarget(widgetType: widgetType, bounds: bounds)
                : tapTarget;
        final _ActionTarget? currentScrollTarget =
            _isScrollWidget(widgetType) && bounds != null
                ? _ActionTarget(widgetType: widgetType, bounds: bounds)
                : scrollTarget;

        collectNode(
          depth: depth,
          widget: widget,
          bounds: bounds,
          tapTarget: tapTarget,
          scrollTarget: scrollTarget,
        );

        _visitElementChildren(element, (Element child) {
          visitElement(
            child,
            depth: depth + 1,
            tapTarget: currentTapTarget,
            scrollTarget: currentScrollTarget,
          );
        });
      }

      final Map<String, Object?>? inspectorRoot = _inspectorRootTree();
      if (inspectorRoot != null) {
        visitInspector(inspectorRoot, depth: 0);
      } else {
        visitElement(rootElement, depth: 0);
      }
      return <String, Object?>{
        'ok': true,
        'nodes': nodes,
        'count': nodes.length,
        'visitedCount': visitedCount,
        'textCount': textCount,
        'actionCount': actionCount,
        'sampleWidgetTypes': sampleWidgetTypes,
        'truncated': truncated,
        'viewport': <String, Object?>{
          'devicePixelRatio': devicePixelRatio,
          'logicalWidth': logicalSize.width,
          'logicalHeight': logicalSize.height,
          'physicalWidth': physicalSize.width,
          'physicalHeight': physicalSize.height,
        },
        'updatedAtMs': DateTime.now().millisecondsSinceEpoch,
      };
    } catch (error) {
      return <String, Object?>{'ok': false, 'error': error.toString()};
    }
  }

  Object? _widgetInspectorTree() {
    try {
      final String raw = WidgetInspectorService.instance
          .getRootWidgetSummaryTree('ai_app_bridge');
      return jsonDecode(raw);
    } catch (error) {
      return <String, Object?>{'ok': false, 'error': error.toString()};
    }
  }

  void _visitElementChildren(Element element, ElementVisitor visitor) {
    var hasDiagnosticElementChild = false;
    for (final DiagnosticsNode child
        in element.toDiagnosticsNode().getChildren()) {
      final Object? value = child.value;
      if (value is Element) {
        hasDiagnosticElementChild = true;
        visitor(value);
      }
    }
    if (hasDiagnosticElementChild) {
      return;
    }
    try {
      element.debugVisitOnstageChildren(visitor);
    } catch (_) {
      element.visitChildren(visitor);
    }
  }

  Map<String, Object?>? _inspectorRootTree() {
    try {
      final String raw = WidgetInspectorService.instance
          .getRootWidgetSummaryTree('ai_app_bridge_operable');
      final Object? decoded = jsonDecode(raw);
      if (decoded is Map) {
        return decoded.cast<String, Object?>();
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  List<Map<String, Object?>> _inspectorChildren(Map<String, Object?> node) {
    final Object? children = node['children'];
    if (children is! List) {
      return const <Map<String, Object?>>[];
    }
    return children
        .whereType<Map>()
        .map((Map child) => child.cast<String, Object?>())
        .toList(growable: false);
  }

  Element? _elementFromInspectorNode(Map<String, Object?> node) {
    final Object? valueId = node['valueId'];
    if (valueId is! String) {
      return null;
    }
    try {
      // ignore: invalid_use_of_protected_member
      final Object? object = WidgetInspectorService.instance.toObject(valueId);
      return object is Element ? object : null;
    } catch (_) {
      return null;
    }
  }

  Future<Map<String, Object?>> _runAction(String body) async {
    try {
      final Object? decoded = body.trim().isEmpty ? null : jsonDecode(body);
      final Map<String, Object?> request = decoded is Map
          ? decoded.cast<String, Object?>()
          : <String, Object?>{};
      final String action = request['action']?.toString() ?? '';
      final Map<String, Object?> result = switch (action) {
        'tapAt' => await _runTapAt(request),
        'tapText' => await _runTapText(request),
        'inputText' => await _runInputText(request),
        'swipe' => await _runSwipe(request),
        'scrollBy' => await _runScrollBy(request),
        'scrollUntilText' => await _runScrollUntilText(request),
        'hideKeyboard' => await _runHideKeyboard(),
        'back' => await _runBack(),
        'openHarness' => await _runOpenHarness(),
        'h5Adapters' => _runH5Adapters(),
        'h5Dom' => await _runH5Dom(),
        'h5Eval' => await _runH5Eval(request),
        _ => <String, Object?>{'ok': false, 'error': 'unknown_action'},
      };
      _schedulePost();
      return result;
    } catch (error) {
      return <String, Object?>{'ok': false, 'error': error.toString()};
    }
  }

  Future<Map<String, Object?>> _runTapAt(Map<String, Object?> request) async {
    final double? x = _doubleValue(request['x']);
    final double? y = _doubleValue(request['y']);
    if (x == null || y == null) {
      return <String, Object?>{'ok': false, 'error': 'x_y_required'};
    }
    await _dispatchTap(Offset(x, y));
    return <String, Object?>{'ok': true, 'x': x, 'y': y};
  }

  Future<Map<String, Object?>> _runTapText(Map<String, Object?> request) async {
    final String text = request['text']?.toString() ?? '';
    if (text.isEmpty) {
      return <String, Object?>{'ok': false, 'error': 'text_required'};
    }
    final _RuntimeTarget? target = _findTargetByText(text);
    if (target == null) {
      return <String, Object?>{'ok': false, 'error': 'text_not_found'};
    }
    await _dispatchTap(target.bounds.center);
    return <String, Object?>{
      'ok': true,
      'text': target.text,
      'widgetType': target.widgetType,
      'bounds': _rectToJson(target.bounds),
    };
  }

  Future<Map<String, Object?>> _runInputText(
    Map<String, Object?> request,
  ) async {
    final String text = request['text']?.toString() ?? '';
    final Offset? point = _pointFromRequest(request) ?? _firstInputCenter();
    if (point == null) {
      return <String, Object?>{'ok': false, 'error': 'input_target_not_found'};
    }
    await _dispatchTap(point);
    await _waitForFrame();
    TextInput.updateEditingValue(
      TextEditingValue(
        text: text,
        selection: TextSelection.collapsed(offset: text.length),
      ),
    );
    await _waitForFrame();
    recordEvent(
      category: 'ui.interaction',
      name: 'input.changed',
      data: <String, Object?>{
        'length': text.length,
        'x': point.dx.round(),
        'y': point.dy.round(),
      },
    );
    return <String, Object?>{
      'ok': true,
      'text': text,
      'x': point.dx,
      'y': point.dy,
    };
  }

  Future<Map<String, Object?>> _runSwipe(Map<String, Object?> request) async {
    final double? startX = _doubleValue(request['startX']);
    final double? startY = _doubleValue(request['startY']);
    final double? endX = _doubleValue(request['endX']);
    final double? endY = _doubleValue(request['endY']);
    if (startX == null || startY == null || endX == null || endY == null) {
      return <String, Object?>{'ok': false, 'error': 'start_end_required'};
    }
    await _dispatchSwipe(Offset(startX, startY), Offset(endX, endY));
    return <String, Object?>{
      'ok': true,
      'startX': startX,
      'startY': startY,
      'endX': endX,
      'endY': endY,
    };
  }

  Future<Map<String, Object?>> _runScrollBy(
    Map<String, Object?> request,
  ) async {
    final double delta = _doubleValue(request['delta']) ?? 420;
    await _hideKeyboard();
    final bool didScroll = await _scrollPrimaryBy(delta);
    return <String, Object?>{'ok': didScroll, 'delta': delta};
  }

  Future<Map<String, Object?>> _runScrollUntilText(
    Map<String, Object?> request,
  ) async {
    final String text = request['text']?.toString() ?? '';
    if (text.isEmpty) {
      return <String, Object?>{'ok': false, 'error': 'text_required'};
    }
    final int maxSwipes = _intValue(request['maxSwipes']) ?? 12;
    await _hideKeyboard();
    final Rect viewport = _viewportRect();
    final Offset start = Offset(viewport.center.dx, viewport.bottom - 80);
    final Offset end = Offset(viewport.center.dx, viewport.top + 160);
    for (var index = 0; index <= maxSwipes; index += 1) {
      final _RuntimeTarget? target = _findTargetByText(text);
      if (target != null) {
        return <String, Object?>{
          'ok': true,
          'text': target.text,
          'swipes': index,
          'bounds': _rectToJson(target.bounds),
        };
      }
      if (index == maxSwipes) {
        break;
      }
      final bool didScroll = await _scrollPrimaryBy(420);
      if (!didScroll) {
        await _dispatchSwipe(start, end);
      }
    }
    return <String, Object?>{'ok': false, 'error': 'text_not_found'};
  }

  Future<Map<String, Object?>> _runHideKeyboard() async {
    await _hideKeyboard();
    return <String, Object?>{'ok': true};
  }

  Future<void> _hideKeyboard() async {
    FocusManager.instance.primaryFocus?.unfocus();
    SystemChannels.textInput.invokeMethod<void>('TextInput.hide').ignore();
    await _waitForFrame();
  }

  Future<Map<String, Object?>> _runBack() async {
    if (_harnessOverlayEntry != null) {
      _closeHarnessOverlay();
      return <String, Object?>{'ok': true, 'handled': true};
    }
    final NavigatorState? navigator = _rootNavigatorState();
    final bool didPop = navigator == null ? false : await navigator.maybePop();
    return <String, Object?>{'ok': true, 'handled': didPop};
  }

  Future<Map<String, Object?>> _runOpenHarness() async {
    if (_harnessOverlayEntry?.mounted == true) {
      return <String, Object?>{'ok': true, 'alreadyOpen': true};
    }
    final OverlayState? overlay = _activeOverlayState();
    if (overlay != null) {
      late final OverlayEntry entry;
      entry = OverlayEntry(
        builder: (_) => _AiAppBridgeHarnessPage(
          onClose: () {
            entry.remove();
            if (_harnessOverlayEntry == entry) {
              _harnessOverlayEntry = null;
            }
          },
        ),
      );
      _harnessOverlayEntry = entry;
      overlay.insert(entry);
      await _waitForFrame();
      return <String, Object?>{'ok': true, 'surface': 'overlay'};
    }

    final NavigatorState? navigator = _rootNavigatorState();
    if (navigator == null) {
      return <String, Object?>{'ok': false, 'error': 'navigator_not_found'};
    }
    unawaited(
      navigator.push<void>(
        MaterialPageRoute<void>(
          builder: (_) => const _AiAppBridgeHarnessPage(),
        ),
      ),
    );
    await _waitForFrame();
    return <String, Object?>{'ok': true, 'surface': 'navigator'};
  }

  void _closeHarnessOverlay() {
    _harnessOverlayEntry?.remove();
    _harnessOverlayEntry = null;
  }

  OverlayState? _activeOverlayState() {
    final List<OverlayState> overlays = <OverlayState>[];
    for (final Element element in _inspectorElements()) {
      if (element is StatefulElement && element.state is OverlayState) {
        overlays.add(element.state as OverlayState);
      }
    }
    final Element? rootElement = WidgetsBinding.instance.rootElement;
    final Set<Element> visited = HashSet<Element>.identity();
    void walk(Element element) {
      if (!visited.add(element)) {
        return;
      }
      if (element is StatefulElement && element.state is OverlayState) {
        overlays.add(element.state as OverlayState);
      }
      _visitElementChildren(element, walk);
    }

    if (rootElement != null) {
      walk(rootElement);
    }
    return overlays.isEmpty ? null : overlays.last;
  }

  Map<String, Object?> _runH5Adapters() {
    return <String, Object?>{
      'ok': true,
      'activeAdapterId': _activeH5Adapter?.id,
      'adapters': _h5Adapters.values
          .map(
            (AiAppBridgeH5Adapter adapter) => <String, Object?>{
              'id': adapter.id,
              'source': adapter.source,
              'active': adapter.id == _activeH5Adapter?.id,
            },
          )
          .toList(growable: false),
    };
  }

  Future<Map<String, Object?>> _runH5Dom() async {
    final AiAppBridgeH5Adapter? adapter = _activeH5Adapter;
    if (adapter == null) {
      return <String, Object?>{'ok': false, 'error': 'no_h5_adapter'};
    }
    final Map<String, Object?> snapshot = await _buildH5Snapshot(adapter);
    _h5 = snapshot;
    return <String, Object?>{
      'ok': true,
      'h5': snapshot,
      'dom': snapshot['dom'],
    };
  }

  Future<Map<String, Object?>> _runH5Eval(Map<String, Object?> request) async {
    final String script = request['script']?.toString().trim() ?? '';
    if (script.isEmpty) {
      return <String, Object?>{'ok': false, 'error': 'missing_script'};
    }
    final AiAppBridgeH5Adapter? adapter = _activeH5Adapter;
    if (adapter == null) {
      return <String, Object?>{'ok': false, 'error': 'no_h5_adapter'};
    }
    final Object? raw = await adapter.evaluateJavascript(script);
    final Object? result = _decodeJavascriptValue(raw);
    final Map<String, Object?> metadata = await _adapterMetadata(adapter);
    return <String, Object?>{
      'ok': true,
      'h5': <String, Object?>{
        'active': true,
        'adapterId': adapter.id,
        'source': adapter.source,
        ...metadata,
      },
      'result': result,
      'raw': raw,
      'updatedAtMs': DateTime.now().millisecondsSinceEpoch,
    };
  }

  NavigatorState? _rootNavigatorState() {
    final List<NavigatorState> navigators = <NavigatorState>[];
    for (final Element element in _inspectorElements()) {
      if (element is StatefulElement && element.state is NavigatorState) {
        navigators.add(element.state as NavigatorState);
      }
    }
    if (navigators.isNotEmpty) {
      return navigators.last;
    }

    final Element? rootElement = WidgetsBinding.instance.rootElement;
    if (rootElement == null) {
      return null;
    }
    final Set<Element> visited = HashSet<Element>.identity();
    NavigatorState? result;

    void walk(Element element) {
      if (result != null || !visited.add(element)) {
        return;
      }
      if (element is StatefulElement && element.state is NavigatorState) {
        result = element.state as NavigatorState;
        return;
      }
      _visitElementChildren(element, walk);
    }

    walk(rootElement);
    return result;
  }

  Iterable<ScrollableState> _scrollableStates() sync* {
    for (final Element element in _inspectorElements()) {
      if (element is StatefulElement && element.state is ScrollableState) {
        yield element.state as ScrollableState;
        continue;
      }
      final ScrollableState? scrollable = Scrollable.maybeOf(element);
      if (scrollable != null) {
        yield scrollable;
      }
    }
  }

  Future<bool> _scrollPrimaryBy(double delta) async {
    final List<ScrollableState> candidates = <ScrollableState>[];
    for (final ScrollableState state in _scrollableStates()) {
      final ScrollPosition position = state.position;
      if (!position.hasPixels || !position.hasContentDimensions) {
        continue;
      }
      if (position.maxScrollExtent <= position.minScrollExtent) {
        continue;
      }
      candidates.add(state);
    }
    if (candidates.isEmpty) {
      return false;
    }
    final ScrollPosition position = candidates.last.position;
    final double next = (position.pixels + delta).clamp(
      position.minScrollExtent,
      position.maxScrollExtent,
    );
    if (next == position.pixels) {
      return false;
    }
    position.jumpTo(next);
    await _waitForFrame();
    return true;
  }

  _RuntimeTarget? _findTargetByText(String text) {
    return _runtimeTargets().firstWhereOrNull(
      (_RuntimeTarget target) => target.text.contains(text),
    );
  }

  Iterable<_RuntimeTarget> _runtimeTargets() sync* {
    final List<_RuntimeTarget> inspectorTargets =
        _runtimeTargetsFromInspector().toList(growable: false);
    if (inspectorTargets.isNotEmpty) {
      yield* inspectorTargets;
      return;
    }

    final Element? rootElement = WidgetsBinding.instance.rootElement;
    if (rootElement == null) {
      return;
    }
    final Set<Element> visited = HashSet<Element>.identity();

    Iterable<Element> walk(Element root) sync* {
      if (!visited.add(root)) {
        return;
      }
      yield root;
      final List<Element> children = <Element>[];
      _visitElementChildren(root, children.add);
      for (final Element child in children) {
        yield* walk(child);
      }
    }

    for (final Element element in walk(rootElement)) {
      final String text = _widgetText(element.widget);
      if (text.isEmpty) {
        continue;
      }
      final Rect? bounds = _visibleGlobalBounds(element);
      if (bounds == null || bounds.isEmpty) {
        continue;
      }
      yield _RuntimeTarget(
        element: element,
        widgetType: element.widget.runtimeType.toString(),
        text: text,
        bounds: bounds,
      );
    }
  }

  Iterable<_RuntimeTarget> _runtimeTargetsFromInspector() sync* {
    for (final Element element in _inspectorElements()) {
      final String text = _widgetText(element.widget);
      if (text.isEmpty) {
        continue;
      }
      final Rect? bounds = _visibleGlobalBounds(element);
      if (bounds == null || bounds.isEmpty) {
        continue;
      }
      yield _RuntimeTarget(
        element: element,
        widgetType: element.widget.runtimeType.toString(),
        text: text,
        bounds: bounds,
      );
    }
  }

  Iterable<Element> _inspectorElements() sync* {
    final Map<String, Object?>? root = _inspectorRootTree();
    if (root == null) {
      return;
    }
    final Set<Element> visited = HashSet<Element>.identity();

    Iterable<Element> walk(Map<String, Object?> node) sync* {
      final Element? element = _elementFromInspectorNode(node);
      if (element != null && visited.add(element)) {
        yield element;
      }
      for (final Map<String, Object?> child in _inspectorChildren(node)) {
        yield* walk(child);
      }
    }

    yield* walk(root);
  }

  Offset? _firstInputCenter() {
    for (final Element element in _inspectorElements()) {
      if (!_isInputWidget(element.widget.runtimeType.toString())) {
        continue;
      }
      final Rect? bounds = _visibleGlobalBounds(element);
      if (bounds != null && !bounds.isEmpty) {
        return bounds.center;
      }
    }

    final Element? rootElement = WidgetsBinding.instance.rootElement;
    if (rootElement == null) {
      return null;
    }
    final Set<Element> visited = HashSet<Element>.identity();
    Offset? result;

    void walk(Element element) {
      if (result != null || !visited.add(element)) {
        return;
      }
      if (_isInputWidget(element.widget.runtimeType.toString())) {
        final Rect? bounds = _visibleGlobalBounds(element);
        if (bounds != null && !bounds.isEmpty) {
          result = bounds.center;
          return;
        }
      }
      _visitElementChildren(element, walk);
    }

    walk(rootElement);
    return result;
  }

  Future<void> _dispatchTap(Offset position) async {
    GestureBinding.instance.handlePointerEvent(
      PointerDownEvent(
        position: position,
        pointer: 1,
        kind: PointerDeviceKind.touch,
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 48));
    GestureBinding.instance.handlePointerEvent(
      PointerUpEvent(
        position: position,
        pointer: 1,
        kind: PointerDeviceKind.touch,
      ),
    );
    await _waitForFrame();
  }

  Future<void> _dispatchSwipe(Offset start, Offset end) async {
    const int pointer = 2;
    GestureBinding.instance.handlePointerEvent(
      PointerDownEvent(
        position: start,
        pointer: pointer,
        kind: PointerDeviceKind.touch,
      ),
    );
    const int steps = 8;
    Offset previous = start;
    for (var index = 1; index <= steps; index += 1) {
      final double t = index / steps;
      final Offset next = Offset.lerp(start, end, t)!;
      GestureBinding.instance.handlePointerEvent(
        PointerMoveEvent(
          position: next,
          delta: next - previous,
          pointer: pointer,
          kind: PointerDeviceKind.touch,
        ),
      );
      previous = next;
      await Future<void>.delayed(const Duration(milliseconds: 16));
    }
    GestureBinding.instance.handlePointerEvent(
      PointerUpEvent(
        position: end,
        pointer: pointer,
        kind: PointerDeviceKind.touch,
      ),
    );
    await _waitForFrame();
  }

  Future<void> _waitForFrame() async {
    SchedulerBinding.instance.scheduleFrame();
    await SchedulerBinding.instance.endOfFrame;
  }

  Offset? _pointFromRequest(Map<String, Object?> request) {
    final double? x = _doubleValue(request['x']);
    final double? y = _doubleValue(request['y']);
    return x == null || y == null ? null : Offset(x, y);
  }

  Rect _viewportRect() {
    final dynamic view = WidgetsBinding.instance.platformDispatcher.views.first;
    final double devicePixelRatio = view.devicePixelRatio;
    final Size physicalSize = view.physicalSize;
    final Size logicalSize = physicalSize / devicePixelRatio;
    return Offset.zero & logicalSize;
  }

  Rect? _visibleGlobalBounds(Element? element) {
    if (element == null || _hasNonInteractiveAncestor(element)) {
      return null;
    }
    final RenderObject? renderObject = element.findRenderObject();
    final Rect? bounds = _globalBounds(renderObject);
    if (bounds == null || bounds.isEmpty) {
      return null;
    }
    final Rect viewport = _viewportRect();
    if (!viewport.contains(bounds.center)) {
      return null;
    }
    return _isHitTestReachable(renderObject, bounds.center) ? bounds : null;
  }

  bool _hasNonInteractiveAncestor(Element element) {
    var blocked = false;
    void inspect(Element candidate) {
      final Widget widget = candidate.widget;
      if (widget is Offstage && widget.offstage) {
        blocked = true;
      } else if (widget is Visibility && !widget.visible) {
        blocked = true;
      } else if (widget is IgnorePointer && widget.ignoring) {
        blocked = true;
      } else if (widget is AbsorbPointer && widget.absorbing) {
        blocked = true;
      }
    }

    inspect(element);
    if (blocked) {
      return true;
    }
    element.visitAncestorElements((Element ancestor) {
      inspect(ancestor);
      return !blocked;
    });
    return blocked;
  }

  bool _isHitTestReachable(RenderObject? renderObject, Offset point) {
    if (renderObject == null || !renderObject.attached) {
      return false;
    }
    try {
      final HitTestResult result = HitTestResult();
      // ignore: deprecated_member_use
      GestureBinding.instance.hitTest(result, point);
      return result.path.any(
        (HitTestEntry entry) => identical(entry.target, renderObject),
      );
    } catch (_) {
      return false;
    }
  }

  double? _doubleValue(Object? value) {
    if (value is num) {
      final double result = value.toDouble();
      return result.isFinite ? result : null;
    }
    return double.tryParse(value?.toString() ?? '');
  }

  int? _intValue(Object? value) {
    if (value is int) {
      return value;
    }
    return int.tryParse(value?.toString() ?? '');
  }

  Map<String, Object?> _widgetDump() {
    try {
      final Element? rootElement = WidgetsBinding.instance.rootElement;
      if (rootElement == null) {
        return <String, Object?>{'ok': false, 'error': 'no_root_element'};
      }
      final String dump = rootElement.toStringDeep(
        minLevel: DiagnosticLevel.info,
      );
      return <String, Object?>{
        'ok': true,
        'text': dump.length > _maxDumpLength
            ? dump.substring(0, _maxDumpLength)
            : dump,
        'truncated': dump.length > _maxDumpLength,
        'length': dump.length,
      };
    } catch (error) {
      return <String, Object?>{'ok': false, 'error': error.toString()};
    }
  }

  Map<String, Object?> _semanticsTree() {
    try {
      final BuildContext? context = WidgetsBinding.instance.rootElement;
      if (context == null) {
        return <String, Object?>{'ok': false, 'error': 'no_root_element'};
      }
      final PipelineOwner pipelineOwner =
          RendererBinding.instance.rootPipelineOwner;
      pipelineOwner.flushSemantics();
      final SemanticsNode? rootNode =
          pipelineOwner.semanticsOwner?.rootSemanticsNode;
      if (rootNode == null) {
        return <String, Object?>{
          'ok': false,
          'error': 'no_root_semantics_node',
          'semanticsEnabled': SemanticsBinding.instance.semanticsEnabled,
        };
      }
      final _NodeCounter counter = _NodeCounter();
      return <String, Object?>{
        'ok': true,
        'root': _semanticsNodeToJson(rootNode, depth: 0, counter: counter),
        'nodeCount': counter.count,
      };
    } catch (error) {
      return <String, Object?>{'ok': false, 'error': error.toString()};
    }
  }

  Map<String, Object?> _semanticsNodeToJson(
    SemanticsNode node, {
    required int depth,
    required _NodeCounter counter,
  }) {
    counter.count += 1;
    final SemanticsData data = node.getSemanticsData();
    final String flags = data.flagsCollection.toString();
    final bool obscured = flags.contains('isObscured');
    final Map<String, Object?> json = <String, Object?>{
      'nodeId': node.id,
      'identifier': data.identifier,
      'label': data.label,
      'value': obscured ? '[secure:length=${data.value.length}]' : data.value,
      'hint': data.hint,
      'tooltip': data.tooltip,
      'role': data.role.toString(),
      'actions': _semanticActions(data),
      'flags': flags,
      'rect': <String, Object?>{
        'left': data.rect.left,
        'top': data.rect.top,
        'right': data.rect.right,
        'bottom': data.rect.bottom,
        'width': data.rect.width,
        'height': data.rect.height,
      },
      'platformViewId': data.platformViewId,
    };
    if (depth < _maxSemanticsDepth && counter.count < _maxSemanticsNodes) {
      final List<Object?> children = <Object?>[];
      node.visitChildren((SemanticsNode child) {
        if (counter.count >= _maxSemanticsNodes) {
          return false;
        }
        children.add(
          _semanticsNodeToJson(child, depth: depth + 1, counter: counter),
        );
        return true;
      });
      if (children.isNotEmpty) {
        json['children'] = children;
      }
    }
    return json;
  }

  List<String> _semanticActions(SemanticsData data) {
    return SemanticsAction.values
        .where(data.hasAction)
        .map((SemanticsAction action) => action.name)
        .toList(growable: false);
  }

  Rect? _globalBounds(RenderObject? renderObject) {
    if (renderObject is! RenderBox || !renderObject.attached) {
      return null;
    }
    final Size size = renderObject.size;
    if (size.isEmpty || !size.width.isFinite || !size.height.isFinite) {
      return null;
    }
    final Offset topLeft = renderObject.localToGlobal(Offset.zero);
    final Rect rect = topLeft & size;
    if (!rect.left.isFinite ||
        !rect.top.isFinite ||
        !rect.right.isFinite ||
        !rect.bottom.isFinite) {
      return null;
    }
    return rect;
  }

  Map<String, Object?> _rectToJson(Rect rect) {
    return <String, Object?>{
      'left': rect.left,
      'top': rect.top,
      'right': rect.right,
      'bottom': rect.bottom,
      'width': rect.width,
      'height': rect.height,
      'centerX': rect.center.dx,
      'centerY': rect.center.dy,
    };
  }

  bool _isTapWidget(String widgetType) {
    return widgetType == 'GestureDetector' ||
        widgetType == 'RawGestureDetector' ||
        widgetType == 'InkWell' ||
        widgetType == 'InkResponse' ||
        widgetType.endsWith('Button') ||
        widgetType == 'ListTile' ||
        widgetType == 'Tab' ||
        widgetType == 'BottomNavigationBar' ||
        widgetType == 'NavigationBar';
  }

  bool _isScrollWidget(String widgetType) {
    return widgetType == 'Scrollable' ||
        widgetType == 'ListView' ||
        widgetType == 'GridView' ||
        widgetType == 'CustomScrollView' ||
        widgetType == 'SingleChildScrollView' ||
        widgetType == 'PageView';
  }

  bool _isInputWidget(String widgetType) {
    return widgetType == 'EditableText' ||
        widgetType == 'TextField' ||
        widgetType == 'TextFormField';
  }

  String _widgetText(Widget widget) {
    if (widget is Text) {
      return widget.data ?? widget.textSpan?.toPlainText() ?? '';
    }
    if (widget is RichText) {
      return widget.text.toPlainText();
    }
    if (widget is EditableText) {
      if (widget.obscureText) {
        return '[secure:length=${widget.controller.text.length}]';
      }
      return widget.controller.text;
    }
    if (widget is Semantics) {
      return widget.properties.label ?? '';
    }
    final String short = widget.toStringShort();
    final RegExpMatch? match = RegExp(
      r'^(?:Text|RichText)\("([^"]*)"\)',
    ).firstMatch(short);
    return match?.group(1) ?? '';
  }

  String _widgetValue(Widget widget) {
    if (widget is EditableText) {
      if (widget.obscureText) {
        return '[secure:length=${widget.controller.text.length}]';
      }
      return widget.controller.text;
    }
    if (widget is Semantics) {
      return widget.properties.value ?? '';
    }
    return '';
  }

  String _trimNodeText(String value) {
    final String normalized = value.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (normalized.length <= 300) {
      return normalized;
    }
    return normalized.substring(0, 300);
  }

  Future<void> _postSnapshot() async {
    if (_snapshotInFlight) {
      _snapshotPending = true;
      return;
    }
    _snapshotInFlight = true;
    try {
      await _refreshH5Snapshot();
      final String snapshotJson = jsonEncode(_snapshot());
      if (await _postSnapshotByMethodChannel(snapshotJson)) {
        return;
      }
      await _postJson(_snapshotPath, snapshotJson);
    } finally {
      _snapshotInFlight = false;
      if (_snapshotPending && _enabled) {
        _snapshotPending = false;
        scheduleMicrotask(() => unawaited(_postSnapshot()));
      }
    }
  }

  Future<void> _sendCapture(
    String method,
    String path,
    Map<String, Object?> payload,
  ) async {
    final String body = jsonEncode(payload);
    if (await _invokeBridgeMethod(method, body)) {
      return;
    }
    await _postJson(path, body);
  }

  Future<void> _postJson(String path, String body) async {
    await runZoned(() async {
      final HttpClient client = HttpClient()
        ..connectionTimeout = const Duration(milliseconds: 300);
      try {
        final Uri uri = Uri.parse('$_baseEndpoint$path');
        final HttpClientRequest request = await client
            .postUrl(uri)
            .timeout(const Duration(milliseconds: 500));
        request.headers.contentType = ContentType.json;
        request.add(utf8.encode(body));
        final HttpClientResponse response = await request.close().timeout(
              const Duration(milliseconds: 500),
            );
        await response.drain<void>();
      } catch (_) {
        // The native AI app bridge is optional and only exists in Android debug runs.
      } finally {
        client.close(force: true);
      }
    }, zoneValues: <Object, Object?>{_autoCaptureSuppressionKey: true});
  }

  Future<bool> _postSnapshotByMethodChannel(String snapshotJson) async {
    return _invokeBridgeMethod('updateSnapshot', snapshotJson);
  }

  Future<bool> _invokeBridgeMethod(String method, String body) async {
    try {
      final Object? response = await _channel.invokeMethod<Object?>(
        method,
        body,
      );
      if (response is Map && response['ok'] == false) {
        return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  String _trimCaptureText(
    String value, [
    int max = _maxAutoCaptureMessageChars,
  ]) {
    if (value.length <= max) {
      return value;
    }
    return value.substring(0, max);
  }
}

class AiAppBridgeNavigatorObserver extends NavigatorObserver {
  AiAppBridgeNavigatorObserver._(this._bridge);

  final AiAppBridge _bridge;

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _record(route, 'push');
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _record(previousRoute, 'pop');
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    _record(newRoute, 'replace');
  }

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _record(previousRoute, 'remove');
  }

  void _record(Route<dynamic>? route, String action) {
    final RouteSettings? settings = route?.settings;
    _bridge.recordRoute(
      location: settings?.name ?? route?.runtimeType.toString() ?? '<none>',
      action: action,
      extra: settings?.arguments,
    );
  }
}

class _AiAppDebugHttpOverrides extends HttpOverrides {
  _AiAppDebugHttpOverrides({required this.previous, required this.bridge});

  final HttpOverrides? previous;
  final AiAppBridge bridge;

  @override
  HttpClient createHttpClient(SecurityContext? context) {
    final HttpClient client =
        previous?.createHttpClient(context) ?? super.createHttpClient(context);
    if (Zone.current[AiAppBridge._autoCaptureSuppressionKey] == true) {
      return client;
    }
    return _AiAppCapturedHttpClient(client, bridge);
  }

  @override
  String findProxyFromEnvironment(Uri url, Map<String, String>? environment) {
    return previous?.findProxyFromEnvironment(url, environment) ??
        super.findProxyFromEnvironment(url, environment);
  }
}

class _AiAppCapturedHttpClient implements HttpClient {
  _AiAppCapturedHttpClient(this._delegate, this._bridge);

  final HttpClient _delegate;
  final AiAppBridge _bridge;

  @override
  Duration get idleTimeout => _delegate.idleTimeout;

  @override
  set idleTimeout(Duration value) => _delegate.idleTimeout = value;

  @override
  Duration? get connectionTimeout => _delegate.connectionTimeout;

  @override
  set connectionTimeout(Duration? value) => _delegate.connectionTimeout = value;

  @override
  int? get maxConnectionsPerHost => _delegate.maxConnectionsPerHost;

  @override
  set maxConnectionsPerHost(int? value) =>
      _delegate.maxConnectionsPerHost = value;

  @override
  bool get autoUncompress => _delegate.autoUncompress;

  @override
  set autoUncompress(bool value) => _delegate.autoUncompress = value;

  @override
  String? get userAgent => _delegate.userAgent;

  @override
  set userAgent(String? value) => _delegate.userAgent = value;

  @override
  Future<HttpClientRequest> open(
    String method,
    String host,
    int port,
    String path,
  ) {
    return _wrap(_delegate.open(method, host, port, path));
  }

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) {
    return _wrap(_delegate.openUrl(method, url));
  }

  @override
  Future<HttpClientRequest> get(String host, int port, String path) {
    return _wrap(_delegate.get(host, port, path));
  }

  @override
  Future<HttpClientRequest> getUrl(Uri url) {
    return _wrap(_delegate.getUrl(url));
  }

  @override
  Future<HttpClientRequest> post(String host, int port, String path) {
    return _wrap(_delegate.post(host, port, path));
  }

  @override
  Future<HttpClientRequest> postUrl(Uri url) {
    return _wrap(_delegate.postUrl(url));
  }

  @override
  Future<HttpClientRequest> put(String host, int port, String path) {
    return _wrap(_delegate.put(host, port, path));
  }

  @override
  Future<HttpClientRequest> putUrl(Uri url) {
    return _wrap(_delegate.putUrl(url));
  }

  @override
  Future<HttpClientRequest> delete(String host, int port, String path) {
    return _wrap(_delegate.delete(host, port, path));
  }

  @override
  Future<HttpClientRequest> deleteUrl(Uri url) {
    return _wrap(_delegate.deleteUrl(url));
  }

  @override
  Future<HttpClientRequest> patch(String host, int port, String path) {
    return _wrap(_delegate.patch(host, port, path));
  }

  @override
  Future<HttpClientRequest> patchUrl(Uri url) {
    return _wrap(_delegate.patchUrl(url));
  }

  @override
  Future<HttpClientRequest> head(String host, int port, String path) {
    return _wrap(_delegate.head(host, port, path));
  }

  @override
  Future<HttpClientRequest> headUrl(Uri url) {
    return _wrap(_delegate.headUrl(url));
  }

  @override
  set authenticate(
    Future<bool> Function(Uri url, String scheme, String? realm)? f,
  ) {
    _delegate.authenticate = f;
  }

  @override
  void addCredentials(
    Uri url,
    String realm,
    HttpClientCredentials credentials,
  ) {
    _delegate.addCredentials(url, realm, credentials);
  }

  @override
  set connectionFactory(
    Future<ConnectionTask<Socket>> Function(
      Uri url,
      String? proxyHost,
      int? proxyPort,
    )? f,
  ) {
    _delegate.connectionFactory = f;
  }

  @override
  set findProxy(String Function(Uri url)? f) {
    _delegate.findProxy = f;
  }

  @override
  set authenticateProxy(
    Future<bool> Function(String host, int port, String scheme, String? realm)?
        f,
  ) {
    _delegate.authenticateProxy = f;
  }

  @override
  void addProxyCredentials(
    String host,
    int port,
    String realm,
    HttpClientCredentials credentials,
  ) {
    _delegate.addProxyCredentials(host, port, realm, credentials);
  }

  @override
  set badCertificateCallback(
    bool Function(X509Certificate cert, String host, int port)? callback,
  ) {
    _delegate.badCertificateCallback = callback;
  }

  @override
  set keyLog(Function(String line)? callback) {
    _delegate.keyLog = callback;
  }

  @override
  void close({bool force = false}) {
    _delegate.close(force: force);
  }

  Future<HttpClientRequest> _wrap(
    Future<HttpClientRequest> requestFuture,
  ) async {
    final HttpClientRequest request = await requestFuture;
    return _AiAppCapturedHttpClientRequest(request, _bridge);
  }
}

class _AiAppCapturedHttpClientRequest implements HttpClientRequest {
  _AiAppCapturedHttpClientRequest(this._delegate, this._bridge)
      : _startedAt = DateTime.now();

  final HttpClientRequest _delegate;
  final AiAppBridge _bridge;
  final DateTime _startedAt;
  final StringBuffer _bodyPreview = StringBuffer();

  @override
  bool get persistentConnection => _delegate.persistentConnection;

  @override
  set persistentConnection(bool value) =>
      _delegate.persistentConnection = value;

  @override
  bool get followRedirects => _delegate.followRedirects;

  @override
  set followRedirects(bool value) => _delegate.followRedirects = value;

  @override
  int get maxRedirects => _delegate.maxRedirects;

  @override
  set maxRedirects(int value) => _delegate.maxRedirects = value;

  @override
  String get method => _delegate.method;

  @override
  Uri get uri => _delegate.uri;

  @override
  int get contentLength => _delegate.contentLength;

  @override
  set contentLength(int value) => _delegate.contentLength = value;

  @override
  bool get bufferOutput => _delegate.bufferOutput;

  @override
  set bufferOutput(bool value) => _delegate.bufferOutput = value;

  @override
  HttpHeaders get headers => _delegate.headers;

  @override
  List<Cookie> get cookies => _delegate.cookies;

  @override
  Future<HttpClientResponse> get done => _delegate.done;

  @override
  HttpConnectionInfo? get connectionInfo => _delegate.connectionInfo;

  @override
  Encoding get encoding => _delegate.encoding;

  @override
  set encoding(Encoding value) => _delegate.encoding = value;

  @override
  void add(List<int> data) {
    _appendBytes(data);
    _delegate.add(data);
  }

  @override
  void addError(Object error, [StackTrace? stackTrace]) {
    _delegate.addError(error, stackTrace);
  }

  @override
  Future<void> addStream(Stream<List<int>> stream) {
    return _delegate.addStream(
      stream.map((List<int> chunk) {
        _appendBytes(chunk);
        return chunk;
      }),
    );
  }

  @override
  Future<HttpClientResponse> close() async {
    final String method = _delegate.method;
    final Uri uri = _delegate.uri;
    final Map<String, Object?> requestHeaders = _headersToJson(
      _delegate.headers,
    );
    final String? requestBody =
        _bodyPreview.isEmpty ? null : _bodyPreview.toString();
    try {
      final HttpClientResponse response = await _delegate.close();
      return _AiAppCapturedHttpClientResponse(
        response,
        bridge: _bridge,
        method: method,
        uri: uri,
        requestHeaders: requestHeaders,
        requestBody: requestBody,
        startedAt: _startedAt,
      );
    } catch (error) {
      _recordNetwork(
        method: method,
        uri: uri,
        statusCode: -1,
        requestHeaders: requestHeaders,
        requestBody: requestBody,
        error: error.toString(),
      );
      rethrow;
    }
  }

  @override
  Future<void> flush() {
    return _delegate.flush();
  }

  @override
  void write(Object? object) {
    _appendText(object?.toString() ?? 'null');
    _delegate.write(object);
  }

  @override
  void writeAll(Iterable<Object?> objects, [String separator = '']) {
    _appendText(
      objects
          .map((Object? value) => value?.toString() ?? 'null')
          .join(separator),
    );
    _delegate.writeAll(objects, separator);
  }

  @override
  void writeCharCode(int charCode) {
    _appendText(String.fromCharCode(charCode));
    _delegate.writeCharCode(charCode);
  }

  @override
  void writeln([Object? object = '']) {
    _appendText('${object?.toString() ?? 'null'}\n');
    _delegate.writeln(object);
  }

  @override
  void abort([Object? exception, StackTrace? stackTrace]) {
    _delegate.abort(exception, stackTrace);
  }

  void _recordNetwork({
    required String method,
    required Uri uri,
    required int statusCode,
    required Map<String, Object?> requestHeaders,
    Map<String, Object?>? responseHeaders,
    String? requestBody,
    String? error,
  }) {
    if (_bridge._isAutoCaptureSuppressed) {
      return;
    }
    _bridge.recordNetwork(
      source: 'flutter-httpclient-auto',
      method: method,
      url: uri.toString(),
      statusCode: statusCode,
      durationMs: DateTime.now().difference(_startedAt).inMilliseconds,
      requestHeaders: requestHeaders,
      responseHeaders: responseHeaders,
      requestBody: requestBody,
      error: error,
    );
  }

  void _appendBytes(List<int> bytes) {
    _appendText(utf8.decode(bytes, allowMalformed: true));
  }

  void _appendText(String value) {
    final int remaining =
        AiAppBridge._maxAutoCaptureBodyChars - _bodyPreview.length;
    if (remaining <= 0) {
      return;
    }
    _bodyPreview.write(
      value.length <= remaining ? value : value.substring(0, remaining),
    );
  }
}

class _AiAppCapturedHttpClientResponse extends Stream<List<int>>
    implements HttpClientResponse {
  _AiAppCapturedHttpClientResponse(
    this._delegate, {
    required AiAppBridge bridge,
    required String method,
    required Uri uri,
    required Map<String, Object?> requestHeaders,
    required String? requestBody,
    required DateTime startedAt,
  })  : _bridge = bridge,
        _method = method,
        _uri = uri,
        _requestHeaders = requestHeaders,
        _requestBody = requestBody,
        _startedAt = startedAt,
        _captureResponseBody = _isPreviewableBody(_delegate.headers);

  final HttpClientResponse _delegate;
  final AiAppBridge _bridge;
  final String _method;
  final Uri _uri;
  final Map<String, Object?> _requestHeaders;
  final String? _requestBody;
  final DateTime _startedAt;
  final bool _captureResponseBody;
  final StringBuffer _responseBodyPreview = StringBuffer();
  bool _recorded = false;

  @override
  int get statusCode => _delegate.statusCode;

  @override
  String get reasonPhrase => _delegate.reasonPhrase;

  @override
  int get contentLength => _delegate.contentLength;

  @override
  HttpClientResponseCompressionState get compressionState =>
      _delegate.compressionState;

  @override
  bool get persistentConnection => _delegate.persistentConnection;

  @override
  bool get isRedirect => _delegate.isRedirect;

  @override
  List<RedirectInfo> get redirects => _delegate.redirects;

  @override
  Future<HttpClientResponse> redirect([
    String? method,
    Uri? url,
    bool? followLoops,
  ]) {
    return _delegate.redirect(method, url, followLoops);
  }

  @override
  HttpHeaders get headers => _delegate.headers;

  @override
  Future<Socket> detachSocket() => _delegate.detachSocket();

  @override
  List<Cookie> get cookies => _delegate.cookies;

  @override
  X509Certificate? get certificate => _delegate.certificate;

  @override
  HttpConnectionInfo? get connectionInfo => _delegate.connectionInfo;

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    final Stream<List<int>> captured = _delegate.transform(
      StreamTransformer<List<int>, List<int>>.fromHandlers(
        handleData: (List<int> chunk, EventSink<List<int>> sink) {
          _appendBytes(chunk);
          sink.add(chunk);
        },
        handleError:
            (Object error, StackTrace stackTrace, EventSink<List<int>> sink) {
          _recordNetwork(error: error.toString());
          sink.addError(error, stackTrace);
        },
        handleDone: (EventSink<List<int>> sink) {
          _recordNetwork();
          sink.close();
        },
      ),
    );
    return captured.listen(
      onData,
      onError: onError,
      onDone: onDone,
      cancelOnError: cancelOnError,
    );
  }

  void _recordNetwork({String? error}) {
    if (_recorded || _bridge._isAutoCaptureSuppressed) {
      return;
    }
    _recorded = true;
    _bridge.recordNetwork(
      source: 'flutter-httpclient-auto',
      method: _method,
      url: _uri.toString(),
      statusCode: statusCode,
      durationMs: DateTime.now().difference(_startedAt).inMilliseconds,
      requestHeaders: _requestHeaders,
      responseHeaders: _headersToJson(_delegate.headers),
      requestBody: _requestBody,
      responseBody:
          _responseBodyPreview.isEmpty ? null : _responseBodyPreview.toString(),
      error: error,
    );
  }

  void _appendBytes(List<int> bytes) {
    if (!_captureResponseBody) {
      return;
    }
    _appendText(utf8.decode(bytes, allowMalformed: true));
  }

  void _appendText(String value) {
    final int remaining =
        AiAppBridge._maxAutoCaptureBodyChars - _responseBodyPreview.length;
    if (remaining <= 0) {
      return;
    }
    _responseBodyPreview.write(
      value.length <= remaining ? value : value.substring(0, remaining),
    );
  }
}

Map<String, Object?> _headersToJson(HttpHeaders headers) {
  final Map<String, Object?> result = <String, Object?>{};
  headers.forEach((String name, List<String> values) {
    result[name] = _redactHeader(name) ? '<redacted>' : values.join(',');
  });
  return result;
}

bool _redactHeader(String name) {
  final String lower = name.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]'), '');
  return lower == 'authorization' ||
      lower == 'proxyauthorization' ||
      lower == 'password' ||
      lower == 'passwd' ||
      lower == 'pwd' ||
      lower == 'passcode' ||
      lower.endsWith('password') ||
      lower == 'token' ||
      lower.endsWith('token');
}

bool _isPreviewableBody(HttpHeaders headers) {
  final String contentType = headers.value(HttpHeaders.contentTypeHeader) ?? '';
  final String lower = contentType.toLowerCase();
  if (lower.isEmpty) {
    return true;
  }
  return lower.startsWith('text/') ||
      lower.contains('json') ||
      lower.contains('xml') ||
      lower.contains('html') ||
      lower.contains('javascript') ||
      lower.contains('x-www-form-urlencoded');
}

class _AiAppBridgeHarnessPage extends StatefulWidget {
  const _AiAppBridgeHarnessPage({this.onClose});

  final VoidCallback? onClose;

  @override
  State<_AiAppBridgeHarnessPage> createState() =>
      _AiAppBridgeHarnessPageState();
}

class _AiAppBridgeHarnessPageState extends State<_AiAppBridgeHarnessPage> {
  final TextEditingController _controller = TextEditingController();
  late final AiAppBridgeH5Adapter _h5FixtureAdapter;
  var _counter = 0;
  var _input = '';
  var _h5FixtureInput = 'h5 initial value';
  var _h5FixtureClicked = false;
  var _h5FixtureScrollY = 0.0;

  @override
  void initState() {
    super.initState();
    _h5FixtureAdapter = AiAppBridgeH5Adapter(
      id: 'runtime-harness-h5',
      source: 'flutter_runtime_harness_adapter',
      evaluateJavascript: _evaluateH5FixtureScript,
      metadata: () => <String, Object?>{
        'currentUrl': 'https://debug.local/flutter-runtime-h5',
        'title': 'Flutter Runtime H5 Fixture',
        'isLoading': false,
      },
    );
    AiAppBridge.instance.registerH5Adapter(_h5FixtureAdapter);
  }

  @override
  void dispose() {
    AiAppBridge.instance.unregisterH5Adapter(_h5FixtureAdapter.id);
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('AiApp Flutter Runtime Harness'),
        leading: widget.onClose == null
            ? null
            : IconButton(
                icon: const Icon(Icons.close),
                tooltip: 'Close',
                onPressed: widget.onClose,
              ),
      ),
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: <Widget>[
                Text('Runtime counter: $_counter'),
                const SizedBox(height: 8),
                ElevatedButton(
                  onPressed: () => setState(() => _counter += 1),
                  child: const Text('Runtime Increment'),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: _controller,
                  decoration: const InputDecoration(labelText: 'Runtime Input'),
                  onChanged: (String value) => setState(() => _input = value),
                ),
                const SizedBox(height: 8),
                Text('Runtime Echo: $_input'),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: <Widget>[
                    ElevatedButton(
                      onPressed: _recordCaptureFixture,
                      child: const Text('Record Capture Fixture'),
                    ),
                    ElevatedButton(
                      onPressed: _recordH5Fixture,
                      child: const Text('Record H5 Fixture'),
                    ),
                    ElevatedButton(
                      onPressed: _recordAutoLogFixture,
                      child: const Text('Record Auto Log Fixture'),
                    ),
                    ElevatedButton(
                      onPressed: () => unawaited(_runHttpClientFixture()),
                      child: const Text('Run Dart HttpClient Fixture'),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: ListView.builder(
              itemCount: 80,
              itemBuilder: (_, int index) {
                return ListTile(title: Text('Runtime Row $index'));
              },
            ),
          ),
        ],
      ),
    );
  }

  void _recordCaptureFixture() {
    AiAppBridge.instance.recordLog(
      tag: 'AiAppFlutterRuntimeHarness',
      message: 'runtime capture fixture',
      data: <String, Object?>{'counter': _counter, 'input': _input},
    );
    AiAppBridge.instance.recordNetwork(
      method: 'GET',
      url: 'https://debug.local/flutter-runtime-harness',
      statusCode: 200,
      durationMs: 9,
      responseBody: '{"ok":true}',
    );
    AiAppBridge.instance.recordState(
      namespace: 'flutter_runtime_harness',
      key: 'screen',
      value: <String, Object?>{'counter': _counter, 'input': _input},
    );
    AiAppBridge.instance.recordEvent(
      category: 'flutter_runtime_harness',
      name: 'capture_fixture_recorded',
      data: <String, Object?>{'ok': true},
    );
  }

  void _recordH5Fixture() {
    AiAppBridge.instance.recordH5(
      active: true,
      source: 'flutter_runtime_harness',
      currentUrl: 'https://debug.local/flutter-runtime-h5',
      title: 'Flutter Runtime H5 Fixture',
      dom: <String, Object?>{
        'documentTitle': 'Flutter Runtime H5 Fixture',
        'bodyText': 'Flutter runtime H5 fixture body',
        'controls': <Object?>[
          <String, Object?>{'tag': 'button', 'text': 'Runtime H5 Button'},
        ],
      },
    );
  }

  void _recordAutoLogFixture() {
    debugPrint(
        'ai_app auto debugPrint fixture counter=$_counter input=$_input');
    FlutterError.reportError(
      FlutterErrorDetails(
        exception: StateError('ai_app auto flutter error fixture'),
        stack: StackTrace.current,
        library: 'ai_app_bridge_harness',
        context: ErrorDescription('Record Auto Log Fixture'),
      ),
    );
  }

  Future<void> _runHttpClientFixture() async {
    final HttpClient client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 2);
    try {
      final HttpClientRequest request = await client.postUrl(
        Uri.parse('http://127.0.0.1:18080/v1/events'),
      );
      request.headers.contentType = ContentType.json;
      request.write(
        jsonEncode(<String, Object?>{
          'category': 'flutter_runtime_harness',
          'name': 'dart_httpclient_fixture',
          'data': <String, Object?>{'counter': _counter, 'input': _input},
        }),
      );
      final HttpClientResponse response = await request.close();
      await response.drain<void>();
    } catch (error, stackTrace) {
      AiAppBridge.instance.recordLog(
        level: 'error',
        tag: 'AiAppFlutterRuntimeHarness',
        message: 'dart HttpClient fixture failed',
        data: <String, Object?>{
          'error': error.toString(),
          'stackTrace': stackTrace.toString(),
        },
      );
    } finally {
      client.close(force: true);
    }
  }

  Future<Object?> _evaluateH5FixtureScript(String script) async {
    final Map<String, Object?>? operation = _extractH5Operation(script);
    if (operation != null) {
      return jsonEncode(_runH5FixtureOperation(operation));
    }
    if (script.contains('document.querySelectorAll') ||
        script.contains('controlCount')) {
      return jsonEncode(_h5FixtureDom());
    }
    if (script.contains('document.title')) {
      return jsonEncode('Flutter Runtime H5 Fixture');
    }
    if (script.contains('location.href')) {
      return jsonEncode('https://debug.local/flutter-runtime-h5');
    }
    return jsonEncode(_h5FixtureDom());
  }

  Map<String, Object?>? _extractH5Operation(String script) {
    final RegExpMatch? match = RegExp(
      r'var params = (\{.*?\});',
      dotAll: true,
    ).firstMatch(script);
    if (match == null) {
      return null;
    }
    final Object? decoded = jsonDecode(match.group(1)!);
    return decoded is Map ? decoded.cast<String, Object?>() : null;
  }

  Map<String, Object?> _runH5FixtureOperation(Map<String, Object?> params) {
    final String action = params['action']?.toString() ?? '';
    final String selector = params['selector']?.toString() ?? '';
    final String targetText = params['targetText']?.toString() ?? '';
    final Map<String, Object?>? target = _findH5FixtureTarget(
      selector: selector,
      targetText: targetText,
      exact: params['exact'] == true,
    );
    if (action == 'find' &&
        targetText.isNotEmpty &&
        _h5FixtureBodyText().contains(targetText)) {
      return <String, Object?>{
        'ok': true,
        'action': action,
        'matchSource': 'bodyText',
        'bodyText': _h5FixtureBodyText(),
        'updatedAtMs': DateTime.now().millisecondsSinceEpoch,
      };
    }
    if (target == null) {
      return <String, Object?>{
        'ok': false,
        'action': action,
        'error': 'target_not_found',
        'selector': selector,
        'targetText': targetText,
        'bodyText': _h5FixtureBodyText(),
        'updatedAtMs': DateTime.now().millisecondsSinceEpoch,
      };
    }
    if (action == 'click' && target['id'] == 'flutter-h5-button') {
      setState(() => _h5FixtureClicked = true);
    } else if (action == 'input' && target['id'] == 'flutter-h5-input') {
      setState(() => _h5FixtureInput = params['value']?.toString() ?? '');
    } else if (action == 'scroll') {
      setState(() {
        _h5FixtureScrollY += _doubleParam(params['deltaY']) ?? 480;
      });
    }
    final Map<String, Object?> updatedTarget = _findH5FixtureTarget(
          selector: selector,
          targetText: targetText,
          exact: params['exact'] == true,
        ) ??
        target;
    return <String, Object?>{
      'ok': true,
      'action': action,
      'matched': updatedTarget,
      'value': updatedTarget['value'] ?? '',
      'bodyText': _h5FixtureBodyText(),
      'scroll': <String, Object?>{'x': 0, 'y': _h5FixtureScrollY},
      'updatedAtMs': DateTime.now().millisecondsSinceEpoch,
    };
  }

  Map<String, Object?>? _findH5FixtureTarget({
    required String selector,
    required String targetText,
    required bool exact,
  }) {
    final List<Map<String, Object?>> targets = <Map<String, Object?>>[
      _h5InputTarget(),
      _h5ButtonTarget(),
    ];
    if (selector.isNotEmpty) {
      return targets
          .firstWhere(
            (Map<String, Object?> target) =>
                selector == '#${target['id']}' ||
                selector == target['tag'] ||
                selector == '[aria-label="${target['ariaLabel']}"]',
            orElse: () => <String, Object?>{},
          )
          .ifEmptyNull;
    }
    if (targetText.isNotEmpty) {
      return targets.firstWhere((Map<String, Object?> target) {
        final String label = <Object?>[
          target['text'],
          target['value'],
          target['id'],
          target['ariaLabel'],
          target['placeholder'],
        ].whereType<String>().join('\n');
        return exact ? label == targetText : label.contains(targetText);
      }, orElse: () => <String, Object?>{}).ifEmptyNull;
    }
    return targets.first;
  }

  Map<String, Object?> _h5FixtureDom() {
    final List<Map<String, Object?>> controls = <Map<String, Object?>>[
      _h5InputTarget(index: 0),
      _h5ButtonTarget(index: 1),
    ];
    return <String, Object?>{
      'ok': true,
      'title': 'Flutter Runtime H5 Fixture',
      'url': 'https://debug.local/flutter-runtime-h5',
      'readyState': 'complete',
      'bodyText': _h5FixtureBodyText(),
      'controls': controls,
      'controlCount': controls.length,
      'updatedAtMs': DateTime.now().millisecondsSinceEpoch,
    };
  }

  String _h5FixtureBodyText() {
    return [
      'Flutter Runtime H5 Fixture',
      'Flutter runtime H5 fixture body',
      _h5FixtureClicked ? 'Runtime H5 clicked' : 'Runtime H5 Button',
      _h5FixtureInput,
    ].join('\n');
  }

  Map<String, Object?> _h5InputTarget({int? index}) {
    return <String, Object?>{
      if (index != null) 'index': index,
      'tag': 'input',
      'id': 'flutter-h5-input',
      'name': '',
      'type': 'text',
      'role': '',
      'ariaLabel': 'Flutter H5 Input',
      'placeholder': '',
      'text': _h5FixtureInput,
      'value': _h5FixtureInput,
      'disabled': false,
      'bounds': <String, Object?>{
        'left': 16,
        'top': 112,
        'right': 220,
        'bottom': 144,
        'width': 204,
        'height': 32,
      },
    };
  }

  Map<String, Object?> _h5ButtonTarget({int? index}) {
    return <String, Object?>{
      if (index != null) 'index': index,
      'tag': 'button',
      'id': 'flutter-h5-button',
      'name': '',
      'type': 'button',
      'role': 'button',
      'ariaLabel': 'Flutter H5 Button',
      'placeholder': '',
      'text': _h5FixtureClicked ? 'Runtime H5 clicked' : 'Runtime H5 Button',
      'value': '',
      'disabled': false,
      'bounds': <String, Object?>{
        'left': 232,
        'top': 112,
        'right': 380,
        'bottom': 144,
        'width': 148,
        'height': 32,
      },
    };
  }

  double? _doubleParam(Object? value) {
    if (value is num) {
      return value.toDouble();
    }
    return double.tryParse(value?.toString() ?? '');
  }
}

extension on Map<String, Object?> {
  Map<String, Object?>? get ifEmptyNull => isEmpty ? null : this;
}

class _NodeCounter {
  int count = 0;
}

class _ActionTarget {
  const _ActionTarget({required this.widgetType, required this.bounds});

  final String widgetType;
  final Rect bounds;
}

class _RuntimeTarget {
  const _RuntimeTarget({
    required this.element,
    required this.widgetType,
    required this.text,
    required this.bounds,
  });

  final Element element;
  final String widgetType;
  final String text;
  final Rect bounds;
}

extension _FirstWhereOrNull<T> on Iterable<T> {
  T? firstWhereOrNull(bool Function(T value) test) {
    for (final T value in this) {
      if (test(value)) {
        return value;
      }
    }
    return null;
  }
}
