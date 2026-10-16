'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { openChildChannel } = require('./child-channel');
const execute = promisify(execFile);
const failure = (code, message, details) => Object.assign(new Error(message), { code, details });
const capabilities = Object.freeze({
  darwin: { supportedModes: ['system', 'display', 'both'], mechanism: 'caffeinate', scope: 'host-idle', manualSleep: 'not_prevented', unlock: false, expiryResolutionMs: 1000 },
  win32: { supportedModes: ['system', 'display', 'both'], mechanism: 'SetThreadExecutionState', scope: 'host-idle', manualSleep: 'not_prevented', unlock: false, screenSaver: 'not_prevented' },
  android: { supportedModes: ['system', 'display', 'both'], mechanism: 'shell-owned-PowerManager-WakeLock', scope: 'selected-device', manualSleep: 'not_prevented', unlock: false, settingsChanged: false },
  ios: { supportedModes: ['display'], mechanism: 'UIApplication.isIdleTimerDisabled', scope: 'selected-sdk-app-foreground', system: false, externalApps: false, manualSleep: 'not_prevented', unlock: false },
});

function createPlatformAdapter({ platform = process.platform, spawnChild = spawn, run = execute, iosRequest } = {}) {
  return async options => {
    const { target, mode } = options;
    const name = target.platform === 'host' ? platform : target.platform;
    const capability = capabilities[name];
    if (!capability || !capability.supportedModes.includes(mode)) throw failure('power_mode_unsupported',
      'The selected platform does not support this power mode.', { target, mode, capability });
    if (name === 'darwin') return macAssertion(options, { spawnChild, run });
    if (name === 'win32') {
      const channel = await openChildChannel('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        fs.readFileSync(path.join(__dirname, 'windows.ps1'), 'utf8')], {
        spawnChild, env: { ...process.env, AAB_POWER_LEASE_ID: options.leaseId, AAB_POWER_MODE: mode, AAB_POWER_TTL_MS: String(options.ttlMs) },
      });
      return channelAdapter(channel);
    }
    if (name === 'android') return androidAssertion(options, { spawnChild, run });
    if (!iosRequest) throw failure('power_ios_transport_required', 'The iOS power adapter requires the existing bound SDK transport.');
    for (const key of ['deviceId', 'bundleId']) if (typeof target[key] !== 'string' || !target[key])
      throw failure('invalid_power_target', `The iOS power target requires ${key}.`);
    const post = async body => {
      const result = await iosRequest(target, body);
      if (result.ok !== true) throw failure(result.error || 'power_ios_failed', result.message || 'The iOS SDK rejected the power lease.', result);
      return result;
    };
    const first = await post({ operation: 'acquire', leaseId: options.leaseId, mode, ttlMs: options.ttlMs });
    return { coverage: first.coverage,
      async renew({ ttlMs }) { return post({ operation: 'renew', leaseId: options.leaseId, ttlMs }); },
      async release() { return post({ operation: 'release', leaseId: options.leaseId }); },
    };
  };
}

function channelAdapter(channel, { remoteProcess = false } = {}) {
  return { coverage: channel.initial.coverage,
    ended: channel.exit.then(result => result.error),
    renew: ({ ttlMs }) => channel.request('renew', { ttlMs }),
    async release() {
      const result = await channel.release();
      if (remoteProcess && result.reason === 'worker_exited' && result.confirmed === false)
        return { released: false, reason: 'transport_closed_without_device_confirmation', boundedByPlatformExpiry: true };
      return result;
    } };
}

async function macAssertion({ mode, ttlMs }, { spawnChild, run }) {
  const flags = mode === 'both' ? '-di' : mode === 'display' ? '-d' : '-i';
  const coverage = { ...capabilities.darwin, system: mode !== 'display', display: mode !== 'system' };
  let current = null, released = false;
  async function start(ttlMs) {
    // Both native expiry and parent-process lifetime bound this assertion.
    const child = spawnChild('/usr/bin/caffeinate', [flags, '-w', String(process.pid), '-t', String(Math.max(1, Math.ceil(ttlMs / 1000)))],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4096); });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const deadline = Date.now() + 3000;
    try {
      while (true) {
        // A synchronous command can delay this poll beyond the deadline while
        // the OS assertion is already active. Confirm one fresh sample before
        // declaring failure; a pre-deadline sample cannot prove current absence.
        const finalProbe = Date.now() >= deadline;
        const { stdout } = await run('/usr/bin/pmset', ['-g', 'assertions'], { timeout: 2000, maxBuffer: 1024 * 1024 });
        const owned = stdout.split('\n').filter(line => line.includes(`pid ${child.pid}(caffeinate):`));
        if ((mode === 'display' || owned.some(line => line.includes('PreventUserIdleSystemSleep')))
          && (mode === 'system' || owned.some(line => line.includes('PreventUserIdleDisplaySleep')))) return child;
        if (child.exitCode !== null) throw failure('power_assertion_failed', 'caffeinate exited before confirming its assertion.', { stderr });
        if (finalProbe) throw failure('power_assertion_unconfirmed', 'pmset did not confirm the requested assertions for this caffeinate process.', { pid: child.pid, stderr });
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } catch (error) { child.kill(); throw error; }
  }
  async function stop(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise(resolve => child.once('close', resolve));
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    child.kill('SIGTERM');
    try { await closed; } finally { clearTimeout(timer); }
  }
  current = await start(ttlMs);
  return { coverage: { ...coverage, pid: current.pid },
    async renew({ ttlMs }) {
      if (released) throw failure('power_lease_ended', 'The macOS assertion has been released.');
      if (current.exitCode !== null || current.signalCode !== null)
        throw failure('power_assertion_lost', 'The macOS assertion expired or closed before renewal. Acquire a new work lease.');
      const replacement = await start(ttlMs), previous = current; current = replacement; await stop(previous);
      return { coverage: { ...coverage, pid: current.pid } };
    },
    async release() { released = true; await stop(current); return { released: true }; },
  };
}

async function androidAssertion({ target, leaseId, mode, ttlMs }, { spawnChild, run }) {
  if (typeof target.serial !== 'string' || !target.serial || target.serial.length > 256)
    throw failure('invalid_power_target', 'An explicit Android serial is required.');
  const adb = target.adb || process.env.ADB || 'adb';
  const file = path.join(__dirname, 'android', 'power-lease.jar');
  if (!fs.existsSync(file)) throw failure('power_android_helper_missing', 'The installed package does not contain the Android power helper.');
  const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const remote = `/data/local/tmp/aab-power-${digest}.jar`;
  // Content-addressed code is shared; each process owns only its own Binder locks.
  // A transport that ignores SIGTERM must not hold acquisition and Host
  // shutdown open after the upload deadline. Only this owned process is killed.
  await run(adb, ['-s', target.serial, 'push', file, remote], { timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  const channel = await openChildChannel(adb, ['-s', target.serial, 'shell', `CLASSPATH=${remote}`, 'app_process', '/system/bin',
    'io.github.mobileaidev.aiappbridge.power.PowerLease', leaseId, mode, String(ttlMs)], { spawnChild });
  return channelAdapter(channel, { remoteProcess: true });
}

module.exports = { createPlatformAdapter, capabilities };
