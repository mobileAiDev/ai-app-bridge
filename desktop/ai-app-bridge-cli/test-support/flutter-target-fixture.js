'use strict';

function flutterRef(elementId, guard = 'guard-1') {
  return { schemaVersion: 'aab.flutter-target/v1', runtimeEpoch: 'flutter-fixture-runtime', elementId: String(elementId), guard };
}

function flutterNode({ id = 'e1', text = 'Settings', action = 'tap', bounds = { left: 10, top: 10, right: 130, bottom: 50 }, ...fields } = {}) {
  return { id, text, widgetType: action === 'input' ? 'EditableText' : action === 'scroll' ? 'Scrollable' : 'Text',
    role: action === 'input' ? 'input' : action === 'scroll' ? 'scrollable' : 'control', actions: [action],
    [action]: { bounds }, targetRef: flutterRef(id), ...fields };
}

module.exports = { flutterRef, flutterNode };
