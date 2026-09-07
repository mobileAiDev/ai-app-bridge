'use strict';

// Decode one XML layer. In particular, &amp;#10; is the literal text &#10;.
function decodeXmlAttribute(value) {
  const named = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|quot|apos|lt|gt|amp);/g, (_, entity) => {
    if (entity[0] !== '#') return named[entity];
    const code = entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    if (!(code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xD7FF)
      || (code >= 0xE000 && code <= 0xFFFD) || (code >= 0x10000 && code <= 0x10FFFF))) {
      throw new Error('invalid_xml_character_reference');
    }
    return String.fromCodePoint(code);
  });
}

function parseXmlAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([A-Za-z0-9_:-]+)="([^"]*)"/g)) {
    attributes[match[1]] = decodeXmlAttribute(match[2]);
  }
  return attributes;
}

module.exports = { decodeXmlAttribute, parseXmlAttributes };
