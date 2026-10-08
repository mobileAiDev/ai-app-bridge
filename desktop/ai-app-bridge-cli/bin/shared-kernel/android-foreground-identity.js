'use strict';

// Android LayoutParams types printed by WindowState.dump. Numeric types are
// used on Android 7; later releases print these platform constant names.
const windowTypes = Object.freeze({
  BASE_APPLICATION: 1, APPLICATION: 2, APPLICATION_STARTING: 3, DRAWN_APPLICATION: 4,
  APPLICATION_PANEL: 1000, APPLICATION_MEDIA: 1001, APPLICATION_SUB_PANEL: 1002,
  APPLICATION_ATTACHED_DIALOG: 1003, APPLICATION_MEDIA_OVERLAY: 1004, APPLICATION_ABOVE_SUB_PANEL: 1005,
  STATUS_BAR: 2000, SEARCH_BAR: 2001, PHONE: 2002, SYSTEM_ALERT: 2003, KEYGUARD: 2004,
  TOAST: 2005, SYSTEM_OVERLAY: 2006, PRIORITY_PHONE: 2007, SYSTEM_DIALOG: 2008,
  KEYGUARD_DIALOG: 2009, SYSTEM_ERROR: 2010, INPUT_METHOD: 2011, INPUT_METHOD_DIALOG: 2012,
  WALLPAPER: 2013, STATUS_BAR_PANEL: 2014, SECURE_SYSTEM_OVERLAY: 2015, DRAG: 2016,
  STATUS_BAR_SUB_PANEL: 2017, POINTER: 2018, NAVIGATION_BAR: 2019, VOLUME_OVERLAY: 2020,
  BOOT_PROGRESS: 2021, INPUT_CONSUMER: 2022, DREAM: 2023, NAVIGATION_BAR_PANEL: 2024,
  UNIVERSE_BACKGROUND: 2025, DISPLAY_OVERLAY: 2026, MAGNIFICATION_OVERLAY: 2027,
  RECENTS_OVERLAY: 2028, KEYGUARD_SCRIM: 2029, PRIVATE_PRESENTATION: 2030,
  VOICE_INTERACTION: 2031, ACCESSIBILITY_OVERLAY: 2032, VOICE_INTERACTION_STARTING: 2033,
  DOCK_DIVIDER: 2034, QS_DIALOG: 2035, SCREENSHOT: 2036, PRESENTATION: 2037,
  APPLICATION_OVERLAY: 2038, ACCESSIBILITY_MAGNIFICATION_OVERLAY: 2039,
  NOTIFICATION_SHADE: 2040, STATUS_BAR_ADDITIONAL: 2041, TRUSTED_APPLICATION_OVERLAY: 2042,
});
const knownTypes = new Set(Object.values(windowTypes));
const packagePattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function validForegroundIdentity(value) {
  if (!value || !packagePattern.test(value.packageName || '') || !nonempty(value.windowIdentity)
    || value.ownershipVerified !== true || !knownTypes.has(value.windowType)) return false;
  if (value.windowKind === 'non-activity') {
    return value.windowType >= 2000 && value.activity === null && value.component === null;
  }
  return value.windowKind === 'activity' && value.windowType < 2000
    && nonempty(value.activity) && nonempty(value.component)
    && value.component.startsWith(`${value.packageName}/`);
}

function sameForegroundWindow(left, right) {
  return Boolean(left && right && nonempty(left.packageName) && nonempty(right.packageName)
    && nonempty(left.windowIdentity) && nonempty(right.windowIdentity)
    && (nonempty(left.component) || left.component === null)
    && (nonempty(right.component) || right.component === null)
    && left.packageName === right.packageName && left.component === right.component
    && left.windowIdentity === right.windowIdentity);
}

