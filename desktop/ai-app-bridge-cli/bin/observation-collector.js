'use strict';

const { spawn: spawnProcess } = require('node:child_process');

const defaultDeviceLogBuffers = ['main', 'system', 'crash'];
const sensitiveDeviceLogBuffers = new Set(['radio', 'security', 'kernel']);
const allowedDeviceLogBuffers = new Set([...defaultDeviceLogBuffers, ...sensitiveDeviceLogBuffers]);

class ObservationCollector {
  constructor({
    rawRunner,
    recordEvidence,
    recordDeviceLog,
    spawn = spawnProcess,
    clock = Date.now,
    timers = globalThis,
    pollIntervalMs = 1_000,
    statusIntervalMs = 5_000,
    initialBackoffMs = 1_000,
    maxBackoffMs = 30_000,
    deviceLogFlushMs = 250,
    deviceLogBatchLines = 100,
    deviceLogBatchBytes = 64 * 1024,
    maxDeviceLogQueueLines = 2_000,
    maxDeviceLogQueueBytes = 1024 * 1024,
    maxDeviceLogPendingBatches = 8,
    deviceLogRestartMs = 1_000,
    maxDeviceLogRestartMs = 30_000,
    actionTimelineLimit = 64,
    actionTimelineTtlMs = 30_000,
    maxTargets = 32,
    inactiveTargetTtlMs = 30 * 60 * 1_000,
  } = {}) {
    if (typeof rawRunner !== 'function') throw new TypeError('rawRunner must be a function');
    if (typeof recordEvidence !== 'function') throw new TypeError('recordEvidence must be a function');
    if (typeof recordDeviceLog !== 'function') throw new TypeError('recordDeviceLog must be a function');
    if (typeof spawn !== 'function') throw new TypeError('spawn must be a function');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (!timers || typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') {
      throw new TypeError('timers must provide setTimeout and clearTimeout');
    }

    this.rawRunner = rawRunner;
    this.recordEvidence = recordEvidence;
    this.recordDeviceLog = recordDeviceLog;
    this.spawn = spawn;
    this.clock = clock;
    this.timers = timers;
    this.pollIntervalMs = positiveNumber(pollIntervalMs, 'pollIntervalMs');
    this.statusIntervalMs = positiveNumber(statusIntervalMs, 'statusIntervalMs');
    this.initialBackoffMs = positiveNumber(initialBackoffMs, 'initialBackoffMs');
    this.maxBackoffMs = positiveNumber(maxBackoffMs, 'maxBackoffMs');
    this.deviceLogFlushMs = positiveNumber(deviceLogFlushMs, 'deviceLogFlushMs');
    this.deviceLogBatchLines = positiveInteger(deviceLogBatchLines, 'deviceLogBatchLines');
    this.deviceLogBatchBytes = positiveInteger(deviceLogBatchBytes, 'deviceLogBatchBytes');
    this.maxDeviceLogQueueLines = positiveInteger(maxDeviceLogQueueLines, 'maxDeviceLogQueueLines');
    this.maxDeviceLogQueueBytes = positiveInteger(maxDeviceLogQueueBytes, 'maxDeviceLogQueueBytes');
    this.maxDeviceLogPendingBatches = positiveInteger(maxDeviceLogPendingBatches, 'maxDeviceLogPendingBatches');
    this.deviceLogRestartMs = positiveNumber(deviceLogRestartMs, 'deviceLogRestartMs');
    this.maxDeviceLogRestartMs = positiveNumber(maxDeviceLogRestartMs, 'maxDeviceLogRestartMs');
    this.actionTimelineLimit = positiveInteger(actionTimelineLimit, 'actionTimelineLimit');
    this.actionTimelineTtlMs = positiveNumber(actionTimelineTtlMs, 'actionTimelineTtlMs');
    this.maxTargets = positiveInteger(maxTargets, 'maxTargets');
    this.inactiveTargetTtlMs = positiveNumber(inactiveTargetTtlMs, 'inactiveTargetTtlMs');
    this.running = false;
    this.targets = new Map();
    this.deviceLogs = new Map();
    this.retiredDeviceLogDrains = new Set();
    this.targetEvictions = 0;
    this.targetExpirations = 0;
  }

