#!/usr/bin/env node
/**
 * Pipeline validation: feed canonical/reference solutions through the judge
 * and confirm the scoring pipeline marks them correct (and broken code wrong).
 * No GPU / model needed — this validates judge wiring, harness assembly and
 * verdict mapping end to end. Expects the judge at 127.0.0.1:8901.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { judgeRun } = require('../server/judge');
const {
  readJsonl, buildDs1000Script, buildLcbFunctionalScript, judgeVerdict,
} = require('../server/runners');

const RAW = path.join(__dirname, '..', 'benchmarks', 'raw');
let failures = 0;

function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : ' -> ' + detail}`);
  if (!ok) failures++;
}

async function main() {
  // --- HumanEval+ : canonical solutions must pass, broken code must fail
  const heRaw = fs.readFileSync(path.join(RAW, 'humanevalplus', 'test.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  for (const q of heRaw.slice(0, 3)) {
    const code = q.prompt + q.canonical_solution;
    const v = judgeVerdict(await judgeRun({ mode: 'tests', code, entry_point: q.entry_point, test_code: q.test, timeout: 15 }));
    check(`HE+ canonical ${q.task_id}`, v.passed, v.detail);
  }
  {
    const q = heRaw[0];
    const v = judgeVerdict(await judgeRun({ mode: 'tests', code: q.prompt + '\n    return True', entry_point: q.entry_point, test_code: q.test, timeout: 15 }));
    check('HE+ broken solution rejected', !v.passed);
  }

  // --- MBPP+ : canonical code must pass
  const { rows: mb } = readJsonl('mbppplus.jsonl', 3);
  for (const q of mb) {
    const entry = (q.code.match(/def\s+([A-Za-z_]\w*)\s*\(/) || [])[1];
    const v = judgeVerdict(await judgeRun({ mode: 'tests', code: q.code, entry_point: entry, test_code: q.test, timeout: 15 }));
    check(`MBPP+ canonical task ${q.task_id}`, v.passed, v.detail);
  }

  // --- DS-1000 : reference solutions must pass
  const { rows: ds } = readJsonl('ds1000.jsonl', 0);
  const picks = ['Pandas', 'Numpy', 'Matplotlib', 'Scipy', 'Sklearn'];
  for (const lib of picks) {
    const q = ds.find((x) => (x.library || '').toLowerCase() === lib.toLowerCase());
    if (!q) { check(`DS-1000 ${lib} present`, false, 'no problem found'); continue; }
    const v = judgeVerdict(await judgeRun({ mode: 'script', code: buildDs1000Script(q.code_context, q.reference_code), timeout: 60 }));
    check(`DS-1000 reference (${lib}, ${q.perturbation})`, v.passed, v.detail);
  }

  // --- LiveCodeBench stdin : cheat solution (echo first expected output) must fail; judge must count all tests
  const { rows: lcb } = readJsonl('livecodebench.jsonl', 200);
  const lcbStdin = lcb.find((x) => x.mode === 'stdin' && x.tests.length >= 3);
  {
    const cheat = `print(${JSON.stringify(lcbStdin.tests[0].o.trim())})`;
    const v = judgeVerdict(await judgeRun({ mode: 'stdin', code: cheat, test_pairs: lcbStdin.tests.map((t) => ({ input: t.i, expected: t.o })), timeout: 6 }));
    check('LCB stdin overfit solution rejected', !v.passed, v.detail);
  }

  // --- LiveCodeBench functional : harness executes and rejects wrong code
  const lcbFn = lcb.find((x) => x.mode === 'functional' && x.entry);
  if (lcbFn) {
    const v = judgeVerdict(await judgeRun({ mode: 'script', code: buildLcbFunctionalScript(`def ${lcbFn.entry}(*a):\n    return None`, lcbFn.tests, lcbFn.entry), timeout: 10 }));
    check('LCB functional wrong solution rejected', !v.passed);
  }

  console.log(failures ? `\n${failures} failure(s)` : '\nALL PIPELINE CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
