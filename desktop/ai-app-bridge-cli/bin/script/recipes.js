'use strict';
const path = require('node:path');
const fs = require('node:fs');
const names = ['android-test-session', 'android-launch-and-wait'];

// Ordinary source files, exposed for callers to inspect, copy and customize.
function catalog() {
  return [
    { name: 'android-test-session', summary: 'Save original rotation/keyboard/stay-awake settings before explicit changes; restore from the same local stateFile after cancellation or a new Script.',
      target: 'Android serial; packageName is optional',
      inputs: { operation: 'prepare | restore', stateFile: 'Absolute path for a new recovery record; reuse it for restore.',
        stayAwake: 'Optional boolean; stay on while plugged into AC, USB or wireless power.',
        rotation: 'Optional 0, 1, 2 or 3; disables automatic rotation and selects the default rotation.',
        showImeWithHardware: 'Optional boolean.', imeId: 'Optional already installed/enabled IME component.', wake: 'Optional boolean; wake the screen, without dismissing credentials.' } },
    { name: 'android-launch-and-wait', summary: 'Launch once, wait for an exact visible label in the selected provider, and return the condition result in one Script.',
      target: 'Android serial and packageName',
      inputs: { readyText: 'Required exact visible label.', provider: 'uia (default), native, flutter or auto.',
        timeoutMs: 'Optional positive integer, default 15000.', intervalMs: 'Optional positive integer, default 250.',
        fullResult: 'Optional boolean, default false. Include raw foreground diagnostic dumps in the result.' } },
  ].map(recipe => {
    const sourcePath = path.resolve(__dirname, '../../recipes', `${recipe.name}.js`);
    return { ...recipe, sourcePath, start: { command: 'script', arguments: { operation: 'start', script: {
      schemaVersion: 'aab.code-script/v1', name: recipe.name, language: 'javascript', sourcePath,
      target: { platform: 'android', serial: '<serial>', ...(recipe.name === 'android-launch-and-wait' ? { packageName: 'example.app' } : {}) },
      inputs: recipe.name === 'android-test-session' ? { operation: 'prepare', stateFile: '/absolute/test-session.json' } : { readyText: '<exact label>' },
    } } } };
  });
}
function read({ name } = {}) {
  const recipes = catalog();
  if (!name) return { ok: true, recipes };
  const recipe = recipes.find(item => item.name === name);
  if (!recipe) return { ok: false, error: 'unknown_recipe', message: `Choose one of: ${names.join(', ')}.` };
  return { ok: true, recipe: { ...recipe, source: fs.readFileSync(recipe.sourcePath, 'utf8') } };
}
module.exports = { catalog, read, names };