  register(command, args = {}) {
    const target = observationTargetFor(command, args);
    if (!target) {
      return { registered: false, ignored: true, reason: 'observable_target_required' };
    }
    const now = this.clock();
    this.pruneInactiveTargets(now);
    const existing = this.targets.get(target.key);
    if (existing) {
      existing.args = { ...existing.args, ...target.args };
      if (target.deviceLogScope === 'device') {
        existing.deviceLogScope = 'device';
        existing.deviceLogBuffers = orderedDeviceLogBuffers([
          ...existing.deviceLogBuffers,
          ...target.deviceLogBuffers,
        ]);
      }
      existing.lastRegisteredAtMs = now;
      existing.updatedAtMs = now;
      this.registerDeviceLogTarget(existing);
      return { registered: false, target: publicTarget(existing) };
    }

    while (this.targets.size >= this.maxTargets) {
      const leastRecentlyUsed = [...this.targets.values()].sort(compareTargetActivity)[0];
      if (!leastRecentlyUsed || !this.removeTarget(leastRecentlyUsed, 'evicted')) break;
    }
    const state = {
      ...target,
      registeredAtMs: now,
      lastRegisteredAtMs: now,
      updatedAtMs: now,
      lastStatusAtMs: null,
      lastPollAtMs: null,
      lastSuccessAtMs: null,
      nextPollAtMs: null,
      runtimeEpoch: null,
      generationChanges: 0,
      failureCount: 0,
      lastError: null,
      lastActionId: null,
      lastActionAtMs: null,
      actionTimeline: [],
      pollTimer: null,
      expiryTimer: null,
      polling: false,
    };
    this.targets.set(state.key, state);
    this.registerDeviceLogTarget(state);
    if (this.running) this.startTarget(state);
    return { registered: true, target: publicTarget(state) };
  }

  noteAction(target, actionId, timings = {}) {
    const key = targetKeyValue(target);
    const state = key ? this.targets.get(key) : null;
    if (!state) return false;
    const now = this.clock();
    const normalizedActionId = actionId === undefined || actionId === null ? null : String(actionId);
    state.lastActionId = normalizedActionId;
    state.lastActionAtMs = now;
    state.lastRegisteredAtMs = now;
    state.updatedAtMs = now;
    if (normalizedActionId === null) return true;

    let action = state.actionTimeline.find((candidate) => candidate.actionId === normalizedActionId);
    if (!action) {
      action = {
        actionId: normalizedActionId,
        requestedAtMs: null,
        startedAtMs: null,
        completedAtMs: null,
        touchedAtMs: now,
      };
      state.actionTimeline.push(action);
    }
    for (const field of ['requestedAtMs', 'startedAtMs', 'completedAtMs']) {
      const value = optionalTimestamp(timings?.[field]);
      if (value !== null) action[field] = value;
    }
    if (
      action.requestedAtMs === null
      && action.startedAtMs === null
      && action.completedAtMs === null
    ) {
      action.requestedAtMs = now;
    }
    action.touchedAtMs = now;
    this.pruneActionTimeline(state, now);
    return true;
  }

  start() {
    if (this.running) return this.status();
    this.running = true;
    for (const target of this.targets.values()) {
      this.startTarget(target);
    }
    return this.status();
  }

  async stop() {
    this.running = false;
    for (const target of this.targets.values()) {
      if (target.pollTimer !== null) this.timers.clearTimeout(target.pollTimer);
      if (target.expiryTimer !== null) this.timers.clearTimeout(target.expiryTimer);
      target.pollTimer = null;
      target.expiryTimer = null;
      target.nextPollAtMs = null;
    }
    for (const deviceLog of this.deviceLogs.values()) {
      if (deviceLog.flushTimer !== null) this.timers.clearTimeout(deviceLog.flushTimer);
      if (deviceLog.restartTimer !== null) this.timers.clearTimeout(deviceLog.restartTimer);
      deviceLog.flushTimer = null;
      deviceLog.restartTimer = null;
      if (deviceLog.partialLine) {
        this.enqueueDeviceLogLine(deviceLog, deviceLog.partialLine);
        deviceLog.partialLine = '';
      }
      while (deviceLog.lines.length > 0) this.flushDeviceLog(deviceLog, false);
      if (deviceLog.child && typeof deviceLog.child.kill === 'function') deviceLog.child.kill();
      deviceLog.child = null;
    }
    await Promise.allSettled([
      ...[...this.deviceLogs.values()].map((deviceLog) => deviceLog.drainPromise).filter(Boolean),
      ...this.retiredDeviceLogDrains,
    ]);
    return this.status();
  }

