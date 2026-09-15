'use strict';

const { object, text, integer } = require('../shared-kernel/argument-schema');
const identifier = { ...text, maxLength: 1024 };
const timeoutMs = integer(1, 300000);
const execution = { timeoutMs, requestId: identifier, feedback: { enum: ['auto', 'off', 'full'] } };
const webIdentity = { sessionId: identifier, runtimeEpoch: identifier, targetId: identifier };
const documentIdentity = { frameId: identifier, documentId: identifier };
const selector = {
  anyOf: [
    object({ by: { const: 'role' }, value: identifier, name: { type: 'string', maxLength: 4096 } }, ['by', 'value', 'name']),
    object({ by: { enum: ['testId', 'text', 'label', 'placeholder', 'css'] }, value: identifier }, ['by', 'value']),
  ],
};
const browserAction = {
  anyOf: [
    object({ type: { enum: ['click', 'doubleClick', 'hover', 'scrollIntoView'] }, selector }, ['type', 'selector']),
    object({ type: { enum: ['fill', 'type', 'press'] }, selector, text: { type: 'string', maxLength: 65536 } }, ['type', 'selector', 'text']),
    object({ type: { const: 'check' }, selector, checked: { type: 'boolean' } }, ['type', 'selector', 'checked']),
    object({ type: { const: 'select' }, selector, values: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 } }, ['type', 'selector', 'values']),
    object({ type: { const: 'drag' }, selector, destination: selector }, ['type', 'selector', 'destination']),
    object({ type: { const: 'upload' }, selector, files: { type: 'array', items: identifier, maxItems: 100 } }, ['type', 'selector', 'files']),
  ],
};

function operationSchema(definitions) {
  const branches = Object.entries(definitions).map(([operation, definition]) =>
    object({ operation: { const: operation }, ...execution, ...definition.properties }, ['operation', ...definition.required]));
  const properties = Object.assign({}, ...branches.map(branch => branch.properties));
  properties.operation = { enum: Object.keys(definitions) };
  return { type: 'object', additionalProperties: false, properties, required: ['operation'], anyOf: branches };
}

function webExecutorSchema() {
  const bound = (properties = {}, required = []) => ({ properties: { ...webIdentity, ...properties }, required: [...Object.keys(webIdentity), ...required] });
  return operationSchema({
    status: { properties: { browser: { enum: ['chromium', 'firefox', 'webkit'] } }, required: [] },
    prepare: { properties: { browser: { enum: ['chromium', 'firefox', 'webkit'] } }, required: [] },
    open: { properties: { url: identifier, browser: { enum: ['chromium', 'firefox', 'webkit'] }, headless: { type: 'boolean' },
      viewport: object({ width: integer(320, 7680), height: integer(240, 4320) }, ['width', 'height']) }, required: ['url'] },
    observe: bound({ maxControls: integer(1, 1000) }),
    act: bound({ ...documentIdentity, actionId: identifier, action: browserAction,
      dialog: object({ action: { enum: ['accept', 'dismiss'] }, promptText: { type: 'string', maxLength: 4096 } }, ['action']) }, [...Object.keys(documentIdentity), 'action']),
    navigate: bound({ ...documentIdentity, url: identifier, actionId: identifier }, [...Object.keys(documentIdentity), 'url']),
    wait: bound({ ...documentIdentity, selector, state: { enum: ['visible', 'hidden', 'attached', 'detached'] }, text: { type: 'string', maxLength: 65536 } }, [...Object.keys(documentIdentity), 'selector']),
    screenshot: bound({ outFile: identifier, fullPage: { type: 'boolean' } }, ['outFile']),
    events: bound({ afterSequence: integer(0, Number.MAX_SAFE_INTEGER), limit: integer(1, 1000) }),
    receipt: bound({ actionId: identifier }, ['actionId']),
    close: bound(),
  });
}

