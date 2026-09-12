'use strict';

const assert = require('node:assert/strict');

const packageName = 'io.github.mobileaidev.aiappbridge.sample';
const apkSha256 = '53cdc4442f3a92a8e05aa2c63f2945781a50a11dfe6f1fed06b4b688745d43eb';
const phones = { FYZLAU49X8OVQGJ7: { brand: 'OPPO', model: 'PGFM10' }, b46093e6: { brand: 'OnePlus', model: 'PKR110' } };

function verifyUiaSampleTarget(adb, serial) {
  assert.ok(Object.hasOwn(phones, serial), 'This validator requires an explicitly authorized physical phone');
  const device = { serial, brand: adb(['shell', 'getprop', 'ro.product.brand']).trim(),
    model: adb(['shell', 'getprop', 'ro.product.model']).trim(), apiLevel: Number(adb(['shell', 'getprop', 'ro.build.version.sdk']).trim()),
    bootId: adb(['shell', 'cat', '/proc/sys/kernel/random/boot_id']).trim() };
  assert.equal(device.brand, phones[serial].brand); assert.equal(device.model, phones[serial].model); assert.equal(device.apiLevel, 36);
  const apk = adb(['shell', 'pm', 'path', packageName]).trim();
  assert.ok(apk.startsWith('package:') && !apk.includes('\n'));
  assert.equal(adb(['shell', 'sha256sum', apk.slice(8)]).trim().split(/\s+/)[0], apkSha256);
  return { device, packageName, apkSha256 };
}

module.exports = { verifyUiaSampleTarget };