  status() {
    return {
      running: this.running,
      targetCount: this.targets.size,
      maxTargets: this.maxTargets,
      inactiveTargetTtlMs: this.inactiveTargetTtlMs,
      targetEvictions: this.targetEvictions,
      targetExpirations: this.targetExpirations,
      targets: [...this.targets.values()].map((target) => {
        const actionTimeline = this.actionTimelineSnapshot(target);
        return {
          ...publicTarget(target),
          ...(target.kind === 'android' ? { deviceLog: this.targetDeviceLogStatus(target) } : {}),
          runtimeEpoch: target.runtimeEpoch,
          failureCount: target.failureCount,
          lastError: target.lastError,
          lastActionId: target.lastActionId,
          actionTimeline,
          backgroundPolling: target.kind !== 'android',
          expiresAtMs: target.lastRegisteredAtMs + this.inactiveTargetTtlMs,
          lastPollAtMs: target.lastPollAtMs,
          lastSuccessAtMs: target.lastSuccessAtMs,
          nextPollAtMs: target.nextPollAtMs,
          generationChanges: target.generationChanges,
        };
      }),
      deviceLogs: [...this.deviceLogs.values()].map((deviceLog) => ({
        serial: deviceLog.serial,
        buffers: [...deviceLog.buffers],
        running: Boolean(deviceLog.child),
        targetKeys: [...deviceLog.targetKeys],
        queuedLines: deviceLog.lines.length,
        queuedBytes: deviceLog.queuedBytes,
        partialBytes: Buffer.byteLength(deviceLog.partialLine, 'utf8'),
        pendingBatches: deviceLog.pendingBatches.length,
        droppedLines: deviceLog.droppedLines,
        droppedBytes: deviceLog.droppedBytes,
        droppedBatches: deviceLog.droppedBatches,
        restartFailures: deviceLog.restartFailures,
        nextRestartAtMs: deviceLog.nextRestartAtMs,
        lastError: deviceLog.lastError,
      })),
      dropped: {
        deviceLogLines: sumDeviceLogMetric(this.deviceLogs, 'droppedLines'),
        deviceLogBytes: sumDeviceLogMetric(this.deviceLogs, 'droppedBytes'),
        deviceLogBatches: sumDeviceLogMetric(this.deviceLogs, 'droppedBatches'),
      },
    };
  }

  targetDeviceLogStatus(target) {
    if (target.deviceLogScope !== 'device') {
      return { enabled: false, reason: 'device_scope_opt_in_required' };
    }
    if (!target.serial) return { enabled: false, reason: 'serial_required' };
    const deviceLog = this.deviceLogs.get(target.serial);
    if (!deviceLog) return { enabled: false, reason: 'not_registered' };
    return {
      enabled: true,
      running: Boolean(deviceLog.child),
      serial: target.serial,
      buffers: [...deviceLog.buffers],
    };
  }

  startTarget(target) {
    if (target.kind === 'android') {
      // Android evidence is read explicitly. An unsolicited SDK connection can
      // block ADB while a background app is being launched; TTL needs no I/O.
      this.scheduleTargetExpiry(target);
    } else {
      this.schedulePoll(target, 0);
    }
    this.startDeviceLogForTarget(target);
  }

  scheduleTargetExpiry(target) {
    if (!this.running || target.expiryTimer !== null || this.targets.get(target.key) !== target) return;
    const delayMs = Math.max(0, target.lastRegisteredAtMs + this.inactiveTargetTtlMs - this.clock());
    target.expiryTimer = this.timers.setTimeout(() => {
      target.expiryTimer = null;
      if (!this.running || this.targets.get(target.key) !== target) return;
      if (this.targetExpired(target)) this.removeTarget(target, 'expired');
      else this.scheduleTargetExpiry(target);
    }, delayMs);
  }

