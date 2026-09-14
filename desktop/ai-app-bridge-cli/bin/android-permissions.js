'use strict';

const { execFileBounded } = require('./shared-kernel/execution-io');
const { checkExecution } = require('./shared-kernel/execution-scope');
const { CommandError, executionFields } = require('./command-errors');
const { executeAndroidShell } = require('./shared-kernel/android-shell-execution');
const execute = (file, args, { timeout, mutation, actionId, ...options }) => mutation
  ? executeAndroidShell({ adb: file, serial: args[1], argv: args.slice(3), timeoutMs: timeout, actionId })
  : execFileBounded(file, args, { ...options, timeoutMs: timeout, encoding: 'utf8' });
const REQUEST_PERMISSIONS = 'android.content.pm.action.REQUEST_PERMISSIONS';

function requireTarget(args) {
  for (const field of ['packageName', 'permission']) {
    if (typeof args[field] !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(args[field])) {
      throw new CommandError('invalid_argument', `${field} must be a qualified Android identifier.`, { field });
    }
  }
  if (typeof args.serial !== 'string' || !args.serial.trim()) throw new CommandError('missing_argument', 'serial is required.', { field: 'serial' });
  if (args.userId !== undefined && (!Number.isSafeInteger(args.userId) || args.userId < 0 || args.userId > 2147483647)) {
    throw new CommandError('invalid_argument', 'userId must be a non-negative Android user ID.', { field: 'userId' });
  }
}

async function androidCommand(args, values, run = execute, { mutation = false } = {}) {
  checkExecution();
  return run(args.adb || process.env.ADB || 'adb', ['-s', args.serial, ...values], {
    timeout: args.adbTimeoutMs || 15000, maxBuffer: 16 * 1024 * 1024, mutation,
    actionId: args.runtimeActionId ?? args.requestId,
  });
}

function block(lines, start) {
  const indent = lines[start].search(/\S/);
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || lines[end].search(/\S/) > indent)) end++;
  return lines.slice(start + 1, end);
}

function uniqueBlock(lines, predicate, error) {
  const indexes = lines.flatMap((line, i) => predicate(line.trim()) ? [i] : []);
  if (indexes.length !== 1) throw new CommandError(error, 'Android did not provide one unambiguous package/user permission record.');
  return { header: lines[indexes[0]].trim(), lines: block(lines, indexes[0]) };
}

function parsePermissionState(text, { packageName, permission, userId }, definitions) {
  const pkg = uniqueBlock(text.split(/\r?\n/), line => line.startsWith(`Package [${packageName}] (`), 'permission_package_not_found');
  const appId = pkg.lines.map(line => /^\s+(?:appId|userId)=(\d+)\s*$/.exec(line)).filter(Boolean);
  if (appId.length !== 1 || Number(appId[0][1]) >= 100000) throw new CommandError('permission_state_unsupported', 'Android package appId is unavailable or ambiguous.');
  const user = uniqueBlock(pkg.lines, line => line.startsWith(`User ${userId}:`), 'permission_user_not_found');
  if (!/\binstalled=true\b/.test(user.header)) throw new CommandError('permission_package_not_installed', 'The package is not installed for the requested Android user.');
  const runtime = uniqueBlock(user.lines, line => line === 'runtime permissions:', 'runtime_permission_not_found');
  const matches = runtime.lines.filter(line => line.trim().startsWith(`${permission}:`));
  if (!matches.length && definitions !== undefined) {
    // Android 7 omits untouched runtime permissions. Establish that the app
    // requests a runtime permission and has no install grant before interpreting
    // the absent PackageManager state as denied with no flags.
    const requested = uniqueBlock(pkg.lines, line => line === 'requested permissions:', 'runtime_permission_not_found');
    const targetSdk = pkg.lines.flatMap(line => [...line.matchAll(/\btargetSdk=(\d+)\b/g)]);
    const definition = uniqueBlock(definitions.split(/\r?\n/), line => line.startsWith(`Permission [${permission}] (`), 'runtime_permission_not_found');
    const protection = definition.lines.flatMap(line => [...line.matchAll(/\bprot=([^\s]+)/g)]);
    if (targetSdk.length === 1 && Number(targetSdk[0][1]) >= 23
        && requested.lines.some(line => line.trim() === permission)
        && protection.length === 1 && protection[0][1].split('|')[0] === 'dangerous'
        && !pkg.lines.some(line => line.trim().startsWith(`${permission}:`))) {
      return { packageName, permission, userId, uid: userId * 100000 + Number(appId[0][1]), granted: false, flags: [] };
    }
  }
  const match = matches.length === 1 && /^\s*[^:]+:\s+granted=(true|false),\s*flags=\[([^\]]*)\]\s*$/.exec(matches[0]);
  if (!matches.length) throw new CommandError('runtime_permission_not_found', 'The requested permission has no runtime permission record for this package and user.');
  if (!match) throw new CommandError('permission_state_unsupported', 'Android returned an unrecognized runtime permission record.');
  const flags = match[2].trim() ? match[2].split('|').map(value => value.trim()) : [];
  if (flags.some(value => !/^[A-Z][A-Z0-9_]*$/.test(value)) || new Set(flags).size !== flags.length) {
    throw new CommandError('permission_state_unsupported', 'Android returned unrecognized permission flags.');
  }
  return { packageName, permission, userId, uid: userId * 100000 + Number(appId[0][1]), granted: match[1] === 'true', flags: flags.sort() };
}

