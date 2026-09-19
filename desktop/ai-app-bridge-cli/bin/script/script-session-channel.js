'use strict';

const MAX_FRAME_BYTES = 1024 * 1024;

function createScriptSessionChannel(child, { maxFrameBytes = MAX_FRAME_BYTES,
  maxInputFrameBytes = maxFrameBytes, maxOutputFrameBytes = maxFrameBytes, maxDiagnosticBytes = 8192 } = {}) {
  let buffer = '';
  let closed = false;
  let failure = null;
  let killTimer;
  child.once('exit', () => clearTimeout(killTimer));
  const waiters = [];
  const pending = [];
  const replies = new Map();
  const maxPending = 32;
  let stderr = Buffer.alloc(0);
  let stderrTotalBytes = 0;

  if (child.stderr) {
    child.stderr.on('data', chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrTotalBytes += bytes.length;
      stderr = bytes.length >= maxDiagnosticBytes ? Buffer.from(bytes.subarray(-maxDiagnosticBytes))
        : Buffer.concat([stderr.subarray(Math.max(0, stderr.length + bytes.length - maxDiagnosticBytes)), bytes]);
    });
  }
  child.stdin.on('error', error => fail(error));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (closed) return;
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (Buffer.byteLength(line, 'utf8') + 1 > maxOutputFrameBytes) {
        fail(new Error('frame_too_large'));
        return;
      }
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        fail(new Error('malformed_frame'));
        return;
      }
      if (message == null || typeof message !== 'object' || Array.isArray(message)) {
        fail(new Error('malformed_frame'));
        return;
      }
      if (message.id && replies.has(message.id)) {
        const resolve = replies.get(message.id);
        replies.delete(message.id);
        resolve(message);
        continue;
      }
      if (waiters.length > 0) {
        waiters.shift()(message);
        continue;
      }
      if (pending.length >= maxPending) {
        fail(new Error('channel_backlog'));
        return;
      }
      pending.push(message);
    }
    if (Buffer.byteLength(buffer, 'utf8') > maxOutputFrameBytes) {
      fail(new Error('frame_too_large'));
    }
  });
  child.stdout.on('end', () => fail(new Error('channel_closed')));
  child.on('error', (error) => fail(error));

  function send(message) {
    if (closed || !child.stdin.writable) return;
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, 'utf8') > maxInputFrameBytes) {
      fail(new Error('frame_too_large'));
      return;
    }
    child.stdin.write(line);
  }

  function nextMessage() {
    return new Promise((resolve) => {
      if (pending.length > 0) {
        resolve(pending.shift());
        return;
      }
      if (closed) { resolve(failure); return; }
      waiters.push(resolve);
    });
  }

  function waitReply(id) {
    return new Promise((resolve) => {
      if (closed) {
        resolve(failure);
        return;
      }
      if (replies.size >= maxPending) {
        fail(new Error('channel_backlog'));
        resolve({ type: 'fail', error: 'channel_backlog' });
        return;
      }
      replies.set(id, resolve);
    });
  }

  function fail(error) {
    if (closed) return;
    closed = true;
    const frame = { type: 'fail', error: error.message || String(error) };
    failure = frame;
    const terminal = error.message === 'channel_closed' ? pending.find(message => ['return', 'fail'].includes(message.type)) : null;
    pending.length = 0;
    if (terminal) pending.push(terminal);
    buffer = '';
    while (waiters.length > 0) waiters.shift()(frame);
    for (const resolve of replies.values()) resolve(frame);
    replies.clear();
  }

  function stop() {
    fail(new Error('stopped'));
    if (!child.pid) return;
    if (child.kill('SIGTERM') && !killTimer) killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
  }

  function diagnostics() {
    if (!stderrTotalBytes) return {};
    // Invalid bytes expand to replacement characters. Bound delivered UTF-8
    // text too, starting at a complete character in the retained tail.
    const text = Buffer.from(stderr.toString('utf8'));
    let start = Math.max(0, text.length - maxDiagnosticBytes);
    while (start < text.length && (text[start] & 0xc0) === 0x80) start++;
    return { stderr: text.subarray(start).toString('utf8'), stderrTruncated: stderrTotalBytes > stderr.length || start > 0 };
  }
  return { send, nextMessage, waitReply, stop, diagnostics };
}

module.exports = { createScriptSessionChannel };