  schedulePoll(target, delayMs) {
    if (
      !this.running
      || target.pollTimer !== null
      || this.targets.get(target.key) !== target
    ) return;
    target.nextPollAtMs = this.clock() + delayMs;
    target.pollTimer = this.timers.setTimeout(() => {
      target.pollTimer = null;
      target.nextPollAtMs = null;
      void this.pollTarget(target);
    }, delayMs);
  }

  async pollTarget(target) {
    if (!this.running || target.polling || this.targets.get(target.key) !== target) return;
    if (this.targetExpired(target, this.clock())) {
      this.removeTarget(target, 'expired');
      return;
    }
    target.polling = true;
    target.lastPollAtMs = this.clock();
    try {
      if (target.lastStatusAtMs === null || this.clock() - target.lastStatusAtMs >= this.statusIntervalMs) {
        await this.pullStatus(target);
      }
      target.failureCount = 0;
      target.lastError = null;
      target.lastSuccessAtMs = this.clock();
      target.updatedAtMs = this.clock();
      this.schedulePoll(target, this.pollIntervalMs);
    } catch (error) {
      target.failureCount += 1;
      target.lastError = firstErrorLine(error);
      target.updatedAtMs = this.clock();
      const delayMs = Math.min(
        this.maxBackoffMs,
        this.initialBackoffMs * (2 ** Math.max(0, target.failureCount - 1)),
      );
      this.schedulePoll(target, delayMs);
    } finally {
      target.polling = false;
    }
  }

  async pullStatus(target) {
    const command = commandFor(target.kind, 'status');
    const result = await this.rawRunner(command, { ...target.args });
    assertSuccessfulResult(command, result);
    const runtimeEpoch = runtimeEpochFor(target.kind, result);
    const changed = target.runtimeEpoch !== null
      && runtimeEpoch !== null
      && target.runtimeEpoch !== runtimeEpoch;
    if (changed) {
      target.generationChanges += 1;
    }
    if (runtimeEpoch !== null) target.runtimeEpoch = runtimeEpoch;
    target.lastStatusAtMs = this.clock();
    await this.recordEvidence(command, { ...target.args }, result, this.evidenceContext(target, {
      generationChanged: changed,
      sinceId: null,
    }));
  }

  evidenceContext(target, extra = {}) {
    const observedAtMs = this.clock();
    return {
      collector: 'observation',
      target: publicTarget(target),
      targetKey: target.key,
      runtimeEpoch: target.runtimeEpoch,
      actionId: target.lastActionId,
      actionTimeline: this.actionTimelineSnapshot(target, observedAtMs),
      observedAtMs,
      ingestedAtMs: observedAtMs,
      ...extra,
    };
  }

  pruneActionTimeline(target, now = this.clock()) {
    const oldestAllowedAtMs = now - this.actionTimelineTtlMs;
    target.actionTimeline = target.actionTimeline.filter((action) => action.touchedAtMs >= oldestAllowedAtMs);
    if (target.actionTimeline.length > this.actionTimelineLimit) {
      target.actionTimeline.splice(0, target.actionTimeline.length - this.actionTimelineLimit);
    }
    if (
      target.lastActionId !== null
      && !target.actionTimeline.some((action) => action.actionId === target.lastActionId)
    ) {
      target.lastActionId = null;
      target.lastActionAtMs = null;
    }
  }

  actionTimelineSnapshot(target, now = this.clock()) {
    this.pruneActionTimeline(target, now);
    return target.actionTimeline.map(publicActionTiming);
  }

  actionTimelineForTargets(targetKeys, now = this.clock()) {
    return targetKeys.flatMap((key) => {
      const target = this.targets.get(key);
      return target ? this.actionTimelineSnapshot(target, now) : [];
    });
  }

  targetExpired(target, now = this.clock()) {
    return now - target.lastRegisteredAtMs >= this.inactiveTargetTtlMs;
  }

  pruneInactiveTargets(now = this.clock()) {
    for (const target of [...this.targets.values()]) {
      if (this.targetExpired(target, now)) this.removeTarget(target, 'expired');
    }
  }

