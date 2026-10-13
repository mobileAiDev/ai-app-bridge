'use strict';
const sessions = new Map();
exports.decide = ({ goal, revision, summary, lastAction }) => {
  const state = sessions.get(goal) || { next: 0, sequence: 0 };
  sessions.set(goal, state);
  const base = { decisionId: `network-login-${++state.sequence}`, basedOnRevision: revision };
  if (lastAction?.error) {
    sessions.delete(goal);
    return { ...base, agentDecision: 'inconclusive', reason: `Inspect the retained command receipt: ${lastAction.error}` };
  }
  if (summary?.nodes?.some(node => node.text === '门店 48 家 · 第 1 页')) {
    sessions.delete(goal);
    return { ...base, agentDecision: 'complete', reason: 'The authenticated merchant response is visible.' };
  }
  const actions = [
    ['input-text', { selector: { contentDescription: 'city_account' }, text: 'bridge@example.test' }],
    ['input-text', { selector: { contentDescription: 'city_password' }, text: 'fixture-password' }],
    ['tap-native', { selector: { contentDescription: 'city_agreement' } }],
    ['tap-native', { selector: { contentDescription: 'city_login' } }],
    ['wait-text', { provider: 'native', anyText: ['门店 48 家 · 第 1 页', '请求失败 401：invalid_credentials_or_agreement，可修正后重试'], timeoutMs: 10000, intervalMs: 50 }],
  ];
  const entry = actions[state.next++];
  if (!entry) {
    sessions.delete(goal);
    return { ...base, agentDecision: 'inconclusive', reason: 'The observed login outcome requires a new decision.' };
  }
  return { ...base, agentDecision: 'act', action: { action: 'command', command: entry[0], arguments: entry[1], observeAfter: entry[0] === 'wait-text' } };
};
