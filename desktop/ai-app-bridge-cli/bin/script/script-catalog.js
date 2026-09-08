'use strict';

const PERMISSIONS = Object.freeze({
  'app.read': Object.freeze([
    'status',
    'tree',
    'uia-tree',
    'screenshot',
    'flutter-tree',
    'flutter-nodes',
    'h5-dom',
    'keyboard-state',
    'permission-state',
    'page-summary',
    'ios-status',
    'ios-uia-tree',
    'web-status',
    'web-dom',
  ]),
  'capture.read': Object.freeze([
    'logs',
    'network',
    'state',
    'events',
    'webview-console',
    'webview-network',
    'ios-logs',
    'ios-network',
    'ios-state',
    'ios-events',
    'web-logs',
    'web-network',
    'web-state',
    'web-events',
  ]),
  'app.interact': Object.freeze([
    'launch-app',
    'tap',
    'tap-text',
    'tap-uia-text',
    'input-text',
    'swipe',
    'keyevent',
    'wait-text',
    'hide-keyboard',
    'tap-flutter',
    'tap-flutter-text',
    'input-flutter-text',
    'scroll-flutter',
    'h5-click',
    'h5-input',
    'h5-wait',
    'h5-scroll',
    'ios-tap',
    'ios-input',
    'ios-swipe',
    'web-click',
    'web-input',
    'web-wait',
    'web-scroll',
  ]),
});

const DENY_DEFAULT = Object.freeze([
  'clear-app-data',
  'install-apk',
  'ios-install-app',
  'ios-setup',
  'permission-grant',
  'permission-revoke',
  'permission-dialog',
  'appops-set',
]);

const DENY_PERMANENT = Object.freeze([
  'h5-eval',
  'flutter-h5-eval',
  'ios-h5-eval',
  'web-command',
  'forward',
  'remove-forward',
]);

const DEFAULT_PERMISSIONS = Object.freeze(['app.read', 'app.interact', 'capture.read']);

function allowedCommands(permissions = DEFAULT_PERMISSIONS) {
  const names = new Set();
  for (const permission of permissions) {
    for (const command of PERMISSIONS[permission] || []) names.add(command);
  }
  return [...names];
}

function commandPermission(command) {
  for (const [permission, commands] of Object.entries(PERMISSIONS)) {
    if (commands.includes(command)) return permission;
  }
  return null;
}

function authorizeCommand(command, permissions = DEFAULT_PERMISSIONS) {
  if (DENY_PERMANENT.includes(command)) {
    return { ok: false, error: 'command_permanently_denied', command };
  }
  if (DENY_DEFAULT.includes(command)) {
    return { ok: false, error: 'command_not_in_default_allowlist', command };
  }
  const permission = commandPermission(command);
  if (!permission) {
    return { ok: false, error: 'command_not_in_catalog', command };
  }
  if (!permissions.includes(permission)) {
    return { ok: false, error: 'permission_not_granted', command, permission };
  }
  return { ok: true, command, permission };
}

function catalogPayload() {
  return {
    runtime: 'trusted-local-code',
    warning: 'Script source is trusted-local-code, not an OS sandbox. permissions gate Bridge SDK calls only.',
    schemaVersion: 'aab.code-script/v1',
    languages: ['javascript', 'python'],
    entrypoint: 'main',
    permissions: PERMISSIONS,
    defaultPermissions: DEFAULT_PERMISSIONS,
    denyDefault: DENY_DEFAULT,
    denyPermanent: DENY_PERMANENT,
    internalOnly: ['page-summary'],
  };
}

module.exports = {
  PERMISSIONS,
  DENY_DEFAULT,
  DENY_PERMANENT,
  DEFAULT_PERMISSIONS,
  allowedCommands,
  authorizeCommand,
  catalogPayload,
};