  removeTarget(targetOrKey, reason) {
    const target = typeof targetOrKey === 'string'
      ? this.targets.get(targetOrKey)
      : targetOrKey;
    if (!target || this.targets.get(target.key) !== target) return false;
    if (target.pollTimer !== null) this.timers.clearTimeout(target.pollTimer);
    if (target.expiryTimer !== null) this.timers.clearTimeout(target.expiryTimer);
    target.pollTimer = null;
    target.expiryTimer = null;
    target.nextPollAtMs = null;
    this.targets.delete(target.key);
    if (reason === 'evicted') this.targetEvictions += 1;
    if (reason === 'expired') this.targetExpirations += 1;
    if (target.kind === 'android' && target.serial) {
      const deviceLog = this.deviceLogs.get(target.serial);
      if (deviceLog) {
        deviceLog.targetKeys.delete(target.key);
        if (deviceLog.targetKeys.size === 0) this.retireDeviceLog(deviceLog);
      }
    }
    return true;
  }

  retireDeviceLog(deviceLog) {
    if (deviceLog.flushTimer !== null) this.timers.clearTimeout(deviceLog.flushTimer);
    if (deviceLog.restartTimer !== null) this.timers.clearTimeout(deviceLog.restartTimer);
    deviceLog.flushTimer = null;
    deviceLog.restartTimer = null;
    deviceLog.nextRestartAtMs = null;
    if (deviceLog.partialLine) {
      this.enqueueDeviceLogLine(deviceLog, deviceLog.partialLine);
      deviceLog.partialLine = '';
    }
    while (deviceLog.lines.length > 0) this.flushDeviceLog(deviceLog, false);
    const drainPromise = deviceLog.drainPromise;
    if (drainPromise) {
      this.retiredDeviceLogDrains.add(drainPromise);
      void drainPromise.then(
        () => this.retiredDeviceLogDrains.delete(drainPromise),
        () => this.retiredDeviceLogDrains.delete(drainPromise),
      );
    }
    const child = deviceLog.child;
    deviceLog.child = null;
    if (child && typeof child.kill === 'function') child.kill();
    this.deviceLogs.delete(deviceLog.serial);
  }

  registerDeviceLogTarget(target) {
    if (target.kind !== 'android' || target.deviceLogScope !== 'device' || !target.serial) return;
    let deviceLog = this.deviceLogs.get(target.serial);
    if (!deviceLog) {
      deviceLog = {
        serial: target.serial,
        adbPath: target.args.adbPath || target.args.adb || 'adb',
        buffers: [...defaultDeviceLogBuffers],
        targetKeys: new Set(),
        child: null,
        partialLine: '',
        lines: [],
        queuedBytes: 0,
        pendingBatches: [],
        drainPromise: null,
        flushTimer: null,
        restartTimer: null,
        restartFailures: 0,
        nextRestartAtMs: null,
        droppedLines: 0,
        droppedBytes: 0,
        droppedBatches: 0,
        lastError: null,
      };
      this.deviceLogs.set(target.serial, deviceLog);
    }
    const previousBuffers = deviceLog.buffers.join(',');
    deviceLog.targetKeys.add(target.key);
    deviceLog.buffers = orderedDeviceLogBuffers([
      ...deviceLog.buffers,
      ...target.deviceLogBuffers,
    ]);
    if (
      this.running
      && deviceLog.child
      && previousBuffers !== deviceLog.buffers.join(',')
    ) {
      const previousChild = deviceLog.child;
      deviceLog.child = null;
      if (typeof previousChild.kill === 'function') previousChild.kill();
      deviceLog.restartFailures = 0;
      this.startDeviceLogForTarget(target);
    }
  }

