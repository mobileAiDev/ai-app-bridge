'use strict';

const isolatedCommandDefinitions = [
  {
    command: 'script',
    domain: 'advanced',
    summary: 'Run an isolated trusted-local-code JavaScript or Python Script. Operations: start, status, wait, progress, pause, resume, decide, cancel, intervene, or runtime-status. Script source is not an OS sandbox.',
    options: ['operation', 'waitMs', 'afterSequence'],
    runtime: 'trusted-local-code',
  },
  {
    command: 'intent',
    domain: 'advanced',
    summary: 'Run an isolated Intent operation: start, status, observe, decide, pause, resume, cancel, or intervene. target.foregroundPackages explicitly enables Android foreground provider routing.',
    options: ['operation'],
  },
  {
    command: 'evidence',
    domain: 'advanced',
    summary: 'Export retained Host Intent or Script evidence for one operation, or verify an archive offline against its frozen manifest SHA-256. Verification does not open FactStore; external payloads are not included.',
    options: ['operation', 'namespace', 'operationId', 'outputDir', 'archiveDir', 'manifestSha256'],
  },
];

function createCommandRouter({ loadScript, loadIntent, loadEvidence, legacyDispatch } = {}) {
  if (typeof legacyDispatch !== 'function') {
    throw new TypeError('legacyDispatch is required');
  }
  const loads = { script: 0, intent: 0, evidence: 0 };
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
      if (command === 'evidence') {
        return invokeIsolated('evidence', loadEvidence, args, loads);
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
  let handlePromise;
  try {
    handlePromise = Promise.resolve(entry.handle(args));
  } catch (error) {
    return isolatedHandleError(name, error);
  }
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
          resolve(isolatedHandleError(name, error));
        },
      );
    });
  if (result && Array.isArray(result.content)) return result;
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    isError: result?.ok === false,
  };
}

function isolatedHandleError(name, error) {
  return isolatedError(
    name,
    error?.code === 'sfs_busy' ? 'fact_store_writer_busy' : 'isolated_module_unavailable',
    error?.message || String(error),
  );
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
