'use strict';

const { commandDefinitions, isolatedCommandDefinitions, commandByName, isolatedByName, commandSchema, commandContract } = require('./command-registry');
const { CommandError, commandFailure } = require('./command-errors');
const { variants, intentDecisionSchema } = require('./shared-kernel/execution-contracts');
const schemaFilterNames = ['operation', 'platform', 'provider', 'action'];
const supportedTargets = [
  'Android native apps',
  'Android WebView/H5/CDP',
  'Flutter apps on Android and iOS',
  'iOS native apps via AiAppBridgeIOS + WebDriverAgent/XCUITest',
  'WKWebView',
  'desktop Web Bridge sessions',
];
const commandDomains = {
  execution: 'intent for observed decisions; script for repeatable local code with progress, persisted results and assertions; runtime and device-ownership controls',
  evidence: 'export and verify retained execution evidence',
  core: 'status, tree, uia-tree, screenshot, logs, network, state, events',
  app: 'install-apk, clear-app-data, launch-*, freeze-app/thaw-app, permission-*, appops-set',
  action: 'tap, tap-text, tap-uia, tap-uia-text, input-text, swipe, keyevent, wait-text, keyboard-state, hide-keyboard',
  flutter: 'flutter-tree, flutter-nodes, flutter-action, tap/input/scroll Flutter controls',
  webview: 'h5-*, flutter-h5-*, webview-pages, webview-network, webview-console',
  ios: 'ios-devices, ios-doctor, ios-setup, ios runtime evidence, ios-uia-tree, ios-tap/ios-input/ios-swipe, ios-h5-*, ios-flutter-*',
  web: 'web-session-start, web-sessions, web-status, web-dom, web-logs, web-network, web-state, web-events, web-command, web-click, web-input, web-wait, web-scroll',
  diagnostics: 'logcat',
  advanced: 'uia-runtime maintenance, forward, remove-forward',
};
const supportedTargetsText = `AI App Bridge supports ${supportedTargets.join('; ')}.`;
const commandDomainsText = `Command domains: ${Object.entries(commandDomains).map(([domain, summary]) => `${domain}(${summary})`).join('; ')}.`;
const discoveryText = 'Use capabilities with a domain for a command directory, then request one command and operation when applicable. For intent decide, narrow by the actual platform, provider and action. Omit filters for the complete command contract; includeOptions:true explicitly expands a directory. Execute with run and command-specific arguments.';
function capabilityPayload(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'invalid_argument', field: 'arguments', dispatched: false, ambiguous: false };
  const invalidKey = Object.keys(args).find(key => !['command', 'domain', 'includeOptions', ...schemaFilterNames].includes(key));
  if (invalidKey) return { ok: false, error: 'unsupported_argument', field: invalidKey, dispatched: false, ambiguous: false };
  for (const [key, type] of [['command', 'string'], ['domain', 'string'], ['includeOptions', 'boolean'], ...schemaFilterNames.map(key => [key, 'string'])]) {
    if (Object.hasOwn(args, key) && (typeof args[key] !== type || type === 'string' && !args[key])) return { ok: false, error: 'invalid_argument', field: key, dispatched: false, ambiguous: false };
  }
  if (args.command && args.domain) return { ok: false, error: 'invalid_argument', field: 'domain', message: 'Use command or domain, not both.', dispatched: false, ambiguous: false };
  const filters = Object.fromEntries(schemaFilterNames.filter(key => Object.hasOwn(args, key)).map(key => [key, args[key]]));
  if (Object.keys(filters).length && !args.command) return { ok: false, error: 'invalid_argument', field: Object.keys(filters)[0], message: 'Schema filters require command.', dispatched: false, ambiguous: false };
  const includeOptions = args.includeOptions === true;
  const requestedCommand = args.command ? normalizeCommandName(args.command) : '';
  if (requestedCommand) {
    const definition = commandByName.get(requestedCommand) || isolatedByName.get(requestedCommand);
    try {
      return {
        ok: Boolean(definition),
        command: requestedCommand,
        ...(definition ? shapeCommandDefinition(definition, true, filters) : { error: 'unknown_command' }),
      };
    } catch (error) {
      if (!(error instanceof CommandError)) throw error;
      return commandFailure(error, requestedCommand);
    }
  }

  const requestedDomain = args.domain ? String(args.domain) : '';
  const domains = {};
  if (requestedDomain && !Object.hasOwn(commandDomains, requestedDomain)) return { ok: false, error: 'unknown_domain', field: 'domain', dispatched: false, ambiguous: false };
  for (const definition of [...isolatedCommandDefinitions, ...commandDefinitions]) {
    if (requestedDomain && definition.domain !== requestedDomain) continue;
    if (!domains[definition.domain]) domains[definition.domain] = [];
    domains[definition.domain].push(shapeCommandDefinition(definition, includeOptions));
  }

  return {
    ok: true,
    surface: 'compact',
    supportedTargets,
    commandDomains,
    usage: `${supportedTargetsText} ${discoveryText} Use run with one of these command names. Prefer packageName for Android app commands, bundleId/deviceId for iOS, and sessionId/targetId for Web Bridge sessions.`,
    domains,
  };
}