  startDeviceLogForTarget(target) {
    if (target.kind !== 'android' || target.deviceLogScope !== 'device' || !target.serial) return;
    const deviceLog = this.deviceLogs.get(target.serial);
    if (!deviceLog || deviceLog.child) return;
    const args = [
      '-s', deviceLog.serial,
      'logcat', '-v', 'epoch',
      // Follow from the current tail instead of replaying the device's entire
      // historical ring buffer into the persistent fact cache.
      '-T', '1',
      ...deviceLog.buffers.flatMap((buffer) => ['-b', buffer]),
    ];
    let child;
    try {
      child = this.spawn(deviceLog.adbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      deviceLog.lastError = firstErrorLine(error);
      this.scheduleDeviceLogRestart(deviceLog);
      return;
    }
    if (!child || !child.stdout || typeof child.stdout.on !== 'function') {
      deviceLog.lastError = 'logcat spawn returned no readable stdout';
      this.scheduleDeviceLogRestart(deviceLog);
      return;
    }
    deviceLog.child = child;
    deviceLog.nextRestartAtMs = null;
    deviceLog.lastError = null;
    if (typeof child.stdout.setEncoding === 'function') child.stdout.setEncoding('utf8');
    if (child.stderr && typeof child.stderr.setEncoding === 'function') child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.acceptDeviceLogChunk(deviceLog, chunk));
    child.stderr?.on?.('data', (chunk) => {
      const line = String(chunk || '').trim();
      if (line) deviceLog.lastError = line.slice(0, 500);
    });
    child.on?.('error', (error) => {
      deviceLog.lastError = firstErrorLine(error);
    });
    child.on?.('exit', (code, signal) => {
      if (deviceLog.child !== child) return;
      deviceLog.child = null;
      if (!this.running) return;
      deviceLog.lastError = `logcat exited (${code ?? 'null'}, ${signal || 'no signal'})`;
      this.scheduleDeviceLogRestart(deviceLog);
    });
  }

  scheduleDeviceLogRestart(deviceLog) {
    if (!this.running || deviceLog.restartTimer !== null) return;
    deviceLog.restartFailures += 1;
    const delayMs = Math.min(
      this.maxDeviceLogRestartMs,
      this.deviceLogRestartMs * (2 ** Math.max(0, deviceLog.restartFailures - 1)),
    );
    deviceLog.nextRestartAtMs = this.clock() + delayMs;
    deviceLog.restartTimer = this.timers.setTimeout(() => {
      deviceLog.restartTimer = null;
      deviceLog.nextRestartAtMs = null;
      const target = [...deviceLog.targetKeys]
        .map((key) => this.targets.get(key))
        .find(Boolean);
      if (target) this.startDeviceLogForTarget(target);
    }, delayMs);
  }

  acceptDeviceLogChunk(deviceLog, chunk) {
    if (!this.running) return;
    deviceLog.restartFailures = 0;
    const text = deviceLog.partialLine + String(chunk || '');
    const parts = text.split(/\r?\n/);
    deviceLog.partialLine = parts.pop() || '';
    const partialBytes = Buffer.byteLength(deviceLog.partialLine, 'utf8');
    if (partialBytes > this.deviceLogBatchBytes) {
      const bounded = utf8Tail(deviceLog.partialLine, this.deviceLogBatchBytes);
      deviceLog.droppedBytes += partialBytes - Buffer.byteLength(bounded, 'utf8');
      deviceLog.partialLine = bounded;
    }
    for (const line of parts) {
      if (line) this.enqueueDeviceLogLine(deviceLog, line);
    }
    if (deviceLog.lines.length >= this.deviceLogBatchLines || deviceLog.queuedBytes >= this.deviceLogBatchBytes) {
      this.flushDeviceLog(deviceLog);
    } else if (deviceLog.lines.length > 0 && deviceLog.flushTimer === null) {
      deviceLog.flushTimer = this.timers.setTimeout(() => {
        deviceLog.flushTimer = null;
        this.flushDeviceLog(deviceLog);
      }, this.deviceLogFlushMs);
    }
  }

  enqueueDeviceLogLine(deviceLog, line) {
    const entry = { text: line, bytes: Buffer.byteLength(line, 'utf8') + 1 };
    deviceLog.lines.push(entry);
    deviceLog.queuedBytes += entry.bytes;
    while (
      deviceLog.lines.length > this.maxDeviceLogQueueLines
      || deviceLog.queuedBytes > this.maxDeviceLogQueueBytes
    ) {
      const dropped = deviceLog.lines.shift();
      if (!dropped) break;
      deviceLog.queuedBytes -= dropped.bytes;
      deviceLog.droppedLines += 1;
      deviceLog.droppedBytes += dropped.bytes;
    }
  }

