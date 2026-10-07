'use strict';

// Explicit Android service responses, shared by fake ADB transports. These are
// fixtures, not a second implementation of the production owner resolver.
function androidForegroundFixture(packageName, options = {}) {
  const userId = options.userId ?? 0, appId = options.appId ?? 10001;
  const uid = userId * 100000 + appId, pid = options.pid ?? 4321;
  const token = options.token ?? 'aabbcc', displayId = options.displayId ?? 0;
  const activity = options.activity ?? `${packageName}.MainActivity`;
  const title = options.title ?? `${packageName}/${activity}`;
  const taskId = options.taskId ?? 23, kind = options.windowKind ?? 'activity';
  const type = options.windowType ?? (kind === 'activity' ? 'BASE_APPLICATION' : 'STATUS_BAR_PANEL');
  const bootId = options.bootId ?? '1457c3c8-cc65-4fa8-b835-fd601361df91';
  const startTicks = options.startTicks ?? '34951868';
  const activityRecord = `ActivityRecord{ddeeff u${userId} ${packageName}/${activity} t${taskId}}`;
  const version = options.apiLevel ?? 36;
  const container = kind !== 'activity' ? '' : version <= 25 ? ' stackId=1' : version <= 30 ? ' rootTaskId=1' : ` taskId=${taskId}`;
  const binding = kind !== 'activity' ? '' : version <= 25
    ? `    mAppToken=AppWindowToken{ffee11 token=Token{eeff22 ${activityRecord}}}\n`
    : `    mActivityRecord=${activityRecord}\n`;
  const windowDump = `  Display: mDisplayId=${displayId}\n  mCurrentFocus=Window{${token} u${userId} ${title}}\n  mTopFocusedDisplayId=${displayId}\nWINDOW MANAGER WINDOWS (dumpsys window windows)\n  Window #0 Window{${token} u${userId} ${title}}:\n    mDisplayId=${displayId}${container} mSession=Session{ccbbaa ${pid}:u${userId}a${appId}} mClient=android.os.BinderProxy@aa\n    mOwnerUid=${uid} showForAllUsers=false package=${packageName} appop=NONE\n    mAttrs={(0,0)(fillxfill) ty=${version <= 25 && type === 'BASE_APPLICATION' ? '1' : type}}\n${binding}`;
  const processDump = `${bootId}\n${pid} (fixture owner) S 1 1 1 0 -1 4194624 0 0 0 0 0 0 0 0 20 0 1 0 ${startTicks} 0 0\nPid:\t${pid}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
  const packageDump = `Packages:\n  Package [${packageName}] (aabbcc):\n    ${version <= 25 ? 'userId' : 'appId'}=${appId}\n    User ${userId}: installed=true hidden=false stopped=false\n`;
  return { windowDump, processDump, packageDump, pid, uid, userId, packageName };
}

function handleAndroidForegroundFixture(args, packageName, options = {}) {
  const fixture = androidForegroundFixture(packageName, options);
  const command = args[0] === '-s' ? args.slice(2) : args;
  let output;
  if (command.join(' ') === 'shell dumpsys window -a') output = fixture.windowDump;
  else if (command.join(' ') === `shell dumpsys package ${packageName}`) output = fixture.packageDump;
  else if (command.join(' ') === `shell cat /proc/sys/kernel/random/boot_id /proc/${fixture.pid}/stat /proc/${fixture.pid}/status`) output = fixture.processDump;
  else return false;
  process.stdout.write(output);
  return true;
}

module.exports = { androidForegroundFixture, handleAndroidForegroundFixture };
