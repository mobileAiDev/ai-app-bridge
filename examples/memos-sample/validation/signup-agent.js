'use strict';

// Fixed first-run policy for the independently hosted, empty Memos sample.
// Passwords stay in the private credentials file; goal contains only its path.
const fs = require('node:fs');
const sessions = new Map();

exports.decide = async ({ goal, revision, lastAction }) => {
  const input = JSON.parse(goal);
  let state = sessions.get(goal);
  if (!state) {
    state = { index: 0, sequence: 0, credentials: JSON.parse(fs.readFileSync(input.credentialsPath, 'utf8')) };
    sessions.set(goal, state);
  }
  const base = { decisionId: `memos-signup-${++state.sequence}`, basedOnRevision: revision };
  if (lastAction?.error) {
    sessions.delete(goal);
    return { ...base, agentDecision: 'inconclusive', reason: `Inspect the original receipt: ${lastAction.error}` };
  }
  if (lastAction?.command === 'web-network' && state.index === 1) state.cursor = lastAction.result.watermarkCursor;
  const actions = [
    ['web-network', {}],
    ['web-input', { selector: { css: '#signup-username' }, value: state.credentials.username }],
    ['web-input', { selector: { css: '#signup-password' }, value: state.credentials.password }],
    ['web-click', { selector: { text: 'Create admin account', tag: 'button' } }],
  ];
  let next = actions[state.index];
  if (next) state.index++;
  else if (state.index === actions.length) {
    const records = lastAction?.command === 'web-network' ? lastAction.result.items.filter(record =>
      record.url.endsWith('/memos.api.v1.UserService/CreateUser')) : [];
    if (records.length > 1) {
      sessions.delete(goal);
      return { ...base, agentDecision: 'inconclusive', reason: 'Unexpected duplicate CreateUser requests; inspect the original network window.' };
    }
    if (records.length === 1 && (records[0].error || records[0].statusCode >= 400)) {
      sessions.delete(goal);
      return { ...base, agentDecision: 'inconclusive', reason: `CreateUser failed (HTTP ${records[0].statusCode}); inspect the captured response and correct the account input before a new attempt.` };
    }
    if (records.length === 1 && records[0].statusCode === 200) {
      next = ['web-wait', { selector: { css: '[role="textbox"][contenteditable="true"]' }, timeoutMs: 10000 }];
      state.index++;
    } else {
      if (lastAction?.command === 'web-network') await new Promise(resolve => setTimeout(resolve, 50));
      next = ['web-network', { factCursor: state.cursor }];
    }
  }
  if (!next) {
    sessions.delete(goal);
    return { ...base, agentDecision: 'complete', reason: 'The authenticated home editor was observed after account creation.' };
  }
  return { ...base, agentDecision: 'act', action: { action: 'command', command: next[0], arguments: next[1],
    observeAfter: next[0] === 'web-wait' } };
};
