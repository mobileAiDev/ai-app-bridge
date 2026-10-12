'use strict';

// This is editable trusted Script source. All device calls use the Bridge;
// the local journal survives Script cancellation without relying on finally.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const schemaVersion = 'aab.android-test-session/v1';
const keys = [
  ['global', 'stay_on_while_plugged_in'], ['system', 'accelerometer_rotation'],
  ['system', 'user_rotation'], ['secure', 'selected_input_method_subtype'], ['secure', 'input_methods_subtype_history'],
  ['secure', 'default_input_method'], ['secure', 'show_ime_with_hard_keyboard'],
];
const quote = value => /^[A-Za-z0-9_./:+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

exports.main = async ctx => {
  const { operation, stateFile } = ctx.inputs;
  if (ctx.target?.platform !== 'android' || !ctx.target.serial)
    throw new Error('Set script.target to an explicit Android serial. No packageName is needed.');
  if (!['prepare', 'restore'].includes(operation) || typeof stateFile !== 'string' || !path.isAbsolute(stateFile))
    throw new Error('Use operation prepare or restore and an absolute stateFile path.');
  const allowed = operation === 'prepare' ? ['operation', 'stateFile', 'stayAwake', 'rotation', 'imeId', 'showImeWithHardware', 'wake'] : ['operation', 'stateFile'];
  if (Object.keys(ctx.inputs).some(key => !allowed.includes(key))) throw new Error(`Supported inputs for ${operation}: ${allowed.join(', ')}.`);
  for (const key of ['stayAwake', 'showImeWithHardware', 'wake'])
    if (ctx.inputs[key] !== undefined && typeof ctx.inputs[key] !== 'boolean') throw new Error(`${key} must be boolean.`);
  if (ctx.inputs.rotation !== undefined && ![0, 1, 2, 3].includes(ctx.inputs.rotation)) throw new Error('rotation must be 0, 1, 2 or 3.');
  if (ctx.inputs.imeId !== undefined && (typeof ctx.inputs.imeId !== 'string' || !/^[A-Za-z][\w.]*\/[\w.$]+$/.test(ctx.inputs.imeId)))
    throw new Error('imeId must identify an installed/enabled IME component, such as package.name/.Keyboard.');
  const adb = (argv, readOnly) => ctx.call('adb-exec', { argv, readOnly });
  const read = async argv => {
    const reply = await adb(argv, true);
    if (!reply.ok) throw Object.assign(new Error('A preparation/restoration observation failed.'), { receipt: reply });
    return reply.result.stdout.trim();
  };
  let journal, recorded = false;
  const save = async (initial = false) => {
    const temporary = initial ? stateFile : `${stateFile}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(journal, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    if (!initial) await fs.rename(temporary, stateFile);
    recorded = true;
  };
  const get = async item => {
    const value = await read(['shell', 'settings', '--user', String(journal.userId), 'get', item.namespace, item.key]);
    return value === 'null' ? null : value;
  };
  const report = (ok, more = {}) => ({ ok, operation, stateFile, serial: journal?.serial ?? ctx.target.serial,
    userId: journal?.userId, ...more,
    recoveryRecordSaved: recorded,
    ...(recorded ? { restore: { ...(ctx.sourcePath ? { command: 'script', arguments: { operation: 'start', script: {
      schemaVersion: 'aab.code-script/v1', language: 'javascript', sourcePath: ctx.sourcePath, target: ctx.target,
      inputs: { operation: 'restore', stateFile },
    } } } : { inputs: { operation: 'restore', stateFile } }) } } : {}),
  });
  try {
    if (operation === 'prepare') {
      const user = await read(['shell', 'am', 'get-current-user']);
      if (!/^\d+$/.test(user)) throw new Error(`Cannot identify the current Android user: ${user}`);
      journal = { schemaVersion, serial: ctx.target.serial, userId: Number(user), recordedAtMs: Date.now(), settings: [] };
      for (const [namespace, key] of keys) {
        const item = { namespace, key }; item.before = await get(item); journal.settings.push(item);
      }
      const desired = {};
      if (ctx.inputs.stayAwake !== undefined) desired.stay_on_while_plugged_in = ctx.inputs.stayAwake ? '7' : '0';
      if (ctx.inputs.rotation !== undefined) { desired.accelerometer_rotation = '0'; desired.user_rotation = String(ctx.inputs.rotation); }
      if (ctx.inputs.showImeWithHardware !== undefined) desired.show_ime_with_hard_keyboard = ctx.inputs.showImeWithHardware ? '1' : '0';
      if (ctx.inputs.imeId !== undefined) desired.default_input_method = ctx.inputs.imeId;
      for (const item of journal.settings) if (Object.hasOwn(desired, item.key)) item.requested = desired[item.key];
      await save(true); // Exclusive creation prevents losing an earlier restore record.
    } else {
      journal = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      if (journal.schemaVersion !== schemaVersion || journal.serial !== ctx.target.serial || !Number.isInteger(journal.userId) || journal.userId < 0
        || !Array.isArray(journal.settings) || journal.settings.length !== keys.length
        || journal.settings.some((item, i) => item.namespace !== keys[i][0] || item.key !== keys[i][1]
          || !(item.before === null || typeof item.before === 'string')))
        throw new Error('This stateFile is not a matching recovery record. Select its original Android serial and the correct stateFile.');
      recorded = true;
    }
    const results = [];
    const settings = operation === 'restore' ? [...journal.settings].reverse() : journal.settings;
    for (const item of settings) {
      if (operation === 'prepare' ? item.requested === undefined : item.attempted !== true) continue;
      const desired = operation === 'prepare' ? item.requested : item.before;
      const beforeWrite = await get(item);
      if (beforeWrite === desired) { results.push({ key: item.key, ok: true, changed: false, value: desired }); continue; }
      if (operation === 'prepare') {
        item.attempted = true;
        // ime set also changes subtype selection/history; record restoration
        // intent before that command, including when its receipt is lost.
        if (item.key === 'default_input_method') for (const related of journal.settings)
          if (['selected_input_method_subtype', 'input_methods_subtype_history'].includes(related.key)) related.attempted = true;
        await save();
      }
      const argv = item.key === 'default_input_method' && desired !== null
        ? ['shell', 'ime', 'set', '--user', String(journal.userId), quote(desired)]
        : ['shell', 'settings', '--user', String(journal.userId), desired === null ? 'delete' : 'put', item.namespace, item.key,
          ...(desired === null ? [] : [quote(desired)])];
      const receipt = await adb(argv, false);
      const verification = receipt.ok ? await get(item) : undefined;
      const ok = receipt.ok && verification === desired;
      const result = { key: item.key, ok, beforeWrite, expected: desired, ...(verification !== undefined ? { observed: verification } : {}),
        execution: receipt.execution, ...(!ok ? { receipt, error: receipt.ok ? 'setting_readback_mismatch' : receipt.error } : {}) };
      item[operation] = result; await save(); results.push(result);
      if (!ok && operation === 'prepare') return report(false, { results, message: 'Preparation stopped. Inspect the receipt or run restore with this stateFile; the failed write was not replayed.' });
    }
    if (operation === 'prepare' && ctx.inputs.wake === true) {
      journal.wakeRequested = true; await save();
      const wake = await adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], false);
      journal.wake = wake; await save(); results.push({ key: 'wake', ok: wake.ok, execution: wake.execution, ...(!wake.ok ? { receipt: wake } : {}) });
    }
    return report(results.every(item => item.ok), { results, message: 'Settings were read back. This does not prove the App orientation or keyboard UI; observe the test page. Wake does not dismiss a credential lock, and restore does not put the screen to sleep.' });
  } catch (error) {
    return report(false, { error: error.code || 'test_session_failed', message: error.code === 'EEXIST'
      ? 'stateFile already exists. Restore that record, or choose a new file to preserve both sessions.' : error.message,
      ...(error.receipt ? { receipt: error.receipt } : {}) });
  }
};
