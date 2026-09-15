'use strict';

const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { AndroidExecutorHost, recoverAndroidExecutor, settlement } = require('./android-host');
const { AndroidExecutorPort, quote } = require('./android-port');
const { atomicJson, readJson } = require('./managed-runtime');
const { runDeviceEffect } = require('../shared-kernel/device-mutation-lease');
const { checkExecution, markExecutionDispatched, executionSleep } = require('../shared-kernel/execution-scope');
const { CommandError } = require('../command-errors');
const protocol = 'aab.flutter-integration-executor/v1';

class FlutterExecutorPort extends AndroidExecutorPort {
  constructor(descriptor) { super(descriptor, { protocolVersion: protocol }); }
  forwardEndpoint() {
    if (!Number.isInteger(this.descriptor.port) || this.descriptor.port < 1 || this.descriptor.port > 65535)
      throw new CommandError('executor_forward_invalid', 'The Flutter test has not published a valid port.');
    return `tcp:${this.descriptor.port}`;
  }
  recordDirectory() { return `no_backup/ai-app-bridge-integration/${this.descriptor.sessionId}`; }
  async terminateClosedProcess() {
    if (await this.processEnded()) return;
    const { pid, bootId, processStartTicks, targetPackage } = this.descriptor;
    // Kill only the exact drained test process, even if the app has since restarted.
    const script = `if [ "$(cat /proc/sys/kernel/random/boot_id)" = ${quote(bootId)} ] && [ -f /proc/${pid}/stat ]; then
aab_stat=$(cat /proc/${pid}/stat) || exit 1
aab_fields=\${aab_stat##*) }
set -- $aab_fields
shift 19
if [ "$1" = ${quote(processStartTicks)} ]; then kill -TERM ${pid}; fi
fi`;
    await this.invoke(['shell', 'run-as', targetPackage, 'sh', '-c', quote(script)]);
  }
}

class FlutterExecutorHost extends AndroidExecutorHost {
  get kind() { return 'flutter-test-executor'; }
  createPort(descriptor) { return new FlutterExecutorPort(descriptor); }
  directory(sessionId) {
    const validated = super.directory(sessionId);
    return path.join(path.dirname(path.dirname(validated)), 'flutter', sessionId);
  }
  async finishClose(port) {
    await port.terminateClosedProcess();
    return port.processEnded();
  }
  async run(args) {
    if (args.operation === 'status') {
      const port = this.createPort({ adb: args.adb || process.env.ADB || 'adb', serial: args.serial });
      const bootId = await port.bootId();
      return { ok: true, serial: args.serial, bootId, engine: 'flutter-integration-test',
        prerequisite: 'Install the application debug build with integration_test/bridge_test.dart as its entrypoint. Add ai_app_bridge_test only to dev_dependencies. Opening restarts the application; closing terminates the drained test process.' };
    }
    return super.run(args);
  }
  async open(args) {
    const sessionId = randomUUID();
    const descriptor = { protocol, sessionId, serial: args.serial, packageName: args.packageName, targetPackage: args.packageName,
      adb: args.adb, token: randomBytes(32).toString('hex') };
    const file = path.join(this.directory(sessionId), 'session.json');
    const port = this.createPort(descriptor);
    descriptor.bootId = await port.bootId();
    atomicJson(file, descriptor);
    const pending = { kind: this.kind, protocol, operation: 'open', sessionId, runtimeEpoch: null,
      target: { serial: args.serial, packageName: args.packageName, adb: args.adb }, descriptorFile: file };
    return runDeviceEffect(pending, async () => {
      await require('./automation-owner').assertAvailable(args.serial);
      const launch = { sessionId, token: descriptor.token, packageName: args.packageName, leaseMs: args.leaseMs ?? 600000 };
      const prepare = `umask 077\nmkdir -p no_backup/ai-app-bridge-integration\nprintf '%s' ${quote(JSON.stringify(launch))} > no_backup/ai-app-bridge-integration/launch.json`;
      checkExecution(); markExecutionDispatched();
      await port.invoke(['shell', 'run-as', args.packageName, 'sh', '-c', quote(prepare)]);
      await port.invoke(['shell', 'am', 'start', '-S', '-W', '-n', `${args.packageName}/${args.activity}`], 30000);
      this.sessions.set(sessionId, port);
      while (true) {
        checkExecution();
        if (!descriptor.pid) {
          const starting = await port.readRecord('starting.json');
          if (starting) {
            Object.assign(descriptor, { runtimeEpoch: starting.runtimeEpoch, pid: starting.pid, processStartTicks: starting.processStartTicks });
            atomicJson(file, descriptor);
          }
        }
        const failed = await port.readRecord('failed.json');
        if (failed) {
          const closed = await port.readRecord('closed.json');
          if (closed?.settled && await this.finishClose(port)) return { ok: false, error: 'executor_initialization_failed', message: failed.error,
            sessionId, runtimeEpoch: descriptor.runtimeEpoch, dispatched: true, ambiguous: true, closed };
        }
        const session = await port.readRecord('session.json');
        if (session) {
          if (session.bootId !== descriptor.bootId || session.targetPackage !== args.packageName || session.capabilities?.engine !== 'flutter-integration-test')
            throw new CommandError('executor_engine_mismatch', 'The running Flutter test does not match the requested target.', { dispatched: true, ambiguous: true });
          Object.assign(descriptor, { runtimeEpoch: session.runtimeEpoch, pid: session.pid, processStartTicks: session.processStartTicks, port: session.port });
          atomicJson(file, descriptor);
          const status = await port.request({ operation: 'status', timeoutMs: 5000 });
          if (!status.ok || status.closing) throw new CommandError('executor_not_ready', 'The Flutter test did not become ready.', { dispatched: true, ambiguous: true });
          return { ...session, ok: true, serial: args.serial, packageName: args.packageName, lifecycle: 'test-entrypoint-application-restarted' };
        }
        await executionSleep(100);
      }
    }, result => settlement(result, pending));
  }
}

async function recoverFlutterExecutor(pending) {
  const descriptor = readJson(pending.descriptorFile);
  if (!descriptor || descriptor.sessionId !== pending.sessionId || descriptor.serial !== pending.target?.serial)
    return { settled: false, error: 'executor_descriptor_mismatch' };
  const port = new FlutterExecutorPort(descriptor);
  if (!await port.bootChanged()) {
    if (!descriptor.pid) {
      const starting = await port.readRecord('starting.json');
      if (starting) {
        Object.assign(descriptor, { runtimeEpoch: starting.runtimeEpoch, pid: starting.pid, processStartTicks: starting.processStartTicks });
        atomicJson(pending.descriptorFile, descriptor);
      }
    }
    const closed = await port.readRecord('closed.json');
    if (closed?.settled && descriptor.pid) await port.terminateClosedProcess();
  }
  return recoverAndroidExecutor(pending, value => new FlutterExecutorPort(value));
}
module.exports = { FlutterExecutorHost, FlutterExecutorPort, protocol, recoverFlutterExecutor };
