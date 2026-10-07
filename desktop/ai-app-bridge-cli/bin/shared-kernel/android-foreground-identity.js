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

// Resolve only the WindowState selected by focus token/user/display. Window
// titles are client data and are never substituted for the OS owner or Activity.
function parseForegroundWindowIdentity(raw, focus) {
  if (!focus.ok) return focus;
  const focused = focus.raw.match(/^mCurrentFocus(?:\[\d+\])?\s*[:=]\s*Window\{(\w+) u(\d+) (.+)\}$/);
  if (!focused) return { ok: false, error: 'foreground_window_identity_missing', focus };
  const [, windowToken, rawUserId, windowTitle] = focused;
  const userId = Number(rawUserId);
  const blocks = [];
  let block = null;
  for (const line of String(raw).split(/\r?\n/)) {
    if (/^WINDOW MANAGER\b/.test(line)) block = null;
    const heading = line.match(/^\s*Window #\d+ Window\{(\w+) u(\d+) (.+)\}:\s*$/);
    if (heading) {
      block = { token: heading[1], userId: Number(heading[2]), title: heading[3], lines: [] };
      blocks.push(block);
    } else if (block) block.lines.push(line);
  }
  const reject = error => ({ ok: false, error, focus });
  const owners = blocks.filter(item => item.token === windowToken && item.userId === userId);
  if (owners.length !== 1) return reject(owners.length ? 'foreground_window_identity_ambiguous' : 'foreground_window_identity_missing');
  const owner = owners[0];
  // API 25 prints stackId, API 30 rootTaskId, and newer releases taskId.
  // Only taskId denotes this Activity's task; the others are not interchangeable.
  const metadata = owner.lines.map(line => line.match(/^\s*mDisplayId=(\d+)\b(.*?)\bmSession=Session\{\w+ (\d+):[^}]+\}/)).filter(Boolean);
  const packages = owner.lines.map(line => line.match(/^\s*mOwnerUid=(\d+)\b.*\bpackage=([^\s]+)(?:\s|$)/)).filter(Boolean);
  const attributes = owner.lines.map(line => line.match(/^\s*mAttrs=\{.*\bty=([A-Z_]+|\d+)(?:\s|\})/)).filter(Boolean);
  if (metadata.length !== 1 || packages.length !== 1) return reject('foreground_window_owner_missing');
  if (attributes.length !== 1) return reject('foreground_window_type_missing');
  const type = attributes[0][1];
  const windowType = /^\d+$/.test(type) ? Number(type) : windowTypes[type];
  if (!knownTypes.has(windowType)) return reject('foreground_window_type_unsupported');
  const [, rawDisplayId, container, rawPid] = metadata[0];
  const [, rawUid, packageName] = packages[0];
  const displayId = Number(rawDisplayId), ownerPid = Number(rawPid), ownerUid = Number(rawUid);
  if (!packagePattern.test(packageName) || owner.title !== windowTitle || ownerPid <= 0
    || Math.floor(ownerUid / 100000) !== userId
    || (focus.displayId !== null && focus.displayId !== displayId)
    || (focus.focusedDisplayId !== null && focus.focusedDisplayId !== displayId)) return reject('foreground_window_owner_conflict');
  // These are the two explicit Android WindowState Activity binding formats.
  // mFocusedApp is not a binding and may describe an app behind a system window.
  const activityLines = owner.lines.filter(line => /^\s*mActivityRecord=/.test(line) || /^\s*mAppToken=/.test(line));
  let activity = null, component = null, taskId = null, activityToken = null;
  const windowKind = windowType < 2000 ? 'activity' : 'non-activity';
  if (windowKind === 'activity') {
    if (activityLines.length !== 1) return reject(activityLines.length ? 'foreground_activity_ambiguous' : 'foreground_activity_missing');
    const record = activityLines[0].match(/ActivityRecord\{(\w+) u(\d+) ([^\s}]+) t(\d+)(?:[^}]*)\}/);
    if (!record) return reject('foreground_activity_missing');
    const parsed = record[3].match(/^([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\/(\.?[A-Za-z0-9_.$]+)$/);
    const declaredTask = container.match(/\btaskId=(-?\d+)\b/);
    taskId = Number(record[4]); activityToken = record[1];
    if (!parsed || parsed[1] !== packageName || Number(record[2]) !== userId
      || (declaredTask && Number(declaredTask[1]) !== taskId)) return reject('foreground_activity_owner_conflict');
    activity = parsed[2].startsWith('.') ? `${packageName}${parsed[2]}` : parsed[2];
    component = `${packageName}/${activity}`;
  } else if (activityLines.length || /\btaskId=/.test(container)) {
    return reject('foreground_window_type_conflict');
  }
  return { ok: true, source: 'mCurrentFocus', packageName, activity, component, windowKind, windowType,
    windowTitle, projectedComponent: focus.component ?? null, raw: focus.raw,
    windowToken, userId, displayId, taskId, activityToken, ownerPid, ownerUid,
    windowIdentity: JSON.stringify([windowToken, userId, displayId, windowType, taskId, activityToken, ownerPid, ownerUid]),
  };
}

function verifyForegroundPackageUid(foreground, raw) {
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
