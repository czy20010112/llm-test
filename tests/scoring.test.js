const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreChoice, scoreAime, aggregateScore } = require('../server/scoring');

test('choice scorer accepts explicit boxed and final-answer formats', () => {
  assert.deepEqual(scoreChoice('D', '推理过程...\\boxed{D}'), { status: 'correct', answer: 'D' });
  assert.deepEqual(scoreChoice('B', '最终答案：B'), { status: 'correct', answer: 'B' });
});

test('choice scorer does not infer an answer from truncated reasoning', () => {
  const truncated = '**Step 1: Analyze the structure**\nThe starting material is trans-cinnamaldehyde.\nLet us count the carbon atoms:';
  assert.deepEqual(scoreChoice('D', truncated), { status: 'unknown', answer: null });
  assert.deepEqual(scoreChoice('C', 'The answer is C because the intermediate result is...\nContinue calculating:'), { status: 'unknown', answer: null });
});

test('AIME scorer accepts boxed integer and marks missing evidence unknown', () => {
  assert.deepEqual(scoreAime('128', '最终答案：\\boxed{128}'), { status: 'correct', answer: '128' });
  assert.deepEqual(scoreAime('128', 'We need calculate the sequence...'), { status: 'unknown', answer: null });
});

test('unknown answers stay in the accuracy denominator', () => {
  assert.equal(aggregateScore({ correct: 9, incorrect: 0, unknown: 1, total: 10 }), 0.9);
});
