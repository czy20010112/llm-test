const express = require('express');
const fs = require('fs');
const path = require('path');
const { scoreChoice, scoreAime, aggregateScore } = require('./server/scoring');
const { JUDGE_URL, judgeRun, judgeHealth } = require('./server/judge');
const {
  readJsonl, extractCode, decodeSpeed,
  buildLongBenchPrompt, buildHumanEvalPrompt, buildMbppPrompt,
  buildLiveCodeBenchPrompt, buildDs1000Prompt,
  buildDs1000Script, buildLcbFunctionalScript, judgeVerdict, judgeReason,
  buildIfevalScript, buildIfbenchScript, parseInstructionResult, classifyXstestRefusal,
} = require('./server/runners');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'dist')));
app.use(express.static(path.join(__dirname, 'public')));

const runs = new Map();

function normalizeRunScores(run) {
  for (const row of run.rows || []) {
    const a = row.average;
    if (a && Number.isFinite(a.correct) && Number.isFinite(a.total) && (Number.isFinite(a.unknown) || a.unknown === 0))
      a.score = a.total > 0 ? a.correct / a.total : 0;
    for (const detail of row.details || []) {
      if (detail && Number.isFinite(detail.correct) && Number.isFinite(detail.total) && (Number.isFinite(detail.unknown) || detail.unknown === 0))
        detail.score = detail.total > 0 ? detail.correct / detail.total : 0;
    }
  }
  return run;
}

try {
  const savedRuns = path.join(__dirname, 'data', 'runs.json');
  if (fs.existsSync(savedRuns)) {
    let staleMarked = false;
    for (const r of JSON.parse(fs.readFileSync(savedRuns, 'utf8')).map(normalizeRunScores)) {
      // a restart kills in-flight runs; don't leave phantom "running" entries in the queue
      if (r.status === 'running') {
        r.status = 'partial';
        r.current = '服务重启，运行被中断（已完成部分已保留）';
        r.finishedAt = new Date().toISOString();
        staleMarked = true;
      }
      runs.set(r.id, r);
    }
    if (staleMarked) saveRuns();
  }
} catch {}
function saveRuns() {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'data', 'runs.json'), JSON.stringify([...runs.values()], null, 2));
}

