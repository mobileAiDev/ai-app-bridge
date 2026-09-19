'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { CommandError } = require('../command-errors');
const { requestDirectory } = require('../shared-kernel/request-context');
const { inspectPython } = require('../script/python-runtime-adapter');
const { executablePath } = require('../shared-kernel/executable-path');

function prepareExtraction(extract) {
  if (extract === null) return null;
  const timeoutMs = extract.timeoutMs ?? 2000;
  const reject = (message, field, code = 'invalid_argument') => { throw new CommandError(code, message, { field }); };
  if (extract.mode === 'regex') {
    const flags = extract.flags ?? '';
    if (new Set(flags).size !== flags.length) reject('Regex flags must be unique.', 'extract.flags');
    if (extract.inputPath !== '' && (!extract.inputPath.startsWith('/') || /~(?![01])/u.test(extract.inputPath))) {
      reject('inputPath must be a JSON Pointer (for example /text; escape ~ as ~0 and / as ~1).', 'extract.inputPath');
    }
    try { new RegExp(extract.pattern, flags); }
    catch (error) { reject(error.message, 'extract.pattern'); }
    return { ...extract, flags, timeoutMs };
  }
  const cwd = requestDirectory();
  const filename = extract.sourcePath ? path.resolve(cwd, extract.sourcePath) : `extract.${extract.language === 'python' ? 'py' : 'js'}`;
  let source = extract.source;
  if (extract.sourcePath) {
    try {
      if (fs.statSync(filename).size > 65536) reject('Extraction source exceeds 64 KiB UTF-8.', 'extract.sourcePath');
      source = fs.readFileSync(filename, 'utf8');
    } catch (error) {
      if (error instanceof CommandError) throw error;
      reject(`Cannot read extraction source: ${error.message}`, 'extract.sourcePath', 'extraction_source_unavailable');
    }
  }
  if (!source.length || Buffer.byteLength(source) > 65536) reject('Extraction source must contain 1–65536 UTF-8 bytes.', extract.sourcePath ? 'extract.sourcePath' : 'extract.source');
  let executable = process.execPath;
  if (extract.language === 'javascript') {
    try { new vm.Script(Module.wrap(source), { filename }); }
    catch (error) { reject(`${filename}: ${error.message}`, 'extract.source', 'extraction_syntax_error'); }
  } else {
    const python = inspectPython();
    if (!python.available) reject('Python 3.9+ is required only for Python extraction. Set AI_APP_BRIDGE_PYTHON to an available interpreter.', 'extract.language', 'extraction_runtime_unavailable');
    executable = executablePath(python.executable);
    if (!executable) reject('The selected Python interpreter is unavailable.', 'extract.language', 'extraction_runtime_unavailable');
    const checked = spawnSync(executable, ['-c', 'import sys; compile(sys.stdin.read(), sys.argv[1], "exec")', filename],
      { input: source, encoding: 'utf8', timeout: 5000, maxBuffer: 16384, cwd });
    if (checked.error) reject(checked.error.message, 'extract.language', 'extraction_runtime_unavailable');
    if (checked.status !== 0) reject(checked.stderr.trim(), 'extract.source', 'extraction_syntax_error');
  }
  return { mode: 'script', language: extract.language, source, filename, cwd, executable, timeoutMs };
}

module.exports = { prepareExtraction };
