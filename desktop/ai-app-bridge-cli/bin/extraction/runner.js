'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createScriptSessionChannel } = require('../script/script-session-channel');

const MAX_INPUT_FRAME_BYTES = 8 * 1024 * 1024 + 64 * 1024;
const MAX_OUTPUT_FRAME_BYTES = 256 * 1024 + 64 * 1024;
let active = 0;

async function runExtraction(prepared, inputs) {
  if (active >= 2) return { ok: false, error: 'extraction_busy', message: 'Two extraction workers are active. Retry extraction using the response ref; do not repeat the action.' };
  active++;
  let directory, child, channel, timer, exited;
  let result;
  let timings = {};
  let started = performance.now();
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-extract-'));
    const python = prepared.language === 'python';
    const artifact = path.join(directory, python ? 'main.py' : 'main.js');
    fs.writeFileSync(artifact, prepared.source ?? '');
    const sdk = path.resolve(__dirname, '../script', python ? 'script-sdk.py' : 'script-sdk.js');
    started = performance.now();
    child = spawn(prepared.executable ?? process.execPath, [sdk, artifact], {
      shell: false, cwd: prepared.cwd, stdio: ['pipe', 'pipe', 'pipe'],
    });
    channel = createScriptSessionChannel(child, { maxInputFrameBytes: MAX_INPUT_FRAME_BYTES, maxOutputFrameBytes: MAX_OUTPUT_FRAME_BYTES });
    exited = new Promise(resolve => {
      child.once('exit', resolve);
      child.once('error', () => { if (child.pid == null) resolve(); });
    });
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ type: 'fail', error: 'extraction_timeout' }), prepared.timeoutMs); });
    const next = () => Promise.race([channel.nextMessage(), timeout]);
    let message = await next();
    if (message.type === 'ready') {
      timings.coldStartMs = performance.now() - started;
      channel.send({ type: 'start', inputs, extraction: prepared.mode === 'regex'
        ? { mode: 'regex', inputPath: prepared.inputPath, pattern: prepared.pattern, flags: prepared.flags }
        : { mode: 'script' }, sourceName: prepared.filename, entrypoint: 'main' });
      message = await next();
    }
    timings.responseMs = performance.now() - started;
    if (message.timings) Object.assign(timings, message.timings);
    if (message.type === 'return' && Object.hasOwn(message, 'result')) {
      require('./json-value').validateJsonValue(message.result);
      if (Buffer.byteLength(JSON.stringify(message.result)) > 256 * 1024) result = { ok: false, error: 'extraction_output_too_large' };
      else result = { ok: true, result: message.result };
    } else {
      const code = ['channel_closed', 'stopped'].includes(message.error) ? 'extraction_worker_exited'
        : message.error === 'frame_too_large' ? 'extraction_frame_too_large'
        : message.error === 'malformed_frame' ? 'extraction_malformed_frame' : message.error;
      result = { ok: false, error: typeof code === 'string' && /^extraction_[a-z0-9_]{1,110}$/.test(code) ? code : 'extraction_failed',
        ...(message.message ? { message: message.message } : {}), ...(message.diagnostic ? { diagnostic: message.diagnostic } : {}) };
    }
  } catch (error) {
    result = { ok: false, error: error.code === 'extraction_type_error' ? error.code : 'extraction_worker_failed', message: error.message };
  } finally {
    clearTimeout(timer);
    channel?.stop();
    if (exited) await exited;
    // Descendants may inherit pipes, but are outside the worker lifecycle.
    // Close our pipe handles after the worker exits instead of waiting for
    // every descendant to close its copies of stdout/stderr.
    child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy();
    try { if (directory) fs.rmSync(directory, { recursive: true, force: true }); }
    catch (error) { result = { ok: false, error: 'extraction_cleanup_failed', message: error.message }; }
    finally { active--; }
  }
  const diagnostics = channel?.diagnostics();
  return { ...result, durationMs: Math.round((performance.now() - started) * 100) / 100, timings,
    ...(!result.ok && diagnostics && Object.keys(diagnostics).length ? { diagnostics } : {}) };
}

module.exports = { runExtraction, MAX_INPUT_FRAME_BYTES, MAX_OUTPUT_FRAME_BYTES };
