'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');

test('iOS log rebinding handles protected pages and denied VM permission without corrupting pointers',
  { skip: process.platform !== 'darwin' }, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aab-log-rebinding-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const executable = path.join(directory, 'check');
    const env = { ...process.env };
    for (const name of ['CPATH', 'C_INCLUDE_PATH', 'CPLUS_INCLUDE_PATH', 'OBJC_INCLUDE_PATH', 'LIBRARY_PATH', 'SDKROOT']) delete env[name];
    execFileSync('xcrun', ['clang', '-Wall', '-Wextra', '-Werror',
      path.join(__dirname, '../test-support/ios-log-rebinding-check.c'), '-o', executable], { env, timeout: 30000 });
    assert.match(execFileSync(executable, [], { encoding: 'utf8', timeout: 5000 }), /^PASS protected-page rebind/);
    const source = path.resolve(__dirname, '../../../ios/ai-app-bridge-ios/Sources/AiAppBridgeFactStoreC/fishhook.c');
    const mirror = path.resolve(__dirname, '../../../flutter/ai_app_bridge_flutter/ios/ai_app_bridge_flutter/Sources/AiAppBridgeFactStoreC/fishhook.c');
    assert.deepEqual(fs.readFileSync(source), fs.readFileSync(mirror));
  });
