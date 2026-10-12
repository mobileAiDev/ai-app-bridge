'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileBounded } = require('./execution-io');
const { runDeviceEffect } = require('./device-mutation-lease');
const { CommandError } = require('../command-errors');

// An explicit expert primitive. Interpret neither ADB commands nor remote shell
// code. Completion describes the ADB process; the caller verifies device effects.
async function adbExec({ argv, serial, adb = process.env.ADB || 'adb', timeoutMs = 30000, readOnly = false, outFile }) {
  if (serial) {
    // ADB transport flags precede the command. Flags inside `shell` belong to
    // the remote program and must not be parsed as Host transport options.
    for (let i = 0; i < argv.length && argv[i].startsWith('-'); i++) {
      const flag = argv[i];
      if (['-d', '-e'].includes(flag) || flag.startsWith('-t') || flag === '-s' && argv[i + 1] !== serial
        || flag.startsWith('-s') && flag !== '-s' && flag.slice(2) !== serial)
        throw new CommandError('adb_target_conflict', 'serial and argv select different ADB transports. Use serial alone, or omit it and supply the transport explicitly in argv.');
      if (['-s', '-H', '-P', '-L'].includes(flag)) i++;
    }
  }
  const args = serial ? ['-s', serial, ...argv] : argv;
  const execute = async () => {
    let result, exitCode = 0;
    try {
      result = await execFileBounded(adb, args, { timeoutMs, mutation: !readOnly,
        encoding: outFile ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    } catch (error) {
      if (!Number.isInteger(error.code)) throw error;
      // A real nonzero process exit is a known failure, not a lost response.
      result = error; exitCode = error.code;
    }
    const reply = { ok: exitCode === 0, ...(exitCode ? { error: 'adb_exit_nonzero' } : {}),
      mechanism: 'adb', completionScope: 'adb-process', exitCode,
      dispatched: true, ambiguous: false, settled: true, stderr: String(result.stderr) };
    if (outFile) {
      const file = path.resolve(outFile);
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, result.stdout);
      } catch (error) {
        return { ...reply, ok: false, error: 'adb_output_write_failed', message: error.message,
          outFile: file, stdoutBytes: result.stdout.length };
      }
      return { ...reply, outFile: file, stdoutBytes: result.stdout.length };
    }
    return { ...reply, stdout: result.stdout };
  };
  return serial && !readOnly
    ? runDeviceEffect({ kind: 'adb', commandSha256: createHash('sha256').update(JSON.stringify(args)).digest('hex') }, execute)
    : execute();
}

module.exports = { adbExec };
