'use strict';

const { execFileSync } = require('node:child_process');
const { CommandError } = require('../command-errors');

function processInfo(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (process.platform === 'win32') {
    const native = require('@mobileaidev/segmented-fact-store-native');
    const start = native.windowsProcessStart(pid);
    if (start === null) return null;
    const raw = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){@{command=$p.CommandLine}|ConvertTo-Json -Compress}`],
    { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (native.windowsProcessStart(pid) !== start) return null;
    const value = raw.trim() ? JSON.parse(raw) : null;
    if (typeof value?.command !== 'string') throw new CommandError('host_process_inspection_failed',
      'Windows could not read the live process command line. The process was not treated as stopped.', { details: { pid } });
    return { start, command: value.command };
  }
  try {
    const raw = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'pgid=', '-o', 'args='],
      { encoding: 'utf8', timeout: 3000, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const match = raw.trim().match(/^(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(\d+)\s+([\s\S]+)$/);
    return match ? { start: match[1], group: Number(match[2]), command: match[3] } : null;
  } catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
}

let ownStart;
function processStart() {
  return ownStart ||= process.platform === 'win32'
    ? require('@mobileaidev/segmented-fact-store-native').windowsProcessStart(process.pid)
    : processInfo(process.pid)?.start;
}

function isBridgeHostCommand(command, names = ['execution-runtime', 'ai-app-bridge', 'mcp-server']) {
  // Windows quotes paths containing spaces, including the .js argument.
  return typeof command === 'string' && new RegExp(`[\\\\/]bin[\\\\/](${names.join('|')})\\.js(?:["']?\\s|["']?$)`).test(command);
}

async function stopHosts(owner, endpoint) {
  const stopped = [];
  for (const item of [owner, endpoint]) {
    if (!item || stopped.includes(item.pid)) continue;
    const info = processInfo(item.pid);
    if (!info) continue;
    if (item.pid === process.pid) throw new CommandError('force_stop_requires_control_client',
      'Run device-ownership force-stop through CLI or MCP, outside the execution owner.');
    const identified = item.processStart ? item.processStart === info.start
      : isBridgeHostCommand(info.command);
    // PID reuse means the original Host is gone. It must neither block reset
    // nor cause an unrelated replacement process to be killed.
    if (!identified) continue;
    try {
      if (process.platform === 'win32') {
        // Host exit closes its unfinished execution Jobs. Check and terminate
        // through one kernel handle, rather than reinterpreting a PID in taskkill.
        if (!require('@mobileaidev/segmented-fact-store-native').windowsTerminateProcess(item.pid, info.start)) continue;
      }
      else if (info.group === item.pid) process.kill(-item.pid, 'SIGKILL');
      else {
        const inventory = execFileSync('ps', ['-axo', 'pid=', '-o', 'ppid='],
          { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
        const pairs = inventory.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
        const descendants = [item.pid];
        for (let i = 0; i < descendants.length; i++)
          for (const [pid, parent] of pairs) if (parent === descendants[i]) descendants.push(pid);
        for (const pid of descendants.reverse()) {
          try { process.kill(pid, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      }
      stopped.push(item.pid);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  return stopped;
}

module.exports = { processStart, processInfo, stopHosts, isBridgeHostCommand };
