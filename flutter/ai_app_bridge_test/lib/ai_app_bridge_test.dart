library ai_app_bridge_test;

import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

const _protocol = 'aab.flutter-integration-executor/v1';

/// Call from integration_test/bridge_test.dart, passing the application's main.
/// Build that entrypoint once, then use Bridge to open and orchestrate sessions.
void aiAppBridgeTest(FutureOr<void> Function() launchApp) {
  if (kReleaseMode || kIsWeb || !Platform.isAndroid) {
    throw UnsupportedError('This executor requires a Flutter debug test build on Android');
  }
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;
  testWidgets('AI App Bridge integration session', (tester) async {
    final launchFile = File('${_privateDirectory().path}/launch.json');
    final launch = jsonDecode(await launchFile.readAsString()) as Map<String, dynamic>;
    await launchFile.delete();
    final sessionId = launch['sessionId'] as String;
    final token = launch['token'] as String;
    final leaseMs = launch['leaseMs'] as int;
    if (!_uuid.hasMatch(sessionId) || !RegExp(r'^[a-f0-9]{64}$').hasMatch(token) || leaseMs < 10000 || leaseMs > 3600000) {
      throw ArgumentError('Invalid Bridge test launch identity or lease');
    }
    await _Session(tester, launch).run(launchApp);
  }, timeout: const Timeout(Duration(hours: 2)));
}

