'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CommandError } = require('../command-errors');
const { executablePath } = require('./executable-path');
const { requestDirectory } = require('./request-context');
const { execFileBounded } = require('./execution-io');
const { checkExecution } = require('./execution-scope');
const { ConnectionCache } = require('../connection-cache');
const executableProvenance = new ConnectionCache({ ttlMs: 3600000, maxEntries: 32 });

// A binding captures the server namespace and executable identity before I/O.
// A wrapper remains supported via its normal CLI/forward path. Its private
// routing behavior is not inferred from its filename alone. Version provenance
// distinguishes a native delegate from the adb executable it invokes.
function adbExecutableIdentity(command) {
  const resolved = executablePath(command, { cwd: requestDirectory() });
  if (!resolved) return { path: command, unavailable: true, nativeExecutable: false };
  const stat = fs.statSync(resolved);
  const fd = fs.openSync(resolved, 'r');
  const magic = Buffer.alloc(4);
  try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
  const native = ['7f454c46', 'cffaedfe', 'feedfacf', 'cefaedfe', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf'].includes(magic.toString('hex')) || magic.subarray(0, 2).toString() === 'MZ';
  return { path: resolved, device: stat.dev, inode: stat.ino, size: stat.size, modifiedMs: stat.mtimeMs, changedMs: stat.ctimeMs,
    nativeExecutable: native };
}

async function standardAdbIdentity(ctx, binding) {
  const executable = binding.executable;
  if (!executable.nativeExecutable || !/^adb(?:\.exe)?$/i.test(path.basename(executable.path))) return { nativeAdb: false, reason: 'custom_adb_executable' };
  return executableProvenance.getOrCreate(JSON.stringify(executable), async () => {
    let stdout;
    try { ({ stdout } = await execFileBounded(executable.path, ['version'], { encoding: 'utf8', timeoutMs: ctx.adbTimeoutMs || 5000,
      maxBuffer: 16384, env: { ...process.env, ADB_SERVER_SOCKET: binding.server.socket } })); }
    catch (error) { checkExecution(); return { nativeAdb: false, reason: 'adb_identity_unverified' }; }
    const installed = /^Installed as (.+)$/m.exec(stdout)?.[1]?.trim();
    if (!/^Android Debug Bridge version [^\r\n]+$/m.test(stdout) || !installed) return { nativeAdb: false, reason: 'custom_adb_executable' };
    let actual;
    try { actual = fs.realpathSync(installed); }
    catch { return { nativeAdb: false, reason: 'adb_identity_unverified' }; }
    return { nativeAdb: actual === executable.path, reason: actual === executable.path ? 'native_adb' : 'custom_adb_executable' };
  });
}

function parseAdbServer(socket) {
  const invalid = () => new CommandError('adb_server_socket_invalid', 'adbServerSocket must be tcp:HOST:PORT, tcp:PORT, localfilesystem:PATH, or localabstract:NAME (Linux).', { field: 'adbServerSocket', dispatched: false, ambiguous: false });
  const tcp = /^tcp:(?:(\[[^\]]+\]|[^:]+):)?([0-9]+)$/.exec(socket);
  if (tcp) {
    const host = tcp[1]?.replace(/^\[|\]$/g, '') || '127.0.0.1';
    const port = Number(tcp[2]);
    if (!port || port > 65535 || /\s/.test(host)) throw invalid();
    return { socket: `tcp:${host.includes(':') ? `[${host}]` : host}:${port}`, host, port };
  }
  if (socket.startsWith('localfilesystem:') && path.isAbsolute(socket.slice(16))) return { socket, path: socket.slice(16) };
  if (socket.startsWith('localabstract:') && socket.length > 14 && process.platform === 'linux') return { socket, path: `\0${socket.slice(14)}` };
  throw invalid();
}

function adbServerSocket(options = {}, env = process.env) {
  if (options.adbServerSocket !== undefined) return options.adbServerSocket;
  if (env.ADB_SERVER_SOCKET) return env.ADB_SERVER_SOCKET;
  const host = env.ANDROID_ADB_SERVER_ADDRESS || '127.0.0.1';
  return `tcp:${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${env.ANDROID_ADB_SERVER_PORT || 5037}`;
}

function resolveAdbBinding(ctx) {
  const executable = adbExecutableIdentity(ctx.adb);
  const server = parseAdbServer(ctx.adbServerSocket ?? adbServerSocket());
  return { executable, server };
}

function selectSdkTransport({ sdkTransport = 'auto', explicitPort = false, adbIdentity }) {
  if (!['auto', 'direct', 'forward'].includes(sdkTransport)) throw new CommandError('invalid_argument', 'sdkTransport must be auto, direct or forward.', { field: 'sdkTransport' });
  if (sdkTransport === 'direct' && explicitPort) throw new CommandError('sdk_transport_conflict', 'direct addresses the device socket; --port selects an ADB forward. Omit port or choose sdkTransport=forward.', { dispatched: false, ambiguous: false });
  if (sdkTransport === 'direct' && !adbIdentity.nativeAdb) throw new CommandError('sdk_direct_requires_native_adb', 'Direct SDK transport requires a native adb executable. Use sdkTransport=forward with a wrapper.', { dispatched: false, ambiguous: false });
  if (sdkTransport === 'forward') return { transport: 'forward', reason: 'caller_selected' };
  if (explicitPort) return { transport: 'forward', reason: 'explicit_port' };
  if (!adbIdentity.nativeAdb) return { transport: 'forward', reason: adbIdentity.reason || 'custom_adb_executable' };
  return { transport: 'direct', reason: sdkTransport === 'auto' ? 'native_adb' : 'caller_selected' };
}

function routeKey(binding, ctx, transport) {
  return JSON.stringify([binding.executable, binding.server.socket, ctx.serial, ctx.packageName, transport, ctx.explicitPort ? ctx.port : null]);
}

function assertOriginalExecutable(route) {
  if (JSON.stringify(adbExecutableIdentity(route.executable.path)) !== JSON.stringify(route.executable))
    throw new CommandError('adb_executable_changed', 'The ADB executable used by the original operation has changed. Restore that executable before querying the original route.', { dispatched: false, ambiguous: false });
}

module.exports = { adbExecutableIdentity, standardAdbIdentity, parseAdbServer, adbServerSocket, resolveAdbBinding, selectSdkTransport, routeKey, assertOriginalExecutable };