// Read assignments by field, skipping balanced objects so LayoutParams.taskId
// cannot masquerade as WindowState.taskId. Class labels and line layout are not
// part of the dumpsys contract. Keep every value for conflict diagnostics.
function fields(text) {
  const result = new Map();
  const assignment = /\b([A-Za-z][A-Za-z0-9_]*)\s*=\s*/g;
  let match;
  while ((match = assignment.exec(text))) {
    const start = assignment.lastIndex;
    const object = /^(?:[A-Za-z_$][\w.$]*\s*)?\{/.exec(text.slice(start));
    let end = start;
    if (object) {
      end += object[0].length;
      let depth = 1;
      while (end < text.length && depth) {
        const char = text[end++];
        if (char === '{') depth++;
        if (char === '}') depth--;
      }
      if (depth) end = text.length;
    } else {
      while (end < text.length && !/[\s}]/.test(text[end])) end++;
    }
    const values = result.get(match[1]) || [];
    values.push(text.slice(start, end));
    result.set(match[1], values);
    assignment.lastIndex = end;
  }
  return result;
}

// Resolve only the WindowState selected by focus token/user/display. Window
// titles are client data and never substitute for OS owner or Activity fields.
function parseForegroundWindowIdentity(raw, focus) {
  const evidence = { focus: focus.raw ?? null };
  const facts = { source: 'mCurrentFocus', ownershipVerified: false, evidence };
  const reject = (error, field, values) => ({ ...facts, ok: false, error, focus,
    ...(field ? { diagnostic: { field, values: values ?? [] } } : {}) });
  if (!focus.ok) return { ...focus, ownershipVerified: false, evidence: { dump: String(raw ?? '') } };
  const focused = focus.raw.match(/^mCurrentFocus(?:\s*\[\s*\d+\s*\])?\s*[:=]\s*Window\s*\{\s*(\w+)\s+u(\d+)\s+([^}]+)\}\s*$/);
  if (!focused) return reject('foreground_window_identity_missing');
  const [, windowToken, rawUserId, title] = focused;
  const windowTitle = title.trim(), userId = Number(rawUserId);
  Object.assign(facts, { windowToken, userId, windowTitle });
  const text = String(raw);
  const headings = [...text.matchAll(/^[ \t]*Window\s*#\s*\d+\s+Window\s*\{\s*(\w+)\s+u(\d+)\s+([^}]+)\}\s*:/gm)];
  const blocks = headings.map((heading, index) => {
    const start = heading.index + heading[0].length;
    const tail = text.slice(start, headings[index + 1]?.index ?? text.length);
    const sectionEnd = tail.search(/^\s*WINDOW MANAGER\b/m);
    const body = sectionEnd < 0 ? tail : tail.slice(0, sectionEnd);
    return { token: heading[1], userId: Number(heading[2]), title: heading[3].replace(/\s+/g, ' ').trim(),
      header: heading[0], lines: body.split(/\r?\n/) };
  });
  const owners = blocks.filter(item => item.token === windowToken && item.userId === userId);
  evidence.windows = owners.map(item => [item.header, ...item.lines].join('\n'));
  if (owners.length !== 1) return reject(owners.length ? 'foreground_window_identity_ambiguous' : 'foreground_window_identity_missing');
  const owner = owners[0];
  evidence.window = evidence.windows[0];
  delete evidence.windows;
  const values = fields(owner.lines.join('\n'));
  let failure;
  function read(name, missing, conflict, pattern, source = values) {
    const entries = source.get(name) || [];
    const unique = [...new Set(entries.map(value => value.replace(/\s+/g, ' ').trim()))];
    if (unique.length !== 1 || pattern && !pattern.test(unique[0])) {
      failure ||= reject(unique.length > 1 ? conflict : missing, name, entries);
      return undefined;
    }
    return unique[0];
  }
  for (const [field, output] of [['mDisplayId', 'displayId'], ['mOwnerUid', 'ownerUid']]) {
    const value = read(field, 'foreground_window_owner_missing', 'foreground_window_owner_conflict', /^\d+$/);
    if (value !== undefined) facts[output] = Number(value);
  }
  const packageName = read('package', 'foreground_window_owner_missing', 'foreground_window_owner_conflict', packagePattern);
  if (packageName !== undefined) facts.packageName = packageName;
  const session = read('mSession', 'foreground_window_owner_missing', 'foreground_window_owner_conflict', /^Session\s*\{\s*\w+\s+\d+\s*:[^}]+\}$/);
  if (session !== undefined) facts.ownerPid = Number(session.match(/\s(\d+)\s*:/)[1]);
  if (failure) return { ...failure, ...facts, ok: false };
  const { displayId, ownerUid, ownerPid } = facts;
  if (owner.title !== windowTitle || ownerPid <= 0 || Math.floor(ownerUid / 100000) !== userId
    || (focus.displayId != null && focus.displayId !== displayId)
    || (focus.focusedDisplayId != null && focus.focusedDisplayId !== displayId)) return reject('foreground_window_owner_conflict');
  const attrs = read('mAttrs', 'foreground_window_type_missing', 'foreground_window_type_conflict');
  if (failure) return failure;
  if (!/^(?:[A-Za-z_$][\w.$]*\s*)?\{[\s\S]*\}$/.test(attrs)) return reject('foreground_window_attributes_invalid', 'mAttrs', [attrs]);
  const attributes = fields(attrs.slice(attrs.indexOf('{') + 1, -1));
  if (attributes.has('mAttrs')) return reject('foreground_window_attributes_invalid', 'mAttrs', [attrs]);
  const type = read('ty', 'foreground_window_type_missing', 'foreground_window_type_conflict', null, attributes);
  if (failure) return failure;
  const symbolicType = type.replace(/^(?:android\.view\.)?(?:WindowManager\.)?LayoutParams\./, '').replace(/^TYPE_/, '');
  const windowType = /^\d+$/.test(type) ? Number(type) : windowTypes[symbolicType];
  if (!knownTypes.has(windowType)) return reject('foreground_window_type_unsupported', 'ty', [type]);
  const windowKind = windowType < 2000 ? 'activity' : 'non-activity';
  Object.assign(facts, { windowKind, windowType });
  const bindings = ['mActivityRecord', 'mAppToken'].flatMap(name => values.get(name) || []).filter(value => value !== 'null');
  let activity = null, component = null, taskId = null, activityToken = null;
  if (windowKind === 'activity') {
    const records = bindings.flatMap(value => [...value.matchAll(/ActivityRecord\s*\{\s*(\w+)\s+u(\d+)\s+([^\s}]+)\s+t(\d+)(?:[^}]*)\}/g)]);
    const identities = [...new Map(records.map(record => [JSON.stringify(record.slice(1)), record])).values()];
    if (identities.length !== 1) return reject(identities.length ? 'foreground_activity_ambiguous' : 'foreground_activity_missing', 'ActivityRecord', bindings);
    const record = identities[0];
    const parsed = record[3].match(/^([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\/(\.?[A-Za-z0-9_.$]+)$/);
    taskId = Number(record[4]); activityToken = record[1];
    // stackId/rootTaskId and LayoutParams.taskId do not denote this task.
    const declaredTasks = values.get('taskId') || [];
    if (!parsed || parsed[1] !== packageName || Number(record[2]) !== userId
      || declaredTasks.some(value => !/^-?\d+$/.test(value) || Number(value) !== taskId)) return reject('foreground_activity_owner_conflict', 'ActivityRecord', bindings);
    activity = parsed[2].startsWith('.') ? `${packageName}${parsed[2]}` : parsed[2];
    component = `${packageName}/${activity}`;
  } else if (bindings.length || values.has('taskId')) return reject('foreground_window_type_conflict');
  return { ...facts, ok: true, activity, component, taskId, activityToken,
    projectedComponent: focus.component ?? null, raw: focus.raw,
    windowIdentity: JSON.stringify([windowToken, userId, displayId, windowType, taskId, activityToken, ownerPid, ownerUid]),
  };
}