function androidExecutorSchema() {
  const target = { serial: identifier, packageName: identifier, adb: identifier };
  const session = { sessionId: identifier, runtimeEpoch: identifier };
  const bound = (properties = {}, required = []) => ({ properties: { ...target, ...session, ...properties }, required: ['serial', 'packageName', 'sessionId', 'runtimeEpoch', ...required] });
  const action = { anyOf: [
    object({ type: { enum: ['click', 'longClick', 'scrollTo', 'swipeUp', 'swipeDown', 'swipeLeft', 'swipeRight', 'webClick', 'webClear', 'webScrollIntoView', 'semanticLongClick', 'composeClearText'] }, nodeId: identifier }, ['type', 'nodeId']),
    object({ type: { enum: ['setText', 'typeText', 'replaceText', 'replaceTextViaInputConnection', 'webKeys', 'composeInput', 'composeReplaceText'] }, nodeId: identifier, text: { type: 'string', maxLength: 65536 } }, ['type', 'nodeId', 'text']),
    object({ type: { const: 'composeScrollToIndex' }, nodeId: identifier, index: integer(0, 1000000) }, ['type', 'nodeId', 'index']),
    object({ type: { const: 'scroll' }, nodeId: identifier, direction: { enum: ['up', 'down', 'left', 'right'] }, percent: { type: 'number', exclusiveMinimum: 0, maximum: 10 } }, ['type', 'nodeId', 'direction', 'percent']),
    object({ type: { enum: ['back', 'home', 'closeKeyboard'] } }, ['type']),
  ] };
  return operationSchema({
    status: { properties: target, required: ['serial'] },
    open: { properties: { ...target,
      instrumentation: { ...identifier, pattern: '^[A-Za-z0-9_.]+/[A-Za-z0-9_.$]+$' }, testClass: { ...identifier, pattern: '^[A-Za-z0-9_.$]+$' },
      activity: { ...identifier, pattern: '^[A-Za-z0-9_.$]+$' }, leaseMs: integer(10000, 3600000) }, required: ['serial', 'packageName', 'instrumentation', 'testClass', 'activity'] },
    observe: bound({ engine: identifier,
      composeUnmergedTree: { type: 'boolean' },
      webView: object({ by: { enum: ['resourceId', 'description'] }, value: identifier }, ['by', 'value']),
      framePath: { type: 'array', maxItems: 16, items: { anyOf: [object({ index: integer(0, 1000) }, ['index']), object({ name: identifier }, ['name'])] } }
    }, ['engine']),
    act: bound({ snapshotId: identifier, actionId: identifier, action }, ['snapshotId', 'action']),
    receipt: bound({ actionId: identifier }, ['actionId']),
    close: bound(),
  });
}

function flutterExecutorSchema() {
  const target = { serial: identifier, packageName: identifier, adb: identifier };
  const session = { sessionId: identifier, runtimeEpoch: identifier };
  const bound = (properties = {}, required = []) => ({ properties: { ...target, ...session, ...properties }, required: ['serial', 'packageName', 'sessionId', 'runtimeEpoch', ...required] });
  const action = { anyOf: [
    object({ type: { enum: ['tap', 'longPress', 'ensureVisible'] }, nodeId: identifier }, ['type', 'nodeId']),
    object({ type: { const: 'enterText' }, nodeId: identifier, text: { type: 'string', maxLength: 65536 } }, ['type', 'nodeId', 'text']),
    object({ type: { const: 'drag' }, nodeId: identifier, dx: { type: 'number' }, dy: { type: 'number' } }, ['type', 'nodeId', 'dx', 'dy']),
    object({ type: { const: 'fling' }, nodeId: identifier, dx: { type: 'number' }, dy: { type: 'number' }, speed: { type: 'number', exclusiveMinimum: 0, maximum: 100000 } }, ['type', 'nodeId', 'dx', 'dy', 'speed']),
    object({ type: { const: 'pageBack' } }, ['type']),
    object({ type: { const: 'pump' }, count: integer(1, 120), durationMs: integer(0, 1000) }, ['type', 'count', 'durationMs']),
  ] };
  return operationSchema({
    status: { properties: target, required: ['serial'] },
    open: { properties: { ...target, activity: { ...identifier, pattern: '^[A-Za-z0-9_.$]+$' }, leaseMs: integer(10000, 3600000) }, required: ['serial', 'packageName', 'activity'] },
    observe: bound(),
    act: bound({ snapshotId: identifier, actionId: identifier, action }, ['snapshotId', 'action']),
    receipt: bound({ actionId: identifier }, ['actionId']),
    close: bound(),
  });
}

module.exports = { webExecutorSchema, androidExecutorSchema, flutterExecutorSchema, operationSchema, selector, browserAction };
