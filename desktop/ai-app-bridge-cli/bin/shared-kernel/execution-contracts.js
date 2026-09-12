'use strict';

const { object, integer, text, milliseconds } = require('./argument-schema');
const { executionTargetSchema } = require('./execution-target');
const { observationTargetSchema, intentTargetSchema } = require('../intent/intent-observation-target');
const { selectorSchema: iosNativeSelector } = require('./ios-native-target');

const boolean = { type: 'boolean' };
const number = { type: 'number', minimum: -2147483647, maximum: 2147483647 };
const revision = integer(1);
const afterSequence = { ...integer(0), default: 0 };
const pageLimit = integer(1, 1000);
const provider = { enum: ['native', 'uia', 'flutter', 'h5'] };
const packageName = { ...text, pattern: '^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+$' };
const jsonObject = { type: 'object', additionalProperties: true, description: 'Application data; nested values must be JSON.' };
const array = (items, minItems = 0, maxItems = 1000) => ({ type: 'array', items, minItems, maxItems });

function variants(tag, branches) {
  const choices = {};
  for (const branch of branches) {
    for (const [name, rule] of Object.entries(branch.properties)) {
      choices[name] ||= new Map();
      choices[name].set(JSON.stringify(rule), rule);
    }
  }
  const properties = Object.fromEntries(Object.entries(choices).map(([name, choices]) => {
    const rules = [...choices.values()];
    return [name, rules.length === 1 ? rules[0] : { anyOf: rules }];
  }));
  properties[tag] = { type: 'string', enum: [...new Set(branches.flatMap(branch => branch.properties[tag].enum || [branch.properties[tag].const]))] };
  return { ...object(properties, [tag]), anyOf: branches };
}

function exactlyOne(properties, keys, required = []) {
  return { ...object(properties, required), oneOf: keys.map(key => ({ required: [key] })) };
}

const nodeLabels = { text, resourceName: text, contentDescription: text };
const nodeIdentity = exactlyOne({ className: text, resourceName: text }, ['className', 'resourceName']);
const ancestor = exactlyOne({ ...nodeIdentity.properties, parent: nodeIdentity }, ['className', 'resourceName']);
const within = exactlyOne({ ...nodeLabels, ancestor }, Object.keys(nodeLabels), ['ancestor']);
const nativeSelector = exactlyOne({ ...nodeLabels, within }, Object.keys(nodeLabels));
const uiaSelector = require('./uia-target').intentSelectorSchema;
const flutterSelector = exactlyOne({ text, nodeId: text }, ['text', 'nodeId']);

function nativeGestureBranches(make) {
  const selector = nativeSelector;
  return [
    make('longPress', { selector, durationMs: integer(500, 10000) }, ['selector', 'durationMs']),
    make('swipe', { selector, deltaX: number, deltaY: number, durationMs: integer(1, 10000) }, ['selector', 'deltaX', 'deltaY', 'durationMs']),
    make('scroll', { selector, direction: { enum: ['up', 'down'] }, durationMs: { ...integer(1, 10000), default: 400 } }, ['selector', 'direction']),
  ];
}

function nativeGestureSchema() {
  return variants('action', nativeGestureBranches((action, properties, required) => object({ action: { const: action }, ...properties }, ['action', ...required])));
}

