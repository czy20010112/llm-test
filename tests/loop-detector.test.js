const test = require('node:test');
const assert = require('node:assert/strict');
const { detectOutputLoop } = require('../server/loop-detector');

test('detects a sustained repeated character but ignores short output', () => {
  assert.equal(detectOutputLoop('!'.repeat(95)), null);
  assert.equal(detectOutputLoop('！'.repeat(160)).kind, 'repeated-character');
});

test('detects a repeated short pattern after enough output', () => {
  assert.equal(detectOutputLoop('正常回答：' + 'abcXYZ'.repeat(30)).kind, 'repeated-pattern');
  assert.equal(detectOutputLoop('这是一个正常的、内容持续变化的回答。'.repeat(12)), null);
});
