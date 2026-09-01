'use strict';

// Legacy `uiautomator dump` serializes every accessibility node as `<node>`.
// Appium's persistent UiAutomator2 server instead serializes the Android class
// name as the XML element name (for example `<android.view.View>`). Keep one
// lightweight scanner for both wire formats so summary, actions, compaction,
// and persistence redaction cannot drift apart.
const XML_TAG_PATTERN = /<\s*(\/?)\s*([A-Za-z_][A-Za-z0-9_.:$-]*)(?:\s+(?:[^"'<>]|"[^"]*"|'[^']*')*)?\s*\/?>/g;
const XML_OPENING_TAG_PATTERN = /^<\s*([A-Za-z_][A-Za-z0-9_.:$-]*)(?:\s|\/?>)/;

function visitAndroidUiHierarchyTags(value, visitor) {
  const text = String(value || '');
  const pattern = new RegExp(XML_TAG_PATTERN.source, XML_TAG_PATTERN.flags);
  let insideHierarchy = false;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const tag = match[0];
    const closing = match[1] === '/';
    const tagName = match[2];
    const selfClosing = /\/\s*>$/.test(tag);
    if (tagName.toLowerCase() === 'hierarchy') {
      insideHierarchy = !closing && !selfClosing;
      continue;
    }
    if (!insideHierarchy) continue;
    if (visitor({
      tag,
      tagName,
      closing,
      selfClosing,
      start: match.index,
      end: pattern.lastIndex,
    }) === false) return false;
  }
  return true;
}

function looksLikeAndroidUiHierarchyXml(value) {
  const text = String(value || '').trimStart();
  const withoutDeclaration = text.replace(/^<\?xml\s[^?]*\?>\s*/i, '');
  if (!/^<hierarchy(?:\s|>)/i.test(withoutDeclaration)) return false;
  let foundElement = false;
  visitAndroidUiHierarchyTags(withoutDeclaration, ({ closing }) => {
    if (closing) return;
    foundElement = true;
    return false;
  });
  return foundElement;
}

function replaceAndroidUiOpeningTags(value, transform) {
  const text = String(value || '');
  let output = '';
  let cursor = 0;
  visitAndroidUiHierarchyTags(text, ({ tag, tagName, closing, start, end }) => {
    if (closing) return;
    output += text.slice(cursor, start);
    output += transform(tag, tagName);
    cursor = end;
  });
  return cursor === 0 ? text : output + text.slice(cursor);
}

function isAndroidUiElementOpeningTag(value) {
  const match = XML_OPENING_TAG_PATTERN.exec(String(value || ''));
  return Boolean(match && match[1].toLowerCase() !== 'hierarchy');
}

module.exports = {
  isAndroidUiElementOpeningTag,
  looksLikeAndroidUiHierarchyXml,
  replaceAndroidUiOpeningTags,
  visitAndroidUiHierarchyTags,
};
