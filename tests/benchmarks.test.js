const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractCode, buildLongBenchPrompt, buildDs1000Script, buildLcbFunctionalScript,
  judgeVerdict, readJsonl,
} = require('../server/runners');

test('extractCode handles fenced python blocks', () => {
  assert.equal(extractCode('Sure!\n```python\ndef f():\n    return 1\n```\nDone.'), 'def f():\n    return 1');
});

test('extractCode strips <code> tags and DS-1000 solution markers', () => {
  const ds = '### BEGIN SOLUTION\n<code>\ndef g(df):\n    return df\n</code>\n### END SOLUTION';
  assert.equal(extractCode(ds, { solutionMarkers: true }), 'def g(df):\n    return df');
  assert.equal(extractCode('<code>\nx = 1\n</code>'), 'x = 1');
});

test('extractCode falls back to raw text', () => {
  assert.equal(extractCode('def f():\n    return 2'), 'def f():\n    return 2');
});

test('buildLongBenchPrompt includes context, question and choices', () => {
  const p = buildLongBenchPrompt({ context: 'MATERIAL', question: 'Q?', A: 'a', B: 'b', C: 'c', D: 'd' });
  assert.ok(p.includes('MATERIAL') && p.includes('Q?') && p.includes('D. d'));
});

test('buildDs1000Script round-trips the solution through base64', () => {
  const script = buildDs1000Script('CTX_MARKER', 'def sol():\n    return "结果"');
  assert.ok(script.includes('CTX_MARKER') && script.includes('test_execution(_solution)'));
  const decoded = Buffer.from(script.match(/b64decode\("([^"]+)"\)/)[1], 'base64').toString('utf8');
  assert.equal(decoded, 'def sol():\n    return "结果"');
});

test('buildLcbFunctionalScript embeds tests and entry function', () => {
  const script = buildLcbFunctionalScript('def add(a, b):\n    return a + b', [{ i: '[1, 2]', o: '3' }], 'add');
  assert.ok(script.includes('def add(') && script.includes('globals()["add"]') && script.includes('_fn(*_args)'));
});

test('judgeVerdict maps judge responses to pass/fail with detail', () => {
  assert.deepEqual(judgeVerdict({ all_passed: true, results: [{ passed: true }] }), { passed: true, detail: '' });
  const fail = judgeVerdict({ all_passed: false, results: [{ passed: false, detail: 'rc=1 stderr=assert' }] });
  assert.equal(fail.passed, false);
  assert.ok(fail.detail.includes('assert'));
  assert.equal(judgeVerdict({ compile_error: 'syntax error line 1' }).passed, false);
  assert.equal(judgeVerdict(null).passed, false);
});

test('readJsonl samples the first N lines and reports the pool size', () => {
  const { rows, total } = readJsonl('humanevalplus.jsonl', 3);
  assert.equal(rows.length, 3);
  assert.ok(total >= rows.length);
  assert.ok(rows[0].entry_point);
});
