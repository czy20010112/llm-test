<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const views = [
  { id: 'overview', label: '总览' },
  { id: 'new', label: '新建评测' },
  { id: 'queue', label: '运行队列' },
  { id: 'history', label: '历史记录' },
  { id: 'compare', label: '对比分析' },
  { id: 'protocols', label: '协议与基线' },
  { id: 'settings', label: '环境设置' },
] as const;

type ViewId = (typeof views)[number]['id'];

const active = ref<ViewId>('overview');
const activeView = computed(() => views.find((v) => v.id === active.value)!);

function select(id: ViewId) {
  active.value = id;
}

// ---------- shared state ----------
const preflight = ref<any>(null);
const tasks = ref<any[]>([]);
const models = ref<string[]>([]);
const runs = ref<any[]>([]); // all runs, newest first
const notice = ref<{ kind: 'ok' | 'err'; text: string } | null>(null);

const runningRuns = computed(() => runs.value.filter((r) => r.status === 'running'));
const finishedRuns = computed(() => runs.value.filter((r) => r.status !== 'running'));

function flash(kind: 'ok' | 'err', text: string) {
  notice.value = { kind, text };
  setTimeout(() => { if (notice.value?.text === text) notice.value = null; }, 4000);
}

async function api<T = any>(url: string, options?: RequestInit): Promise<T> {
  const r = await fetch(url, options);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body as T;
}

const cfg = ref(JSON.parse(localStorage.getItem('llmCfg') || '{"endpoint":"http://127.0.0.1:9292/v1","key":""}'));

async function refreshPreflight() {
  try { preflight.value = await api('/api/preflight'); } catch { preflight.value = null; }
}
async function refreshTasks() {
  try { tasks.value = await api('/api/tasks'); } catch { tasks.value = []; }
}
async function refreshRuns() {
  try { runs.value = await api('/api/runs'); } catch { /* keep last */ }
}
async function fetchModels() {
  loadingModels.value = true;
  try {
    const body = await api('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: cfg.value.endpoint, key: cfg.value.key }),
    });
    models.value = (body.data || []).map((m: any) => ({ id: String(m.id), name: m.name ? String(m.name) : undefined, description: m.description ? String(m.description) : undefined }));
    flash('ok', `已获取 ${models.value.length} 个模型`);
  } catch (e: any) {
    flash('err', '获取模型失败：' + e.message);
  } finally {
    loadingModels.value = false;
  }
}

let timer: number | undefined;
onMounted(async () => {
  await Promise.all([refreshPreflight(), refreshTasks(), refreshRuns()]);
  // restore the server-cached model list (already normalized to {id,name,description})
  try {
    const p = await api('/api/profiles');
    if (Array.isArray(p.models) && p.models.length) models.value = p.models;
  } catch { /* ignore */ }
  timer = window.setInterval(refreshRuns, 2000);
});
onBeforeUnmount(() => {
  window.clearInterval(timer);
  document.removeEventListener('click', closeMenus);
});

// auto-scroll open queue logs to the bottom as they grow
watch(() => runs.value.map((r) => (r.log || []).length).join(','), () => {
  nextTick(() => {
    document.querySelectorAll<HTMLElement>('.auto-scroll').forEach((el) => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    });
  });
});

function statusText(s: string) {
  return ({ running: '运行中', done: '已完成', error: '有错误', partial: '已中断', crashed: '崩溃' } as Record<string, string>)[s] || s;
}

// ---------- 新建评测：模型（逐栏下拉，选中后自动拉出下一栏） ----------
const loadingModels = ref(false);
const modelRows = ref<string[]>(['']);
const selectedModels = computed(() => modelRows.value.filter(Boolean));

function onModelPicked(i: number) {
  // fill the last row -> grow one empty row below; never keep two empty rows
  if (i === modelRows.value.length - 1 && modelRows.value[i]) modelRows.value.push('');
}
function removeModelRow(i: number) {
  modelRows.value.splice(i, 1);
  if (!modelRows.value.length) modelRows.value.push('');
  const last = modelRows.value.length - 1;
  if (modelRows.value[last]) modelRows.value.push('');
}

// ---------- 新建评测：测试项目表格（逐行下拉 + 每行参数） ----------
const taskRows = ref([{ task: '', limit: '', repeats: '', concurrency: '', maxTokens: '' }]);
const openDd = ref(-1);
const judgeKinds = ['humanevalplus', 'mbppplus', 'livecodebench', 'ds1000'];
const taskById = (id: string) => tasks.value.find((t) => t.id === id);

