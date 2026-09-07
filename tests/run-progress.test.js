const test = require('node:test');
const assert = require('node:assert/strict');
const { updateRowCheckpoint } = require('../server/run-progress');

test('persists settled question items and a partial score in the row checkpoint', () => {
  const row = { status: 'running', repeat: 0, average: {}, details: [] };
  updateRowCheckpoint(row, 1, {
    items: { 0: 'correct', 1: 'unknown' },
    score: 0.25,
    correct: 1,
    incorrect: 0,
    unknown: 1,
    total: 4,
    answered: 1,
    samples: 4,
    poolTotal: 198,
  });

  assert.deepEqual(row.checkpoint, {
    liveRepeat: 1,
    items: { 0: 'correct', 1: 'unknown' },
  });
  assert.deepEqual(row.average, {
    score: 0.25,
    correct: 1,
    incorrect: 0,
    unknown: 1,
    total: 4,
    answered: 1,
    samples: 4,
    poolTotal: 198,
  });
});
