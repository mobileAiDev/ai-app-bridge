'use strict';

const MAX_FRAME_BYTES = 1024 * 1024;

function createScriptSessionChannel(child, { maxFrameBytes = MAX_FRAME_BYTES } = {}) {
  let buffer = '';
  let closed = false;
  const waiters = [];
  const pending = [];
  const replies = new Map();
  const maxPending = 32;

  if (child.stderr) {
    child.stderr.on('data', () => {});
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (closed) return;
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (Buffer.byteLength(line, 'utf8') > maxFrameBytes) {
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
    if (Buffer.byteLength(buffer, 'utf8') > maxFrameBytes) {
      fail(new Error('frame_too_large'));
    }
  });
  child.stdout.on('end', () => fail(new Error('channel_closed')));
  child.on('error', (error) => fail(error));

  function send(message) {
    if (closed || !child.stdin.writable) return;
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, 'utf8') > maxFrameBytes) {
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
      if (closed) {
        resolve({ type: 'fail', error: 'channel_closed' });
        return;
      }
      waiters.push(resolve);
    });
  }

  function waitReply(id) {
    return new Promise((resolve) => {
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
    while (waiters.length > 0) waiters.shift()(frame);
    for (const resolve of replies.values()) resolve(frame);
    replies.clear();
  }

  function stop() {
    fail(new Error('stopped'));
    if (!child.pid) return;
    child.kill('SIGTERM');
  }

  return { send, nextMessage, waitReply, stop };
}

module.exports = { createScriptSessionChannel };