function closeMenus(e: Event) {
  if (!(e.target as HTMLElement).closest('.dd')) openDd.value = -1;
}
function pickTask(i: number, id: string) {
  taskRows.value[i].task = id;
  openDd.value = -1;
  if (i === taskRows.value.length - 1) taskRows.value.push({ task: '', limit: '', repeats: '', concurrency: '', maxTokens: '' });
}
function removeTaskRow(i: number) {
  taskRows.value.splice(i, 1);
  if (!taskRows.value.length) taskRows.value.push({ task: '', limit: '', repeats: '', concurrency: '', maxTokens: '' });
  const last = taskRows.value[taskRows.value.length - 1];
  if (last.task) taskRows.value.push({ task: '', limit: '', repeats: '', concurrency: '', maxTokens: '' });
}

async function submitRun() {
  if (!selectedModels.value.length) { flash('err', '请至少选择一个模型'); return; }
  const taskPayload = taskRows.value
    .filter((r) => r.task)
    .map((r) => {
      const t: any = { id: r.task };
      for (const k of ['limit', 'repeats', 'concurrency', 'maxTokens'] as const) {
        if (r[k] !== '' && Number(r[k]) > 0) t[k] = Number(r[k]);
      }
      return t;
    });
  if (!taskPayload.length) { flash('err', '请至少选择一个测试项目'); return; }
  try {
    await api('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: form.name, note: form.note, models: selectedModels.value, tasks: taskPayload }),
    });
    flash('ok', '评测已加入运行队列');
    select('queue');
    refreshRuns();
  } catch (e: any) {
    flash('err', e.message);
  }
}

const form = ref({ name: '本地模型评测', note: '' });

async function cancelRun(id: string) {
  try {
    await api(`/api/runs/${id}`, { method: 'DELETE' });
    flash('ok', '已请求中断');
    refreshRuns();
  } catch (e: any) { flash('err', e.message); }
}

// ---------- 删除确认（主题化弹窗，Enter=确认 / Esc=取消） ----------
const pendingDelete = ref<any>(null);
const confirmBtn = ref<HTMLButtonElement | null>(null);

function askDelete(run: any) { pendingDelete.value = run; }
async function confirmDelete() {
  const run = pendingDelete.value;
  if (!run) return;
  try {
    await api(`/api/results/${run.id}`, { method: 'DELETE' });
    comparePicks.value = comparePicks.value.filter((x) => x !== run.id);
    flash('ok', `已删除「${run.name}」`);
    refreshRuns();
  } catch (e: any) { flash('err', e.message); }
  pendingDelete.value = null;
}
function onModalKey(e: KeyboardEvent) {
  if (!pendingDelete.value) return;
  if (e.key === 'Enter') { e.preventDefault(); confirmDelete(); }
  else if (e.key === 'Escape') { e.preventDefault(); pendingDelete.value = null; }
}
watch(pendingDelete, (v) => {
  if (v) {
    window.addEventListener('keydown', onModalKey);
    nextTick(() => confirmBtn.value?.focus());
  } else {
    window.removeEventListener('keydown', onModalKey);
  }
});

function toggleCompare(id: string) {
  const i = comparePicks.value.indexOf(id);
  if (i >= 0) comparePicks.value.splice(i, 1); else comparePicks.value.push(id);
}

// ---------- 结果 ----------
function scoreOf(row: any) {
  const a = row.average || {};
  if (typeof a.score === 'number') return (a.score * 100).toFixed(1) + '%';
  return '—';
}
function scoreDetail(row: any) {
  const a = row.average || {};
  if (Number.isFinite(a.tokPerSec)) return `${a.tokPerSec.toFixed(1)} tok/s · 首 token ${((a.firstMs || 0) / 1000).toFixed(2)}s`;
  const parts: string[] = [];
  if (Number.isFinite(a.correct)) parts.push(`对 ${a.correct}`);
  if (Number.isFinite(a.incorrect)) parts.push(`错 ${a.incorrect}`);
  if (Number.isFinite(a.unknown) && a.unknown) parts.push(`未知 ${a.unknown}`);
  if (Number.isFinite(a.total)) parts.push(`共 ${a.total}`);
  return parts.join(' / ');
}

