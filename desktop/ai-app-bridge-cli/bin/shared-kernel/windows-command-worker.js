'use strict';

// No requested program is started before the parent attaches this worker to
// its own kill-on-close Job. EOF before start ends the unused worker.
const spawn = require('cross-spawn');
process.once('disconnect', () => process.exit(1));
process.once('message', ({ file, args, options }) => {
  const child = spawn(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  let spawned = child.pid !== undefined;
  child.once('spawn', () => { spawned = true; });
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  let failure;
  child.once('error', error => { failure = { message: error.message, code: error.code, errno: error.errno, syscall: error.syscall }; });
  child.once('close', (code, signal) => {
    // IPC and stdout are different pipes: drain both output queues before
    // telling the parent the command finished and may release Job ownership.
    process.stdout.write('', () => process.stderr.write('', () => {
      process.send({ event: 'result', code, signal, failure, spawned }, () => {});
    }));
  });
});
process.send({ event: 'ready' });
