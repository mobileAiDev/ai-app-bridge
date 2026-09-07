'use strict';

const { looksLikeAndroidUiHierarchyXml } = require('../android-uia-xml');

function createIsolatedScriptActions(dispatch, target = {}) {
  if (typeof dispatch !== 'function') {
    throw new TypeError('dispatch');
  }
  return async function actions(command, args = {}, options = {}) {
    const result = await dispatch(command, {
      ...target,
      ...options,
      ...args,
      serial: args.serial || target.serial,
      packageName: args.packageName || target.packageName,
    });
    const text = result && result.content && result.content[0] && result.content[0].text;
    if (typeof text !== 'string') {
      throw new TypeError('action_result_text');
    }
    try {
      return JSON.parse(text);
    } catch {
      if (command === 'uia-tree' && !result.isError && looksLikeAndroidUiHierarchyXml(text)) return text;
      return { ok: false, error: text, command };
    }
  };
}

module.exports = { createIsolatedScriptActions };