function intentActionSchema(activeProvider, platform) {
  const branches = [];
  for (const name of activeProvider ? [activeProvider] : provider.enum) {
    const make = (action, properties = {}, required = []) => object({ action: { const: action }, provider: { const: name }, ...properties }, ['action', ...required]);
    if (name === 'h5') {
      const webSelector = require('./web-dom-target').intentSelectorSchema;
      if (platform === 'web' || platform === undefined) {
        branches.push(make('tap', { selector: webSelector }, ['selector']), make('scroll', { selector: webSelector }, ['selector']),
          make('inputText', { selector: webSelector, value: { type: 'string', maxLength: 16384 } }, ['selector', 'value']),
          make('pressKey', { selector: webSelector, key: { enum: ['Enter', 'Escape'] } }, ['selector', 'key']),
          make('scrollBy', { selector: webSelector, deltaX: number, deltaY: number }, ['selector', 'deltaX', 'deltaY']));
        if (platform === 'web') continue;
      }
      const selector = require('./ios-h5-target').selectorSchema;
      branches.push(make('tap', { selector }, ['selector']), make('scroll', { selector }, ['selector']),
        make('inputText', { selector, value: { type: 'string', maxLength: 16384 } }, ['selector', 'value']));
      continue;
    }
    const native = platform === 'ios' ? iosNativeSelector : platform === 'android' ? nativeSelector
      : { allOf: [object({ ...nativeSelector.properties, ...iosNativeSelector.properties }), { anyOf: [nativeSelector, iosNativeSelector] }] };
    const selector = name === 'native' ? native : name === 'uia' ? uiaSelector : flutterSelector;
    if (name === 'native' && (platform === 'ios' || platform === undefined)) {
      branches.push(make('setOrientation', { orientation: require('./ios-native-target').orientationSchema }, ['orientation']));
    }
    branches.push(make('tap', { selector }, ['selector']));
    if (name === 'native' && platform === 'ios') {
      branches.push(make('inputText', { selector, value: { type: 'string', maxLength: 16384 } }, ['selector', 'value']));
      continue;
    }
    branches.push(make('back'));
    if (platform !== 'ios') branches.push(make('keyevent', { keyCode: integer(0, 2147483647) }, ['keyCode']));
    if (name === 'native') {
      branches.push(make('inputText', { selector, value: { type: 'string' } }, ['selector', 'value']));
      branches.push(...nativeGestureBranches(make));
    }
    if (name === 'flutter') {
      branches.push(make('inputText', { selector, value: { type: 'string' } }, ['selector', 'value']));
      branches.push(make('scrollBy', { selector, delta: number }, ['selector', 'delta']));
      branches.push(make('hideKeyboard'));
    }
    else if (name === 'uia') branches.push(make('scroll', { direction: { enum: ['up', 'down'] }, durationMs: { ...integer(1, 10000), default: 400 } }, ['direction']));
  }
  return variants('action', branches);
}

function intentDecisionSchema(activeProvider, platform) {
  const common = { decisionId: text, basedOnRevision: revision, reason: text };
  return variants('agentDecision', [
    object({ ...common, agentDecision: { const: 'act' }, action: intentActionSchema(activeProvider, platform) }, ['decisionId', 'basedOnRevision', 'agentDecision', 'action']),
    ...['complete', 'fail', 'inconclusive'].map(value => object({ ...common, agentDecision: { const: value } }, ['decisionId', 'basedOnRevision', 'agentDecision'])),
  ]);
}

const intentTarget = intentTargetSchema();
const scriptTarget = executionTargetSchema({ nullable: true });
const intentActionNames = intentActionSchema().properties.action.enum;
const intentBudget = object({ maxSteps: { ...integer(1, 10000), default: 30 }, maxAgentCalls: { ...integer(1, 10000), default: 30 },
  maxDurationMs: { ...milliseconds, default: 120000 }, allowlist: { ...array({ enum: intentActionNames }, 0, intentActionNames.length), uniqueItems: true, default: ['tap'] } });
const captureRequirements = object({ streams: { ...array({ enum: ['logs', 'network', 'state', 'events'] }, 1, 4), uniqueItems: true },
  view: { enum: ['decision-window', 'connected-history'], default: 'decision-window' }, sinceMs: integer(0), limit: pageLimit,
  timeoutMs: milliseconds, runtimeEpoch: text,
  afterActionId: { anyOf: [text, { type: 'null' }], description: 'Omitted selects the current action. Explicit null retains all records in the observed window without claiming causal attribution.' },
  factCursor: text }, ['streams']);

