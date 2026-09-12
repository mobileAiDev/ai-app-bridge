'use strict';

const { scriptPermissions } = require('../command-registry');
const PERMISSIONS = Object.freeze(Object.fromEntries(Object.entries(scriptPermissions).map(([name, commands]) =>
  [name, Object.freeze(name === 'app.read' ? [...commands, 'page-summary'] : [...commands])])));

const DENY_DEFAULT = Object.freeze([
  'clear-app-data',
  'install-apk',
  'ios-install-app',
  'ios-setup',
  'permission-grant',
  'permission-revoke',
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
  if (DENY_DEFAULT.includes(command) && !permissions.includes(commandPermission(command))) {
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
    executablePlatforms: ['android', 'ios', 'web'],
    unavailablePlatforms: {},
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