function commandInputSchema(command, filters = {}) {
  for (const [key, value] of Object.entries(filters)) {
    if (!schemaFilterNames.includes(key)) throw new CommandError('unsupported_argument', `Unknown schema filter: ${key}.`, { field: key });
    if (typeof value !== 'string' || !value) throw new CommandError('invalid_argument', `${key} must be a non-empty string.`, { field: key });
  }
  const schema = commandSchema(command);
  if (!Object.keys(filters).length) return schema;
  const scope = ['platform', 'provider', 'action'].find(key => Object.hasOwn(filters, key));
  if (scope && (command !== 'intent' || filters.operation !== 'decide')) {
    throw new CommandError('invalid_argument', `${scope} is available only with command=intent and operation=decide.`, { field: scope });
  }
  if (!['intent', 'script', 'evidence'].includes(command)) {
    throw new CommandError('invalid_argument', 'Operation schema selection supports intent, script and evidence.', { field: 'operation' });
  }
  const selected = schema.anyOf.filter(branch => branch.properties.operation.const === filters.operation);
  if (!selected.length) throw new CommandError('invalid_argument', `Unknown ${command} operation: ${filters.operation}.`, { field: 'operation' });
  if (!scope) return selected.length === 1 ? selected[0] : variants('operation', selected);

  const providersByPlatform = commandContract('intent').providersByPlatform;
  if (filters.platform && !Object.hasOwn(providersByPlatform, filters.platform)) {
    throw new CommandError('invalid_argument', 'platform must be android, ios or web.', { field: 'platform' });
  }
  const providers = filters.platform ? providersByPlatform[filters.platform] : [...new Set(Object.values(providersByPlatform).flat())];
  if (filters.provider && !providers.includes(filters.provider)) {
    throw new CommandError('invalid_argument', `provider must be one of: ${providers.join(', ')}.`, { field: 'provider' });
  }
  const decisions = (filters.provider ? [filters.provider] : providers).map(provider => intentDecisionSchema(provider, filters.platform));
  let actions = decisions.flatMap(decision => decision.properties.action.anyOf);
  if (filters.action) {
    actions = actions.filter(branch => branch.properties.action.const === filters.action);
    if (!actions.length) throw new CommandError('invalid_argument', `Action ${filters.action} is unavailable for the selected platform/provider.`, { field: 'action' });
  }
  const decision = variants('agentDecision', decisions[0].anyOf.map(branch => branch.properties.agentDecision.const === 'act'
    ? { ...branch, properties: { ...branch.properties, action: actions.length === 1 ? actions[0] : variants('action', actions) } } : branch));
  return { ...selected[0], properties: { ...selected[0].properties, decision } };
}

function shapeCommandDefinition(definition, includeOptions, filters = {}) {
  if (!includeOptions) return { command: definition.command, summary: definition.summary };
  const inputSchema = commandInputSchema(definition.command, filters);
  const shaped = {
    command: definition.command,
    summary: definition.summary,
    targetApp: Boolean(definition.targetApp),
    ...commandContract(definition.command),
    options: Object.keys(inputSchema.properties), inputSchema,
    ...(Object.keys(filters).length ? { selection: filters } : {}),
    contractVersion: 'aab.command/v1',
  };
  if (definition.command === 'script') {
    const { catalogPayload } = require('./script/script-catalog');
    shaped.runtime = 'trusted-local-code';
    shaped.warning = 'Script source is trusted-local-code, not an OS sandbox.';
    shaped.catalog = catalogPayload();
  }
  return shaped;
}


function normalizeCommandName(value) { return typeof value === 'string' ? value : ''; }
module.exports = { capabilities: capabilityPayload, commandInputSchema, commandDomains, supportedTargets, supportedTargetsText, commandDomainsText, discoveryText };