async function readPermissionState(args, run = execute) {
  requireTarget(args);
  try {
    let userId = args.userId;
    if (userId === undefined) {
      const current = (await androidCommand(args, ['shell', 'am', 'get-current-user'], run)).stdout.trim();
      if (!/^\d+$/.test(current) || Number(current) > 2147483647) throw new CommandError('permission_user_unknown', 'Android current user could not be determined.');
      userId = Number(current);
    }
    const dump = await androidCommand(args, ['shell', 'dumpsys', 'package', args.packageName], run);
    let state;
    try { state = parsePermissionState(dump.stdout, { ...args, userId }); }
    catch (error) {
      if (error.code !== 'runtime_permission_not_found') throw error;
      const definitions = await androidCommand(args, ['shell', 'dumpsys', 'package', 'permissions'], run);
      state = parsePermissionState(dump.stdout, { ...args, userId }, definitions.stdout);
    }
    return { ok: true, source: 'android-package-manager', serial: args.serial,
      ...state, capturedAtMs: Date.now() };
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError('permission_query_failed', 'Android permission state could not be read.', { details: { cause: error.code || null } });
  }
}

async function changePermission(args, action, run = execute) {
  if (!['grant', 'revoke'].includes(action)) throw new TypeError('Unknown permission mutation');
  const before = await readPermissionState(args, run);
  const target = { ...args, userId: before.userId };
  let failure = null;
  let execution;
  try { execution = await androidCommand(target, ['shell', 'pm', action, '--user', String(before.userId), args.packageName, args.permission], run, { mutation: true }); }
  catch (error) { failure = error; }
  if (failure?.settled === false) throw failure;
  try { checkExecution(); }
  catch (error) { throw Object.assign(error, executionFields(failure || execution)); }
  let after; let queryError;
  try { after = await readPermissionState(target, run); }
  catch (error) { queryError = error.code || 'permission_query_failed'; }
  const details = { action, before, after: after || null, queryError: queryError || null };
  if (failure) {
    const response = [failure.stderr, failure.stdout].filter(Boolean).join('\n');
    const denied = /\bjava\.lang\.SecurityException:/.test(response);
    const unchanged = after && after.uid === before.uid && after.granted === before.granted && JSON.stringify(after.flags) === JSON.stringify(before.flags);
    const reason = response.split(/\r?\n/).find(line => line.includes('Exception:')) || response.trim().slice(0, 1024);
    throw new CommandError(denied ? 'permission_change_denied' : 'permission_change_failed',
      denied ? 'Android does not authorize this ADB identity to change runtime permissions.' : 'Android rejected or did not acknowledge the permission change.', {
        details: { ...details, cause: failure.code || null, reason: reason.slice(0, 1024) || null }, dispatched: failure.code !== 'ENOENT',
        ambiguous: failure.code !== 'ENOENT' && !(denied && unchanged),
        ...executionFields(failure),
      });
  }
  if (!after || after.uid !== before.uid || after.granted !== (action === 'grant')) {
    throw new CommandError('permission_verification_failed', 'The permission change was submitted but its resulting state was not verified.', { details, ...executionFields(execution), dispatched: true, ambiguous: !after || after.uid !== before.uid });
  }
  return { ...after, action, before, verified: true, dispatched: true, ambiguous: false, ...executionFields(execution) };
}

