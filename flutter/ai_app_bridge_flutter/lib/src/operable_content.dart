part of '../ai_app_bridge_flutter.dart';

// Explicit control state is cheap to collect during the existing Element walk.
// Propagate it to labels in a merged tile; never infer state from label text.
Map<String, Object?> _widgetControlState(Widget widget) {
  if (widget is CheckboxListTile) {
    return {'checked': widget.value, 'enabled': widget.enabled ?? widget.onChanged != null};
  }
  if (widget is Checkbox) {
    return {'checked': widget.value, 'enabled': widget.onChanged != null};
  }
  if (widget is SwitchListTile) {
    return {'toggled': widget.value, 'enabled': widget.onChanged != null};
  }
  if (widget is Switch) {
    return {'toggled': widget.value, 'enabled': widget.onChanged != null};
  }
  if (widget is Semantics) {
    final properties = widget.properties;
    return {
      if (properties.checked != null) 'checked': properties.checked,
      if (properties.mixed != null) 'mixed': properties.mixed,
      if (properties.toggled != null) 'toggled': properties.toggled,
      if (properties.selected != null) 'selected': properties.selected,
      if (properties.enabled != null) 'enabled': properties.enabled,
    };
  }
  return const {};
}

// Standard text paint and editor declarations. Custom canvas content still
// needs App semantics; diagnostic strings are not visible text.
String _paragraphText(InlineSpan span,
    [TextStyle inherited = const TextStyle()]) {
  if (span is! TextSpan) return '';
  final style = inherited.merge(span.style);
  final color = style.foreground?.color ?? style.color;
  final text = color != null && color.a == 0 ? '' : span.text ?? '';
  return text +
      (span.children ?? const <InlineSpan>[])
          .map((child) => _paragraphText(child, style))
          .join();
}

({String? label, String? hint, String? errorText}) _editorDescription(
    Element element) {
  String? label, hint, errorText;
  element.visitAncestorElements((ancestor) {
    final widget = ancestor.widget;
    if (widget is InputDecorator) {
      label = widget.decoration.labelText;
      hint = widget.decoration.hintText;
      errorText = widget.decoration.errorText;
      return false;
    }
    if (widget is CupertinoTextField) {
      hint = widget.placeholder;
      return false;
    }
    return true;
  });
  return (label: label, hint: hint, errorText: errorText);
}
