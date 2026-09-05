#!/usr/bin/env node
/**
 * Convert raw downloaded benchmark files (benchmarks/raw/) into the compact
 * JSONL task files the eval server reads (scripts/data/).
 *
 * Sources -> outputs:
 *   longbench2/data.json  (465MB, JSON array) -> longbench2.jsonl
 *   livecodebench/test5.jsonl + test6.jsonl   -> livecodebench.jsonl
 *   ds1000/test.jsonl                          -> ds1000.jsonl (renamed fields only)
 *   humanevalplus/test.jsonl                   -> humanevalplus.jsonl (as-is)
 *
 * LongBench v2 items keep their full context (that is the point of the benchmark).
 * LiveCodeBench private test cases are base64+zlib compressed in the raw files
 * and are decompressed here once, so the server never pays that cost.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RAW = path.join(__dirname, '..', 'benchmarks', 'raw');
const OUT = path.join(__dirname, 'data');
fs.mkdirSync(OUT, { recursive: true });

function writeJsonl(name, rows) {
  const p = path.join(OUT, name);
  const tmp = p + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  for (const r of rows) fs.writeSync(fd, JSON.stringify(r) + '\n');
  fs.closeSync(fd);
  fs.renameSync(tmp, p);
  console.log(`${name}: ${rows.length} items, ${(fs.statSync(p).size / 1e6).toFixed(1)} MB`);
}

/** Stream-parse a top-level JSON array file without loading it into one string. */
function* streamJsonArray(file) {
  const CHUNK = 8 * 1024 * 1024;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(CHUNK);
  let pending = '';            // unyielded text starting at a top-level '{'
  let depth = 0, inStr = false, esc = false;
  let pos = 0;
  while (true) {
    const n = fs.readSync(fd, buf, 0, CHUNK, pos);
    if (n === 0) break;
    pos += n;
    const s = pending + buf.toString('utf8', 0, n);
    let objStart = -1;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') {
        if (depth === 0) objStart = i;
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0 && objStart >= 0) {
          yield JSON.parse(s.slice(objStart, i + 1));
          objStart = -1;
        }
      }
    }
    if (objStart >= 0) {
      // partial object: carry it and rewind scanner state to the object start
      pending = s.slice(objStart);
      depth = 0; inStr = false; esc = false;
    } else {
      pending = '';
    }
  }
  fs.closeSync(fd);
}

function prepareLongBench2() {
  const rows = [];
  for (const o of streamJsonArray(path.join(RAW, 'longbench2', 'data.json'))) {
    rows.push({
      id: o._id, domain: o.domain, sub_domain: o.sub_domain,
      difficulty: o.difficulty, length: o.length,
      question: o.question,
      A: o.choice_A, B: o.choice_B, C: o.choice_C, D: o.choice_D,
      answer: o.answer, context: o.context,
    });
  }
  writeJsonl('longbench2.jsonl', rows);
}

/**
 * Minimal pickle-string extractor: LCB compresses private tests as
 * base64(zlib(pickle.dumps(json_str))). A pickled str is PROTO, FRAME,
 * BINUNICODE/SHORT_BINUNICODE, STOP — nothing else.
 */
function pickleGetString(buf) {
  let i = 0;
  while (i < buf.length) {
    const op = buf[i++];
    if (op === 0x80) { i += 1; continue; }        // PROTO
    if (op === 0x95) { i += 8; continue; }        // FRAME
    if (op === 0x58) {                             // BINUNICODE
      const len = buf.readUInt32LE(i); i += 4;
      return buf.subarray(i, i + len).toString('utf8');
    }
    if (op === 0x8c) {                             // SHORT_BINUNICODE
      const len = buf[i++];
      return buf.subarray(i, i + len).toString('utf8');
    }
    if (op === 0x2e) return null;                  // STOP
    return null;                                   // anything else: unsupported
  }
  return null;
}

function decodeTests(raw) {
  let jsonStr;
  const b64 = Buffer.from(raw, 'base64');
  if (b64[0] === 0x78) {
    // zlib -> pickle(str) in recent releases
    jsonStr = pickleGetString(zlib.inflateSync(b64));
  } else {
    jsonStr = raw;                                  // plain JSON in old releases
  }
  if (!jsonStr) throw new Error('cannot decode test case pickle');
  const arr = JSON.parse(jsonStr);
  return arr.map((t) => ({ i: t.input, o: t.output, type: t.testtype || 'stdin' }));
}

async function prepareLiveCodeBench() {
  const readline = require('readline');
  const rows = [];
  for (const f of ['test5.jsonl', 'test6.jsonl']) {
    const p = path.join(RAW, 'livecodebench', f);
    if (!fs.existsSync(p)) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(p, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      const pub = decodeTests(o.public_test_cases || '[]');
      let priv = [];
      try {
        priv = decodeTests(o.private_test_cases || '');
      } catch (e) {
        console.warn(`  ! ${o.question_id}: private tests undecodable (${e.message}), public only`);
      }
      // A handful of problems ship pathological test payloads (10s of MB).
      // Keep tests within a sane envelope so judge requests stay small:
      // public tests first (never dropped), then private until 1 MB / 100 cases.
      const tests = [];
      let bytes = 0, truncated = false;
      for (const t of pub.concat(priv)) {
        const size = (t.i ? t.i.length : 0) + (t.o ? t.o.length : 0);
        if (tests.length >= 100 || bytes + size > 1024 * 1024) { truncated = true; break; }
        tests.push(t); bytes += size;
      }
      if (!tests.length) continue;
      const functional = Boolean((o.starter_code || '').trim());
      let entry = null;
      if (functional) {
        const m = o.starter_code.match(/def\s+([A-Za-z_]\w*)\s*\(/);
        if (m) entry = m[1];
      }
      rows.push({
        qid: o.question_id, title: o.question_title,
        content: o.question_content, platform: o.platform,
        difficulty: o.difficulty,
        starter: o.starter_code || '',
        mode: functional ? 'functional' : 'stdin',
        entry,
        truncated,
        tests,
      });
    }
  }
  writeJsonl('livecodebench.jsonl', rows);
}

function prepareDs1000() {
  const lines = fs.readFileSync(path.join(RAW, 'ds1000', 'test.jsonl'), 'utf8').trim().split(/\r?\n/);
  const rows = lines.map((l) => {
    const o = JSON.parse(l);
    return {
      prompt: o.prompt, reference_code: o.reference_code, code_context: o.code_context,
      library: o.metadata && o.metadata.library, perturbation: o.metadata && o.metadata.perturbation_type,
    };
  });
  writeJsonl('ds1000.jsonl', rows);
}

function prepareHumanevalPlus() {
  const lines = fs.readFileSync(path.join(RAW, 'humanevalplus', 'test.jsonl'), 'utf8').trim().split(/\r?\n/);
  const rows = lines.map((l) => {
    const o = JSON.parse(l);
    return { task_id: o.task_id, prompt: o.prompt, entry_point: o.entry_point, test: o.test };
  });
  writeJsonl('humanevalplus.jsonl', rows);
}

(async () => {
  const which = process.argv.slice(2);
  const all = which.length === 0;
  if (all || which.includes('longbench2')) prepareLongBench2();
  if (all || which.includes('livecodebench')) await prepareLiveCodeBench();
  if (all || which.includes('ds1000')) prepareDs1000();
  if (all || which.includes('humanevalplus')) prepareHumanevalPlus();
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
