'use strict';

const { CommandError } = require('../command-errors');

function validateLogcatQuery(options) {
  if (options.grepMode !== 'regex' || !options.grep) return;
  try { new RegExp(options.grep, options.grepCaseSensitive ? '' : 'i'); }
  catch (error) { throw new CommandError('invalid_argument', `Invalid logcat regex: ${error.message}`, { field: 'grep' }); }
}

function priority(value) {
  return { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, A: 5 }[String(value || '').trim().toUpperCase()] ?? -1;
}

function parseLine(line) {
  const match = /^\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d+\s+(\d+)\s+(\d+)\s+([VDIWEAF])\s+([^:]+):\s?(.*)$/.exec(line);
  return match ? { pid: match[1], priority: match[3], tag: match[4].trim() } : null;
}

// Regex mode is invoked by queryLogcat in an isolated extraction worker.
// Literal mode stays synchronous and does not pay a worker startup cost.
function filterLogcat(text, options) {
  const tags = String(options.tag || options.tags || '').split(',').map(tag => tag.trim()).filter(Boolean);
  const grep = options.grep ? String(options.grep) : '';
  const regex = options.grepMode === 'regex' && grep ? new RegExp(grep, options.grepCaseSensitive ? '' : 'i') : null;
  const needle = options.grepCaseSensitive ? grep : grep.toLowerCase();
  const matches = line => !grep || (regex ? regex.test(line) : (options.grepCaseSensitive ? line : line.toLowerCase()).includes(needle));
  const minLevel = priority(options.level || options.minLevel);
  const pid = options.pid ? String(options.pid) : '';
  const requiresAppPid = options.appPid || options.packagePid || options.pid === 'current';
  if (requiresAppPid && !pid) return '';
  const needsMetadata = Boolean(pid || tags.length || minLevel >= 0);
  const filtered = [];
  let header = null, eligible = false, included = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line) continue;
    const parsed = parseLine(line);
    if (parsed) {
      header = line;
      eligible = (!pid || parsed.pid === pid) && (!tags.length || tags.includes(parsed.tag))
        && (minLevel < 0 || priority(parsed.priority) >= minLevel);
      included = eligible && matches(line);
      if (included) filtered.push(line);
    } else if (header) {
      if (eligible && (included || matches(line))) {
        if (!included) filtered.push(header);
        filtered.push(line); included = true;
      }
    } else if (!needsMetadata && matches(line)) filtered.push(line);
  }
  const limit = Number(options.limitLines || options.outputLines || 0);
  return (limit > 0 && filtered.length > limit ? filtered.slice(-limit) : filtered).join('\n');
}

async function queryLogcat(text, options) {
  if ((options.appPid || options.packagePid) && !options.pid) return { ok: false, error: 'logcat_app_pid_unavailable', text: '',
    message: 'No running App PID was found. Start the App, or omit appPid to inspect device logs.' };
  const metadata = options.pid || options.tag || options.tags || options.level || options.minLevel;
  if (metadata && text.trim() && !text.split(/\r?\n/).some(parseLine)) return { ok: false, error: 'logcat_format_not_filterable', text,
    filterApplied: false, message: 'PID, tag and level filters need threadtime fields. The collected text is retained; request format: "threadtime" for these filters.' };
  if (options.grepMode !== 'regex' || !options.grep) return { ok: true, text: filterLogcat(text, options) };
  validateLogcatQuery(options);
  const filtered = await require('../extraction/runner').runExtraction({ mode: 'script', language: 'javascript', timeoutMs: 2000,
    source: `module.exports.main = ctx => require(${JSON.stringify(__filename)}).filterLogcat(ctx.inputs.response.text, ctx.inputs.response.options);`,
  }, { response: { text, options } });
  return filtered.ok ? { ok: true, text: filtered.result } : { ok: false, error: 'logcat_filter_failed', cause: filtered.error,
    text, filterApplied: false, message: 'The regex filter did not finish. The collected text is retained; filter this response instead of repeating logcat or clearing the buffer.' };
}

function logcatGuidance(args, value) {
  const output = typeof value === 'string' ? value : value?.text;
  let message, changes;
  if (value?.error === 'logcat_format_not_filterable') {
    message = value.message; changes = { format: 'threadtime' };
  } else if (value?.error === 'logcat_app_pid_unavailable') {
    message = value.message; changes = { appPid: false };
  } else if (output === '' && args.grep && args.grepMode !== 'regex' && /[|()[\]{}^$*+?\\]/.test(args.grep)) {
    message = 'No literal matches. grep defaults to literal text; use grepMode: "regex" if the pattern is an expression (for example A|B).';
    changes = { grepMode: 'regex' };
  } else return null;
  const parameters = { ...args, ...changes, clear: false };
  delete parameters.clearFirst; delete parameters.requestId;
  try { require('../command-registry').validateCommandArguments('logcat', parameters); }
  catch { return { message, nextActions: [] }; }
  return { message, nextActions: [{ command: 'logcat', arguments: parameters }] };
}

module.exports = { validateLogcatQuery, filterLogcat, queryLogcat, logcatGuidance };
