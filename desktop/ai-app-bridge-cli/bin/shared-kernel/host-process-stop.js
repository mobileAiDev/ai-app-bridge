'use strict';

const { execFileSync } = require('node:child_process');
const { CommandError } = require('../command-errors');

function processInfo(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (process.platform === 'win32') {
      const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){@{start=$p.CreationDate.ToUniversalTime().ToString('O');command=$p.CommandLine}|ConvertTo-Json -Compress}`],
      { encoding: 'utf8', timeout: 3000, windowsHide: true });
      return raw.trim() ? JSON.parse(raw) : null;
    }
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
function processStart() { return ownStart ||= processInfo(process.pid)?.start; }

async function stopHosts(owner, endpoint) {
  const stopped = [];
  for (const item of [owner, endpoint]) {
    if (!item || stopped.includes(item.pid)) continue;
    const info = processInfo(item.pid);
    if (!info) continue;
    if (item.pid === process.pid) throw new CommandError('force_stop_requires_control_client',
      'Run device-ownership force-stop through CLI or MCP, outside the execution owner.');
    const identified = item.processStart ? item.processStart === info.start
      : /[\\/]bin[\\/](execution-runtime|ai-app-bridge|mcp-server)\.js(?:\s|$)/.test(info.command);
    // PID reuse means the original Host is gone. It must neither block reset
    // nor cause an unrelated replacement process to be killed.
    if (!identified) continue;
    try {
      if (process.platform === 'win32') execFileSync('taskkill.exe', ['/PID', String(item.pid), '/F', '/T'], { timeout: 5000, windowsHide: true, stdio: 'pipe' });
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

module.exports = { processStart, stopHosts };