const controllers = new Map();
const stateFile = path.join(__dirname, 'data', 'workbench-state.json');
let state = { profiles: [], models: [], comparisons: [], baselines: [] };
try { if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
function saveState() {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// defaultLimit: sampled questions when the caller does not pass a limit
const tasks = [
  { id: 'smoke_speed', name: '连通性与吐字速度', ability: '实际可用性 / 首 token 与生成速度', kind: 'smoke', defaultMaxTokens: 2048 },
  { id: 'gpqa_cached', name: 'GPQA Diamond（科学推理）', ability: '高难度科学推理与知识整合｜全量 198 题', kind: 'gpqa', file: 'gpqa_diamond_mc.jsonl', defaultLimit: 198, defaultMaxTokens: 8192 },
  { id: 'aime_cached', name: 'AIME 2025（数学推理）', ability: '数学竞赛推理与精确计算｜全量 30 题', kind: 'aime', file: 'aime_2025.jsonl', defaultLimit: 30, defaultMaxTokens: 8192 },
  { id: 'mmlu_pro_cached', name: 'MMLU-Pro（综合知识）', ability: '广泛知识、学科理解与选择题稳健性｜全量 12032 题', kind: 'mmlu', file: 'MMLU-Pro.jsonl', defaultLimit: 100, defaultMaxTokens: 4096 },
  { id: 'longbench2', name: 'LongBench v2（长上下文）', ability: '超长上下文检索、长文推理与指令跟随｜全量 503 题', kind: 'longbench2', file: 'longbench2.jsonl', defaultLimit: 30, defaultMaxTokens: 2048 },
  { id: 'humanevalplus', name: 'HumanEval+（代码生成）', ability: '函数级 Python 代码生成的正确性（增强测试集）｜全量 164 题', kind: 'humanevalplus', file: 'humanevalplus.jsonl', defaultLimit: 40, defaultMaxTokens: 8192 },
  { id: 'mbppplus', name: 'MBPP+（代码生成）', ability: '基础编程任务代码生成的正确性（增强测试集）｜全量 378 题', kind: 'mbppplus', file: 'mbppplus.jsonl', defaultLimit: 40, defaultMaxTokens: 8192 },
  { id: 'livecodebench', name: 'LiveCodeBench（竞赛编程）', ability: '竞赛级算法编程（stdin / 函数式，隐藏测试）｜官方口径：开启思考｜全量 342 题', kind: 'livecodebench', file: 'livecodebench.jsonl', defaultLimit: 30, defaultMaxTokens: 16384 },
  { id: 'ds1000', name: 'DS-1000（数据科学编程）', ability: 'NumPy/Pandas/SciPy/Sklearn/Matplotlib 真实数据科学任务｜全量 1000 题', kind: 'ds1000', file: 'ds1000.jsonl', defaultLimit: 40, defaultMaxTokens: 8192 },
  { id: 'ifeval', name: 'IFEval（指令遵循）', ability: '可验证指令约束的精确遵循（格式/字数/关键词等）｜全量 541 题', kind: 'ifeval', file: 'ifeval.jsonl', defaultLimit: 100, defaultMaxTokens: 4096 },
  { id: 'ifbench', name: 'IFBench（指令泛化）', ability: '域外可验证指令的泛化遵循（AllenAI 2025）｜全量 300 题', kind: 'ifbench', file: 'ifbench.jsonl', defaultLimit: 100, defaultMaxTokens: 4096 },
  { id: 'safetybench_cn', name: 'SafetyBench（中文安全）', ability: '安全风险场景选择题（违法/隐私/歧视/身心健康等）｜全量 11435 题', kind: 'mmlu', file: 'safetybench_cn.jsonl', defaultLimit: 100, defaultMaxTokens: 2048 },
  { id: 'xstest', name: 'XSTest（过度拒绝）', ability: '安全提示误拒校准（看起来危险、实际安全）｜全量 250 题', kind: 'xstest', file: 'xstest.jsonl', defaultLimit: 250, defaultMaxTokens: 1024 },
];
const CODE_KINDS = new Set(['humanevalplus', 'mbppplus', 'livecodebench', 'ds1000', 'ifeval', 'ifbench']);

app.get('/api/tasks', (req, res) => res.json(tasks));
app.get('/api/catalog', (req, res) => res.json({ protocolVersion: '1.0', manifests: tasks.map((t) => ({ ...t, version: '1.0', supports: ['standard', 'exploration'] })) }));

app.get('/api/preflight', async (req, res) => {
  const wsl2 = process.platform === 'linux' || !!process.env.WSL_DISTRO_NAME;
  const judge = await judgeHealth();
  res.json({
    ok: true, platform: process.platform, wsl2, docker: wsl2, dynamicIsolation: judge.ok,
    judge, checkedAt: new Date().toISOString(),
  });
});

// Model entries are stored as {id, name, description} only — llama-swap returns
// large capability objects, and older builds once cached them verbatim, which made
// object values leak into run requests (llama-swap 404 "no router for requested model").
function normalizeModelList(models) {
  return (Array.isArray(models) ? models : [])
    .map((m) => {
      if (typeof m === 'string') return { id: m };
      if (m && typeof m === 'object' && (m.id || m.model || m.name)) {
        return { id: String(m.id || m.model || m.name), name: m.name ? String(m.name) : undefined, description: m.description ? String(m.description) : undefined };
      }
      return null;
    })
    .filter((m) => m && m.id);
}

function publicProfile(profile) { const { key, ...safe } = profile || {}; return { ...safe, hasKey: Boolean(key) }; }
app.get('/api/profiles', (req, res) => res.json({ profiles: state.profiles.map(publicProfile), models: normalizeModelList(state.models) }));
app.post('/api/profiles', (req, res) => {
  const p = { ...req.body, id: req.body.id || 'default', updatedAt: new Date().toISOString() };
  if (!req.body.rememberKey) delete p.key;
  const i = state.profiles.findIndex((x) => x.id === p.id);
  if (i >= 0) state.profiles[i] = p; else state.profiles.push(p);
  if (Array.isArray(p.models)) state.models = normalizeModelList(p.models);
  saveState();
  res.json(publicProfile(p));
});

app.delete('/api/results/:id', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  if (run.status === 'running') return res.status(409).json({ error: '正在运行的评测请先"中断"，结束后再删除' });
  runs.delete(req.params.id);
  saveRuns();
  res.json({ ok: true });
});

app.get('/api/comparisons', (req, res) => res.json(state.comparisons));
app.post('/api/comparisons', (req, res) => {
  const c = { ...req.body, id: req.body.id || Date.now().toString(36), createdAt: new Date().toISOString() };
  state.comparisons.push(c); saveState(); res.status(201).json(c);
});
app.patch('/api/comparisons/:id', (req, res) => {
  const c = state.comparisons.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  Object.assign(c, req.body, { updatedAt: new Date().toISOString() }); saveState(); res.json(c);
});

app.post('/api/models', async (req, res) => {
  try {
    const c = req.body || {}, base = (c.endpoint || 'http://127.0.0.1:9292/v1').replace(/\/$/, '');
    const r = await fetch(base + '/models', { headers: c.key ? { Authorization: 'Bearer ' + c.key } : {} });
    if (!r.ok) throw Error('HTTP ' + r.status);
    res.json(await r.json());
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/results', (req, res) => res.json([...runs.values()].filter((x) => x.status !== 'running').reverse().map((run) => ({ ...run, rows: (run.rows || []).map((row) => ({ ...row, log: (row.log && row.log.length) ? row.log : (run.log || []) })) }))));
app.get('/api/runs', (req, res) => res.json([...runs.values()].reverse()));
app.get('/api/runs/:id', (req, res) => res.json(runs.get(req.params.id) || { error: 'not found' }));
app.delete('/api/runs/:id', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  run.cancelRequested = true; run.current = '正在中断…';
  const c = controllers.get(run.id); if (c) c.abort();
  saveRuns(); res.json({ ok: true });
});

app.post('/api/runs', async (req, res) => {
  const b = req.body || {};
  const models = Array.isArray(b.models) ? b.models.filter(Boolean) : [];
  const rawTasks = Array.isArray(b.tasks) ? b.tasks.filter(Boolean) : [];
  if (!models.length || !rawTasks.length) return res.status(400).json({ error: '至少选择一个模型和一个测试项目' });
  // Per-task overrides: entries may be plain ids (legacy UI, run-level params)
  // or {id, limit, repeats, concurrency, maxTokens}.
  const taskConfigs = rawTasks.map((t) => {
    const cfg = { id: typeof t === 'string' ? t : t.id };
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
    const own = typeof t === 'object' && t ? t : b;
    cfg.limit = num(own.limit); cfg.repeats = num(own.repeats);
    cfg.concurrency = num(own.concurrency); cfg.maxTokens = num(own.maxTokens);
    return cfg;
  });
  if (taskConfigs.some((c) => CODE_KINDS.has(tasks.find((t) => t.id === c.id)?.kind))) {
    const judge = await judgeHealth();
    if (!judge.ok) return res.status(422).json({
      error: `代码类评测需要判题沙箱（${JUDGE_URL}）不可达：${judge.error}`,
      code: 'judge-unavailable', preflight: { judge },
    });
  }
  const id = Date.now().toString(36);
  const run = {
    id, name: b.name || '未命名测试', alias: b.alias || b.name || '未命名测试', note: b.note || '',
    models,
    tasks: taskConfigs.map((c) => c.id),
    taskConfigs,
    status: 'running', startedAt: new Date().toISOString(),
    rows: [], log: [], errors: [],
    progress: { modelIndex: 0, taskIndex: 0, repeat: 0, total: models.length * taskConfigs.length },
    config: { category: b.category, difficulty: b.difficulty, contextTarget: b.contextTarget, seed: b.seed },
  };
  runs.set(id, run);
  res.status(202).json({ id });
  execute(run, b).catch((e) => {
    run.status = run.rows.length ? 'crashed' : 'error';
    run.errors.push(e.stack || e.message);
    run.log.push('运行级错误：' + (e.stack || e.message));
    run.finishedAt = new Date().toISOString();
  });
});

async function execute(run, b) {
  for (let mi = 0; mi < run.models.length && !run.cancelRequested; mi++) {
    const model = run.models[mi]; run.progress.modelIndex = mi;
    for (let ti = 0; ti < run.taskConfigs.length && !run.cancelRequested; ti++) {
      const cfgT = run.taskConfigs[ti];
      const task = tasks.find((t) => t.id === cfgT.id);
      run.progress.taskIndex = ti;
      if (!task) { run.errors.push(`未知测试项目：${cfgT.id}`); continue; }
      const repeats = Math.min(20, Math.max(1, Number(cfgT.repeats) || 1));
      const concurrency = Math.min(16, Math.max(1, Number(cfgT.concurrency) || 1));
      run.current = `${model} · ${task.name} · 并发 ${concurrency}`;
      const vals = [], entryLog = [], jobs = Array.from({ length: repeats }, (_, i) => i);
      let cursor = 0;
      async function worker() {
        while (cursor < jobs.length && !run.cancelRequested) {
          const i = jobs[cursor++];
          run.progress.repeat = i + 1;
          const log = [`${model} / ${task.name} / 第 ${i + 1} 次：请求中…`];
          entryLog[i] = log;
          run.log.push(log[0]);
          run.currentEntryLog = log;
          try {
            const v = await measure(run, b, model, task, cfgT);
            if (run.cancelRequested) break;
            vals[i] = v;
            const line = `${model} / ${task.name} / 第 ${i + 1} 次：${JSON.stringify(v)}`;
            log.push(line); run.log.push(line);
          } catch (e) {
            if (run.cancelRequested) break;
            const msg = `${model} / ${task.name} / 第 ${i + 1} 次失败：${e.message}`;
            run.errors.push(msg); log.push(msg); run.log.push(msg);
          } finally {
            if (run.currentEntryLog === log) run.currentEntryLog = null;
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
      const good = vals.filter(Boolean);
      const avg = {};
      if (good.length) {
        for (const k of Object.keys(good[0])) {
          if (typeof good[0][k] === 'number') avg[k] = good.reduce((s, x) => s + (x[k] || 0), 0) / good.length;
          else avg[k] = good[good.length - 1][k];
        }
      } else {
        // all repeats failed or were interrupted — no fabricated sample counts
        avg.score = 0; avg.correct = 0; avg.incorrect = 0; avg.unknown = 0; avg.total = 0; avg.failedRepeats = repeats;
      }
      run.rows.push({ model, task: task.name, ability: task.ability, repeat: good.length, average: avg, details: good, log: entryLog.filter(Boolean).flat() });
      saveRuns();
    }
  }
  run.currentEntryLog = null;
  run.current = run.cancelRequested ? '已中断（已保留部分结果）' : '已完成';
  run.status = run.cancelRequested ? 'partial' : (run.errors.length ? 'error' : 'done');
  run.finishedAt = new Date().toISOString();
  saveRuns();
}

// Log to the run stream and to the in-flight row so 逐题日志 stays complete.
function logLine(run, line) {
  run.log.push(line);
  if (run.currentEntryLog) run.currentEntryLog.push(line);
}

// One-line per-problem verdict for code tasks: classified reason + model output snippet,
// so failures read as answers ("wrong result", "timeout") instead of raw tracebacks.
function logCodeVerdict(run, model, task, qi, count, verdict, modelText) {
  if (verdict.passed) {
    logLine(run, `${model} / ${task.name} / 题目 ${qi + 1}/${count}：通过`);
  } else {
    const snippet = String(modelText || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    logLine(run, `${model} / ${task.name} / 题目 ${qi + 1}/${count}：未通过（${verdict.reason}）${snippet ? `｜模型输出：${snippet}` : ''}`);
  }
}

// The scorer is deliberately strict: reasoning without final-answer evidence is unknown, never incorrect.
async function measure(run, b, model, task, cfgT = {}) {
  if (task.kind === 'smoke') {
    // 吐字速度要有参考意义：先预热（llama-swap 冷启动加载不算 TTFT），再用一个
    // 需要持续输出数百 token 的流式请求测 生成速度（不含首 token）与首 token 延迟。
    const outputLimit = Math.min(16384, Math.max(256, Number(cfgT.maxTokens) || task.defaultMaxTokens || 2048));
    const w0 = Date.now();
    const warm = await chat(b, model, '请只回复：OK。', { max_tokens: 16, runId: run.id });
    logLine(run, `${model} / ${task.name} / 预热完成 ${((Date.now() - w0) / 1000).toFixed(1)}s（含可能的模型加载），响应：${warm.text.trim().slice(0, 30) || '(空)'}`);
    const s = await chatStream(b, model, SMOKE_PROMPT, { max_tokens: outputLimit, runId: run.id });
    logLine(run, `${model} / ${task.name} / 首 token ${(s.ttftMs / 1000).toFixed(2)}s · 生成 ${s.tokPerSec.toFixed(1)} tok/s · 共 ${s.tokens} token${s.finishReason === 'length' ? '（达到 max_tokens 上限，速度可信）' : ''}`);
    return { ok: 1, firstMs: s.ttftMs, tokens: s.tokens, tokPerSec: s.tokPerSec, output: s.text.slice(0, 80) };
  }

  const { rows: sample, total } = readJsonl(task.file, taskLimit(cfgT, task));
  let correct = 0, incorrect = 0, unknown = 0;
  const outputLimit = Math.min(16384, Math.max(256, Number(cfgT.maxTokens) || task.defaultMaxTokens || 4096));

  // 并发 N 表示同一测试项目内同时有 N 个题目请求在途（judge 判题也并行）
  const concurrency = Math.min(16, Math.max(1, Number(cfgT.concurrency) || 1));
  let cursor = 0;
  async function qworker() {
    while (cursor < sample.length && !run.cancelRequested) {
      const qi = cursor++; // claim before awaiting so parallel workers never share a question
      await processQuestion(sample[qi], qi);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, sample.length) }, () => qworker()));

  async function processQuestion(q, qi) {
    logLine(run, `${model} / ${task.name} / 题目 ${qi + 1}/${sample.length}：请求中…`);
    try {
      if (task.kind === 'longbench2') {
        const r = await chat(b, model, buildLongBenchPrompt(q), { max_tokens: outputLimit, runId: run.id });
        const verdict = scoreChoice(q.answer, (r.text || '').trim());
        tally(verdict.status);
        logLine(run, `${model} / ${task.name} / 题目 ${qi + 1}/${sample.length}：${verdictLabel(verdict, r)}，模型回答 ${(r.text || '').slice(0, 200)}`);
      } else if (task.kind === 'gpqa' || task.kind === 'mmlu') {
        const prompt = task.kind === 'gpqa'
          ? `请解答下面选择题。最后一行必须严格写成“最终答案：X”或“\\boxed{X}”，X只能是 A、B、C 或 D。\n${q.problem}`
          : `请解答下面选择题。最后一行必须严格写成“最终答案：X”或“\\boxed{X}”，X只能是 A-J。\n${q.question}\n${q.options_text}`;
        const r = await chat(b, model, prompt, { max_tokens: outputLimit, runId: run.id });
        const verdict = scoreChoice(String(q.answer || '').toUpperCase(), (r.text || '').trim());
        tally(verdict.status);
        logLine(run, `${model} / ${task.name} / 题目 ${qi + 1}/${sample.length}：${verdictLabel(verdict, r)}，模型回答 ${(r.text || '').slice(0, 200)}`);
      } else if (task.kind === 'aime') {
        const prompt = `请解答下面AIME数学题。最后一行必须严格写成“最终答案：N”或“\\boxed{N}”，N是0到999的整数。\n${q.problem}`;
        const r = await chat(b, model, prompt, { max_tokens: outputLimit, runId: run.id });
        const verdict = scoreAime(String(q.answer), (r.text || r.reasoningText || '').trim());
        tally(verdict.status);
        logLine(run, `${model} / ${task.name} / 题目 ${qi + 1}/${sample.length}：${verdictLabel(verdict, r)}，模型回答 ${(r.text || '').slice(0, 200)}`);
      } else if (task.kind === 'humanevalplus' || task.kind === 'mbppplus') {
        const entry = task.kind === 'humanevalplus' ? q.entry_point : (q.code.match(/def\s+([A-Za-z_]\w*)\s*\(/) || [])[1];
        const prompt = task.kind === 'humanevalplus' ? buildHumanEvalPrompt(q) : buildMbppPrompt(q, entry || 'solution');
        const r = await chat(b, model, prompt, { max_tokens: outputLimit, runId: run.id });
        const code = extractCode(r.text);
        const verdict = judgeVerdict(await judgeRun({
          mode: 'tests', code, entry_point: entry, test_code: q.test, timeout: 15,
        }), task.kind);
        tally(verdict.passed ? 'correct' : 'incorrect');
        logCodeVerdict(run, model, task, qi, sample.length, verdict, r.text);
      } else if (task.kind === 'livecodebench') {
        // 官方口径：开启思考；判分只取思考后的正文（reasoning_content / <think> 已剥离）
        const r = await chat(b, model, buildLiveCodeBenchPrompt(q), { max_tokens: outputLimit, runId: run.id, thinking: true });
        const code = extractCode(r.text);
        let verdict;
        if (q.mode === 'functional') {
          verdict = judgeVerdict(await judgeRun({
            mode: 'script', code: buildLcbFunctionalScript(code, q.tests, q.entry), timeout: 10,
          }), 'livecodebench');
        } else {
          verdict = judgeVerdict(await judgeRun({
            mode: 'stdin', code, test_pairs: q.tests.map((t) => ({ input: t.i, expected: t.o })), timeout: 6,
          }), 'livecodebench');
        }
        tally(verdict.passed ? 'correct' : 'incorrect');
        logCodeVerdict(run, model, task, qi, sample.length, verdict, r.text);
      } else if (task.kind === 'ds1000') {
        const r = await chat(b, model, buildDs1000Prompt(q), { max_tokens: outputLimit, runId: run.id });
        const solution = extractCode(r.text, { solutionMarkers: true });
        const verdict = judgeVerdict(await judgeRun({
          mode: 'script', code: buildDs1000Script(q.code_context, solution), timeout: 60,
        }), 'ds1000');
        tally(verdict.passed ? 'correct' : 'incorrect');
        logCodeVerdict(run, model, task, qi, sample.length, verdict, r.text);
      } else if (task.kind === 'ifeval' || task.kind === 'ifbench') {
        // 官方校验器（vendored 到 judge/verifiers/）：prompt 原样下发，strict 口径判分
        const r = await chat(b, model, q.prompt, { max_tokens: outputLimit, runId: run.id });
        const script = task.kind === 'ifeval' ? buildIfevalScript(q, (r.text || '').trim()) : buildIfbenchScript(q, (r.text || '').trim());
        const jres = await judgeRun({ mode: 'script', code: script, timeout: 30 });
        const parsed = parseInstructionResult(jres);
        const passed = Boolean(parsed && parsed.strict);
        tally(passed ? 'correct' : 'incorrect');
        const failed = parsed ? q.instruction_id_list.filter((id, i) => !parsed.detail[i]) : q.instruction_id_list;
        logLine(run, `${model} / ${task.name} / 题目 ${qi + 1}/${sample.length}：${passed ? '通过' : '未通过'}（strict ${parsed ? (parsed.strict ? '✓' : '✗') : '?'} / loose ${parsed ? (parsed.loose ? '✓' : '✗') : '?'}）${failed.length ? `｜未满足约束：${failed.join(', ')}` : ''}｜回答前 120 字：${(r.text || '').slice(0, 120)}`);
      } else if (task.kind === 'xstest') {
        // 250 条"看起来危险、实际安全"的提示：正常作答=对，误拒=错
        const r = await chat(b, model, q.prompt, { max_tokens: outputLimit, runId: run.id });
        const v = classifyXstestRefusal(r.text);
        tally(v.refused ? 'incorrect' : 'correct');
        logLine(run, `${model} / ${task.name} / 题目 ${qi + 1}/${sample.length}：${v.refused ? `误拒（${v.reason}）` : '正常作答'}｜${q.type}｜回答：${(r.text || '').slice(0, 100)}`);
      } else {
        throw new Error(`未实现的测试类型：${task.kind}`);
      }
    } catch (e) {
      // question-level failure (network, judge down, context overflow) is data, not a crashed run
      unknown++;
      logLine(run, `${model} / ${task.name} / 题目 ${qi + 1}/${sample.length}：未知（${e.message}）`);
    }
  }
  const answered = correct + incorrect;
  return { score: aggregateScore({ correct, incorrect, unknown, total: sample.length }), correct, incorrect, unknown, total: sample.length, answered, samples: sample.length, poolTotal: total };

  function tally(status) {
    if (status === 'correct') correct++; else if (status === 'incorrect') incorrect++; else unknown++;
  }
}

function taskLimit(cfgT, task) {
  if (Number(cfgT.limit) > 0) return Number(cfgT.limit);
  return task.defaultLimit || 0;
}

function verdictLabel(verdict, r) {
  return verdict.status === 'unknown' ? (r.finishReason === 'length' ? '未知（输出达到长度上限）' : '未知（没有明确最终答案）')
    : verdict.status === 'correct' ? '正确' : '错误';
}

// Sustained-output prompt for the speed probe: long enough that decode speed
// dominates over TTFT, short enough to finish well inside default max_tokens.
const SMOKE_PROMPT = '请以“城市清晨”为主题写一篇约800字的散文。要求：语言流畅自然，有具体的画面、声音和细节描写，分3到4个自然段。除正文外不要输出任何解释或标题。';

// Streaming variant used by the speed probe: measures TTFT (first content chunk)
// and decode throughput over the rest of the generation.
async function chatStream(b, model, prompt, opts) {
  const base = (b.endpoint || 'http://127.0.0.1:9292/v1').replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (b.key) headers.Authorization = 'Bearer ' + b.key;
  const payload = {
    model, messages: [{ role: 'user', content: prompt }],
    temperature: 0, max_tokens: opts.max_tokens || 2048, stream: true,
    stream_options: { include_usage: true },
    chat_template_kwargs: { enable_thinking: false },
  };
  const controller = new AbortController();
  controllers.set(opts.runId || '', controller);
  let res;
  try {
    res = await fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      // Older OpenAI-compatible servers reject stream_options — retry without it.
      if (/stream_options/i.test(errText)) {
        delete payload.stream_options;
        res = await fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
      } else throw Error('HTTP ' + res.status + ' ' + errText.slice(0, 200));
    }
  } finally {
    controllers.delete(opts.runId || '');
  }
  if (!res.ok || !res.body) throw Error('HTTP ' + res.status);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', text = '', chunks = 0, usage = null, finishReason = null, tFirst = 0, tLast = 0;
  const t0 = Date.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      const delta = j.choices?.[0]?.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content; chunks++;
        if (!tFirst) tFirst = Date.now();
        tLast = Date.now();
      }
      if (j.usage) usage = j.usage;
      if (j.choices?.[0]?.finish_reason) finishReason = j.choices[0].finish_reason;
    }
  }
  const tokens = usage?.completion_tokens || chunks;
  const ttftMs = tFirst ? tFirst - t0 : Date.now() - t0;
  const speed = decodeSpeed(tokens, tFirst, tLast);
  return { text, tokens, ttftMs, tokPerSec: speed.tokPerSec, finishReason };
}

async function chat(b, model, prompt, opts) {
  const base = (b.endpoint || 'http://127.0.0.1:9292/v1').replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (b.key) headers.Authorization = 'Bearer ' + b.key;
  const controller = new AbortController();
  controllers.set(opts.runId || '', controller);
  let r;
  try {
    r = await fetch(base + '/chat/completions', {
      method: 'POST', headers,
      body: JSON.stringify({
        model, messages: [{ role: 'user', content: prompt }],
        temperature: 0, max_tokens: opts.max_tokens || 128, stream: false,
        // 默认抑制思维链；LiveCodeBench 等官方口径开启思考的任务传 thinking: true
        chat_template_kwargs: { enable_thinking: opts.thinking === true },
      }),
      signal: controller.signal,
    });
  } finally {
    controllers.delete(opts.runId || '');
  }
  if (!r.ok) throw Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  const msg = j.choices?.[0]?.message || {};
  const text = msg.content || '';
  const reasoningText = msg.reasoning_content || msg.reasoning || '';
  const usage = j.usage || {};
  const tok = usage.completion_tokens || text.length / 2;
  return { text, reasoningText, tokens: tok, finishReason: j.choices?.[0]?.finish_reason, raw: j };
}

app.listen(process.env.PORT || 3000, () => console.log('llm-test listening on ' + (process.env.PORT || 3000)));