// ---------- 对比分析：行=测试项目，列=结果名称×模型 ----------
const comparePicks = ref<string[]>([]);
const compareCols = computed(() => {
  const cols: { runId: string; runName: string; model: string }[] = [];
  const seen = new Set<string>();
  for (const run of finishedRuns.value) {
    if (!comparePicks.value.includes(run.id)) continue;
    for (const model of run.models || []) {
      const key = `${run.id}\u0000${model}`;
      if (!seen.has(key)) { seen.add(key); cols.push({ runId: run.id, runName: run.name || run.id, model }); }
    }
  }
  return cols;
});
const compareRows = computed(() => {
  const taskOrder = new Map(tasks.value.map((t, i) => [t.name, i]));
  const names = new Set<string>();
  for (const run of finishedRuns.value) {
    if (!comparePicks.value.includes(run.id)) continue;
    for (const row of run.rows || []) names.add(row.task);
  }
  return [...names].sort((a, b) => (taskOrder.get(a) ?? 99) - (taskOrder.get(b) ?? 99));
});
function compareCell(task: string, col: { runId: string; model: string }) {
  const run = finishedRuns.value.find((r) => r.id === col.runId);
  const row = run && (run.rows || []).find((r: any) => r.task === task && r.model === col.model);
  return row ? { score: row.average?.score, detail: scoreDetail(row) } : null;
}
function cellScore(task: string, col: { runId: string; model: string }): string {
  const cell = compareCell(task, col);
  return cell && cell.score != null ? (cell.score * 100).toFixed(1) + '%' : '—';
}