  flushDeviceLog(deviceLog, scheduleRemaining = true) {
    if (deviceLog.flushTimer !== null) {
      this.timers.clearTimeout(deviceLog.flushTimer);
      deviceLog.flushTimer = null;
    }
    if (deviceLog.lines.length === 0) return;
    const lines = [];
    let bytes = 0;
    while (deviceLog.lines.length > 0 && lines.length < this.deviceLogBatchLines) {
      const next = deviceLog.lines[0];
      if (lines.length > 0 && bytes + next.bytes > this.deviceLogBatchBytes) break;
      deviceLog.lines.shift();
      deviceLog.queuedBytes -= next.bytes;
      lines.push(next.text);
      bytes += next.bytes;
    }
    if (deviceLog.pendingBatches.length >= this.maxDeviceLogPendingBatches) {
      deviceLog.droppedBatches += 1;
      deviceLog.droppedLines += lines.length;
      deviceLog.droppedBytes += bytes;
    } else {
      deviceLog.pendingBatches.push({ lines, bytes });
      this.drainDeviceLog(deviceLog);
    }
    if (scheduleRemaining && deviceLog.lines.length > 0 && deviceLog.flushTimer === null) {
      deviceLog.flushTimer = this.timers.setTimeout(() => {
        deviceLog.flushTimer = null;
        this.flushDeviceLog(deviceLog);
      }, 0);
    }
  }

  drainDeviceLog(deviceLog) {
    if (deviceLog.drainPromise) return;
    deviceLog.drainPromise = (async () => {
      while (deviceLog.pendingBatches.length > 0) {
        const batch = deviceLog.pendingBatches.shift();
        const targetKeys = [...deviceLog.targetKeys];
        const observedAtMs = this.clock();
        const actionTimeline = this.actionTimelineForTargets(targetKeys, observedAtMs);
        const actionId = latestActionIdFromTimeline(actionTimeline);
        const buffers = [...deviceLog.buffers];
        try {
          await this.recordDeviceLog({
            serial: deviceLog.serial,
            deviceLogScope: 'device',
            buffers,
          }, {
            lines: batch.lines,
            count: batch.lines.length,
            byteCount: batch.bytes,
            observedAtMs,
            buffers,
            dropped: deviceLog.droppedLines,
          }, {
            collector: 'observation',
            provider: 'android',
            serial: deviceLog.serial,
            targetKeys,
            actionId,
            actionTimeline,
            runtimeEpoch: latestRuntimeEpoch(targetKeys, this.targets),
            lineCount: batch.lines.length,
            byteCount: batch.bytes,
            observedAtMs,
            ingestedAtMs: this.clock(),
            droppedLines: deviceLog.droppedLines,
            droppedBytes: deviceLog.droppedBytes,
            droppedBatches: deviceLog.droppedBatches,
          });
        } catch (error) {
          deviceLog.lastError = firstErrorLine(error);
        }
      }
    })().finally(() => {
      deviceLog.drainPromise = null;
      if (deviceLog.pendingBatches.length > 0) this.drainDeviceLog(deviceLog);
    });
  }
}

function observationTargetFor(command, args = {}) {
  const name = String(command || '');
  if (name.startsWith('ios-')) {
    const deviceId = stringPart(args.deviceId);
    const bundleId = stringPart(args.bundleId);
    // A device id alone identifies hardware, not an observable app runtime.
    if (!bundleId && !args.runtimeUrl) return null;
    return {
      kind: 'ios',
      key: identityKey('ios', deviceId, bundleId),
      args: pickDefined(args, ['deviceId', 'bundleId', 'iosHost', 'iosPort', 'runtimeUrl']),
      deviceId,
      bundleId,
    };
  }
  if (name.startsWith('web-')) {
    // Web ingress commits authoritative facts before its SDK acknowledgement.
    // Pulling those facts into a second observer would duplicate evidence and
    // infer action ownership from whichever command happened to run last.
    return null;
  }
  const packageName = stringPart(args.packageName);
  if (!packageName) return null;
  const serial = stringPart(args.serial);
  return {
    kind: 'android',
    key: identityKey('android', serial, packageName),
    args: pickDefined(args, ['serial', 'packageName', 'port', 'adb', 'adbPath']),
    serial,
    packageName,
    deviceLogScope: normalizeDeviceLogScope(args.deviceLogScope),
    deviceLogBuffers: normalizeDeviceLogBuffers(args.deviceLogBuffers),
  };
}

