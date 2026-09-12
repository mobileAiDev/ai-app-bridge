'use strict';

const { commandDefinitions, isolatedCommandDefinitions, commandByName, isolatedByName, commandSchema, commandContract } = require('./command-registry');
const supportedTargets = [
  'Android native apps',
  'Android WebView/H5/CDP',
  'Flutter apps on Android and iOS',
  'iOS native apps via AiAppBridgeIOS + WebDriverAgent/XCUITest',
  'WKWebView',
  'desktop Web Bridge sessions',
];
const commandDomains = {
  execution: 'intent for observed decisions; script for repeatable local code with progress, cancellation and assertions',
  evidence: 'export and verify retained execution evidence',
  core: 'status, tree, uia-tree, screenshot, logs, network, state, events',
  app: 'install-apk, clear-app-data, launch-*, freeze-app/thaw-app, permission-*, appops-set',
  action: 'tap, tap-text, tap-uia, tap-uia-text, input-text, swipe, keyevent, wait-text, keyboard-state, hide-keyboard',
  flutter: 'flutter-tree, flutter-nodes, flutter-action, tap/input/scroll Flutter controls',
  webview: 'h5-*, flutter-h5-*, webview-pages, webview-network, webview-console',
  ios: 'ios-devices, ios-doctor, ios-setup, ios runtime evidence, ios-uia-tree/tap/input/swipe, ios-h5-*, ios-flutter-*',
  web: 'web-session-start, web-sessions, web-status, web-dom, web-logs, web-network, web-state, web-events, web-command, web-click, web-input, web-wait, web-scroll',
  diagnostics: 'logcat',
  advanced: 'forward, remove-forward',
};
const supportedTargetsText = `AI App Bridge supports ${supportedTargets.join('; ')}.`;
const commandDomainsText = `Command domains: ${Object.entries(commandDomains).map(([domain, summary]) => `${domain}(${summary})`).join('; ')}.`;
const discoveryText = 'Discover domains, commands and argument schemas with capabilities, then run the selected command with its arguments.';
function capabilityPayload(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'invalid_argument', field: 'arguments', dispatched: false, ambiguous: false };
  const invalidKey = Object.keys(args).find(key => !['command', 'domain', 'includeOptions'].includes(key));
  if (invalidKey) return { ok: false, error: 'unsupported_argument', field: invalidKey, dispatched: false, ambiguous: false };
  for (const [key, type] of [['command', 'string'], ['domain', 'string'], ['includeOptions', 'boolean']]) {
    if (Object.hasOwn(args, key) && typeof args[key] !== type) return { ok: false, error: 'invalid_argument', field: key, dispatched: false, ambiguous: false };
  }
  if (args.command && args.domain) return { ok: false, error: 'invalid_argument', field: 'domain', message: 'Use command or domain, not both.', dispatched: false, ambiguous: false };
  const includeOptions = args.includeOptions === true;
  const requestedCommand = args.command ? normalizeCommandName(args.command) : '';
  if (requestedCommand) {
    const definition = commandByName.get(requestedCommand) || isolatedByName.get(requestedCommand);
    return {
      ok: Boolean(definition),
      command: requestedCommand,
      ...(definition ? shapeCommandDefinition(definition, true) : { error: 'unknown_command' }),
    };
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

function shapeCommandDefinition(definition, includeOptions) {
  const shaped = {
    command: definition.command,
    summary: definition.summary,
    targetApp: Boolean(definition.targetApp),
    ...commandContract(definition.command),
    ...(includeOptions ? { options: Object.keys(commandSchema(definition.command).properties), inputSchema: commandSchema(definition.command) } : {}),
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
module.exports = { capabilities: capabilityPayload, commandDomains, supportedTargets, supportedTargetsText, commandDomainsText, discoveryText };