// ---------- 环境设置 ----------
const profile = ref({ id: 'default', endpoint: cfg.value.endpoint, key: '', rememberKey: false });
async function saveProfile() {
  cfg.value.endpoint = profile.value.endpoint;
  localStorage.setItem('llmCfg', JSON.stringify(cfg.value));
  try {
    await api('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...profile.value, models }) });
    flash('ok', '连接设置已保存');
  } catch (e: any) { flash('err', e.message); }
  refreshPreflight();
}
</script>

<template>
  <div class="shell">
    <aside class="sidenav">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">测</span>
        <div class="brand-text">
          <strong>模型测评台</strong>
          <small>Precision Lab</small>
        </div>
      </div>
      <nav class="nav" aria-label="主导航">
        <button
          v-for="v in views"
          :key="v.id"
          type="button"
          class="nav-item"
          :class="{ active: active === v.id }"
          :aria-current="active === v.id ? 'page' : undefined"
          @click="select(v.id)"
        >
          {{ v.label }}
        </button>
      </nav>
      <div class="sidenav-foot">
        <a href="/legacy/">旧版控制台</a>
        <span class="dot-row">
          <span class="dot" :class="preflight?.judge?.ok ? 'ok' : 'bad'" :title="preflight?.judge?.ok ? '判题沙箱在线' : '判题沙箱离线'"></span>
          judge
        </span>
      </div>
    </aside>
    <main class="content">
      <header class="content-head">
        <h1 class="view-title">{{ activeView.label }}</h1>
        <p v-if="notice" class="notice" :class="notice.kind">{{ notice.text }}</p>
      </header>
      <Transition name="view" mode="out-in">
        <section class="view-body" :data-view="active" :key="active">

        <!-- 总览 -->
        <template v-if="active === 'overview'">
          <div class="cards">
            <div class="card">
              <h3>推理服务</h3>
              <p class="mono">{{ cfg.endpoint }}</p>
              <p>{{ models.length ? `${models.length} 个模型可测` : '尚未获取模型列表（环境设置）' }}</p>
              <button class="btn" @click="select('new')">开始评测</button>
            </div>
            <div class="card">
              <h3>判题沙箱</h3>
              <p>
                <span class="dot big" :class="preflight?.judge?.ok ? 'ok' : 'bad'"></span>
                {{ preflight?.judge?.ok ? '在线（Docker 隔离，无外网）' : '离线 — 代码类评测不可用' }}
              </p>
              <p class="soft">HumanEval+ / MBPP+ / LiveCodeBench / DS-1000 需要判题沙箱</p>
            </div>
            <div class="card">
              <h3>正在运行</h3>
              <p class="big-num">{{ runningRuns.length }}</p>
              <p>历史记录 {{ finishedRuns.length }} 次</p>
            </div>
            <div class="card">
              <h3>测试协议</h3>
              <p class="big-num">{{ tasks.length }}</p>
              <p>速度探测 + 3 题库 + 5 项代码/长上下文基准</p>
            </div>
          </div>
        </template>

        <!-- 新建评测 -->
        <template v-else-if="active === 'new'">
          <div class="panel head-row">
            <div class="row">
              <label>结果名称</label>
              <input v-model="form.name" type="text" class="input" placeholder="例如：Qwen3.8 Q8 vs Q6K" />
            </div>
            <div class="row grow">
              <label>备注</label>
              <input v-model="form.note" type="text" class="input" placeholder="可选" />
            </div>
          </div>

          <fieldset class="panel">
            <legend>模型（自上而下即执行顺序，选中后自动出现下一栏）</legend>
            <div class="rows-list">
              <div v-for="(m, i) in modelRows" :key="`m${i}`" class="row-line">
                <span class="idx">{{ i + 1 }}</span>
                <select v-model="modelRows[i]" class="input wide" :aria-label="`模型 ${i + 1}`" @change="onModelPicked(i)">
                  <option value="" disabled>选择模型…</option>
                  <option v-for="opt in models" :key="opt.id" :value="opt.id">
                    {{ opt.id }} - {{ opt.name || '—' }}{{ opt.description ? ` - ${opt.description}` : '' }}
                  </option>
                </select>
                <button
                  v-if="!(i === modelRows.length - 1 && !m)" class="x" type="button"
                  :aria-label="`移除模型 ${i + 1}`" @click="removeModelRow(i)"
                >×</button>
              </div>
              <p v-if="!models.length" class="soft">模型列表为空 — 请先到"环境设置"填写端点并获取模型。</p>
            </div>
          </fieldset>

          <fieldset class="panel">
            <legend>测试项目（每行一项，参数可留空用默认值，选中后自动出现下一行）</legend>
            <table class="task-table">
              <thead>
                <tr>
                  <th class="c-task">测试项目</th>
                  <th>题数</th>
                  <th>重复次数</th>
                  <th>并发请求</th>
                  <th>max_tokens</th>
                  <th class="c-note">备注</th>
                  <th class="c-x"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in taskRows" :key="`t${i}`">
                  <td class="c-task">
                    <div class="dd">
                      <button class="dd-toggle input" type="button" @click.stop="openDd = openDd === i ? -1 : i">
                        {{ taskById(r.task)?.name || '选择测试项目…' }}
                      </button>
                      <ul v-if="openDd === i" class="dd-menu">
                        <li v-for="t in tasks" :key="t.id" @click.stop="pickTask(i, t.id)">
                          <strong>{{ t.name }}</strong>
                          <small>{{ t.ability }}{{ judgeKinds.includes(t.kind) ? ' · 需要沙箱' : '' }}</small>
                        </li>
                      </ul>
                    </div>
                  </td>
                  <td><input v-model="r.limit" class="input num" type="number" min="1" :placeholder="taskById(r.task)?.defaultLimit || '全部'" /></td>
                  <td><input v-model="r.repeats" class="input num" type="number" min="1" placeholder="1" /></td>
                  <td><input v-model="r.concurrency" class="input num" type="number" min="1" placeholder="1" /></td>
                  <td><input v-model="r.maxTokens" class="input num" type="number" min="256" :placeholder="taskById(r.task)?.defaultMaxTokens || 4096" /></td>
                  <td class="c-note soft">
                    <template v-if="taskById(r.task)">{{ taskById(r.task).ability }} · {{ judgeKinds.includes(taskById(r.task).kind) ? '需要判题沙箱' : '无需沙箱' }}</template>
                  </td>
                  <td class="c-x">
                    <button
                      v-if="!(i === taskRows.length - 1 && !r.task)" class="x" type="button"
                      :aria-label="`移除测试 ${i + 1}`" @click="removeTaskRow(i)"
                    >×</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </fieldset>

          <div class="actions">
            <button class="btn primary" @click="submitRun">开始评测</button>
            <span class="soft">temperature=0 · 抑制思维链 · 留空的参数使用每项默认值</span>
          </div>
        </template>

        <!-- 运行队列：只显示正在运行的，日志常开、自动滚底 -->
        <template v-else-if="active === 'queue'">
          <p v-if="!runningRuns.length" class="soft">当前没有正在运行的评测。</p>
          <article v-for="r in runningRuns" :key="r.id" class="run-card">
            <header>
              <strong>{{ r.name }}</strong>
              <span class="badge running">{{ statusText(r.status) }}</span>
              <button class="btn ghost danger" @click="cancelRun(r.id)">中断</button>
            </header>
            <p class="soft">
              {{ (r.models || []).join('、') }} · {{ (r.tasks || []).length }} 项测试 · 进度 {{ (r.progress?.modelIndex || 0) + 1 }}/{{ r.models.length }}
              <template v-if="r.current"> — {{ r.current }}</template>
            </p>
            <div v-if="r.rows?.length" class="mini-table">
              <div v-for="(row, i) in r.rows" :key="i" class="mini-row">
                <span>{{ row.model }}</span><span>{{ row.task }}</span><strong>{{ scoreOf(row) }}</strong>
                <small class="soft">{{ scoreDetail(row) }}</small>
              </div>
            </div>
            <pre class="log auto-scroll">{{ (r.log || []).join('\n') }}</pre>
          </article>
        </template>

        <!-- 历史记录 -->
        <template v-else-if="active === 'history'">
          <p v-if="!finishedRuns.length" class="soft">暂无完成的结果。</p>
          <article v-for="r in finishedRuns" :key="r.id" class="run-card">
            <header>
              <strong>{{ r.name }}</strong>
              <span class="badge" :class="r.status">{{ statusText(r.status) }}</span>
              <span class="soft">{{ new Date(r.startedAt).toLocaleString() }}</span>
              <span class="head-actions">
                <button class="btn act-btn" :class="{ danger: true }" @click="askDelete(r)">删除</button>
                <button class="btn act-btn primary-ghost" :class="{ on: comparePicks.includes(r.id) }" @click="toggleCompare(r.id)">
                  {{ comparePicks.includes(r.id) ? '已选入' : '选入对比' }}
                </button>
              </span>
            </header>
            <table class="table">
              <thead><tr><th>模型</th><th>测试</th><th>得分</th><th>明细</th><th>重复</th></tr></thead>
              <tbody>
                <tr v-for="(row, i) in r.rows" :key="i">
                  <td>{{ row.model }}</td>
                  <td>{{ row.task }}</td>
                  <td><strong>{{ scoreOf(row) }}</strong></td>
                  <td class="soft">{{ scoreDetail(row) }}</td>
                  <td>{{ row.repeat }}</td>
                </tr>
              </tbody>
            </table>
            <details>
              <summary>逐题日志（{{ (r.log || []).length }} 行）</summary>
              <pre class="log">{{ (r.log || []).join('\n') }}</pre>
            </details>
          </article>
        </template>

        <!-- 对比分析：行=测试项目，列=结果名称×模型 -->
        <template v-else-if="active === 'compare'">
          <p v-if="!comparePicks.length" class="soft">在"历史记录"中把若干次运行"选入对比"，这里会按测试项目逐行对比每个模型的表现。</p>
          <table v-else class="table compare">
            <thead>
              <tr>
                <th class="c-run">测试项目</th>
                <th v-for="col in compareCols" :key="col.runId + col.model">
                  <span class="col-task">{{ col.runName }}</span>
                  <span class="col-model soft">{{ col.model }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="task in compareRows" :key="task">
                <td class="c-run"><strong>{{ task }}</strong></td>
                <td v-for="col in compareCols" :key="col.runId + col.model">
                  <template v-if="compareCell(task, col)">
                    <strong>{{ cellScore(task, col) }}</strong>
                    <br /><small class="soft">{{ compareCell(task, col)!.detail }}</small>
                  </template>
                  <template v-else>—</template>
                </td>
              </tr>
            </tbody>
          </table>
        </template>

        <!-- 协议与基线 -->
        <template v-else-if="active === 'protocols'">
          <div class="panel">
            <p>统一口径：temperature=0、抑制思维链（enable_thinking=false）；所有题目对每个模型一致。选择题判分只认明确的最终答案（最终答案：X / \boxed{X} / 末行独立字母），推理无结论计"未知"并保留在分母中，避免把截断的推理误判为错误。</p>
          </div>
          <table class="table">
            <thead><tr><th>协议</th><th>能力</th><th>判分方式</th><th>默认题数</th></tr></thead>
            <tbody>
              <tr v-for="t in tasks" :key="t.id">
                <td>{{ t.name }}</td>
                <td>{{ t.ability }}</td>
                <td class="soft">{{ ({
                  smoke: '请求成功 + 首 token 延迟 + tok/s',
                  gpqa: '选项字母精确匹配',
                  aime: '整数答案精确匹配',
                  mmlu: '选项字母精确匹配',
                  longbench2: 'A/B/C/D 字母精确匹配',
                  humanevalplus: '全部增强测试通过（沙箱执行）',
                  mbppplus: '全部增强测试通过（沙箱执行）',
                  livecodebench: '隐藏测试全通过（stdin/函数式沙箱）',
                  ds1000: '官方扰动测试通过（沙箱执行）',
                } as Record<string, string>)[t.kind] }}</td>
                <td>{{ t.defaultLimit || '—' }}</td>
              </tr>
            </tbody>
          </table>
          <div class="panel">
            <p class="soft">代码类题目要求模型只输出代码；判题在 WSL2 Docker 沙箱内执行（无外网、CPU/内存/文件系统受限、单测超时 6-30s）。LongBench v2 默认取前 30 题（可调），LiveCodeBench 每题最多 100 个测试用例。</p>
          </div>
        </template>

        <!-- 环境设置 -->
        <template v-else-if="active === 'settings'">
          <div class="panel">
            <div class="row"><label>API 端点</label><input v-model="profile.endpoint" class="input" type="text" /></div>
            <div class="row"><label>API Key</label><input v-model="profile.key" class="input" type="password" placeholder="本地服务通常留空" /></div>
            <div class="row"><label></label><label class="inline"><input v-model="profile.rememberKey" type="checkbox" /> 保存 Key（服务端配置）</label></div>
            <div class="actions">
              <button class="btn primary" @click="saveProfile">保存并应用</button>
              <button class="btn" :disabled="loadingModels" @click="fetchModels">{{ loadingModels ? '获取中…' : '重新获取模型' }}</button>
            </div>
          </div>
          <div class="panel">
            <h3>环境自检</h3>
            <pre class="log">{{ JSON.stringify(preflight, null, 2) }}</pre>
          </div>
        </template>
      </section>
      </Transition>
    </main>

    <!-- 删除确认弹窗 -->
    <Transition name="fade">
      <div v-if="pendingDelete" class="modal-backdrop" @click.self="pendingDelete = null">
        <div class="modal" role="alertdialog" aria-modal="true" aria-label="确认删除">
          <h3>删除这条测试结果？</h3>
          <p class="modal-name">「{{ pendingDelete.name }}」</p>
          <p class="soft">删除后不可恢复。按 Enter 确认，Esc 取消。</p>
          <div class="modal-actions">
            <button class="btn" type="button" @click="pendingDelete = null">取消</button>
            <button ref="confirmBtn" class="btn primary danger-solid" type="button" @click="confirmDelete">删除</button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 232px 1fr;
  min-height: 100vh;
}

.sidenav {
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 20px 14px;
  background: var(--color-teal);
  color: var(--color-teal-on);
}

.brand { display: flex; align-items: center; gap: 10px; padding: 0 6px; }
.brand-mark {
  display: grid; place-items: center;
  width: 38px; height: 38px; border-radius: var(--radius-md);
  background: var(--color-teal-strong); font-family: var(--font-display); font-size: 20px;
}
.brand-text { display: flex; flex-direction: column; line-height: 1.25; }
.brand-text small { color: var(--color-teal-on-soft); }

.nav { display: flex; flex-direction: column; gap: 2px; }
.nav-item {
  text-align: left; padding: 9px 12px; border: 0; border-radius: var(--radius-sm);
  background: transparent; color: var(--color-teal-on); cursor: pointer;
  font: inherit; transition: background var(--motion-fast);
}
.nav-item:hover { background: var(--color-teal-hover); }
.nav-item.active { background: var(--color-teal-active); font-weight: 700; }

.sidenav-foot { margin-top: auto; display: flex; flex-direction: column; gap: 8px; padding: 0 6px; }
.sidenav-foot a { color: var(--color-teal-on-soft); font-size: 12px; }
.dot-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--color-teal-on-soft); }

