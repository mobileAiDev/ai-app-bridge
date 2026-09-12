/// Bounds diagnostic JSON independently of the actionable UI snapshot.
///
/// Deep Flutter inspector trees exceed native JSON parser nesting limits. A
/// pruned diagnostic value is explicitly incomplete; it cannot prove absence.
Map<String, Object?> diagnosticSnapshot(Object? root,
    {int maxDepth = 64, int maxEntries = 4000}) {
  if (maxDepth < 1 || maxEntries < 1) {
    throw ArgumentError('Diagnostic limits must be positive.');
  }
  var entries = 0;
  var truncated = false;
  Object? visit(Object? value, int depth) {
    if (value is! Map && value is! List) return value;
    if (depth >= maxDepth) {
      truncated = true;
      return null;
    }
    if (value is Map<String, dynamic>) {
      final result = <String, Object?>{};
      for (final entry in value.entries) {
        if (entries == maxEntries) {
          truncated = true;
          break;
        }
        entries++;
        result[entry.key] = visit(entry.value, depth + 1);
      }
      return result;
    }
    if (value is List) {
      final result = <Object?>[];
      for (final child in value) {
        if (entries == maxEntries) {
          truncated = true;
          break;
        }
        entries++;
        result.add(visit(child, depth + 1));
      }
      return result;
    }
    throw ArgumentError('Diagnostic JSON requires string map keys.');
  }

  final tree = visit(root, 0);
  return <String, Object?>{
    'ok': true,
    'root': tree,
    'truncated': truncated,
    'entries': entries,
    'maxDepth': maxDepth,
    'maxEntries': maxEntries,
  };
}
