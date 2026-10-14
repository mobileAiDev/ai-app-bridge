'use strict';

const { CommandError } = require('../command-errors');
const { httpRequestBounded } = require('./execution-io');

const framingFailures = {
  invalid_http_request: { status: 400, suggestion: 'Fix the HTTP request framing before sending a new action.' },
  incomplete_http_request: { status: 400, suggestion: 'Send the complete Content-Length body as a new action.' },
  http_request_timeout: { status: 408, suggestion: 'Check the device connection, then send the complete request as a new action.' },
  http_request_too_large: { status: 413, suggestion: 'Reduce the request below the reported byte limit before sending a new action.' },
};

// Only Android's explicit pre-dispatch framing refusals prove no effect.
// Other HTTP failures and lost connections retain the transport's unknown state.
async function androidSdkHttpRequest(url, options) {
  try { return await httpRequestBounded(url, options); }
  catch (error) {
    if (![400, 408, 413].includes(error.statusCode)) throw error;
    let response;
    try { response = JSON.parse(error.responseBody); } catch { throw error; }
    const contract = framingFailures[response?.error];
    if (!contract || contract.status !== error.statusCode || response.ok !== false
        || response.dispatched !== false || response.ambiguous !== false
        || typeof response.message !== 'string' || !response.message
        || Object.keys(response).some(key => !['ok', 'error', 'message', 'dispatched', 'ambiguous'].includes(key))) throw error;
    throw new CommandError(response.error, response.message, {
      details: { statusCode: error.statusCode, response, suggestion: contract.suggestion },
      dispatched: false, ambiguous: false,
    });
  }
}

module.exports = { androidSdkHttpRequest };
