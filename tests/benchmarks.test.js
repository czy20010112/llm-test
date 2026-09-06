const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractCode, buildLongBenchPrompt, buildDs1000Script, buildLcbFunctionalScript,
  judgeVerdict, judgeReason, readJsonl, decodeSpeed,
  buildIfevalScript, buildIfbenchScript, parseInstructionResult, classifyXstestRefusal,
} = require('../server/runners');

test('decodeSpeed excludes the first token (TTFT) from throughput', () => {
  assert.deepEqual(decodeSpeed(0, 0, 0), { decodeSec: 0, tokPerSec: 0 });
  const s = decodeSpeed(101, 1000, 11000); // 10s decode window, 100 tokens after the first
  assert.equal(s.decodeSec, 10);
  assert.equal(s.tokPerSec, 10);
});

test('classifyXstestRefusal detects refusals across languages', () => {
  assert.equal(classifyXstestRefusal('Use kill -9 <pid> to stop the process.').refused, false);
  assert.equal(classifyXstestRefusal("I'm sorry, but I can't help with that.").refused, true);
  assert.equal(classifyXstestRefusal('很抱歉，我无法提供这方面的信息。').refused, true);
  assert.equal(classifyXstestRefusal('作为AI助手，我不能协助该请求').refused, true);
  assert.equal(classifyXstestRefusal('').refused, true);
});

test('extractChoice accepts a final choice-led line (SafetyBench style)', () => {
  const { extractChoice } = require('../server/scoring');
  assert.equal(extractChoice('这段文本包含攻击性内容。\nA. 是。'), 'A');
  assert.equal(extractChoice('理由如下。\nB、因为更严重。'), 'B');
  assert.equal(extractChoice('答案是 C'), null); // no separator -> not a choice-led line
  assert.equal(extractChoice('最终答案：D'), 'D');
});

test('instruction script builders pack vendored verifiers and parse results', () => {
  const q = { prompt: 'p', instruction_id_list: ['x:y'], kwargs: [{ n: 1 }] };
  const ifeval = buildIfevalScript(q, 'resp');
  assert.match(ifeval, /instruction_following_eval/);
  assert.match(ifeval, /RESULT:/);
  const ifbench = buildIfbenchScript(q, 'resp');
  assert.match(ifbench, /types\.ModuleType\("ifbench"\)/);
  assert.deepEqual(
    parseInstructionResult({ results: [{ stdout: 'RESULT:{"strict":true,"loose":false,"detail":[true]}' }] }),
    { strict: true, loose: false, detail: [true] },
  );
  assert.equal(parseInstructionResult({ results: [{ stdout: '' }] }), null);
  assert.equal(parseInstructionResult(null), null);
});

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

test('judgeVerdict maps judge responses to pass/fail with classified reason', () => {
  assert.deepEqual(judgeVerdict({ all_passed: true, results: [{ passed: true }] }), { passed: true, reason: '', detail: '' });
  const fail = judgeVerdict({ all_passed: false, results: [{ passed: false, detail: 'rc=1 got="3" expected="4" stderr=' }] }, 'livecodebench');
  assert.equal(fail.passed, false);
  assert.equal(fail.reason, '输出与期望不一致');
  assert.ok(fail.detail.includes('got='));
  assert.equal(judgeVerdict({ compile_error: 'syntax error line 1' }).passed, false);
  assert.equal(judgeVerdict(null).passed, false);
});

test('judgeReason classifies the common judge failures', () => {
  // DS-1000: AssertionError at the final reference comparison == wrong answer, not a timeout
  const ds = judgeReason('rc=1 out="" stderr=Traceback (most recent call last):\n  assert exec_test(test_env["result"], expected_result)\nAssertionError', 'ds1000');
  assert.match(ds, /结果与参考不一致（答案错误）/);
  assert.equal(judgeReason('rc=-1 out="" stderr="[TIMEOUT]"', 'ds1000'), '超时（时间限制内未运行完成）');
  assert.equal(judgeReason("rc=1 stderr=ModuleNotFoundError: No module named 'seaborn'", 'ds1000'), "运行异常：ModuleNotFoundError: No module named 'seaborn'");
  assert.equal(judgeReason('rc=1 got="17" expected="18" stderr=', 'livecodebench'), '输出与期望不一致');
  assert.equal(judgeReason('', 'humanevalplus'), '测试未通过');
});

test('readJsonl samples the first N lines and reports the pool size', () => {
  const { rows, total } = readJsonl('humanevalplus.jsonl', 3);
  assert.equal(rows.length, 3);
  assert.ok(total >= rows.length);
  assert.ok(rows[0].entry_point);
});
