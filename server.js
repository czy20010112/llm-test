const express = require('express');
const fs = require('fs');
const path = require('path');
const { scoreChoice, scoreAime, aggregateScore } = require('./server/scoring');
const { JUDGE_URL, judgeRun, judgeHealth } = require('./server/judge');
const { requestFetchOptions } = require('./server/llm-client');
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
    // 旧记录没有 row.status：smoke 行 1 次即完整，其余按已完成轮次与最近一次平均推断，
    // 这里不依赖 tasks 注册表（注册表声明在后面），进度统计依赖该状态
    if (!row.status) {
      const target = row.average && row.average.ok === 1 ? 1 : Math.max(1, row.repeat || 1);
      row.status = (row.repeat || 0) >= target ? 'done' : 'partial';
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

// 同一次运行可能同时有多个在途请求（重复轮 × 题目并发），按 Set 追踪，取消时全部中止
const controllers = new Map(); // runId -> Set<AbortController>
function track(runId, controller) {
  if (!runId) return;
  let s = controllers.get(runId);
  if (!s) controllers.set(runId, s = new Set());
  s.add(controller);
}
function untrack(runId, controller) {
  const s = controllers.get(runId);
  if (s) { s.delete(controller); if (!s.size) controllers.delete(runId); }
}
function abortAll(runId) {
  const s = controllers.get(runId);
  if (s) for (const c of [...s]) c.abort();
}
const stateFile = path.join(__dirname, 'data', 'workbench-state.json');
let state = { profiles: [], models: [], comparisons: [], baselines: [] };
try { if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
function saveState() {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// defaultLimit: sampled questions when the caller does not pass a limit
const tasks = [
  { id: 'smoke_speed', name: '连通性与吐字速度', name_en: 'Connectivity & Decode Speed', ability: '实际可用性 / 首 token 与生成速度', ability_en: 'Real-world usability / TTFT & decode speed', kind: 'smoke', defaultMaxTokens: 2048 },
  { id: 'gpqa_cached', name: 'GPQA Diamond（科学推理）', name_en: 'GPQA Diamond (Science)', ability: '高难度科学推理与知识整合｜官方口径：开启思考（xhigh）｜全量 198 题', ability_en: 'Graduate-level science reasoning | official: thinking on (xhigh) | 198 items', kind: 'gpqa', file: 'gpqa_diamond_mc.jsonl', defaultLimit: 198, defaultMaxTokens: 32768 },
  { id: 'aime_cached', name: 'AIME 2025（数学推理）', name_en: 'AIME 2025 (Math)', ability: '数学竞赛推理与精确计算｜官方口径：开启思考（输出预算 38912）｜全量 30 题', ability_en: 'Competition math reasoning | official: thinking on (38,912-token budget) | 30 items', kind: 'aime', file: 'aime_2025.jsonl', defaultLimit: 30, defaultMaxTokens: 38912 },
  { id: 'mmlu_pro_cached', name: 'MMLU-Pro（综合知识）', name_en: 'MMLU-Pro (Knowledge)', ability: '广泛知识、学科理解与选择题稳健性｜全量 12032 题', ability_en: 'Broad knowledge & MCQ robustness | 12032 items', kind: 'mmlu', file: 'MMLU-Pro.jsonl', defaultLimit: 100, defaultMaxTokens: 4096 },
  { id: 'longbench2', name: 'LongBench v2（长上下文）', name_en: 'LongBench v2 (Long Context)', ability: '超长上下文检索、长文推理与指令跟随｜全量 503 题', ability_en: 'Long-context retrieval & reasoning | 503 items', kind: 'longbench2', file: 'longbench2.jsonl', defaultLimit: 30, defaultMaxTokens: 2048 },
  { id: 'humanevalplus', name: 'HumanEval+（代码生成）', name_en: 'HumanEval+ (Code)', ability: '函数级 Python 代码生成的正确性（增强测试集）｜全量 164 题', ability_en: 'Function-level Python correctness (augmented) | 164 items', kind: 'humanevalplus', file: 'humanevalplus.jsonl', defaultLimit: 40, defaultMaxTokens: 8192 },
  { id: 'mbppplus', name: 'MBPP+（代码生成）', name_en: 'MBPP+ (Code)', ability: '基础编程任务代码生成的正确性（增强测试集）｜全量 378 题', ability_en: 'Basic Python programming correctness (augmented) | 378 items', kind: 'mbppplus', file: 'mbppplus.jsonl', defaultLimit: 40, defaultMaxTokens: 8192 },
  { id: 'livecodebench', name: 'LiveCodeBench（竞赛编程）', name_en: 'LiveCodeBench (Competitive)', ability: '竞赛级算法编程（stdin / 函数式，隐藏测试）｜官方口径：开启思考（xhigh）｜全量 342 题', ability_en: 'Competitive programming, hidden tests | official: thinking on (xhigh) | 342 items', kind: 'livecodebench', file: 'livecodebench.jsonl', defaultLimit: 30, defaultMaxTokens: 32768 },
  { id: 'ds1000', name: 'DS-1000（数据科学编程）', name_en: 'DS-1000 (Data Science)', ability: 'NumPy/Pandas/SciPy/Sklearn/Matplotlib 真实数据科学任务｜全量 1000 题', ability_en: 'Real data-science tasks across the SciPy stack | 1000 items', kind: 'ds1000', file: 'ds1000.jsonl', defaultLimit: 40, defaultMaxTokens: 8192 },
  { id: 'ifeval', name: 'IFEval（指令遵循）', name_en: 'IFEval (Instruction Following)', ability: '可验证指令约束的精确遵循（格式/字数/关键词等）｜全量 541 题', ability_en: 'Verifiable instruction constraints | 541 items', kind: 'ifeval', file: 'ifeval.jsonl', defaultLimit: 100, defaultMaxTokens: 4096 },
  { id: 'ifbench', name: 'IFBench（指令泛化）', name_en: 'IFBench (IF Generalization)', ability: '域外可验证指令的泛化遵循（AllenAI 2025）｜官方口径：开启思考（xhigh）｜全量 300 题', ability_en: 'Out-of-domain instruction constraints (AllenAI 2025) | official: thinking on (xhigh) | 300 items', kind: 'ifbench', file: 'ifbench.jsonl', defaultLimit: 100, defaultMaxTokens: 32768 },
  { id: 'safetybench_cn', name: 'SafetyBench（中文安全）', name_en: 'SafetyBench (Safety, zh)', ability: '安全风险场景选择题（违法/隐私/歧视/身心健康等）｜全量 11435 题', ability_en: 'Safety risk MCQ (fraud/privacy/discrimination etc.) | 11435 items', kind: 'mmlu', file: 'safetybench_cn.jsonl', defaultLimit: 100, defaultMaxTokens: 2048 },
  { id: 'xstest', name: 'XSTest（过度拒绝）', name_en: 'XSTest (Over-refusal)', ability: '安全提示误拒校准（看起来危险、实际安全）｜全量 250 题', ability_en: 'Exaggerated-safety calibration (safe but scary prompts) | 250 items', kind: 'xstest', file: 'xstest.jsonl', defaultLimit: 250, defaultMaxTokens: 1024 },
];
const CODE_KINDS = new Set(['humanevalplus', 'mbppplus', 'livecodebench', 'ds1000', 'ifeval', 'ifbench']);
const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const LEGACY_THINKING_KINDS = new Set(['gpqa', 'aime', 'livecodebench', 'ifbench']);

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

// 历史记录里重命名一次评测（名称 / 备注）
app.patch('/api/results/:id', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  if (typeof req.body?.name === 'string' && req.body.name.trim()) run.name = req.body.name.trim();
  if (typeof req.body?.note === 'string') run.note = req.body.note.trim();
  run.alias = run.name;
  saveRuns();
  res.json({ ok: true, name: run.name, note: run.note });
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
    // 协议：openai = /v1/models（默认）；llama-swap = /v1/models 之上再取 /v1/mu/models 拼接运行配置；
    // oai_pages 走 OpenAI 分页式（data[].id + has_more）——遇到非标服务时可手动指定
    const proto = String(c.protocol || 'openai');
    const headers = c.key ? { Authorization: 'Bearer ' + c.key } : {};
    const out = { protocol: proto, models: [] };
    const j = async (url) => {
      const r = await fetch(url, { headers });
      if (!r.ok) throw Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
      return r.json();
    };
    if (proto === 'llama-swap') {
      let list = [];
      try {
        const m = await j(base + '/models');
        list = (m.data || []).map((x) => ({ id: x.id, name: x.name || undefined, description: x.description || undefined }));
      } catch { /* lower versions have no /v1/models either */ }
      try {
        const mu = await j(base.replace(/\/v1$/, '') + '/mu/models');
        const extras = (Array.isArray(mu) ? mu : []).map((x) => ({
          id: x.name || x.id,
          name: x.state !== undefined ? `${x.name || x.id} · ${x.state}` : undefined,
          description: x.metadata ? Object.keys(x.metadata).slice(0, 3).join(', ') : undefined,
        })).filter((x) => x.id && !list.some((m) => m.id === x.id));
        list = [...list, ...extras];
      } catch { /* /mu/models unavailable — plain list only */ }
      if (!list.length) throw Error('未获取到任何模型（/v1/models 与 /mu/models 均不可用）');
      out.models = list;
    } else {
      // OpenAI 兼容：自动翻页（最多 20 页），兼容使用 first-id 游标的服务
      let url = base + '/models?limit=100';
      for (let page = 0; page < 20 && url; page++) {
        const m = await j(url);
        out.models.push(...(m.data || []).map((x) => ({ id: x.id, name: x.name || undefined, description: x.description || undefined })));
        url = m.has_more && (m.data || []).length ? base + '/models?limit=100&after=' + encodeURIComponent(m.data[m.data.length - 1].id) : null;
      }
    }
    out.models = out.models.filter((m) => m && m.id);
    res.json(out);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/results', (req, res) => res.json([...runs.values()].filter((x) => x.status !== 'running').reverse().map((run) => ({ ...run, rows: (run.rows || []).map((row) => ({ ...row, log: (row.log && row.log.length) ? row.log : (run.log || []) })) }))));
app.get('/api/runs', (req, res) => res.json([...runs.values()].reverse().map((run) => ({ ...run, donePairs: (run.rows || []).filter((r) => r.status === 'done').length }))));
app.get('/api/runs/:id', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  res.json({ ...run, donePairs: (run.rows || []).filter((r) => r.status === 'done').length });
});
app.delete('/api/runs/:id', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  run.cancelRequested = true; run.current = '正在中断…';
  abortAll(run.id);
  saveRuns(); res.json({ ok: true });
});

// 继续测评：完整的“模型×项目”对直接跳过；不完整的对保留题目级检查点（checkpoint.items），
// 只重跑没有终态的题目，已完成的轮次也不再重跑
app.post('/api/runs/:id/resume', (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  if (run.status === 'running') return res.status(409).json({ error: '该运行仍在进行中' });
  const kept = new Set();
  // Keep partial rows: their checkpoint contains the completed questions/repeats
  // needed to resume instead of starting the task over.
  for (const row of run.rows || []) {
    if (row.status === 'done') kept.add(row.model + '\u0000' + row.task);
  }
  const totalPairs = (run.models || []).length * (run.taskConfigs || []).length;
  if (kept.size >= totalPairs) return res.status(400).json({ error: '所有测试项目均已完成，无需继续' });
  run.status = 'running';
  run.cancelRequested = false;
  run.errors = [];
  run.current = '继续执行中…';
  delete run.finishedAt;
  run.log.push(`${nowTs()} 继续测评：跳过 ${kept.size} 个已完成项目，其余从未完成的题目处继续`);
  saveRuns();
  res.status(202).json({ id: run.id });
  execute(run, { endpoint: run.endpoint, key: run.key }, kept).catch((e) => {
    run.status = run.rows.length ? 'crashed' : 'error';
    run.errors.push(e.stack || e.message);
    run.log.push('运行级错误：' + (e.stack || e.message));
    run.finishedAt = new Date().toISOString();
    saveRuns();
  });
});

app.post('/api/runs', async (req, res) => {
  const b = req.body || {};
  const models = Array.isArray(b.models) ? b.models.filter(Boolean) : [];
  const rawTasks = Array.isArray(b.tasks) ? b.tasks.filter(Boolean) : [];
  if (!models.length || !rawTasks.length) return res.status(400).json({ error: '至少选择一个模型和一个测试项目' });
  // Per-task overrides: entries may be plain ids (legacy UI, run-level params)
  // or {id, limit, repeats, concurrency, maxTokens, thinking, reasoningEffort}.
  const taskConfigs = rawTasks.map((t) => {
    const cfg = { id: typeof t === 'string' ? t : t.id };
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
    const own = typeof t === 'object' && t ? t : b;
    cfg.limit = num(own.limit); cfg.repeats = num(own.repeats);
    cfg.concurrency = num(own.concurrency); cfg.maxTokens = num(own.maxTokens);
    cfg.thinking = own.thinking === true;
    cfg.reasoningEffort = cfg.thinking && REASONING_EFFORTS.has(String(own.reasoningEffort))
      ? String(own.reasoningEffort) : null;
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
    endpoint: b.endpoint, key: b.key,
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
    saveRuns();
  });
});

async function execute(run, b, skip = null) {
  for (let mi = 0; mi < run.models.length && !run.cancelRequested; mi++) {
    const model = run.models[mi]; run.progress.modelIndex = mi;
    for (let ti = 0; ti < run.taskConfigs.length && !run.cancelRequested; ti++) {
      const cfgT = run.taskConfigs[ti];
      const task = tasks.find((t) => t.id === cfgT.id);
      run.progress.taskIndex = ti;
      if (!task) { run.errors.push(`未知测试项目：${cfgT.id}`); continue; }
      if (skip && skip.has(model + '\u0000' + task.name)) {
        run.log.push(`${nowTs()} 跳过已完成：${model} / ${task.name}`);
        continue;
      }
      const repeats = Math.min(20, Math.max(1, Number(cfgT.repeats) || 1));
      const concurrency = Math.min(16, Math.max(1, Number(cfgT.concurrency) || 1));
      run.current = `${model} · ${task.name} · 并发 ${concurrency}`;
      // 重复轮次严格串行：任一时刻在途的题目请求 ≤ concurrency，而不是 repeats × concurrency。
      // 每个 model×task 对进入执行时就先落一行（status=running），逐题更新统计并保存，
      // 中断/崩溃/服务重启后都能看到阶段性得分，恢复时也以此为检查点。
      const key = model + '\u0000' + task.name;
      let row = run.rows.find((r) => r.model === model && r.task === task.name);
      if (row && row.status === 'done') continue;
      if (!row) { row = { model, task: task.name, ability: task.ability, status: 'running', repeat: 0, average: {}, details: [], log: [] }; run.rows.push(row); }
      row.status = 'running';
      row.repeatsTarget = repeats;
      const doneRepeats = (row.details || []).filter(Boolean).length;
      const liveRepeat = (row.checkpoint && row.checkpoint.liveRepeat) || 0;
      // 断点续跑：完整轮次跳过，未完成轮次带题目检查点重入（未记录终态的题会重新请求）
      for (let i = doneRepeats; i < repeats && !run.cancelRequested; i++) {
        const resumeCheckpoint = (i === liveRepeat - 1 && row.checkpoint) ? row.checkpoint.items : null;
        run.progress.repeat = i + 1;
        const log = [`${nowTs()} ${model} / ${task.name} / 第 ${i + 1} 次：请求中…`];
        row.log.push(log[0]);
        run.log.push(log[0]);
        run.currentEntryLog = log;
        row.checkpoint = { liveRepeat: i + 1, items: resumeCheckpoint || {} };
        saveRuns();
        try {
          const v = await measure(run, b, model, task, cfgT, resumeCheckpoint);
          if (run.cancelRequested) break;
          row.details[i] = v;
          row.repeat = row.details.filter(Boolean).length;
          row.average = avgOf(row.details.filter(Boolean), task);
          row.checkpoint = { liveRepeat: i + 1, items: v.items || {}, done: true };
          const line = `${nowTs()} ${model} / ${task.name} / 第 ${i + 1} 次：${JSON.stringify({ score: v.score, correct: v.correct, incorrect: v.incorrect, unknown: v.unknown, total: v.total })}`;
          row.log.push(line); run.log.push(line);
          saveRuns();
        } catch (e) {
          if (run.cancelRequested) break;
          const msg = `${nowTs()} ${model} / ${task.name} / 第 ${i + 1} 次失败：${e.message}`;
          run.errors.push(msg); row.log.push(msg); run.log.push(msg);
          saveRuns();
        } finally {
          if (run.currentEntryLog === log) run.currentEntryLog = null;
        }
      }
      if (row.details.filter(Boolean).length >= repeats && !run.cancelRequested) {
        row.status = 'done';
        row.checkpoint = null;
      } else if (run.cancelRequested) {
        row.status = 'partial';
      }
      saveRuns();
    }
  }
  run.currentEntryLog = null;
  run.current = run.cancelRequested ? '已中断（已保留部分结果）' : '已完成';
  run.status = run.cancelRequested ? 'partial' : (run.errors.length ? 'error' : 'done');
  run.finishedAt = new Date().toISOString();
  saveRuns();
}

function avgOf(good, task) {
  if (!good.length) return task.kind === 'smoke' ? { failedRepeats: 0 } : { score: 0, correct: 0, incorrect: 0, unknown: 0, total: 0, failedRepeats: 0 };
  const avg = {};
  for (const k of Object.keys(good[0])) {
    if (typeof good[0][k] === 'number') avg[k] = good.reduce((s, x) => s + (x[k] || 0), 0) / good.length;
    else if (k === 'items') avg[k] = good[good.length - 1][k];
  }
  return avg;
}

// Log to the run stream and to the in-flight row so 逐题日志 stays complete.
const nowTs = () => new Date().toTimeString().slice(0, 8);
function logLine(run, line) {
  const stamped = `${nowTs()} ${line}`;
  run.log.push(stamped);
  if (run.currentEntryLog) run.currentEntryLog.push(stamped);
  console.log(stamped); // 控制台启动方式下实时可见（判题中、报错等）
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
// 兜底：若服务端未把思考拆到 reasoning_content，剥掉正文中的 <think> 段，避免思考文本污染判分
function stripThink(s) {
  return s.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
}
async function measure(run, b, model, task, cfgT = {}, resumeItems = null) {
  const thinking = resolveThinking(cfgT, task);
  const effort = thinking ? resolveReasoningEffort(cfgT) : undefined;
  if (task.kind === 'smoke') {
    // 吐字速度要有参考意义：先预热（llama-swap 冷启动加载不算 TTFT），再用一个
    // 需要持续输出数百 token 的流式请求测 生成速度（不含首 token）与首 token 延迟。
    const outputLimit = Math.min(65536, Math.max(256, Number(cfgT.maxTokens) || task.defaultMaxTokens || 2048));
    const hbLabel = `${model} / ${task.name}`;
    const w0 = Date.now();
    const warm = await chat(b, model, '请只回复：OK。', { max_tokens: 16, runId: run.id, heartbeat: hbLabel, thinking, effort });
    logLine(run, `${model} / ${task.name} / 预热完成 ${((Date.now() - w0) / 1000).toFixed(1)}s（含可能的模型加载），响应：${warm.text.trim().slice(0, 30) || '(空)'}`);
    const s = await chatStream(b, model, SMOKE_PROMPT, { max_tokens: outputLimit, runId: run.id, heartbeat: hbLabel, thinking, effort });
    logLine(run, `${model} / ${task.name} / 首 token ${(s.ttftMs / 1000).toFixed(2)}s · 生成 ${s.tokPerSec.toFixed(1)} tok/s · 共 ${s.tokens} token${s.finishReason === 'length' ? '（达到 max_tokens 上限，速度可信）' : ''}`);
    return { ok: 1, firstMs: s.ttftMs, tokens: s.tokens, tokPerSec: s.tokPerSec, output: s.text.slice(0, 80), items: {} };
  }

  const { rows: sample, total } = readJsonl(task.file, taskLimit(cfgT, task));
  let correct = 0, incorrect = 0, unknown = 0;
  const outputLimit = Math.min(65536, Math.max(256, Number(cfgT.maxTokens) || task.defaultMaxTokens || 4096));
  // 题目级检查点：恢复时带进来的是上一轮已判出终态的题（qi -> verdict），这些题直接跳过，
  // 统计沿用检查点记录的值，不重新请求模型
  const items = resumeItems || {};
  if (resumeItems) {
    for (const v of Object.values(resumeItems)) {
      if (v === 'correct') correct++; else if (v === 'incorrect') incorrect++; else unknown++;
    }
    if (Object.keys(resumeItems).length)
      logLine(run, `${model} / ${task.name} / 从检查点恢复：已完成 ${Object.keys(resumeItems).length}/${sample.length} 题，其余继续`);
  }

  // 并发 N 表示同一测试项目内同时有 N 个题目请求在途（judge 判题也并行）
  const concurrency = Math.min(16, Math.max(1, Number(cfgT.concurrency) || 1));
  let cursor = 0;
  async function qworker() {
    while (cursor < sample.length && !run.cancelRequested) {
      const qi = cursor++; // claim before awaiting so parallel workers never share a question
      if (items[qi] != null) continue; // 检查点里已有终态
      await processQuestion(sample[qi], qi);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, sample.length) }, () => qworker()));

  async function processQuestion(q, qi) {
    const hbLabel = `${model} / ${task.name} / 题目 ${qi + 1}/${sample.length}`;
    logLine(run, `${model} / ${task.name} / 题目 ${qi + 1}/${sample.length}：请求中…`);
    try {
      if (task.kind === 'longbench2') {
        const r = await chat(b, model, buildLongBenchPrompt(q), { max_tokens: outputLimit, runId: run.id, heartbeat: hbLabel, thinking, effort });
        const verdict = scoreChoice(q.answer, (r.text || '').trim());
        tally(verdict.status, qi);
        logLine(run, `${model} / ${task.name} / 题目 ${qi + 1}/${sample.length}：${verdictLabel(verdict, r)}，模型回答 ${(r.text || '').slice(0, 200)}`);
      } else if (task.kind === 'gpqa' || task.kind === 'mmlu') {
        const prompt = task.kind === 'gpqa'
          ? `请解答下面选择题。最后一行必须严格写成“最终答案：X”或“\\boxed{X}”，X只能是 A、B、C 或 D。\n${q.problem}`
          : `请解答下面选择题。最后一行必须严格写成“最终答案：X”或“\\boxed{X}”，X只能是 A-J。\n${q.question}\n${q.options_text}`;
        const r = await chat(b, model, prompt, { max_tokens: outputLimit, runId: run.id, thinking, effort });
        const verdict = scoreChoice(String(q.answer || '').toUpperCase(), stripThink((r.text || '').trim()));
        tally(verdict.status, qi);
        logLine(run, `${model} / ${task.name} / 题目 ${qi + 1}/${sample.length}：${verdictLabel(verdict, r)}，模型回答 ${(r.text || '').slice(0, 200)}`);
      } else if (task.kind === 'aime') {
        const prompt = `请解答下面AIME数学题。最后一行必须严格写成“最终答案：N”或“\\boxed{N}”，N是0到999的整数。\n${q.problem}`;
        const r = await chat(b, model, prompt, { max_tokens: outputLimit, runId: run.id, thinking, effort });
        const verdict = scoreAime(String(q.answer), stripThink(String(r.text || r.reasoningText || '').trim()));
        tally(verdict.status, qi);
        logLine(run, `${model} / ${task.name} / 题目 ${qi + 1}/${sample.length}：${verdictLabel(verdict, r)}，模型回答 ${(r.text || '').slice(0, 200)}`);
      } else if (task.kind === 'humanevalplus' || task.kind === 'mbppplus') {
        const entry = task.kind === 'humanevalplus' ? q.entry_point : (q.code.match(/def\s+([A-Za-z_]\w*)\s*\(/) || [])[1];
        const prompt = task.kind === 'humanevalplus' ? buildHumanEvalPrompt(q) : buildMbppPrompt(q, entry || 'solution');
        const r = await chat(b, model, prompt, { max_tokens: outputLimit, runId: run.id, heartbeat: hbLabel, thinking, effort });
        const code = extractCode(r.text);
        const verdict = judgeVerdict(await judgeRun({
          mode: 'tests', code, entry_point: entry, test_code: q.test, timeout: 15,
        }), task.kind);
        tally(verdict.passed ? 'correct' : 'incorrect', qi);
        logCodeVerdict(run, model, task, qi, sample.length, verdict, r.text);
      } else if (task.kind === 'livecodebench') {
        // 判分只取思考后的正文（reasoning_content / <think> 已剥离）
        const r = await chat(b, model, buildLiveCodeBenchPrompt(q), { max_tokens: outputLimit, runId: run.id, thinking, effort });
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
        tally(verdict.passed ? 'correct' : 'incorrect', qi);
        logCodeVerdict(run, model, task, qi, sample.length, verdict, r.text);
      } else if (task.kind === 'ds1000') {
        const r = await chat(b, model, buildDs1000Prompt(q), { max_tokens: outputLimit, runId: run.id, heartbeat: hbLabel, thinking, effort });
        const solution = extractCode(r.text, { solutionMarkers: true });
        const verdict = judgeVerdict(await judgeRun({
          mode: 'script', code: buildDs1000Script(q.code_context, solution), timeout: 60,
        }), 'ds1000');
        tally(verdict.passed ? 'correct' : 'incorrect', qi);
        logCodeVerdict(run, model, task, qi, sample.length, verdict, r.text);
      } else if (task.kind === 'ifeval' || task.kind === 'ifbench') {
        // 官方校验器（vendored 到 judge/verifiers/）：prompt 原样下发，strict 口径判分
        const r = await chat(b, model, q.prompt, { max_tokens: outputLimit, runId: run.id, thinking, effort });
        const response = stripThink((r.text || '').trim());
        const script = task.kind === 'ifeval' ? buildIfevalScript(q, response) : buildIfbenchScript(q, response);
        const jres = await judgeRun({ mode: 'script', code: script, timeout: 30 });
        const parsed = parseInstructionResult(jres);
        const passed = Boolean(parsed && parsed.strict);
        tally(passed ? 'correct' : 'incorrect', qi);
        const failed = parsed ? q.instruction_id_list.filter((id, i) => !parsed.detail[i]) : q.instruction_id_list;
        logLine(run, `${model} / ${task.name} / 题目 ${qi + 1}/${sample.length}：${passed ? '通过' : '未通过'}（strict ${parsed ? (parsed.strict ? '✓' : '✗') : '?'} / loose ${parsed ? (parsed.loose ? '✓' : '✗') : '?'}）${failed.length ? `｜未满足约束：${failed.join(', ')}` : ''}｜回答前 120 字：${(r.text || '').slice(0, 120)}`);
      } else if (task.kind === 'xstest') {
        // 250 条"看起来危险、实际安全"的提示：正常作答=对，误拒=错
        const r = await chat(b, model, q.prompt, { max_tokens: outputLimit, runId: run.id, heartbeat: hbLabel, thinking, effort });
        const v = classifyXstestRefusal(r.text);
        tally(v.refused ? 'incorrect' : 'correct', qi);
        logLine(run, `${model} / ${task.name} / 题目 ${qi + 1}/${sample.length}：${v.refused ? `误拒（${v.reason}）` : '正常作答'}｜${q.type}｜回答：${(r.text || '').slice(0, 100)}`);
      } else {
        throw new Error(`未实现的测试类型：${task.kind}`);
      }
    } catch (e) {
      // question-level failure (network, judge down, context overflow) is data, not a crashed run
      // 用户取消导致的失败不算终态（恢复时会重新请求），其余计为未知并写入检查点
      if (run.cancelRequested) throw e;
      unknown++;
      items[qi] = 'unknown';
      logLine(run, `${model} / ${task.name} / 题目 ${qi + 1}/${sample.length}：未知（${e.message}）`);
    }
  }
  const answered = correct + incorrect;
  return { score: aggregateScore({ correct, incorrect, unknown, total: sample.length }), correct, incorrect, unknown, total: sample.length, answered, samples: sample.length, poolTotal: total, items };

  function tally(status, qi) {
    if (status === 'correct') correct++; else if (status === 'incorrect') incorrect++; else unknown++;
    if (qi != null) items[qi] = status; // 题目级检查点：中断/恢复时据此跳过已判题
  }
}

function taskLimit(cfgT, task) {
  if (Number(cfgT.limit) > 0) return Number(cfgT.limit);
  return task.defaultLimit || 0;
}

// New runs persist an explicit boolean. Older runs omitted it and used the
// former official-thinking defaults, so keep those runs reproducible.
function resolveThinking(cfgT, task) {
  return typeof cfgT.thinking === 'boolean' ? cfgT.thinking : LEGACY_THINKING_KINDS.has(task.kind);
}

function resolveReasoningEffort(cfgT) {
  if (REASONING_EFFORTS.has(String(cfgT.reasoningEffort))) return String(cfgT.reasoningEffort);
  return 'xhigh';
}

function verdictLabel(verdict, r) {
  return verdict.status === 'unknown' ? (r.finishReason === 'length' ? '未知（输出达到长度上限）' : '未知（没有明确最终答案）')
    : verdict.status === 'correct' ? '正确' : '错误';
}

// Sustained-output prompt for the speed probe: long enough that decode speed
// dominates over TTFT, short enough to finish well inside default max_tokens.
const SMOKE_PROMPT = '请以“城市清晨”为主题写一篇约800字的散文。要求：语言流畅自然，有具体的画面、声音和细节描写，分3到4个自然段。除正文外不要输出任何解释或标题。';

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const THINKING_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const CONFIGURED_REQUEST_TIMEOUT_MS = Number(process.env.LLM_REQUEST_TIMEOUT_MS);

function requestTimeoutMs(opts = {}) {
  if (Number.isFinite(CONFIGURED_REQUEST_TIMEOUT_MS) && CONFIGURED_REQUEST_TIMEOUT_MS > 0)
    return CONFIGURED_REQUEST_TIMEOUT_MS;
  return opts.thinking === true ? THINKING_REQUEST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
}

function timeoutMessage(timeoutMs) {
  return `请求超时（${Math.round(timeoutMs / 60000)} 分钟无响应，已中断，计入未知）`;
}

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
    chat_template_kwargs: {
      enable_thinking: opts.thinking === true,
      ...(opts.thinking ? { reasoning_effort: opts.effort || 'xhigh' } : {}),
    },
  };
  const controller = new AbortController();
  track(opts.runId || '', controller);
  const timeoutMs = requestTimeoutMs(opts);
  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let res;
  try {
    res = await fetch(base + '/chat/completions', requestFetchOptions(timeoutMs, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal,
    }));
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      // Older [OI]-compatible servers reject stream_options — retry without it.
      if (/stream_options/i.test(errText)) {
        delete payload.stream_options;
        res = await fetch(base + '/chat/completions', requestFetchOptions(timeoutMs, {
          method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal,
        }));
      } else throw Error('HTTP ' + res.status + ' ' + errText.slice(0, 200));
    }
  } catch (e) {
    clearTimeout(watchdog);
    untrack(opts.runId || '', controller);
    if (timedOut) throw Error(timeoutMessage(timeoutMs));
    throw e;
  }
  // controller 保留到流读完：流式 body 未消费完之前，中断仍要能取消在途生成
  if (!res.ok || !res.body) {
    clearTimeout(watchdog);
    untrack(opts.runId || '', controller);
    throw Error('HTTP ' + res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', text = '', chunks = 0, usage = null, finishReason = null, tFirst = 0, tLast = 0;
  const t0 = Date.now();
  try {
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
  } catch (e) {
    if (timedOut) throw Error(timeoutMessage(timeoutMs));
    throw e;
  } finally {
    clearTimeout(watchdog);
    untrack(opts.runId || '', controller);
  }
  const tokens = usage?.completion_tokens || chunks;
  const ttftMs = tFirst ? tFirst - t0 : Date.now() - t0;
  const speed = decodeSpeed(tokens, tFirst, tLast);
  return { text, tokens, ttftMs, tokPerSec: speed.tokPerSec, finishReason };
}

// 单请求看门狗：普通请求默认 10 分钟，开启思考默认 15 分钟；可用
// LLM_REQUEST_TIMEOUT_MS 显式覆盖两者。

async function chat(b, model, prompt, opts) {
  const base = (b.endpoint || 'http://127.0.0.1:9292/v1').replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (b.key) headers.Authorization = 'Bearer ' + b.key;
  const controller = new AbortController();
  track(opts.runId || '', controller);
  const run = opts.runId ? runs.get(opts.runId) : null;
  const started = Date.now();
  const timeoutMs = requestTimeoutMs(opts);
  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  // 心跳：长生成期间每 60s 在日志里报一次存活，避免"看起来卡住了"
  const heartbeat = opts.heartbeat && run ? setInterval(() => {
    if (!run.cancelRequested) logLine(run, `${opts.heartbeat}：仍在生成（已等待 ${Math.round((Date.now() - started) / 1000)}s）`);
  }, 60000) : null;
  let r;
  try {
    r = await fetch(base + '/chat/completions', requestFetchOptions(timeoutMs, {
      method: 'POST', headers,
      body: JSON.stringify({
        model, messages: [{ role: 'user', content: prompt }],
        temperature: 0, max_tokens: opts.max_tokens || 128, stream: false,
        // 默认抑制思维链；官方口径开启思考的任务传 thinking: true，思考档位 xhigh（Qwen3.8 官方默认档）
        chat_template_kwargs: {
          enable_thinking: opts.thinking === true,
          ...(opts.thinking ? { reasoning_effort: opts.effort || 'xhigh' } : {}),
        },
      }),
      signal: controller.signal,
    }));
  } catch (e) {
    if (timedOut) throw Error(timeoutMessage(timeoutMs));
    throw e;
  } finally {
    clearTimeout(watchdog);
    if (heartbeat) clearInterval(heartbeat);
    untrack(opts.runId || '', controller);
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
