// Prepares the instruction-following & safety benchmark task files:
//   IFEval / IFBench  -> {id, prompt, instruction_id_list, kwargs}
//   SafetyBench (zh)  -> {id, question, options_text, answer, category} (mmlu-style MCQ)
//   XSTest            -> {id, type, prompt} (250 safe prompts, compliance scoring)
// Raw sources live in benchmarks/raw/<name>/ (see README). Run: node scripts/prepare_if_safety.js
const fs = require('fs');
const path = require('path');

const RAW = path.join(__dirname, '..', 'benchmarks', 'raw');
const OUT = path.join(__dirname, 'data');
fs.mkdirSync(OUT, { recursive: true });

function writeJsonl(name, rows) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`${name}: ${rows.length} 题`);
  return rows.length;
}

// ---------- IFEval (Google): 541 prompts, verifiable instruction ids ----------
{
  const rows = fs.readFileSync(path.join(RAW, 'ifeval', 'ifeval_input_data.jsonl'), 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => {
      const j = JSON.parse(l);
      return { id: j.key, prompt: j.prompt, instruction_id_list: j.instruction_id_list, kwargs: j.kwargs };
    });
  writeJsonl('ifeval.jsonl', rows);
}

// ---------- IFBench (AllenAI): 300 test prompts, out-of-domain constraints ----------
{
  const src = path.join(RAW, 'ifbench', 'ifbench_test.jsonl');
  const rows = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean)
    .map((l) => {
      const j = JSON.parse(l);
      // strip None kwargs (parquet pads every arg; official eval filters them too)
      const kwargs = (j.kwargs || []).map((k) => Object.fromEntries(Object.entries(k || {}).filter(([, v]) => v !== null && v !== undefined)));
      return { id: j.key, prompt: j.prompt, instruction_id_list: j.instruction_id_list, kwargs };
    });
  writeJsonl('ifbench.jsonl', rows);
}

// ---------- SafetyBench zh (THU): 11435 MCQ with official GitHub answers ----------
{
  const test = JSON.parse(fs.readFileSync(path.join(RAW, 'safetybench', 'test_zh.json'), 'utf8'));
  const answers = JSON.parse(fs.readFileSync(path.join(RAW, 'safetybench', 'test_answers_zh.json'), 'utf8'));
  const rows = Object.entries(test).map(([id, q]) => {
    const ans = answers[id];
    if (!ans) return null; // skip unlabeled stragglers
    const options_text = (q.options || []).map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n');
    return {
      id,
      question: q.question,
      options_text,
      answer: String.fromCharCode(65 + ans.answer),
      category: q.category || ans.category || '',
    };
  }).filter(Boolean);
  writeJsonl('safetybench_cn.jsonl', rows);
}

// ---------- XSTest: 250 safe prompts that look risky (label column = safe) ----------
{
  // RFC4180 split (quoted fields with commas/escapes)
  const splitCsv = (line) => {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const lines = fs.readFileSync(path.join(RAW, 'xstest', 'xstest_prompts.csv'), 'utf8').split('\n').filter(Boolean);
  const header = splitCsv(lines[0]).map((h) => h.trim());
  const col = (h) => header.indexOf(h);
  const rows = [];
  for (const line of lines.slice(1)) {
    const parts = splitCsv(line);
    if (parts[col('label')].trim() !== 'safe') continue;
    rows.push({ id: parts[col('id')], type: parts[col('type')], prompt: parts[col('prompt')] });
  }
  writeJsonl('xstest.jsonl', rows);
}

console.log('done ->', OUT);
