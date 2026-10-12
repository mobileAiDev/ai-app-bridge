'use strict';

const { scriptPermissions } = require('../command-registry');
const PERMISSIONS = Object.freeze(Object.fromEntries(Object.entries(scriptPermissions).map(([name, commands]) =>
  [name, Object.freeze(name === 'app.read' ? [...commands, 'page-summary'] : [...commands])])));

const DEFAULT_PERMISSIONS = Object.freeze(Object.keys(PERMISSIONS));

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

function authorizeCommand(command, permissions = DEFAULT_PERMISSIONS, args = {}) {
  const permission = command === 'logcat' && args.clear === true
    || ['webview-network', 'webview-console'].includes(command) && args.script !== undefined
    ? 'app.expert' : commandPermission(command);
  if (!permission) {
    return { ok: false, error: 'command_not_in_catalog', command,
      message: `${command} has no Script adapter. Use the run tool for this command; capabilities lists its arguments.` };
  }
  if (!permissions.includes(permission)) {
    return { ok: false, error: 'permission_not_granted', command, permission,
      message: `This script's explicit permissions exclude ${permission}. Add it to permissions, or omit permissions to enable all supported commands.` };
  }
  return { ok: true, command, permission };
}

function catalogPayload() {
  return {
    runtime: 'trusted-local-code',
    warning: 'Script source is trusted-local-code, not an OS sandbox. All supported commands are enabled by default; an explicit permissions list restricts Bridge SDK calls.',
    schemaVersion: 'aab.code-script/v1',
    languages: ['javascript', 'python'],
    executablePlatforms: ['android', 'ios', 'web'],
    unavailablePlatforms: {},
    entrypoint: 'main',
    permissions: PERMISSIONS,
    defaultPermissions: DEFAULT_PERMISSIONS,
    internalOnly: ['page-summary'],
    recipes: require('./recipes').catalog(),
  };
}

module.exports = {
  PERMISSIONS,
  DEFAULT_PERMISSIONS,
  allowedCommands,
  authorizeCommand,
  catalogPayload,
};