function scriptSpecSchema(permissionNames) {
  return { ...object({ schemaVersion: { const: 'aab.code-script/v1' }, name: { ...text, default: 'script' },
    language: { enum: ['javascript', 'python'] }, source: text, sourcePath: text, cwd: text,
    entrypoint: { ...text, default: 'main' }, target: scriptTarget, inputs: { ...jsonObject, default: {} },
    permissions: { ...array({ enum: permissionNames }, 0, permissionNames.length), uniqueItems: true,
      default: ['app.read', 'app.interact', 'capture.read'] },
    policy: object({ timeoutMs: { ...milliseconds, default: 600000 },
      restartPolicy: { enum: ['none', 'checkpoint'], default: 'none' },
      maxOutputBytes: { ...integer(1, 64 * 1024 * 1024), default: 1048576 }, maxProgressBytes: { ...integer(1, 64 * 1024 * 1024), default: 1048576 } }),
  }, ['schemaVersion', 'language']), oneOf: [{ required: ['source'] }, { required: ['sourcePath'] }] };
}

function executionCommandSchema(command, permissionNames) {
  const read = { afterSequence, limit: pageLimit };
  const scriptRead = { ...read, eventLimit: pageLimit, includeCatalog: boolean };
  const operation = (name, properties, required = []) => object({ operation: { const: name }, ...properties }, ['operation', ...required]);
  const control = (name, properties = {}) => operation(name, { operationId: text, ...properties }, ['operationId']);
  if (command === 'script') return variants('operation', [
    { ...operation('start', { script: scriptSpecSchema(permissionNames), operationId: text, recordingDir: text, pythonPath: text }, ['script']),
      allOf: [
        { if: { required: ['pythonPath'] }, then: { properties: { script: { properties: { language: { const: 'python' } } } } } },
        { if: { required: ['recordingDir'] }, then: { properties: { script: { properties: { policy: { properties: { restartPolicy: { const: 'none' } } } } } } } },
      ] },
    control('result'),
    control('status', scriptRead), control('wait', { ...scriptRead, waitMs: { ...integer(0, 60000), default: 30000 } }),
    ...['pause', 'resume', 'cancel'].map(name => control(name, scriptRead)),
    operation('decide', { operationId: text, requestId: text, revision, decision: { contentMediaType: 'application/json', description: 'JSON answer to the current ctx.askAgent request; business data is preserved.' }, ...scriptRead }, ['operationId', 'requestId', 'revision', 'decision']),
    operation('runtime-status', {}),
  ]);
  if (command === 'intent') {
    const start = { goal: text, target: intentTarget, provider: { ...provider, default: 'native' }, observationTarget: observationTargetSchema, operationId: text,
      timeoutMs: { ...milliseconds, default: 300000, description: 'Total lifetime including observations, decision waits, paused time and actions; terminal persistence drains afterwards.' },
      require: captureRequirements, recordingDir: text };
    return variants('operation', [
      operation('start', { ...start, mode: { const: 'supervised', default: 'supervised' } }, ['goal', 'target']),
      operation('start', { ...start, mode: { const: 'autonomous' }, agentModule: text, budget: intentBudget }, ['goal', 'target', 'mode', 'agentModule']),
      control('status', read), control('observe', { basedOnRevision: revision, observationTarget: observationTargetSchema,
        provider: { ...provider, description: 'Observe through this provider on the frozen target. Becomes selected only after the new observation and summary are committed; omitted retains the last committed selection.' } }),
      operation('decide', { operationId: text, decision: intentDecisionSchema() }, ['operationId', 'decision']),
      ...['pause', 'resume', 'cancel'].map(name => control(name)),
      operation('intervene', { operationId: text, reason: text }, ['operationId', 'reason']),
    ]);
  }
  if (command === 'evidence') return variants('operation', [
    operation('export', { namespace: { enum: ['intent', 'script'] }, operationId: text, outputDir: text, includeRecordedPayloads: boolean }, ['namespace', 'operationId', 'outputDir']),
    operation('verify', { archiveDir: text, manifestSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['archiveDir', 'manifestSha256']),
  ]);
  throw new Error(`No execution contract for ${command}`);
}

module.exports = { variants, exactlyOne, jsonObject, flutterSelector, nativeSelector, scriptSpecSchema, intentDecisionSchema, intentActionSchema, nativeGestureSchema,
  intentBudget, captureRequirements, executionCommandSchema };
