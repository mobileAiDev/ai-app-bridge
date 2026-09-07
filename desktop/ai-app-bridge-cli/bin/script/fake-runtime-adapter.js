'use strict';

function createFakeRuntimeAdapter({ program = null } = {}) {
  return {
    kind: 'fake',
    async start({ spec, host, agent, emit, now, control }) {
      const ctx = {
        inputs: spec.inputs,
        call: (command, args, options) => host.call(command, args, options),
        assert: (assertion) => host.assert(assertion),
        assert_: (assertion) => host.assert(assertion),
        progress: async (event) => {
          await holdIfPaused(control);
          if (jsonBytes(event) > spec.policy.maxProgressBytes) {
            throw new Error('progress_too_large');
          }
          emit('progress', event);
          await holdIfPaused(control);
        },
        checkpoint: async (name, state) => {
          await holdIfPaused(control);
          if (jsonBytes(state) > spec.policy.maxOutputBytes) {
            throw new Error('checkpoint_too_large');
          }
          const receipt = await emit('checkpoint', { name, state });
          if (receipt && receipt.ok === false) {
            throw new Error(receipt.error || 'checkpoint_not_persisted');
          }
          await holdIfPaused(control);
          return receipt;
        },
        askAgent: async (request) => {
          await holdIfPaused(control);
          const value = await agent.askAgent(request);
          await holdIfPaused(control);
          return value;
        },
        controlPoint: () => control(),
        resume: () => {
          const state = control();
          if (!state.checkpoint) return null;
          return state.checkpoint.state;
        },
      };
      try {
        const result = program ? await program(ctx) : { passed: true };
        if (jsonBytes(result) > spec.policy.maxOutputBytes) {
          emit('script_failed', { error: 'output_too_large' });
          return { ok: false, error: 'output_too_large' };
        }
        emit('script_completed', { result });
        return { ok: true, result };
      } catch (error) {
        emit('script_failed', { error: error.message || String(error) });
        return { ok: false, error: error.message || String(error) };
      }
    },
  };
}

function isHeld(status) {
  return status === 'pause_requested'
    || status === 'paused_manual'
    || status === 'paused_live'
    || status === 'paused_ambiguous';
}

function holdIfPaused(control) {
  return new Promise((resolve) => {
    const tick = () => {
      const state = typeof control === 'function' ? control() : control;
      if (!isHeld(state && state.status)) {
        resolve();
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

module.exports = { createFakeRuntimeAdapter };
