'use strict';

const crypto = require('node:crypto');
const {
  isAndroidUiElementOpeningTag,
  looksLikeAndroidUiHierarchyXml,
  replaceAndroidUiOpeningTags,
} = require('./android-uia-xml');

const REDACTED = '[REDACTED]';
const SECURE_UI_XML_TEXT_ATTRIBUTES = new Set([
  'text',
  'value',
]);

/**
 * Canonical write-side normalization shared by every FactStore Adapter.
 * Only password and token values are redacted here. Bodies, cookies, and
 * ordinary query parameters stay as captured.
 */
function normalizePersistentFact(fact, now = Date.now()) {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
    throw new TypeError('fact must be an object');
  }
  const partition = requiredString(fact.partition, 'partition');
  const timestamps = fact.timestamps && typeof fact.timestamps === 'object' ? fact.timestamps : {};
  const payload = fact.payload === undefined ? null : fact.payload;
  return {
    partition,
    targetKey: requiredString(fact.targetKey, 'targetKey'),
    app: sanitizePersistentValue(fact.app === undefined ? {} : fact.app, 'app'),
    runtimeEpoch: requiredString(fact.runtimeEpoch, 'runtimeEpoch'),
    actionId: fact.actionId === undefined || fact.actionId === null ? null : String(fact.actionId),
    dedupeKey: fact.dedupeKey === undefined || fact.dedupeKey === null
      ? null
      : normalizeDedupeKey(fact.dedupeKey),
    timestamps: {
      occurredAtMs: finiteInteger(timestamps.occurredAtMs, now, 'timestamps.occurredAtMs'),
      observedAtMs: finiteInteger(timestamps.observedAtMs, now, 'timestamps.observedAtMs'),
      ingestedAtMs: now,
    },
    payload: sanitizePersistentValue(payload, 'payload'),
  };
}

function sanitizePersistentValue(value, key = '', ancestors = new WeakSet()) {
  if (isSensitiveKey(key)) return REDACTED;
  if (value === null || value === undefined) return value === undefined ? null : value;
  if (typeof value === 'string') return sanitizeString(value, key);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { type: 'buffer', byteLength: value.length };
  if (ancestors.has(value)) throw new TypeError('fact must be JSON-serializable without cycles');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry) => sanitizePersistentValue(entry, key, ancestors));
  } else {
    result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = sanitizePersistentValue(childValue, childKey, ancestors);
    }
  }
  ancestors.delete(value);
  return result;
}

