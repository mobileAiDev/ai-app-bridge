'use strict';

// Each UI action goes through the published executor. This is a real JS Script,
// not a wrapper that launches a fixed test method and calls that Python support.
module.exports.main = async function main(ctx) {
  const fs = require('node:fs');
  const { plan, output, runId } = ctx.inputs;
  const steps = JSON.parse(JSON.stringify(plan.steps).replaceAll('@RUN@', runId));
  const result = { language: 'javascript', planVersion: plan.version, runId,
    ok: false, startedAtMs: Date.now(), steps: [], phases: [], actions: 0, assertions: 0 };
  let identity, currentPhase;
  const save = () => fs.writeFileSync(output, JSON.stringify(result, null, 2));
  const call = async args => {
    const r = await ctx.call('android-executor', { feedback: 'off', ...args });
    if (!r.ok || r.result.ok === false) throw new Error(JSON.stringify(r));
    return r.result;
  };
  const observe = async engine => (await call({ ...identity, operation: 'observe', engine })).observation;
  function matches(node, selector, observation) {
    for (const [key, value] of Object.entries(selector)) {
      if (key === 'within') {
        const parents = observation.nodes.filter(n => matches(n, value, observation));
        if (parents.length !== 1) return false;
        let p = node;
        while (p && p.nodeId !== parents[0].nodeId) p = observation.nodes.find(n => n.nodeId === p.parentId);
        if (!p) return false;
      } else if (key === 'id') {
        if (node.resourceId !== (value.includes(':') ? value : ctx.inputs.target.packageName + ':id/' + value)) return false;
      } else if (key === 'classSuffix') {
        if (!node.className?.endsWith(value)) return false;
      } else if (key === 'textContains') {
        if (typeof node.text !== 'string' || !node.text.includes(value)) return false;
      } else if (node[key] !== value) return false;
    }
    return true;
  }
  function selected(o, selector) { return o.nodes.filter(n => matches(n, selector, o)); }
  async function act(o, type, node, fields, index) {
    const r = await call({ ...identity, operation: 'act', snapshotId: o.snapshotId,
      actionId: runId + '-' + index + '-' + result.actions,
      action: { type, ...(node ? { nodeId: node.nodeId } : {}), ...fields } });
    result.actions++;
    return r.action;
  }
  try {
    const opened = await call({ operation: 'open', serial: ctx.inputs.target.serial,
      packageName: ctx.inputs.target.packageName,
      instrumentation: ctx.inputs.target.packageName + '.test/androidx.test.runner.AndroidJUnitRunner',
      testClass: 'io.github.mobileaidev.aiappbridge.generated.BridgeSessionTest',
      activity: 'com.philkes.notallyx.presentation.activity.main.MainActivity',
      leaseMs: 1800000, timeoutMs: 45000 });
    identity = { serial: ctx.inputs.target.serial, packageName: ctx.inputs.target.packageName,
      sessionId: opened.sessionId, runtimeEpoch: opened.runtimeEpoch };
    result.identity = identity;
    result.flowStartedAtMs = Date.now();
    for (const [index, step] of steps.entries()) {
      if (step.phase !== currentPhase) {
        currentPhase = step.phase;
        result.phases.push({ name: currentPhase, startedAtMs: Date.now(), firstStep: index });
        await ctx.progress({ phase: currentPhase, step: index, total: steps.length });
      }
      const record = { index, phase: step.phase, name: step.name, operation: step.op, startedAtMs: Date.now() };
      result.steps.push(record);
      const engine = step.engine || 'espresso';
      const deadline = Date.now() + (step.timeoutMs || 7000);
      let o, found, scrolls = 0;
      do {
        o = await observe(engine);
        found = step.selector ? selected(o, step.selector) : [];
        const desired = step.count === undefined ? 1 : step.count;
        if (!step.selector || found.length === desired) break;
        if (step.seek && scrolls++ < 10) { const boxes = selected(o, { id: 'MainListView', visible: true }); if (boxes.length !== 1) throw Error('Scroll container not unique'); await act(o, 'swipeDown', boxes[0], {}, index); } else await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      if (step.selector && found.length !== (step.count === undefined ? 1 : step.count)) {
        result.failureObservation = o;
        throw new Error('Selector count ' + found.length + ' at ' + index + ': ' + JSON.stringify(step));
      }
      if (step.op === 'assert') {
        result.assertions++;
        record.actual = found;
      } else if (step.op === 'action') {
        let node = found[0];
        if (step.scroll === true && node && !node.visible) {
          await act(o, 'scrollTo', node, {}, index);
          o = await observe(engine);
          found = selected(o, step.selector);
          if (found.length !== 1 || !found[0].visible) throw new Error('Scroll did not reveal exact target');
          node = found[0];
        }
        record.mechanism = await act(o, step.action, node, step.fields || {}, index);
      } else throw new Error('Unknown plan operation ' + step.op);
      record.passed = true;
      record.elapsedMs = Date.now() - record.startedAtMs;
      save();
    }
    result.flowElapsedMs = Date.now() - result.flowStartedAtMs;
    result.finalObservation = await observe('espresso');
    result.ok = true;
  } catch (error) {
    result.error = String(error.stack || error);
    if (identity && !result.failureObservation) {
      try { result.failureObservation = await observe('espresso'); }
      catch (observationError) { result.observationError = String(observationError); }
    }
  } finally {
    if (identity) {
      try { result.close = await call({ ...identity, operation: 'close', timeoutMs: 30000 }); }
      catch (error) { result.ok = false; result.closeError = String(error); }
    }
    result.elapsedMs = Date.now() - result.startedAtMs;
    save();
  }
  return result;
};
