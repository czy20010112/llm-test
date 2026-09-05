'use strict';
/**
 * Benchmark runners for the eval server.
 *
 * Pure helpers (prompt building, answer extraction, judge-harness assembly)
 * are exported for unit tests; the task-specific `measure` entry points are
 * consumed by server.js. Scoring conventions:
 *   - Multiple choice (LongBench v2): reuse scoreChoice on the tail lines.
 *   - Code tasks: one problem counts correct only when the judge passes
 *     every sampled test case (pass@1, temperature 0).
 */
const fs = require('fs');
const path = require('path');
const { judgeRun } = require('./judge');

const DATA_DIR = path.join(__dirname, '..', 'scripts', 'data');

/** Stream the first `limit` lines of a JSONL file (limit<=0 -> all). */
function readJsonl(file, limit = 0) {
  const p = path.join(DATA_DIR, file);
  const text = fs.readFileSync(p, 'utf8');
  const lines = text.trim().split(/\r?\n/);
  const n = limit > 0 ? Math.min(limit, lines.length) : lines.length;
  const rows = [];
  for (let i = 0; i < n; i++) if (lines[i].trim()) rows.push(JSON.parse(lines[i]));
  return { rows, total: lines.filter((l) => l.trim()).length };
}

/** Strip markdown fences / <code> tags / DS-1000 markers from a model reply. */
function extractCode(text, { solutionMarkers = false } = {}) {
  let t = String(text || '');
  if (solutionMarkers) {
    const begin = t.search(/###\s*BEGIN\s*SOLUTION|BEGIN\s*SOLUTION/);
    if (begin >= 0) {
      t = t.slice(t.indexOf('\n', begin) + 1);
      const end = t.search(/###\s*END\s*SOLUTION|END\s*SOLUTION/);
      if (end >= 0) t = t.slice(0, end);
    }
  }
  const fenced = t.match(/```(?:python|py)?\s*\n([\s\S]*?)```/i);
  if (fenced) t = fenced[1];
  const tagged = t.match(/<code>\n?([\s\S]*?)<\/code>/);
  if (tagged && !fenced) t = tagged[1];
  return t.trim();
}

function buildLongBenchPrompt(q) {
  return [
    'Read the following material carefully, then answer the multiple-choice question.',
    '',
    '<text>',
    q.context,
    '</text>',
    '',
    q.question,
    'A. ' + q.A,
    'B. ' + q.B,
    'C. ' + q.C,
    'D. ' + q.D,
    '',
    'Answer with a single letter (A, B, C or D). End your reply with a line "最终答案：X" where X is the letter.',
  ].join('\n');
}

function buildHumanEvalPrompt(q) {
  return [
    'Complete the following Python function:',
    '',
    '```python',
    q.prompt,
    '```',
    '',
    `Return only the complete, self-contained function \`${q.entry_point}\` (include any needed imports). No test code, no examples.`,
  ].join('\n');
}

function buildMbppPrompt(q, entry) {
  return [
    q.prompt.trim(),
    '',
    `Write a Python function named \`${entry}\` that solves this. Return only the complete, self-contained function definition (include any needed imports). No test code, no examples.`,
  ].join('\n');
}

function buildLiveCodeBenchPrompt(q) {
  if (q.mode === 'functional') {
    return [
      q.content.trim(),
      '',
      'Function signature:',
      '```python',
      q.starter.trim(),
      '```',
      '',
      `Return only a complete Python 3 implementation of \`${q.entry}\` (include needed imports) in a single \`\`\`python code block.`,
    ].join('\n');
  }
  return [
    q.content.trim(),
    '',
    'Solve this as a complete Python 3 program that reads from standard input and prints the answers to standard output.',
    'Return only one \`\`\`python code block with the whole program.',
  ].join('\n');
}

function buildDs1000Prompt(q) {
  return [
    'Solve the following data-science problem. Write your solution between "### BEGIN SOLUTION" and "### END SOLUTION" markers. The solution must set the target variable described in the problem.',
    '',
    q.prompt.trim(),
  ].join('\n');
}

/** Assemble the self-contained DS-1000 harness (judge "script" mode). */
function buildDs1000Script(codeContext, solution) {
  const b64 = Buffer.from(solution, 'utf8').toString('base64');
  return [
    'import base64',
    '_solution = base64.b64decode("' + b64 + '").decode()',
    codeContext,
    'test_execution(_solution)',
  ].join('\n');
}

/** Assemble the LCB functional harness (judge "script" mode). */
function buildLcbFunctionalScript(code, tests, entry) {
  const b64 = Buffer.from(JSON.stringify(tests), 'utf8').toString('base64');
  return [
    'import base64, json, sys',
    code,
    '',
    '_tests = json.loads(base64.b64decode("' + b64 + '").decode())',
    '_fn = globals()["' + entry + '"]',
    '_last = None',
    'for _t in _tests:',
    '    try:',
    '        _args = json.loads(_t["i"]) if _t["i"].strip() else []',
    '        if not isinstance(_args, list): _args = [_args]',
    '        _got = _fn(*_args)',
    '        _exp = json.loads(_t["o"])',
    '        _ok = (json.dumps(_got, sort_keys=True) == json.dumps(_exp, sort_keys=True))',
    '        _last = f"got={_got!r} expected={_exp!r}"',
    '    except Exception as _e:',
    '        _ok = False; _last = f"exception {_e.__class__.__name__}: {_e}"',
    '    if not _ok:',
    '        print("failed test:", _last)',
    '        sys.exit(1)',
    'sys.exit(0)',
  ].join('\n');
}

/** Judge response -> per-problem verdict + human-readable failure detail. */
function judgeVerdict(judgeRes) {
  if (!judgeRes || typeof judgeRes !== 'object') return { passed: false, detail: 'no judge response' };
  if (judgeRes.compile_error) return { passed: false, detail: 'compile error: ' + judgeRes.compile_error };
  const failed = (judgeRes.results || []).find((r) => !r.passed);
  return {
    passed: Boolean(judgeRes.all_passed),
    detail: failed ? String(failed.detail || 'test failed').slice(0, 500) : '',
  };
}

module.exports = {
  readJsonl, extractCode,
  buildLongBenchPrompt, buildHumanEvalPrompt, buildMbppPrompt,
  buildLiveCodeBenchPrompt, buildDs1000Prompt,
  buildDs1000Script, buildLcbFunctionalScript, judgeVerdict,
};
