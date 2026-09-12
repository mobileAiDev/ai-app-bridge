'use strict';
const { webCommandSchema } = require('../shared-kernel/provider-command-contracts');
const { selectorSchema, expectedTargetSchema } = require('../shared-kernel/web-dom-target');
const text = { type: 'string', minLength: 1, maxLength: 1024 };
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const target = { sessionId: text, runtimeEpoch: text, targetId: { enum: ['main'], default: 'main' } };
const control = { timeoutMs: { ...integer(1, 30000), default: 5000 }, requestId: text, feedback: { enum: ['auto', 'off', 'full'] } };
const query = { history: { type: 'boolean', default: false }, sinceMs: integer(0, Number.MAX_SAFE_INTEGER),
  cursor: { ...text, maxLength: 4096 }, throughCursor: { ...text, maxLength: 4096 }, limit: { ...integer(1, 16), default: 16 } };
const cursorPair = { anyOf: [{ required: ['cursor', 'throughCursor'] }, { not: { anyOf: [{ required: ['cursor'] }, { required: ['throughCursor'] }] } }] };

function webSchema(command) {
  if (command === 'web-session-start') return object({ host: text, webPort: integer(0, 65535),
    path: { ...text, pattern: '^/[A-Za-z0-9/_-]+$' }, token: text, ...control });
  if (['web-provider-status', 'web-session-stop', 'web-connect-info', 'web-sessions'].includes(command)) return object(control);
  if (command === 'web-status') return object({ sessionId: text, ...control }, ['sessionId']);
  if (command === 'web-execution') return { ...object({ ...target, ...control,
    operation: { enum: ['status', 'result', 'cancel', 'reconcile'] }, actionId: text }, ['operation', 'sessionId', 'runtimeEpoch']),
    oneOf: [{ properties: { operation: { enum: ['status', 'reconcile'] }, actionId: false } },
      { properties: { operation: { enum: ['result', 'cancel'] } }, required: ['actionId'] }] };
  if (command === 'web-command') {
    const schema = webCommandSchema({ ...target, ...control });
    for (const branch of schema.anyOf) branch.required.push('runtimeEpoch');
    schema.required.push('sessionId', 'runtimeEpoch');
    return schema;
  }
  if (['web-logs', 'web-network', 'web-state', 'web-events'].includes(command)) return {
    ...object({ ...target, ...query, ...control,
      view: { enum: ['decision-window', 'connected-history'], default: 'decision-window' },
      factCursor: { ...text, maxLength: 4096 }, afterActionId: text,
    }, ['sessionId', 'runtimeEpoch']), allOf: [cursorPair,
      { not: { properties: { history: { const: true }, view: { const: 'decision-window' } }, required: ['history', 'view'] } },
      { if: { required: ['afterActionId'] }, then: { required: ['factCursor'] } },
      { if: { anyOf: [
        { properties: { history: { const: true } }, required: ['history'] },
        { properties: { view: { const: 'connected-history' } }, required: ['view'] },
      ] }, then: { properties: { factCursor: false, afterActionId: false } } },
    ] };
  if (command === 'web-dom') return { ...object({ ...target, ...query, ...control, selector: text, maxControls: integer(1, 1000) }, ['sessionId', 'runtimeEpoch']),
    allOf: [cursorPair], oneOf: [
      { properties: { history: { const: false }, cursor: false, throughCursor: false, sinceMs: false, limit: false } },
      { properties: { history: { const: true }, selector: false, maxControls: false }, required: ['history'] },
    ] };
  if (command === 'web-scroll') return { ...object({ ...target, ...control, selector: selectorSchema, expectedTarget: expectedTargetSchema,
    mode: { enum: ['into-view', 'by'] }, deltaX: { type: 'number' }, deltaY: { type: 'number' } }, ['sessionId', 'runtimeEpoch', 'mode']), oneOf: [
    { properties: { mode: { const: 'into-view' }, deltaX: false, deltaY: false }, required: ['selector'] },
    { properties: { mode: { const: 'by' } }, anyOf: [{ required: ['deltaX'] }, { required: ['deltaY'] }] },
  ], allOf: [{ if: { required: ['expectedTarget'] }, then: { required: ['selector'] } }] };
  const fields = command === 'web-key' ? { selector: selectorSchema, expectedTarget: expectedTargetSchema, key: { enum: ['Enter', 'Escape'] } }
    : command === 'web-input' ? { selector: selectorSchema, expectedTarget: expectedTargetSchema, value: { type: 'string', maxLength: 16384 } }
    : command === 'web-click' ? { selector: selectorSchema, expectedTarget: expectedTargetSchema }
    : { selector: selectorSchema, targetText: text };
  const schema = object({ ...target, ...control, ...fields }, ['sessionId', 'runtimeEpoch',
    ...(command === 'web-key' ? ['selector', 'key'] : command === 'web-input' ? ['selector', 'value'] : command === 'web-click' ? ['selector'] : [])]);
  if (command === 'web-wait') schema.oneOf = [
    { required: ['selector'], properties: { targetText: false } }, { required: ['targetText'], properties: { selector: false } }];
  return schema;
}
module.exports = { webSchema };
