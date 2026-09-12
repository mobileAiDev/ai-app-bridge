'use strict';

const { CommandError } = require('../command-errors');

// iOS providers resolve devicectl identity and own the canonical physical UDID
// lease. An outer operation must not acquire a second lock using its connection
// identifier, which can differ from that UDID. Android providers inherit the
// operation's serial lease. The serving Web provider owns its session lease.
async function admitExecutionMutation(target, lease, action) {
  if (target.platform === 'ios' || target.platform === 'web') return action();
  if (target.platform !== 'android') {
    throw new CommandError('unsupported_execution_platform', 'No mutation admission is implemented for this platform.',
      { dispatched: false, ambiguous: false });
  }
  const held = lease.acquire(target.serial);
  if (!held.ok) throw new CommandError(held.error, 'The target device cannot admit this operation.',
    { dispatched: false, ambiguous: false, details: held });
  try { return await held.run(action); }
  finally { held.release(); }
}

module.exports = { admitExecutionMutation };
