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

const nativeSelector = require('./native-target').selectorSchema;
const uiaSelector = require('./uia-target').intentSelectorSchema;
const flutterSelector = { ...object({ text, nodeId: text, label: text, hint: text,
  role: { enum: ['input', 'control', 'scrollable'] }, widgetType: text }), minProperties: 1,
  allOf: [{ if: { required: ['nodeId'] }, then: { maxProperties: 1 } }] };

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
  const branches = [object({ action: { const: 'command' }, command: text,
    arguments: jsonObject, target: executionTargetSchema(),
    observeAfter: { type: 'boolean', default: false,
      description: 'Optional fresh UI observation after this command. Default false returns its result directly; existing UI evidence retains its original revision.' },
  }, ['action', 'command'])];
  for (const name of activeProvider ? [activeProvider] : provider.enum) {
    const make = (action, properties = {}, required = []) => object({ action: { const: action }, provider: { const: name },
      observeAfter: { type: 'boolean', default: true, description: 'Set false to continue using already observed controls. The executor still validates their live identity; uiObservation.stale marks the older page until observe or the next observed action.' }, ...properties }, ['action', ...required]);
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
      branches.push(make('inputText', { selector, value: { type: 'string' }, focus: { type: 'boolean' }, hideKeyboard: { type: 'boolean' } }, ['selector', 'value']));
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
  maxDurationMs: { ...milliseconds, default: 120000 }, allowlist: { ...array({ enum: intentActionNames }, 0, intentActionNames.length), uniqueItems: true,
    description: 'Optional caller restriction. Omit to allow every action supported by the selected platform and provider.' } });
const captureRequirements = object({ streams: { ...array({ enum: ['logs', 'network', 'state', 'events'] }, 1, 4), uniqueItems: true },
  view: { enum: ['decision-window', 'connected-history'], default: 'decision-window' }, sinceMs: integer(0), limit: pageLimit,
  timeoutMs: milliseconds, runtimeEpoch: text,
  afterActionId: { anyOf: [text, { type: 'null' }], description: 'Omitted selects the current action. Explicit null retains all records in the observed window without claiming causal attribution.' },
  factCursor: text }, ['streams']);

function scriptSpecSchema(permissionNames) {
  return { ...object({ schemaVersion: { const: 'aab.code-script/v1' }, name: { ...text, default: 'script' },
    language: { enum: ['javascript', 'python'] }, source: { ...text,
      description: 'JavaScript exports main(ctx); Python defines main(ctx). Workflow ctx.call(command, args) returns {ok,result,error}; check ok before reading command data from result.' }, sourcePath: text, cwd: text,
    entrypoint: { ...text, default: 'main' }, target: scriptTarget, inputs: { ...jsonObject, default: {} },
    permissions: { ...array({ enum: permissionNames }, 0, permissionNames.length), uniqueItems: true,
      default: permissionNames, description: 'Optional caller restriction. Omit to enable every supported Script command.' },
    policy: object({ timeoutMs: { ...milliseconds, default: 600000 },
      restartPolicy: { enum: ['none', 'checkpoint'], default: 'none' },
      maxOutputBytes: { ...integer(1, 64 * 1024 * 1024), default: 1048576 }, maxProgressBytes: { ...integer(1, 64 * 1024 * 1024), default: 1048576 } }),
  }, ['schemaVersion', 'language']), oneOf: [{ required: ['source'] }, { required: ['sourcePath'] }] };
}

const scriptStartExamples = ['javascript', 'python'].map(language => ({
  operation: 'start', waitMs: 5000,
  script: { schemaVersion: 'aab.code-script/v1', language,
    source: language === 'javascript'
      ? "module.exports.main = async ctx => { const reply = await ctx.call('runtime', {operation:'status'}); if (!reply.ok) throw new Error(reply.error); return reply.result; };"
      : "def main(ctx):\n    reply = ctx.call('runtime', {'operation': 'status'})\n    if not reply['ok']:\n        raise RuntimeError(reply['error'])\n    return reply['result']\n",
  },
}));

