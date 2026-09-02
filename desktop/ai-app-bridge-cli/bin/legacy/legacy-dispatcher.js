'use strict';

function createLegacyDispatcher(dispatch) {
  if (typeof dispatch !== 'function') {
    throw new TypeError('legacy dispatch function is required');
  }
  return {
    dispatch(command, args) {
      return dispatch(command, args);
    },
  };
}

module.exports = { createLegacyDispatcher };
