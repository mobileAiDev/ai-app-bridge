'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

// The caller flushes the source file before publishing its name. Windows uses
// the native write-through rename instead of trying to fsync a directory fd.
function durableRename(source, destination) {
  if (process.platform === 'win32') {
    require('@mobileaidev/segmented-fact-store-native').durableRename(source, destination);
    return;
  }
  fs.renameSync(source, destination);
  syncDirectory(path.dirname(destination));
  if (path.dirname(source) !== path.dirname(destination)) syncDirectory(path.dirname(source));
}

function writeFlushed(file, bytes) {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function durableCreate(file, bytes) {
  if (process.platform !== 'win32') {
    writeFlushed(file, bytes);
    syncDirectory(path.dirname(file));
    return;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFlushed(temporary, bytes);
    // false preserves exclusive creation: existing evidence is never replaced.
    require('@mobileaidev/segmented-fact-store-native').durableRename(temporary, file, false);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (cleanup) { if (cleanup.code !== 'ENOENT') error.cleanupError = cleanup.code; }
    throw error;
  }
}

function durableRemove(file) {
  if (process.platform !== 'win32') {
    fs.unlinkSync(file);
    syncDirectory(path.dirname(file));
    return;
  }
  // Retire the active name durably before deleting the retired bytes. A crash
  // between these calls may retain the retired file, but cannot restore an owner.
  const retired = `${file}.${randomUUID()}.retired`;
  require('@mobileaidev/segmented-fact-store-native').durableRename(file, retired, false);
  fs.unlinkSync(retired);
}

function durableCreateDirectory(directory) {
  if (process.platform !== 'win32') {
    fs.mkdirSync(directory);
    syncDirectory(path.dirname(directory));
    return;
  }
  const temporary = `${directory}.${randomUUID()}.tmp`;
  fs.mkdirSync(temporary);
  try { require('@mobileaidev/segmented-fact-store-native').durableRename(temporary, directory, false); }
  catch (error) {
    try { fs.rmdirSync(temporary); } catch (cleanup) { if (cleanup.code !== 'ENOENT') error.cleanupError = cleanup.code; }
    throw error;
  }
}

module.exports = { durableRename, durableCreate, durableRemove, durableCreateDirectory, syncDirectory };
