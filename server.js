const express = require('express');
const fs = require('fs');
const path = require('path');
const { scoreChoice, scoreAime, aggregateScore } = require('./server/scoring');
const { JUDGE_URL, judgeRun, judgeHealth } = require('./server/judge');
const {
  readJsonl, extractCode,
  buildLongBenchPrompt, buildHumanEvalPrompt, buildMbppPrompt,
  buildLiveCodeBenchPrompt, buildDs1000Prompt,
  buildDs1000Script, buildLcbFunctionalScript, judgeVerdict, judgeReason,
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
  if (fs.existsSync(savedRuns)) for (const r of JSON.parse(fs.readFileSync(savedRuns, 'utf8'))) runs.set(r.id, normalizeRunScores(r));
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
  { id: 'smoke_speed', name: '连通性与吐字速度', ability: '实际可用性 / 首 token 与生成速度', kind: 'smoke' },
  { id: 'gpqa_cached', name: 'GPQA Diamond（缓存题库）', ability: '高难度科学推理与知识整合', kind: 'gpqa', file: 'gpqa_diamond_mc.jsonl', defaultLimit: 198 },
  { id: 'aime_cached', name: 'AIME 2025（缓存题库）', ability: '数学竞赛推理与精确计算', kind: 'aime', file: 'aime_2025.jsonl', defaultLimit: 30 },
  { id: 'mmlu_pro_cached', name: 'MMLU-Pro（缓存题库）', ability: '广泛知识、学科理解与选择题稳健性', kind: 'mmlu', file: 'MMLU-Pro.jsonl', defaultLimit: 100 },
  { id: 'longbench2', name: 'LongBench v2（长上下文）', ability: '超长上下文检索、长文推理与指令跟随', kind: 'longbench2', file: 'longbench2.jsonl', defaultLimit: 30 },
  { id: 'humanevalplus', name: 'HumanEval+（代码生成）', ability: '函数级 Python 代码生成的正确性（增强测试集）', kind: 'humanevalplus', file: 'humanevalplus.jsonl', defaultLimit: 40 },
  { id: 'mbppplus', name: 'MBPP+（代码生成）', ability: '基础编程任务代码生成的正确性（增强测试集）', kind: 'mbppplus', file: 'mbppplus.jsonl', defaultLimit: 40 },
  { id: 'livecodebench', name: 'LiveCodeBench（竞赛编程）', ability: '竞赛级算法编程（stdin / 函数式，隐藏测试）', kind: 'livecodebench', file: 'livecodebench.jsonl', defaultLimit: 30 },
  { id: 'ds1000', name: 'DS-1000（数据科学编程）', ability: 'NumPy/Pandas/SciPy/Sklearn/Matplotlib 真实数据科学任务', kind: 'ds1000', file: 'ds1000.jsonl', defaultLimit: 40 },
];
const CODE_KINDS = new Set(['humanevalplus', 'mbppplus', 'livecodebench', 'ds1000']);

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
      } else { avg.score = 0; avg.correct = 0; avg.total = repeats; }
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
    const t = Date.now();
    const r = await chat(b, model, '请只回复：测试通过。', { max_tokens: 64, runId: run.id });
    const ms = Date.now() - t;
    return { ok: 1, firstMs: ms, tokens: r.tokens || 0, tokPerSec: r.tokPerSec || 0, output: r.text.slice(0, 80) };
  }

  const { rows: sample, total } = readJsonl(task.file, taskLimit(cfgT, task));
  let correct = 0, incorrect = 0, unknown = 0;
  const outputLimit = Math.min(8192, Math.max(256, Number(cfgT.maxTokens) || 4096));

  for (let qi = 0; qi < sample.length && !run.cancelRequested; qi++) {
    const q = sample[qi];
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
        const r = await chat(b, model, buildLiveCodeBenchPrompt(q), { max_tokens: outputLimit, runId: run.id });
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
        chat_template_kwargs: { enable_thinking: false },
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