function publicTarget(target) {
  const base = { kind: target.kind, key: target.key };
  if (target.kind === 'android') return { ...base, serial: target.serial, packageName: target.packageName };
  return { ...base, deviceId: target.deviceId, bundleId: target.bundleId };
}

function targetKeyValue(target) {
  if (typeof target === 'string') return target;
  return target && typeof target === 'object' ? target.key : null;
}

function commandFor(kind, stream) {
  if (kind === 'android') return stream;
  return `${kind}-${stream}`;
}

function runtimeEpochFor(kind, result) {
  const value = result?.debugBridge?.runtimeEpoch;
  return value === undefined || value === null || value === '' ? null : String(value);
}

function assertSuccessfulResult(command, result) {
  if (result && typeof result === 'object' && result.ok === false) {
    throw new Error(`${command}: ${result.error || result.message || 'failed'}`);
  }
}

function identityKey(kind, first, second) {
  return `${kind}:${JSON.stringify([first, second])}`;
}

function stringPart(value) {
  return value === undefined || value === null ? '' : String(value);
}

function pickDefined(source, keys) {
  const result = {};
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== '') result[key] = source[key];
  }
  return result;
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${name} must be a positive number`);
  return number;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive integer`);
  return number;
}

function optionalTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function publicActionTiming(action) {
  return {
    actionId: action.actionId,
    requestedAtMs: action.requestedAtMs,
    startedAtMs: action.startedAtMs,
    completedAtMs: action.completedAtMs,
  };
}

function compareTargetActivity(left, right) {
  return left.lastRegisteredAtMs - right.lastRegisteredAtMs
    || left.registeredAtMs - right.registeredAtMs
    || left.key.localeCompare(right.key);
}

function firstErrorLine(error) {
  return String(error?.message || error || 'unknown error').split(/\r?\n/, 1)[0];
}

function normalizeDeviceLogBuffers(value) {
  const requested = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  return orderedDeviceLogBuffers([
    ...defaultDeviceLogBuffers,
    ...requested.map((entry) => String(entry).trim()).filter(Boolean),
  ]);
}

function normalizeDeviceLogScope(value) {
  return String(value || '').trim().toLowerCase() === 'device' ? 'device' : null;
}

function orderedDeviceLogBuffers(values) {
  const unique = new Set(values.filter((value) => allowedDeviceLogBuffers.has(value)));
  return [...defaultDeviceLogBuffers, ...['radio', 'security', 'kernel']]
    .filter((value) => unique.has(value));
}

function latestActionIdFromTimeline(actionTimeline) {
  let selected = null;
  let selectedAtMs = Number.NEGATIVE_INFINITY;
  for (const action of actionTimeline) {
    const atMs = action.completedAtMs ?? action.startedAtMs ?? action.requestedAtMs;
    if (atMs === null || atMs < selectedAtMs) continue;
    selected = action.actionId;
    selectedAtMs = atMs;
  }
  return selected;
}

function latestRuntimeEpoch(targetKeys, targets) {
  let selected = null;
  let selectedAtMs = Number.NEGATIVE_INFINITY;
  for (const key of targetKeys) {
    const target = targets.get(key);
    if (!target || target.runtimeEpoch === null || target.lastSuccessAtMs < selectedAtMs) continue;
    selected = target.runtimeEpoch;
    selectedAtMs = target.lastSuccessAtMs;
  }
  return selected;
}

function sumDeviceLogMetric(deviceLogs, name) {
  let total = 0;
  for (const deviceLog of deviceLogs.values()) total += deviceLog[name];
  return total;
}

function utf8Tail(value, maxBytes) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xC0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

module.exports = {
  ObservationCollector,
  observationTargetFor,
};