.content { padding: 26px 34px 60px; }
.content-head { display: flex; align-items: baseline; gap: 16px; }
.view-title { font-family: var(--font-display); font-size: 24px; margin: 0 0 18px; }

.notice { margin: 0; padding: 6px 12px; border-radius: var(--radius-sm); font-size: 13px; }
.notice.ok { background: var(--color-success-soft); color: var(--color-success); }
.notice.err { background: var(--color-coral-soft); color: var(--color-coral-strong); }

.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
.card, .panel, .run-card {
  background: var(--color-paper-raised); border: 1px solid var(--color-line);
  border-radius: var(--radius-md); box-shadow: var(--shadow-card); padding: 16px 18px;
}
.panel { margin-bottom: 14px; }
fieldset.panel { border: 1px solid var(--color-line); }
fieldset.panel legend { padding: 0 8px; color: var(--color-ink-soft); font-size: 13px; }
.card h3, .panel h3 { margin: 0 0 8px; font-size: 14px; color: var(--color-ink-soft); font-weight: 700; }
.card p { margin: 4px 0; }
.big-num { font-family: var(--font-display); font-size: 30px; margin: 2px 0 !important; }
.mono { font-family: var(--font-mono); font-size: 12px; }
.soft { color: var(--color-ink-soft); font-size: 12px; }

