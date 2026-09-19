'use strict';

function boundedText(value, maxBytes) {
  return Buffer.from(String(value)).subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '');
}

function errorDiagnostic(error) {
  const stack = typeof error?.stack === 'string' ? error.stack : '';
  let frameCount = 0;
  const limitedStack = stack.split('\n').filter(line => !/^\s*at /.test(line) || ++frameCount <= 20).join('\n');
  const frame = stack.split('\n').find(line => /:(\d+):(\d+)\)?$/.test(line));
  const location = frame?.match(/(?:at .*?\(|at )(.*):(\d+):(\d+)\)?$/);
  const syntaxLocation = error?.name === 'SyntaxError' ? stack.split('\n')[0].match(/^(.*):(\d+)$/) : null;
  return { type: boundedText(error?.name || 'Error', 128), message: boundedText(error?.message ?? error, 2048),
    ...(stack ? { stack: boundedText(limitedStack, 8192), stackTruncated: frameCount > 20 || Buffer.byteLength(limitedStack) > 8192 } : {}),
    ...(syntaxLocation ? { location: { file: boundedText(syntaxLocation[1], 1024), line: Number(syntaxLocation[2]) } }
      : location ? { location: { file: boundedText(location[1], 1024), line: Number(location[2]), column: Number(location[3]) } } : {}),
    ...(typeof error?.valuePath === 'string' ? { valuePath: boundedText(error.valuePath, 1024) } : {}) };
}

module.exports = { boundedText, errorDiagnostic };