function activityIdentity(value) {
  const match = /ActivityRecord\{([^\s{}]+) u(\d+) ([^\s{}]+\/[^\s{}]+)\s/.exec(value);
  if (!match) return null;
  const [packageName, activity] = match[3].split('/');
  // Android's flattened ComponentName may abbreviate the class with a leading dot.
  const component = `${packageName}/${activity.startsWith('.') ? packageName + activity : activity}`;
  return { token: match[1], userId: Number(match[2]), component, packageName };
}

// ActivityManager supplies requester identity even when Intent extras are redacted.
// It does not expose the requested permission list here; the Agent must inspect
// the actual dialog, and PackageManager independently verifies the named permission.
function parsePermissionRequest(text) {
  const lines = text.split(/\r?\n/);
  let tops = lines.filter(line => /^\s*topResumedActivity=/.test(line)).map(activityIdentity);
  if (!tops.length) {
    // Before multi-resume, ActivityManager records one focused Activity and
    // each stack's resumed Activity. Both identities must agree.
    tops = lines.filter(line => /^\s*mFocusedActivity:/.test(line)).map(activityIdentity);
    const resumed = lines.filter(line => /^\s*mResumedActivity:/.test(line)).map(activityIdentity);
    if (tops.length !== 1 || !tops[0] || !resumed.some(value => value && value.token === tops[0].token
        && value.component === tops[0].component && value.userId === tops[0].userId)) {
      throw new CommandError('permission_request_unsupported', 'The focused and resumed Android Activity identities did not agree.');
    }
  }
  if (tops.length !== 1 || !tops[0]) throw new CommandError('permission_request_unsupported', 'One top-resumed Android Activity could not be identified.');
  const records = lines.flatMap((line, i) => /^\s*\* Hist\s+#\d+: ActivityRecord\{/.test(line) ? [{ ...activityIdentity(line), lines: block(lines, i) }] : []);
  const requests = records.filter(record => record.lines.some(line => line.trim().startsWith('Intent {') && line.includes(`act=${REQUEST_PERMISSIONS} `)));
  const current = records.filter(record => record.token === tops[0].token && record.component === tops[0].component && record.userId === tops[0].userId);
  if (current.length !== 1) throw new CommandError('permission_request_unsupported', 'The top-resumed Activity has no unique detailed record.');
  const result = { source: 'android-activity-manager', foreground: tops[0], activeRequestTokens: requests.map(record => record.token), request: null };
  if (!requests.includes(current[0])) return result;
  const origin = current[0].lines.map(line => /\blaunchedFromUid=(\d+) launchedFromPackage=([^\s]+).*\buserId=(\d+)\s*$/.exec(line)).filter(Boolean);
  if (origin.length !== 1 || Number(origin[0][3]) !== tops[0].userId) throw new CommandError('permission_request_unsupported', 'The runtime permission requester is unavailable or ambiguous.');
  result.request = { ...tops[0], action: REQUEST_PERMISSIONS, requesterPackage: origin[0][2], requesterUid: Number(origin[0][1]) };
  return result;
}

async function readPermissionRequest(args, run = execute) {
  try {
    const dump = await androidCommand(args, ['shell', 'dumpsys', 'activity', 'activities'], run);
    return { ...parsePermissionRequest(dump.stdout), capturedAtMs: Date.now() };
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError('permission_request_query_failed', 'Android runtime permission request could not be read.', { details: { cause: error.code || null } });
  }
}

module.exports = { readPermissionState, changePermission, readPermissionRequest, parsePermissionState, parsePermissionRequest, androidCommand };