function verifyForegroundPackageUid(foreground, raw) {
  foreground = { ...foreground, evidence: { ...foreground.evidence, package: String(raw) } };
  const reject = error => ({ ...foreground, ok: false, ownershipVerified: false, error });
  const dump = String(raw).split(/\r?\n/);
  // Updated system apps also appear under "Hidden system packages:" with their
  // old bundled version. Only the active Packages section identifies the owner.
  const sections = dump.flatMap((line, index) => line.trim() === 'Packages:' ? [index] : []);
  if (sections.length !== 1) return reject('foreground_package_uid_unverified');
  const sectionStart = sections[0], sectionIndent = dump[sectionStart].search(/\S/);
  let sectionEnd = sectionStart + 1;
  while (sectionEnd < dump.length && (!dump[sectionEnd].trim() || dump[sectionEnd].search(/\S/) > sectionIndent)) sectionEnd++;
  const lines = dump.slice(sectionStart + 1, sectionEnd);
  const headers = lines.flatMap((line, index) => line.trim().startsWith(`Package [${foreground.packageName}] (`) ? [index] : []);
  if (headers.length !== 1) return reject('foreground_package_uid_unverified');
  const start = headers[0], indent = lines[start].search(/\S/);
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || lines[end].search(/\S/) > indent)) end++;
  const body = lines.slice(start + 1, end);
  foreground.evidence.package = lines.slice(start, end).join('\n');
  // PackageManager's userId field was renamed appId; both denote the app ID,
  // never a full multi-user UID. This matches android-permissions' contract.
  const ids = body.map(line => /^\s+(?:appId|userId)=(\d+)\s*$/.exec(line)).filter(Boolean);
  const users = body.filter(line => new RegExp(`^\\s+User ${foreground.userId}:`).test(line));
  if (ids.length !== 1 || Number(ids[0][1]) >= 100000 || users.length !== 1
    || !/\binstalled=true\b/.test(users[0])) return reject('foreground_package_uid_unverified');
  const packageUid = foreground.userId * 100000 + Number(ids[0][1]);
  if (packageUid !== foreground.ownerUid) return { ...reject('foreground_package_uid_mismatch'), packageUid };
  return { ...foreground, packageUid, ownershipVerified: true };
}