.head-row { display: flex; gap: 24px; flex-wrap: wrap; }
.head-row .row { flex: 1 1 280px; }

.row { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
.row > label { width: 90px; flex: none; color: var(--color-ink-soft); font-size: 13px; }

.input {
  background: var(--color-paper); color: var(--color-ink);
  border: 1px solid var(--color-line); border-radius: var(--radius-sm);
  padding: 7px 10px; font: inherit; min-width: 0;
}
.input:focus { outline: 2px solid var(--color-teal-line); outline-offset: 1px; }
.input.wide { width: 100%; }
.input.num { width: 100%; text-align: right; }
.input.num::placeholder, .input::placeholder { color: var(--color-ink-soft); opacity: 0.55; }
select.input { appearance: auto; }

.rows-list { display: flex; flex-direction: column; gap: 8px; }
.row-line { display: flex; align-items: center; gap: 10px; }
.row-line .idx { width: 22px; text-align: right; color: var(--color-ink-soft); font-family: var(--font-mono); font-size: 12px; flex: none; }
.row-line select { flex: 1; }
.x {
  width: 26px; height: 26px; flex: none; border: 1px solid var(--color-line); border-radius: 50%;
  background: transparent; color: var(--color-ink-soft); cursor: pointer; font-size: 14px; line-height: 1;
}
.x:hover { color: var(--color-danger); border-color: var(--color-danger); }
.add { align-self: flex-start; }

/* 测试项目表格 */
.task-table { width: 100%; border-collapse: collapse; }
.task-table th, .task-table td {
  border: 1px solid var(--color-line); padding: 6px 8px; text-align: left; vertical-align: middle;
  font-size: 13px;
}
.task-table th { background: var(--color-teal-soft); color: var(--color-ink-soft); font-weight: 600; white-space: nowrap; }
.task-table .c-task { width: 30%; min-width: 220px; }
.task-table .c-note { width: 26%; }
.task-table .c-x { width: 36px; text-align: center; border: 0 !important; background: transparent; }
.task-table td .input { border-color: transparent; background: transparent; }
.task-table td .input:focus { background: var(--color-paper); border-color: var(--color-teal-line); }
.task-table .dd-toggle { width: 100%; text-align: left; cursor: pointer; }

/* 自定义下拉 */
.dd { position: relative; }
.dd-menu {
  position: absolute; z-index: 30; top: calc(100% + 4px); left: 0; right: -140px; min-width: 100%;
  margin: 0; padding: 4px; list-style: none;
  background: var(--color-paper-raised); border: 1px solid var(--color-line);
  border-radius: var(--radius-sm); box-shadow: var(--shadow-card); max-height: 320px; overflow: auto;
}
.dd-menu li { padding: 7px 10px; cursor: pointer; border-radius: var(--radius-sm); }
.dd-menu li:hover { background: var(--color-teal-soft); }
.dd-menu li strong { display: block; font-size: 13px; }
.dd-menu li small { color: var(--color-ink-soft); }

.btn {
  border: 1px solid var(--color-line); background: var(--color-paper-raised); color: var(--color-ink);
  border-radius: var(--radius-sm); padding: 7px 14px; cursor: pointer; font: inherit;
  transition: background var(--motion-fast);
}
.btn:hover { background: var(--color-teal-soft); }
.btn.primary { background: var(--color-coral); border-color: var(--color-coral); color: #fff; font-weight: 700; }
.btn.primary:hover { background: var(--color-coral-strong); }
.btn.ghost { background: transparent; }
.btn.ghost.danger { color: var(--color-danger); border-color: var(--color-danger); }
.btn.on { outline: 2px solid var(--color-teal-line); }
.btn:disabled { opacity: 0.6; cursor: default; }
.actions { display: flex; align-items: center; gap: 14px; margin: 6px 0 24px; }

.run-card { margin-bottom: 16px; }
.run-card header { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
.badge { border-radius: 999px; padding: 2px 10px; font-size: 12px; background: var(--color-teal-soft); color: var(--color-teal); }
.badge.running { background: var(--color-coral-soft); color: var(--color-coral-strong); }
.badge.done { background: var(--color-success-soft); color: var(--color-success); }
.badge.error, .badge.crashed { background: var(--color-coral-soft); color: var(--color-danger); }
header .btn { margin-left: auto; }

.mini-table { margin: 6px 0; }
.mini-row { display: grid; grid-template-columns: 1fr 1fr 80px 1fr; gap: 10px; padding: 5px 0; border-top: 1px dashed var(--color-line); font-size: 13px; }

.table { width: 100%; border-collapse: collapse; margin: 8px 0; }
.table th, .table td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--color-line); font-size: 13px; vertical-align: top; }
.table th { color: var(--color-ink-soft); font-weight: 600; }
.table.compare th { border-bottom: 2px solid var(--color-line); }
.col-task { display: block; font-weight: 700; color: var(--color-ink); }
.col-model { display: block; font-family: var(--font-mono); font-size: 11px; }
.c-run { white-space: nowrap; }

details { margin-top: 6px; }
summary { cursor: pointer; color: var(--color-ink-soft); font-size: 13px; }
.log {
  margin-top: 8px; max-height: 320px; overflow: auto; background: var(--color-paper);
  border: 1px solid var(--color-line); border-radius: var(--radius-sm);
  padding: 10px; font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap;
}
.run-card .log { max-height: 420px; }

.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.dot.big { width: 12px; height: 12px; }
.dot.ok { background: var(--color-success); }
.dot.bad { background: var(--color-danger); }
.sidenav-foot .dot { animation: soft-pulse 2.4s ease-in-out infinite; }

/* 历史卡片操作按钮：固定尺寸、右侧对齐，切换文案不改变布局 */
.head-actions { margin-left: auto; display: flex; gap: 8px; flex: none; }
.act-btn { width: 88px; text-align: center; padding: 7px 0; }
.act-btn.danger { color: var(--color-danger); border-color: var(--color-danger); background: transparent; }
.act-btn.danger:hover { background: var(--color-coral-soft); }
.act-btn.primary-ghost { color: var(--color-teal); border-color: var(--color-teal-line); background: transparent; }
.act-btn.primary-ghost:hover { background: var(--color-teal-soft); }
.act-btn.primary-ghost.on { background: var(--color-teal); color: var(--color-teal-on); border-color: var(--color-teal); }

/* 删除确认弹窗 */
.modal-backdrop {
  position: fixed; inset: 0; z-index: 60;
  background: color-mix(in srgb, #14181a 55%, transparent);
  display: grid; place-items: center;
}
.modal {
  width: min(420px, 90vw);
  background: var(--color-paper-raised); color: var(--color-ink);
  border: 1px solid var(--color-line); border-radius: var(--radius-md);
  box-shadow: var(--shadow-card); padding: 22px 24px;
}
.modal h3 { margin: 0 0 6px; font-family: var(--font-display); font-size: 17px; }
.modal-name { margin: 4px 0; font-weight: 700; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
.danger-solid { background: var(--color-danger) !important; border-color: var(--color-danger) !important; color: #fff !important; }
.danger-solid:hover { filter: brightness(1.08); }

/* 动效（参考 Precision Lab：短促、克制的缓动） */
.view-enter-active { transition: opacity .22s cubic-bezier(.16, 1, .3, 1), transform .22s cubic-bezier(.16, 1, .3, 1); }
.view-leave-active { transition: opacity .12s ease; }
.view-enter-from { opacity: 0; transform: translateY(6px); }
.view-leave-to { opacity: 0; }

.fade-enter-active, .fade-leave-active { transition: opacity .16s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

.card, .panel, .run-card { transition: transform .15s ease, box-shadow .15s ease; }
.card:hover { transform: translateY(-1px); box-shadow: 0 3px 6px light-dark(rgb(34 39 43 / 10%), rgb(0 0 0 / 45%)), 0 8px 20px light-dark(rgb(34 39 43 / 8%), rgb(0 0 0 / 35%)); }

.btn:active { transform: scale(.97); }
.badge.running { animation: soft-pulse 1.6s ease-in-out infinite; }
@keyframes soft-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .55; }
}

@media (prefers-reduced-motion: reduce) {
  .view-enter-active, .view-leave-active, .fade-enter-active, .fade-leave-active { transition: none; }
  .badge.running, .sidenav-foot .dot { animation: none; }
}
</style>
