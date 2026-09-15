'use strict';

// Unit-test files model unrelated fake phones, often with the same serial.
// Their subprocesses inherit one namespace per file; production never derives
// device ownership from a FactStore path or an individual package installation.
if (process.env.NODE_TEST_CONTEXT && (process.argv[1] || '').endsWith('.test.js')) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-test-device-ownership-'));
  process.env.AI_APP_BRIDGE_DEVICE_OWNERSHIP_DIR = directory;
  process.env.AI_APP_BRIDGE_RUNTIME_HOME = path.join(directory, 'runtimes');
  process.env.AI_APP_BRIDGE_EXECUTOR_HOME = path.join(directory, 'executors');
  // Isolate the default path without overriding a test's explicit DIR or
  // legacy CACHE_PATH contract when it launches a public Host subprocess.
  process.env.AI_APP_BRIDGE_FACT_STORE_PATH ??= path.join(directory, 'facts');
  const test = require('node:test');
  test.beforeEach(() => {
    // New test cases model new controlled peers. Preserve lock files and prove
    // the OS lock is free before removing this case's fake-device journal.
    const { createOwnershipStore } = require('../bin/shared-kernel/device-ownership-store');
    const store = createOwnershipStore(directory);
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
      const file = path.join(directory, name);
      const serial = JSON.parse(fs.readFileSync(file, 'utf8')).serial;
      const lock = store.lock(serial);
      if (!lock) throw new Error(`Test left a live device owner: ${serial}`);
      try { fs.unlinkSync(file); } finally { lock.close(); }
    }
  });
  test.after(async () => {
    const runtimeHome = path.join(directory, 'runtimes');
    if (fs.existsSync(runtimeHome)) {
      const { exchange } = require('../bin/runtime-client');
      for (const entry of fs.readdirSync(runtimeHome)) {
        const file = path.join(runtimeHome, entry, 'endpoint.json');
        if (!fs.existsSync(file)) continue;
        const endpoint = JSON.parse(fs.readFileSync(file, 'utf8'));
        await exchange(endpoint, 'stop', {}, { timeoutMs: 15000 });
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
}
