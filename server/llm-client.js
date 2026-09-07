const { Agent } = require('undici');

const dispatchers = new Map();

function requestDispatcherOptions(timeoutMs) {
  const value = Math.trunc(Number(timeoutMs));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('请求超时必须是正整数');
  return { headersTimeout: value, bodyTimeout: value };
}

function requestDispatcher(timeoutMs) {
  const value = Math.trunc(Number(timeoutMs));
  let dispatcher = dispatchers.get(value);
  if (!dispatcher) {
    dispatcher = new Agent(requestDispatcherOptions(value));
    dispatchers.set(value, dispatcher);
  }
  return dispatcher;
}

function requestFetchOptions(timeoutMs, init = {}) {
  return { ...init, dispatcher: requestDispatcher(timeoutMs) };
}

module.exports = { requestDispatcherOptions, requestDispatcher, requestFetchOptions };
