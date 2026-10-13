'use strict';

// A local Agent policy for this visible fixture. No hidden app state is read.
// One autonomous Intent runs this policy repeatedly without model/tool round trips.
const sessions = new Map();
exports.decide = ({ goal, revision, summary, lastAction }) => {
  const session = sessions.get(goal) || { next: 0, decision: 0 };
  sessions.set(goal, session);
  const base = { decisionId: `login-${++session.decision}`, basedOnRevision: revision };
  const nodes = summary?.nodes || [];
  if (nodes.some(node => node.text === 'Login successful')) {
    sessions.delete(goal);
    return { ...base, agentDecision: 'complete', reason: 'Fresh visible authenticated home.' };
  }
  if (lastAction?.error) {
    sessions.delete(goal);
    return { ...base, agentDecision: 'inconclusive', reason: `Action receipt: ${lastAction.error}` };
  }
  const actions = [
    { action: 'tap', selector: { contentDescription: 'login_entry' } },
    { action: 'inputText', selector: { contentDescription: 'login_account' }, value: 'bridge@example.test' },
    { action: 'inputText', selector: { contentDescription: 'login_password' }, value: 'fixture-password' },
    { action: 'tap', selector: { contentDescription: 'login_terms' } },
    { action: 'tap', selector: { contentDescription: 'login_submit' } },
  ];
  const action = actions[session.next++];
  if (action) return { ...base, agentDecision: 'act', action: { provider: 'native', ...action } };
  return { ...base, agentDecision: 'act', action: { action: 'command', command: 'wait-text',
    arguments: { provider: 'native', targetText: 'Login successful', timeoutMs: 5000, intervalMs: 50 }, observeAfter: true } };
};