final _uuid = RegExp(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$');
Directory _privateDirectory() {
  final temporary = Directory.systemTemp;
  final name = temporary.path.split('/').last;
  if (name != 'cache' && name != 'code_cache') throw UnsupportedError('The standard Android Flutter cache directory is required');
  return Directory('${temporary.parent.path}/no_backup/ai-app-bridge-integration');
}
String _newId() {
  final random = Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  final hex = bytes.map((value) => value.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}
String _hash(String value) => sha256.convert(utf8.encode(value)).toString();
Object? _canonical(Object? value) {
  if (value is Map<String, dynamic>) return SplayTreeMap<String, dynamic>.from(value.map((key, item) => MapEntry(key, _canonical(item))));
  if (value is List) return value.map(_canonical).toList();
  return value;
}
Future<void> _write(File file, Map<String, dynamic> value) async {
  await file.parent.create(recursive: true);
  final temporary = File('${file.path}.tmp');
  await temporary.writeAsString(jsonEncode(value), flush: true);
  await temporary.rename(file.path);
}

class _Failure implements Exception {
  _Failure(this.code, this.message, {this.dispatched = false});
  final String code, message;
  final bool dispatched;
}
class _Request {
  _Request(this.body, this.socket);
  final Map<String, dynamic> body;
  final Socket socket;
  final Stopwatch elapsed = Stopwatch()..start();
  bool cancelled = false;
  String get id => body['requestId'] as String;
  bool get expired => elapsed.elapsedMilliseconds >= (body['timeoutMs'] as int? ?? 30000);
}

class _Session {
  _Session(this.tester, this.launch);
  final WidgetTester tester;
  final Map<String, dynamic> launch;
  late final Directory directory;
  late final Map<String, dynamic> identity;
  final _queue = Queue<_Request>();
  final _requests = <String, _Request>{};
  final _sockets = <Socket>{};
  final _nodes = <String, Element>{};
  final _fingerprints = <String, String>{};
  ServerSocket? _server;
  String? _snapshotId;
  bool _closing = false;
  final Stopwatch _lastRequest = Stopwatch()..start();
  String? _active;
  final capabilities = <String, dynamic>{
    'engine': 'flutter-integration-test', 'bridgeVersion': '0.3.8', 'scope': 'flutter-widgets',
    'framePolicy': 'fullyLive',
    'actions': ['tap', 'longPress', 'enterText', 'drag', 'fling', 'ensureVisible', 'pageBack', 'pump'],
    'limitations': ['Requires the application integration_test entrypoint build', 'WidgetTester pointer events run inside Flutter',
      'enterText injects editing state and does not test a physical IME', 'Platform views, WebView DOM and system dialogs require their own adapter',
      'Cancellation waits for the original tester Future; it never starts a replacement action'],
  };

  Future<void> run(FutureOr<void> Function() launchApp) async {
    final stat = await File('/proc/self/stat').readAsString();
    identity = {
      'protocol': _protocol, 'sessionId': launch['sessionId'], 'runtimeEpoch': _newId(),
      'targetPackage': launch['packageName'], 'pid': pid,
      'bootId': (await File('/proc/sys/kernel/random/boot_id').readAsString()).trim(),
      'processStartTicks': stat.substring(stat.lastIndexOf(') ') + 2).split(RegExp(r'\s+'))[19],
    };
    directory = Directory('${_privateDirectory().path}/${identity['sessionId']}');
    if (await directory.exists()) throw StateError('Executor session directory already exists');
    await directory.create(recursive: true);
    await _write(File('${directory.path}/starting.json'), {...identity, 'state': 'starting'});
    try {
      await launchApp();
      await tester.pump();
      final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      _server = server;
      server.listen(_serve);
      await _write(File('${directory.path}/session.json'), {...identity, 'port': server.port, 'capabilities': capabilities});
      while (!_closing) {
        if (_queue.isEmpty) {
          if (_lastRequest.elapsedMilliseconds >= (launch['leaseMs'] as int)) { _closing = true; break; }
          await Future<void>.delayed(const Duration(milliseconds: 16));
          continue;
        }
        final request = _queue.removeFirst();
        _active = request.id;
        try { await _reply(request.socket, await _execute(request)); }
        catch (error) { await _reply(request.socket, _failure(error, dispatched: request.body['operation'] == 'act')); }
        finally { _active = null; _requests.remove(request.id); }
      }
    } catch (error) {
      await _write(File('${directory.path}/failed.json'), {...identity, 'error': error.toString(), 'state': 'failed'});
      rethrow;
    } finally {
      _closing = true;
      await _server?.close();
      for (final request in _queue) { await _reply(request.socket, _error('executor_closed', 'The test is closing')); }
      _queue.clear(); _requests.clear();
      await _write(File('${directory.path}/closed.json'), {...identity, 'settled': true, 'closedAtMs': DateTime.now().millisecondsSinceEpoch});
      for (final socket in _sockets.toList()) { socket.destroy(); }
    }
  }

  Future<void> _serve(Socket socket) async {
    if (_sockets.length >= 32) { socket.destroy(); return; }
    _sockets.add(socket);
    var handedOff = false;
    try {
      final bytes = <int>[];
      await for (final chunk in socket.timeout(const Duration(seconds: 5))) {
        bytes.addAll(chunk);
        if (bytes.length > 1024 * 1024) throw const FormatException('Request exceeds 1 MiB');
        if (bytes.last != 10) continue;
        final body = jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>;
        if (body['token'] != launch['token'] || body['protocol'] != _protocol || body['sessionId'] != identity['sessionId']) {
          await _reply(socket, _error('executor_session_mismatch', 'Executor authentication or identity changed')); return;
        }
        final operation = body['operation'] as String;
        if (operation != 'status' && body['runtimeEpoch'] != identity['runtimeEpoch']) {
          await _reply(socket, _error('executor_session_mismatch', 'Executor generation changed')); return;
        }
        _lastRequest.reset();
        if (operation == 'status') {
          await _reply(socket, {...identity, 'ok': true, 'capabilities': capabilities, 'closing': _closing, 'activeRequestId': _active}); return;
        }
        if (operation == 'receipt') {
          final receipt = await _readReceipt(body['actionId'] as String);
          await _reply(socket, {...identity, 'ok': receipt != null, 'receipt': receipt}); return;
        }
        if (operation == 'cancel') {
          final original = _requests[body['requestId']]; original?.cancelled = true;
          await _reply(socket, {...identity, 'ok': true, 'cancelRequested': original != null, 'settled': original == null}); return;
        }
        final request = _Request(body, socket);
        if (_closing || _queue.length >= 16 || _requests.containsKey(request.id)) {
          await _reply(socket, _error('executor_not_admitted', 'Session is closing, queue is full or requestId is active')); return;
        }
        _requests[request.id] = request; _queue.add(request); handedOff = true; return;
      }
    } catch (error) {
      await _reply(socket, _error('executor_request_invalid', error.toString()));
    } finally { if (!handedOff) { _sockets.remove(socket); socket.destroy(); } }
  }

  Future<void> _reply(Socket socket, Map<String, dynamic> value) async {
    var bytes = utf8.encode('${jsonEncode(value)}\n');
    if (bytes.length > 4 * 1024 * 1024) bytes = utf8.encode('${jsonEncode(_error('executor_response_limit', 'Query the original receipt', dispatched: value['dispatched'] == true))}\n');
    try { socket.add(bytes); await socket.flush().timeout(const Duration(seconds: 5)); }
    on SocketException { /* The receipt remains available when transport ends. */ }
    on TimeoutException { /* End the blocked reply transport, not the UI action. */ }
    finally { _sockets.remove(socket); socket.destroy(); }
  }
  Map<String, dynamic> _error(String code, String message, {bool dispatched = false}) =>
    {...identity, 'ok': false, 'error': code, 'message': message, 'dispatched': dispatched, 'ambiguous': dispatched};
  Map<String, dynamic> _failure(Object error, {bool dispatched = false}) => error is _Failure
    ? _error(error.code, error.message, dispatched: error.dispatched)
    : _error('executor_failed', error.toString(), dispatched: dispatched);
  Future<Map<String, dynamic>?> _readReceipt(String id) async {
    final file = File('${directory.path}/receipts/${_hash(id)}.json');
    if (!await file.exists()) return null;
    final receipt = jsonDecode(await file.readAsString()) as Map<String, dynamic>;
    if (receipt['actionId'] != id || receipt['runtimeEpoch'] != identity['runtimeEpoch']) throw StateError('Receipt identity mismatch');
    return receipt;
  }

  Future<Map<String, dynamic>> _execute(_Request request) async {
    final body = request.body, operation = request.body['operation'];
    if (operation != 'act' && (request.cancelled || request.expired)) return _error('executor_cancelled', 'Request ended before execution');
    if (operation == 'close') { _closing = true; return {...identity, 'ok': true, 'closing': true}; }
    if (operation == 'observe') return {...identity, 'ok': true, 'observation': await _observe()};
    if (operation != 'act') return _error('executor_operation_unsupported', 'Unsupported operation');
    final id = body['actionId'] as String;
    final digest = _hash(jsonEncode(_canonical({'snapshotId': body['snapshotId'], 'action': body['action']})));
    final previous = await _readReceipt(id);
    if (previous != null) {
      if (previous['requestDigest'] != digest) return _error('idempotency_conflict', 'actionId identifies a different original action');
      if (previous['settled'] != true) return _error('executor_action_unresolved', 'Read the original action receipt');
      return {...previous['result'] as Map<String, dynamic>, 'replayed': true, 'executionReceipt': previous};
    }
    final receipts = Directory('${directory.path}/receipts');
    await receipts.create();
    if (await receipts.list().length >= 4096) return _error('executor_receipt_capacity', 'Close this session before creating further actions');
    final receipt = {...identity, 'actionId': id, 'requestDigest': digest, 'settled': false, 'phase': 'started'};
    final file = File('${receipts.path}/${_hash(id)}.json');
    await _write(file, receipt);
    final timer = Stopwatch()..start();
    Map<String, dynamic> result;
    try {
      result = request.cancelled || request.expired ? _error('executor_cancelled', 'Request ended before dispatch')
        : {...identity, 'ok': true, 'dispatched': true, 'ambiguous': false, 'action': await _act(request)};
    } catch (error) { result = _failure(error, dispatched: true); }
    result.addAll({'actionId': id, 'cancelRequested': request.cancelled, 'executionMs': timer.elapsedMilliseconds});
    receipt.addAll({'settled': true, 'phase': 'completed', 'result': Map<String, dynamic>.from(result), 'completedAtMs': DateTime.now().millisecondsSinceEpoch});
    await _write(file, receipt);
    return {...result, 'executionReceipt': receipt};
  }

  Map<String, dynamic> _describe(Element element) {
    final widget = element.widget;
    final render = element.findRenderObject();
    List<double>? bounds;
    if (render is RenderBox && render.attached && render.hasSize) {
      final rect = MatrixUtils.transformRect(render.getTransformTo(null), Offset.zero & render.size);
      if ([rect.left, rect.top, rect.right, rect.bottom].every((value) => value.isFinite)) bounds = [rect.left, rect.top, rect.right, rect.bottom];
    }
    return {'type': widget.runtimeType.toString(), 'key': widget.key is ValueKey<String> ? (widget.key as ValueKey<String>).value : widget.key?.toString(),
      'text': widget is EditableText ? (widget.obscureText ? null : widget.controller.text) : widget is Text ? widget.data ?? widget.textSpan?.toPlainText() : null,
      'bounds': bounds};
  }
  Future<Map<String, dynamic>> _observe() async {
    await tester.pump();
    _nodes.clear(); _fingerprints.clear(); _snapshotId = _newId();
    final tree = <Map<String, dynamic>>[];
    for (final element in tester.allElements) {
      if (_nodes.length >= 4000) throw _Failure('executor_tree_limit', 'Flutter observation exceeds 4000 elements');
      final id = _nodes.length.toString(), description = _describe(element);
      _nodes[id] = element; _fingerprints[id] = jsonEncode(description);
      tree.add({...description, 'nodeId': id});
    }
    return {'snapshotId': _snapshotId, 'engine': 'flutter-integration-test', 'nodes': tree, 'observedAtMs': DateTime.now().millisecondsSinceEpoch};
  }
  Future<Map<String, dynamic>> _act(_Request request) async {
    if (_snapshotId == null || request.body['snapshotId'] != _snapshotId) throw _Failure('reobserve_required', 'The Flutter observation changed');
    final action = request.body['action'] as Map<String, dynamic>, type = action['type'] as String;
    if (type == 'pump') {
      final count = action['count'] as int, milliseconds = action['durationMs'] as int;
      for (var index = 0; index < count; index++) {
        if (request.cancelled || request.expired) throw _Failure('executor_cancelled', 'Pumping stopped after the original frame completed', dispatched: index > 0);
        await tester.pump(Duration(milliseconds: milliseconds));
      }
      return {'type': type, 'mechanism': 'widget-tester-pump'};
    }
    if (type == 'pageBack') { await tester.pageBack(); await tester.pump(); return {'type': type, 'mechanism': 'widget-tester-page-back'}; }
    final node = _nodes[action['nodeId']];
    if (node == null || !node.mounted || jsonEncode(_describe(node)) != _fingerprints[action['nodeId']]) {
      throw _Failure('reobserve_required', 'The observed Flutter element changed');
    }
    final finder = find.byElementPredicate((element) => identical(element, node));
    if (['tap', 'longPress', 'drag', 'fling'].contains(type) && finder.hitTestable().evaluate().length != 1) {
      throw _Failure('executor_target_not_hittable', 'The observed Flutter element is not hit testable');
    }
    switch (type) {
      case 'tap': await tester.tap(finder);
      case 'longPress': await tester.longPress(finder);
      case 'enterText': await tester.enterText(finder, action['text'] as String);
      case 'ensureVisible': await tester.ensureVisible(finder);
      case 'drag': await tester.drag(finder, Offset((action['dx'] as num).toDouble(), (action['dy'] as num).toDouble()));
      case 'fling': await tester.fling(finder, Offset((action['dx'] as num).toDouble(), (action['dy'] as num).toDouble()), (action['speed'] as num).toDouble());
      default: throw _Failure('executor_action_unsupported', 'Unsupported WidgetTester action');
    }
    await tester.pump();
    if (type == 'enterText') {
      final editor = tester.widget<EditableText>(find.descendant(of: finder, matching: find.byType(EditableText), matchRoot: true));
      if (editor.controller.text != action['text']) throw _Failure('executor_postcondition_failed', 'The editor did not retain the requested value', dispatched: true);
    }
    return {'type': type, 'mechanism': type == 'enterText' ? 'widget-tester-editing-state' : type == 'ensureVisible' ? 'widget-tester-scroll' : 'widget-tester-pointer'};
  }
}
