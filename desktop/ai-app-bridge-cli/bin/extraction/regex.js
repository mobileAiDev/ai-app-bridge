'use strict';

function extractRegex(response, { inputPath, pattern, flags = '' }) {
  let input = response;
  if (inputPath !== '') {
    for (const part of inputPath.slice(1).split('/')) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (input === null || typeof input !== 'object' || !Object.hasOwn(input, key)) {
        throw Object.assign(new Error(`JSON Pointer does not exist: ${inputPath}`), { code: 'extraction_path_not_found' });
      }
      input = input[key];
    }
  }
  if (typeof input !== 'string') throw Object.assign(new Error('Regex inputPath must select a string.'), { code: 'extraction_input_type' });
  const expression = new RegExp(pattern, `${flags}g`);
  const matches = [];
  let match;
  while ((match = expression.exec(input)) !== null) {
    if (matches.length === 1000) throw Object.assign(new Error('Regex exceeded 1000 matches; no partial result was returned.'), { code: 'extraction_match_limit' });
    matches.push({ match: match[0], groups: Array.from(match).slice(1).map(value => value === undefined ? null : value),
      namedGroups: Object.fromEntries(Object.entries(match.groups || {}).map(([key, value]) => [key, value === undefined ? null : value])) });
    if (match[0] === '') {
      const code = input.codePointAt(expression.lastIndex);
      expression.lastIndex += flags.includes('u') && code > 0xffff ? 2 : 1;
    }
  }
  return matches;
}

module.exports = { extractRegex };