function executionCommandSchema(command, permissionNames) {
  // Script and Intent page with different cursors; the schema states which one.
  const historyRead = {
    afterSequence: { ...afterSequence, description: 'History page cursor: the previous response\'s history.lastSequence. Not an eventSequence.' },
    limit: { ...pageLimit, description: 'History entries per page; it bounds entries, not response bytes.' },
  };
  const scriptRead = {
    afterSequence: { ...afterSequence, description: 'Sequence lower bound. For progress waits use the previous eventSequence. To audit every bounded page, use history.lastSequence for history, or the last returned events[].sequence for events; eventSequence is the live watermark and can skip unread records.' },
    limit: { ...pageLimit, default: 1, description: 'History entries per page; defaults to one. With no cursor or explicit limits, returns only the latest record and marks omittedBefore. Use afterSequence:0 and a larger limit to audit history.' },
    eventLimit: { ...pageLimit, default: 1, description: 'Event entries per page; defaults to limit or one. Does not increase the history limit.' }, includeCatalog: boolean,
  };
  const operation = (name, properties, required = []) => object({ operation: { const: name }, ...properties }, ['operation', ...required]);
  const control = (name, properties = {}) => operation(name, { operationId: text, ...properties }, ['operationId']);
  if (command === 'script') return variants('operation', [
    { ...operation('start', { script: scriptSpecSchema(permissionNames), operationId: text,
      recordingDir: { ...text, description: 'Optional new recording directory. Put this beside script in the start arguments, not inside the script object.' }, pythonPath: text,
      waitMs: { ...integer(0, 60000), default: 0, description: 'Optionally wait for completion or an Agent question in this same call. Zero starts asynchronously; a timeout returns the running operationId.' } }, ['script']),
      examples: scriptStartExamples,
      allOf: [
        { if: { required: ['pythonPath'] }, then: { properties: { script: { properties: { language: { const: 'python' } } } } } },
        { if: { required: ['recordingDir'] }, then: { properties: { script: { properties: { policy: { properties: { restartPolicy: { const: 'none' } } } } } } } },
      ] },
    control('result'),
    control('status', scriptRead), control('wait', { ...scriptRead,
      until: { enum: ['attention', 'event'], default: 'attention', description: 'By default wait for completion, failure, cancellation, pause, or an Agent question. Select event for progress streaming.' },
      waitMs: { ...integer(0, 60000), default: 30000,
      description: 'Upper bound of one wait call in milliseconds. To keep waiting, call wait again with the same operationId and afterSequence set to the last eventSequence.' } }),
    control('pause', scriptRead),
    { ...control('resume', { ...scriptRead,
      script: scriptSpecSchema(permissionNames),
      recovery: require('../script/script-recovery').recoverySchema,
      waitMs: { ...integer(0, 60000), default: 0,
      description: 'Optionally resume and wait for completion or an Agent question in the same call, returning a ready result inline.' } }),
      description: 'Optionally supply the exact original script specification. Source, inputs, target, cwd, permissions and policy must match the original hash; this cannot replace the program.' },
    control('cancel', scriptRead),
    operation('decide', { operationId: text, requestId: text, revision, decision: { contentMediaType: 'application/json', description: 'JSON answer to the current ctx.askAgent request; business data is preserved.' }, ...scriptRead,
      waitMs: { ...integer(0, 60000), default: 0,
        description: 'Optionally answer and wait for completion or the next Agent question in the same call. A timeout leaves the answered operation running; continue with wait, without submitting another decision.' } }, ['operationId', 'requestId', 'revision', 'decision']),
    operation('runtime-status', {}),
    operation('recipes', { name: { type: 'string', enum: require('../script/recipes').names } }),
  ]);
  if (command === 'intent') {
    const start = { goal: text, target: intentTarget, provider: { ...provider, default: 'native' }, observationTarget: observationTargetSchema, operationId: text,
      background: { type: 'boolean', default: false, description: 'Return operationId after admission while observation/Agent work continues. Script/Intent command composition defaults this to true; explicit false waits for the initial decision loop.' },
      timeoutMs: { ...milliseconds, default: 300000, description: 'Total lifetime including observations, decision waits, paused time and actions; terminal persistence drains afterwards.' },
      require: captureRequirements, recordingDir: text };
    return variants('operation', [
      operation('start', { ...start, mode: { const: 'supervised', default: 'supervised' } }, ['goal', 'target']),
      operation('start', { ...start, mode: { const: 'autonomous' }, agentModule: text, budget: intentBudget }, ['goal', 'target', 'mode', 'agentModule']),
      control('status', historyRead), control('observe', { basedOnRevision: revision, observationTarget: observationTargetSchema,
        provider: { ...provider, description: 'Observe through this provider on the frozen target. Becomes selected only after the new observation and summary are committed; omitted retains the last committed selection.' } }),
      control('wait', { ...historyRead, afterEventSequence: { ...integer(0), default: 0,
        description: 'Event cursor from the previous Intent response eventSequence; distinct from history.afterSequence.' },
        waitMs: { ...integer(0, 60000), default: 30000 } }),
      operation('decide', { operationId: text, decision: intentDecisionSchema() }, ['operationId', 'decision']),
      ...['pause', 'resume', 'cancel'].map(name => control(name)),
      operation('intervene', { operationId: text, reason: text }, ['operationId', 'reason']),
    ]);
  }
  if (command === 'evidence') return variants('operation', [
    operation('export', { namespace: { enum: ['intent', 'script', 'response'] }, operationId: text, outputDir: text, includeRecordedPayloads: boolean }, ['namespace', 'operationId', 'outputDir']),
    operation('verify', { archiveDir: text, manifestSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['archiveDir', 'manifestSha256']),
  ]);
  throw new Error(`No execution contract for ${command}`);
}

module.exports = { variants, exactlyOne, jsonObject, flutterSelector, nativeSelector, scriptSpecSchema, intentDecisionSchema, intentActionSchema, nativeGestureSchema,
  intentBudget, captureRequirements, executionCommandSchema };
