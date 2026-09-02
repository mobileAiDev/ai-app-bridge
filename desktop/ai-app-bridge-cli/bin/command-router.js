'use strict';

const isolatedCommandDefinitions = [
  {
    command: 'script',
    domain: 'advanced',
    summary: 'Run an isolated Script operation: start, status, progress, pause, resume, cancel, or intervene.',
    options: ['operation'],
  },
  {
    command: 'intent',
    domain: 'advanced',
    summary: 'Run an isolated Intent operation: start, status, decide, pause, resume, cancel, or intervene.',
    options: ['operation'],
  },
];

function createCommandRouter({ loadScript, loadIntent, legacyDispatch } = {}) {
  if (typeof legacyDispatch !== 'function') {
    throw new TypeError('legacyDispatch is required');
  }
  const loads = { script: 0, intent: 0 };
  return {
    isolatedCommandDefinitions,
    loads,
    async route(command, args = {}) {
      if (command === 'script') {
        return invokeIsolated('script', loadScript, args, loads);
      }
      if (command === 'intent') {
        return invokeIsolated('intent', loadIntent, args, loads);
      }
      return legacyDispatch(command, args);
    },
  };
}

async function invokeIsolated(name, loader, args, loads) {
  if (typeof loader !== 'function') {
    return isolatedError(name, 'not_implemented');
  }
  loads[name] += 1;
  let entry;
  try {
    entry = loader();
  } catch (error) {
    return isolatedError(name, 'isolated_module_unavailable', error.message || String(error));
  }
  if (!entry || typeof entry.handle !== 'function') {
    return isolatedError(name, 'isolated_module_unavailable', 'entry handle is missing');
  }
  const handlePromise = Promise.resolve(entry.handle(args));
  const timeoutMs = args.isolatedTimeoutMs;
  const result = timeoutMs == null
    ? await handlePromise
    : await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(isolatedError(name, 'isolated_timeout')), timeoutMs);
      handlePromise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          resolve(isolatedError(name, 'isolated_module_unavailable', error.message || String(error)));
        },
      );
    });
  if (result && Array.isArray(result.content)) return result;
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    isError: result?.ok === false,
  };
}

function isolatedError(command, error, detail) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ok: false,
        error,
        command,
        ...(detail ? { detail } : {}),
      }, null, 2),
    }],
    isError: true,
  };
}

module.exports = {
  createCommandRouter,
  isolatedCommandDefinitions,
};
