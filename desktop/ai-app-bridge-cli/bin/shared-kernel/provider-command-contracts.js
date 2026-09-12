'use strict';

const { object, integer, text, milliseconds } = require('./argument-schema');
const { variants, exactlyOne, jsonObject, flutterSelector } = require('./execution-contracts');

const coordinate = { type: 'number', minimum: 0, maximum: 2147483647 };
const delta = { type: 'number', minimum: -2147483647, maximum: 2147483647 };
const pairedCoordinates = { anyOf: [{ required: ['x', 'y'] }, { not: { anyOf: [{ required: ['x'] }, { required: ['y'] }] } }] };

function flutterActionSchema() {
  const h5 = require('./flutter-h5-target');
  const action = (name, properties = {}, required = []) => object({ action: { const: name }, ...properties }, ['action', ...required]);
  return variants('action', [
    action('tapAt', { x: coordinate, y: coordinate }, ['x', 'y']),
    action('tapText', { text }, ['text']),
    action('tapTarget', { selector: flutterSelector }, ['selector']),
    { ...action('inputText', { text: { type: 'string' }, selector: flutterSelector, x: coordinate, y: coordinate }, ['text']), allOf: [pairedCoordinates,
      { not: { required: ['selector'], anyOf: [{ required: ['x'] }, { required: ['y'] }] } }] },
    action('swipe', { startX: coordinate, startY: coordinate, endX: coordinate, endY: coordinate }, ['startX', 'startY', 'endX', 'endY']),
    action('scrollBy', { delta, selector: flutterSelector }, ['delta']),
    action('scrollUntilText', { text, selector: flutterSelector, maxSwipes: { ...integer(0, 1000), default: 12 } }, ['text']),
    ...['hideKeyboard', 'back', 'openHarness', 'h5Adapters'].map(name => action(name)),
    action('h5Dom', { adapterId: text }),
    action('h5Eval', { script: text, expectedPage: h5.pageSchema }, ['script', 'expectedPage']),
    { ...action('h5Control', { operation: { enum: ['click', 'input', 'scroll', 'scrollBy'] },
      expectedTarget: h5.expectedTargetSchema, expectedPage: h5.pageSchema,
      text: { type: 'string', maxLength: 16384 }, deltaX: delta, deltaY: delta }, ['operation']), oneOf: [
      { properties: { operation: { enum: ['click', 'scroll'] }, expectedPage: false, text: false, deltaX: false, deltaY: false }, required: ['expectedTarget'] },
      { properties: { operation: { const: 'input' }, expectedPage: false, deltaX: false, deltaY: false }, required: ['expectedTarget', 'text'] },
      { properties: { operation: { const: 'scrollBy' }, expectedTarget: false, text: false }, required: ['expectedPage', 'deltaX', 'deltaY'],
        not: { properties: { deltaX: { const: 0 }, deltaY: { const: 0 } } } },
    ] },
  ]);
}

function webCommandSchema(common) {
  const command = (name, args, required = []) => object({ ...common, name: { const: name }, arguments: args }, ['sessionId', 'name', ...required]);
  const { selectorSchema, expectedTargetSchema } = require('./web-dom-target');
  const selector = { selector: selectorSchema, expectedTarget: expectedTargetSchema };
  return variants('name', [
    command('domSnapshot', object({ selector: text, maxControls: integer(1, 1000) })),
    command('click', object(selector, ['selector']), ['arguments']),
    command('input', object({ ...selector, value: { type: 'string', maxLength: 16384 } }, ['selector', 'value']), ['arguments']),
    command('key', object({ ...selector, key: { enum: ['Enter', 'Escape'] } }, ['selector', 'key']), ['arguments']),
    command('waitFor', exactlyOne({ selector: selectorSchema, targetText: text, timeoutMs: { ...milliseconds, default: 5000 }, intervalMs: { ...milliseconds, default: 250 } }, ['selector', 'targetText']), ['arguments']),
    command('scroll', { ...object({ ...selector, mode: { enum: ['into-view', 'by'] }, deltaX: delta, deltaY: delta }, ['mode']),
      oneOf: [{ properties: { mode: { const: 'into-view' }, deltaX: false, deltaY: false }, required: ['selector'] },
        { properties: { mode: { const: 'by' } }, anyOf: [{ required: ['deltaX'] }, { required: ['deltaY'] }] }],
      allOf: [{ if: { required: ['expectedTarget'] }, then: { required: ['selector'] } }] }, ['arguments']),
    command('state', object({})),
    command('action', object({ name: text, arguments: { ...jsonObject, description: 'Arguments for the explicitly named registered App action.' } }, ['name', 'arguments']), ['arguments']),
  ]);
}

module.exports = { flutterActionSchema, webCommandSchema };