function verifyForegroundProcessIdentity(foreground, raw) {
  foreground = { ...foreground, evidence: { ...foreground.evidence, process: String(raw) } };
  const lines = String(raw).split(/\r?\n/), bootId = lines[0];
  const stat = (lines[1] || '').match(/^(\d+) \((.*)\) ([A-Za-z]) (.+)$/);
  const pids = lines.map(line => line.match(/^Pid:\s+(\d+)\s*$/)).filter(Boolean);
  const uids = lines.map(line => line.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/)).filter(Boolean);
  const reject = error => ({ ...foreground, ok: false, ownershipVerified: false, error });
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId)
    || !stat || pids.length !== 1 || uids.length !== 1) return reject('foreground_process_identity_missing');
  const processStartTicks = stat[4].split(/\s+/)[18]; // /proc/PID/stat field 22.
  if (!/^[1-9][0-9]*$/.test(processStartTicks || '') || Number(stat[1]) !== foreground.ownerPid
    || Number(pids[0][1]) !== foreground.ownerPid || uids[0].slice(1).some(uid => Number(uid) !== foreground.ownerUid)) {
    return reject('foreground_process_owner_conflict');
  }
  const processIdentity = JSON.stringify([bootId, foreground.ownerPid, foreground.ownerUid, processStartTicks]);
  return { ...foreground, bootId, processStartTicks, processIdentity,
    windowIdentity: JSON.stringify([foreground.windowIdentity, processIdentity]) };
}

module.exports = { parseForegroundWindowIdentity, verifyForegroundPackageUid, verifyForegroundProcessIdentity,
  sameForegroundWindow, validForegroundIdentity };
