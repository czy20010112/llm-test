const test = require('node:test');
const assert = require('node:assert/strict');
const { requestDispatcherOptions } = require('../server/llm-client');

test('uses the application request timeout for Undici headers and body timeouts', () => {
  const ordinary = 10 * 60 * 1000;
  const thinking = 15 * 60 * 1000;

  assert.deepEqual(requestDispatcherOptions(ordinary), {
    headersTimeout: ordinary,
    bodyTimeout: ordinary,
  });
  assert.deepEqual(requestDispatcherOptions(thinking), {
    headersTimeout: thinking,
    bodyTimeout: thinking,
  });
});
