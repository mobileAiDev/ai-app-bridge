'use strict';

const { createDeviceMutationLease, runDeviceEffect } = require('../bin/shared-kernel/device-mutation-lease');
const [directory, serial, mode] = process.argv.slice(2);
const lease = createDeviceMutationLease({ directory });
const held = lease.acquire(serial);
if (!held.ok) { process.send({ ready: true, ok: false, error: held.error }); process.disconnect(); }
else if (mode === 'effect') {
  void held.run(() => runDeviceEffect({ kind: 'flutter', actionId: 'child-action', runtimeEpoch: 'child-runtime', packageName: 'example.child' }, async () => {
    process.send({ ready: true, ok: true });
    await new Promise(() => {});
  }));
  setInterval(() => {}, 1000);
} else {
  process.send({ ready: true, ok: true });
  process.on('message', message => { if (message === 'release') { held.release(); process.disconnect(); } });
}