function sanitizeString(value, key) {
  if (isCanonicalBase64Field(key, value)) return value;
  const androidUiHierarchyXml = looksLikeAndroidUiHierarchyXml(value);
  if (androidUiHierarchyXml) value = redactSecureAndroidUiXml(value);
  const trimmed = value.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        value = JSON.stringify(sanitizePersistentValue(parsed));
      }
    } catch (_) {
      // Preserve non-JSON text and apply inline credential rules below.
    }
  }
  if (looksLikeUrlKey(key)) {
    // Some frameworks place credentials in the path instead of a query
    // parameter (for example Moodle tokenpluginfile.php/<token>/...). Apply
    // this once before parsing as well so relative URLs receive the same
    // write-side protection as absolute URLs.
    value = redactSensitiveUrlPath(value);
    try {
      const url = new URL(value);
      if (url.password) url.password = REDACTED;
      url.pathname = redactSensitiveUrlPath(url.pathname);
      for (const parameter of [...url.searchParams.keys()]) {
        if (isSensitiveKey(parameter)) url.searchParams.set(parameter, REDACTED);
      }
      value = url.toString();
    } catch (_) {
      // Relative/non-URL text still receives assignment redaction below.
    }
  }
  let sanitized = value.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]');
  sanitized = sanitized.replace(
    /(\b(?:authorization|proxy[-_ ]?authorization)\b\s*[:=]\s*)[^\r\n]*/gi,
    '$1[REDACTED]',
  );
  const assignmentPattern = /((?:["']?)(?:password|passwd|passcode|pwd|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|session[-_ ]?token|token)(?:["']?)\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&#"'{}\[\]]+)/gi;
  sanitized = sanitized.replace(assignmentPattern, (match, prefix, secretValue, offset, source) => {
    const unquotedValue = secretValue.replace(/^["']|["']$/g, '');
    if (
      androidUiHierarchyXml
      && isUiXmlBooleanPasswordAttribute(source, offset, prefix, unquotedValue)
    ) return match;
    if (unquotedValue === REDACTED || /^%5bredacted%5d$/i.test(unquotedValue)) return match;
    const quote = secretValue.length >= 2
      && (secretValue[0] === '"' || secretValue[0] === "'")
      && secretValue.at(-1) === secretValue[0]
      ? secretValue[0]
      : '';
    return `${prefix}${quote}${REDACTED}${quote}`;
  });
  return sanitized;
}

function redactSecureAndroidUiXml(value) {
  return replaceAndroidUiOpeningTags(value, (tag) => {
    const attributes = uiXmlAttributes(tag);
    const inputShape = [
      attributes.class,
      attributes.classname,
      attributes.type,
      attributes.role,
    ].some((candidate) => (
      /edittext|textfield|textinput|securefield|searchfield|^input$|^textarea$|textbox/i
        .test(String(candidate || ''))
    ));
    const sensitiveIdentity = inputShape && [
      attributes.resourceid,
      attributes.resourcename,
      attributes.id,
      attributes.name,
      attributes.autocomplete,
      attributes.textcontenttype,
      attributes.placeholder,
    ].some((candidate) => (
      /password|passwd|pwd|passcode|current-password|new-password/i
        .test(String(candidate || ''))
    ));
    const secure = isTruePrivacyFlag(attributes.password)
      || isTruePrivacyFlag(attributes.ispassword)
      || isTruePrivacyFlag(attributes.secure)
      || isTruePrivacyFlag(attributes.issecure)
      || /securetext|passwordfield|passwordinput/i.test(String(attributes.class || ''))
      || sensitiveIdentity;
    if (!secure) return tag;
    return tag.replace(
      /([A-Za-z_:][A-Za-z0-9_.:-]*)(\s*=\s*)(["'])([\s\S]*?)\3/g,
      (attribute, name, separator, quote) => (
        SECURE_UI_XML_TEXT_ATTRIBUTES.has(normalizeXmlAttributeName(name))
          ? `${name}${separator}${quote}${REDACTED}${quote}`
          : attribute
      ),
    );
  });
}

function uiXmlAttributes(tag) {
  const attributes = {};
  const pattern = /([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*)(["'])([\s\S]*?)\2/g;
  let match;
  while ((match = pattern.exec(tag)) !== null) {
    attributes[normalizeXmlAttributeName(match[1])] = match[3];
  }
  return attributes;
}

function normalizeXmlAttributeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isTruePrivacyFlag(value) {
  return value === true || value === 1 || String(value).toLowerCase() === 'true';
}

function isUiXmlBooleanPasswordAttribute(source, offset, prefix, value) {
  if (!/^(?:true|false)$/i.test(String(value))) return false;
  if (!/^["']?password["']?\s*[:=]\s*$/i.test(String(prefix).trim())) return false;
  const preceding = offset > 0 ? source[offset - 1] : '';
  if (preceding && !/[\s<]/.test(preceding)) return false;
  const before = source.slice(0, offset);
  const open = before.lastIndexOf('<');
  const close = before.lastIndexOf('>');
  return open > close && isAndroidUiElementOpeningTag(source.slice(open));
}

function isCanonicalBase64Field(key, value) {
  const normalizedKey = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalizedKey.endsWith('base64')
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function redactSensitiveUrlPath(value) {
  let redacted = String(value);

  // Moodle's authenticated file endpoint embeds the access token directly
  // after the script name, without a descriptive "token" path segment.
  redacted = redacted.replace(
    /(\/tokenpluginfile\.php\/)[^/?#]+/gi,
    `$1${REDACTED}`,
  );

  // Cover conventional token marker/value path pairs and marker=value segments.
  const marker = '(?:access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|token)';
  redacted = redacted.replace(
    new RegExp(`(\\/(?:oauth|authorization|auth)\\/token\\/)[^/?#]+`, 'gi'),
    `$1${REDACTED}`,
  );
  redacted = redacted.replace(
    new RegExp(`(\\/${marker}\\/)[^/?#]+`, 'gi'),
    (match, prefix) => {
      const valueSegment = match.slice(prefix.length);
      // Do not consume the second marker in paths such as /auth/code/value;
      // the nested-marker rule above has already handled the actual value.
      return new RegExp(`^${marker}$`, 'i').test(valueSegment)
        ? match
        : `${prefix}${REDACTED}`;
    },
  );
  redacted = redacted.replace(
    new RegExp(`(\\/${marker}[=:])[^/?#]+`, 'gi'),
    `$1${REDACTED}`,
  );

  // JWTs are self-identifying credentials and occasionally appear as an
  // otherwise unlabeled URL segment.
  redacted = redacted.replace(
    /(\/)(eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,})(?=\/|\?|#|$)/g,
    `$1${REDACTED}`,
  );
  return redacted;
}

function isPasswordKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === 'password'
    || normalized === 'passwd'
    || normalized === 'pwd'
    || normalized === 'passcode'
    || normalized.endsWith('password');
}

function isTokenKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === 'token'
    || normalized === 'accesstoken'
    || normalized === 'refreshtoken'
    || normalized === 'idtoken'
    || normalized === 'sessiontoken'
    || normalized === 'authorization'
    || normalized === 'proxyauthorization'
    || normalized.endsWith('token');
}

function isSensitiveKey(key) {
  return isPasswordKey(key) || isTokenKey(key);
}

function looksLikeUrlKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === 'url' || normalized === 'uri' || normalized.endsWith('url') || normalized.endsWith('uri');
}

function normalizeDedupeKey(value) {
  return crypto.createHash('sha256')
    .update(`fact-dedupe-v1\0${String(value)}`)
    .digest('base64url');
}

function requiredString(value, name) {
  if (value === undefined || value === null || String(value).length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return String(value);
}

function finiteInteger(value, fallback, name) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate)) throw new TypeError(`${name} must be a safe integer`);
  return candidate;
}

module.exports = {
  REDACTED,
  isSensitiveKey,
  normalizeDedupeKey,
  normalizePersistentFact,
  sanitizePersistentValue,
};
