import 'dart:convert';

import 'package:ai_app_bridge_flutter/src/diagnostic_snapshot.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('deep diagnostics remain serializable and do not truncate action nodes',
      () {
    Object? tree = <String, Object?>{'description': 'deep leaf'};
    for (var i = 0; i < 600; i++) {
      tree = <String, Object?>{
        'children': <Object?>[tree]
      };
    }
    final actions = <Object?>[
      <String, Object?>{'nodeId': 'save', 'text': 'Save', 'depth': 600}
    ];
    final snapshot = <String, Object?>{
      'widgetInspector': diagnosticSnapshot(tree),
      'operable': <String, Object?>{'nodes': actions, 'truncated': false},
    };
    final decoded = jsonDecode(jsonEncode(snapshot)) as Map<String, dynamic>;
    expect(decoded['widgetInspector']['truncated'], true);
    expect(decoded['operable']['nodes'], actions);
    expect(decoded['operable']['truncated'], false);
    var maximumDepth = 0;
    void walk(Object? value, int depth) {
      if (depth > maximumDepth) maximumDepth = depth;
      if (value is Map) {
        for (final child in value.values) {
          walk(child, depth + 1);
        }
      } else if (value is List) {
        for (final child in value) {
          walk(child, depth + 1);
        }
      }
    }

    walk(decoded, 0);
    expect(maximumDepth, lessThan(80));
  });

  test('wide diagnostics declare omission without modifying the source', () {
    final source = <Object?>[
      for (var i = 0; i < 100; i++) <String, Object?>{'label': '$i'}
    ];
    final snapshot = diagnosticSnapshot(source, maxEntries: 10);
    expect(snapshot['truncated'], true);
    expect(snapshot['entries'], 10);
    expect((snapshot['root'] as List).length, 5);
    expect(source.length, 100);
  });

  test('a complete small diagnostic retains exact values and empty containers',
      () {
    final source = <String, Object?>{
      'label': '保存 中文',
      'enabled': false,
      'value': null,
      'children': <Object?>[]
    };
    final snapshot = diagnosticSnapshot(source);
    expect(snapshot['truncated'], false);
    expect(snapshot['root'], source);
    expect(() => diagnosticSnapshot(source, maxDepth: 0), throwsArgumentError);
  });
}
