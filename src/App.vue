<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { lang, setLang, t } from './i18n';

type ViewId = 'overview' | 'new' | 'queue' | 'history' | 'compare' | 'protocols' | 'settings';

const views = computed(() => [
  { id: 'overview' as ViewId, label: t('总览', 'Overview') },
  { id: 'new' as ViewId, label: t('新建评测', 'New Run') },
  { id: 'queue' as ViewId, label: t('运行队列', 'Queue') },
  { id: 'history' as ViewId, label: t('历史记录', 'History') },
  { id: 'compare' as ViewId, label: t('对比分析', 'Compare') },
  { id: 'protocols' as ViewId, label: t('协议与基线', 'Protocols') },
  { id: 'settings' as ViewId, label: t('环境设置', 'Settings') },
]);

const active = ref<ViewId>('overview');
const activeView = computed(() => views.value.find((v) => v.id === active.value)!);

// 服务端任务的双语展示（任务名/能力）；历史行数据保持原样
const taskName = (task: any) => (lang.value === 'en' && task?.name_en ? task.name_en : task?.name || '');
const taskAbility = (task: any) => (lang.value === 'en' && task?.ability_en ? task.ability_en : task?.ability || '');
function toggleLang() {
  setLang(lang.value === 'zh' ? 'en' : 'zh');
}

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
async function fetchModels() {
  loadingModels.value = true;
  try {
    const body = await api('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: cfg.value.endpoint, key: cfg.value.key }),
    });
    models.value = (body.data || []).map((m: any) => ({ id: String(m.id), name: m.name ? String(m.name) : undefined, description: m.description ? String(m.description) : undefined }));
    flash('ok', `${t('已获取', 'Fetched')} ${models.value.length} ${t('个模型', 'models')}`);
  } catch (e: any) {
    flash('err', t('获取模型失败：', 'Failed to fetch models: ') + e.message);
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
  for (const timer of toastTimers.values()) window.clearTimeout(timer);
});

// ---------- 完成通知：跳转历史 或 右上角 toast（自动消失 + 手动红叉） ----------
const toasts = ref<{ id: string; text: string; sub: string }[]>([]);
const toastTimers = new Map<string, number>();
const prevStatuses = new Map<string, string>();
let statusSeeded = false;

function doneText(s: string) {
  return s === 'done' ? t('测试完成', 'finished')
    : s === 'partial' ? t('已中断', 'stopped')
    : s === 'error' || s === 'crashed' ? t('已结束（有错误）', 'ended with errors')
    : statusText(s);
}
function pushToast(run: any) {
  toasts.value = [...toasts.value.filter((x) => x.id !== run.id), {
    id: run.id,
    text: `${run.name} · ${doneText(run.status)}`,
    sub: t('点击查看逐题日志', 'Click to open per-item logs'),
  }];
  toastTimers.set(run.id, window.setTimeout(() => dismissToast(run.id), 6500));
}
function dismissToast(id: string) {
  const timer = toastTimers.get(id);
  if (timer) { window.clearTimeout(timer); toastTimers.delete(id); }
  toasts.value = toasts.value.filter((x) => x.id !== id);
}
function toastClick(id: string) {
  dismissToast(id);
  openRunLog(id);
}
// 历史记录中打开某次运行的逐题日志并滚到底部（DOM 操作避免 :open 绑定和手动开合打架）
function openRunLog(id: string) {
  select('history');
  window.setTimeout(() => {
    const card = document.querySelector<HTMLElement>(`.run-card[data-run-id="${id}"]`);
    if (!card) return;
    const details = card.querySelector('details');
    if (details) details.open = true;
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const log = card.querySelector<HTMLElement>('.log');
    if (log) log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
  }, 380); // 等待视图过渡完成
}

async function refreshRuns() {
  try {
    const fresh = await api('/api/runs');
    runs.value = fresh;
    for (const r of fresh) {
      const prev = prevStatuses.get(r.id);
      if (statusSeeded && prev === 'running' && r.status !== 'running') {
        if (active.value === 'queue') openRunLog(r.id);
        else pushToast(r);
      }
      prevStatuses.set(r.id, r.status);
    }
    statusSeeded = true;
  } catch { /* keep last */ }
}

// auto-scroll open queue logs to the bottom as they grow
watch(() => runs.value.map((r) => (r.log || []).length).join(','), () => {
  nextTick(() => {
    document.querySelectorAll<HTMLElement>('.auto-scroll').forEach((el) => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    });
  });
});

function statusText(s: string) {
  return ({
    running: t('运行中', 'Running'), done: t('已完成', 'Done'), error: t('有错误', 'Error'),
    partial: t('已中断', 'Stopped'), crashed: t('崩溃', 'Crashed'),
  } as Record<string, string>)[s] || s;
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
const judgeKinds = ['humanevalplus', 'mbppplus', 'livecodebench', 'ds1000', 'ifeval', 'ifbench'];
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
  if (!selectedModels.value.length) { flash('err', t('请至少选择一个模型', 'Select at least one model')); return; }
  const taskPayload = taskRows.value
    .filter((r) => r.task)
    .map((r) => {
      const t: any = { id: r.task };
      for (const k of ['limit', 'repeats', 'concurrency', 'maxTokens'] as const) {
        if (r[k] !== '' && Number(r[k]) > 0) t[k] = Number(r[k]);
      }
      return t;
    });
  if (!taskPayload.length) { flash('err', t('请至少选择一个测试项目', 'Select at least one benchmark')); return; }
  try {
    await api('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: form.value.name, note: form.value.note, models: selectedModels.value, tasks: taskPayload }),
    });
    flash('ok', t('评测已加入运行队列', 'Run queued'));
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
    flash('ok', t('已请求中断', 'Cancellation requested'));
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
    flash('ok', `${t('已删除「', 'Deleted "')}${run.name}${t('」', '"')}`);
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
// 速度探测没有百分比分值，用绝对值 t/s 展示（雷达图上按选中最高值定标）
const isSpeedRow = (row: any) => Number.isFinite(row?.average?.tokPerSec);
function scoreOf(row: any) {
  const a = row.average || {};
  if (isSpeedRow(row)) return `${a.tokPerSec.toFixed(1)} t/s`;
  if (typeof a.score === 'number' && a.total > 0) return (a.score * 100).toFixed(1) + '%';
  return '—';
}
function scoreDetail(row: any) {
  const a = row.average || {};
  if (Number.isFinite(a.tokPerSec)) return `${a.tokPerSec.toFixed(1)} tok/s · ${t('首 token', 'TTFT')} ${((a.firstMs || 0) / 1000).toFixed(2)}s`;
  if (a.failedRepeats) return t(`已中断/失败 ${a.failedRepeats} 次（无有效样本）`, `${a.failedRepeats} repeat(s) interrupted/failed - no valid samples`);
  const parts: string[] = [];
  if (Number.isFinite(a.correct)) parts.push(`${t('对', 'ok')} ${a.correct}`);
  if (Number.isFinite(a.incorrect)) parts.push(`${t('错', 'bad')} ${a.incorrect}`);
  if (Number.isFinite(a.unknown) && a.unknown) parts.push(`${t('未知', 'unknown')} ${a.unknown}`);
  if (Number.isFinite(a.total) && a.total > 0) parts.push(`${t('共', 'of')} ${a.total}`);
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
    for (const row of run.rows || []) names.add(normTask(row.task));
  }
  return [...names].sort((a, b) => (taskOrder.get(a) ?? 99) - (taskOrder.get(b) ?? 99));
});
function compareCell(task: string, col: { runId: string; model: string }) {
  const run = finishedRuns.value.find((r) => r.id === col.runId);
  const row = run && (run.rows || []).find((r: any) => normTask(r.task) === task && r.model === col.model);
  return row ? { score: row.average?.score, speed: isSpeedRow(row) ? row.average.tokPerSec : null, detail: scoreDetail(row) } : null;
}
function cellScore(task: string, col: { runId: string; model: string }): string {
  const cell = compareCell(task, col);
  if (!cell) return '—';
  if (cell.speed != null) return `${cell.speed.toFixed(1)} t/s`;
  return cell.score != null ? (cell.score * 100).toFixed(1) + '%' : '—';
}

// 历史行里的旧题库名称（“…（缓存题库）”）归一到当前口径，老结果也能和新结果同表对比
const TASK_ALIAS: Record<string, string> = {
  'GPQA Diamond（缓存题库）': 'GPQA Diamond（科学推理）',
  'AIME 2025（缓存题库）': 'AIME 2025（数学推理）',
  'MMLU-Pro（缓存题库）': 'MMLU-Pro（综合知识）',
};
const normTask = (n: string) => TASK_ALIAS[n] || n;

// ---------- 对比分析：维度雷达图（轴=本次覆盖的项目，系列=运行×模型，默认不绘制） ----------
const RADAR_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16'];
const radarPicks = ref<string[]>([]);
const radarOptions = computed(() => compareCols.value.map((col) => ({ key: `${col.runId}\u0000${col.model}`, col })));
const radarActive = computed(() => radarOptions.value.filter((o) => radarPicks.value.includes(o.key)));
function toggleRadar(key: string) {
  const i = radarPicks.value.indexOf(key);
  if (i >= 0) radarPicks.value.splice(i, 1); else radarPicks.value.push(key);
}
function radarColor(key: string) {
  const i = radarOptions.value.findIndex((o) => o.key === key);
  return RADAR_COLORS[(i < 0 ? 0 : i) % RADAR_COLORS.length];
}
const R_W = 420, R_H = 340, R_CX = 210, R_CY = 172, R_R = 118;
function radarAngle(i: number, n: number) { return -Math.PI / 2 + (2 * Math.PI * i) / n; }
function radarPt(i: number, n: number, r: number) {
  const a = radarAngle(i, n);
  return { x: R_CX + r * Math.cos(a), y: R_CY + r * Math.sin(a) };
}
function radarRing(frac: number): string {
  const n = compareRows.value.length;
  return Array.from({ length: n }, (_, i) => {
    const p = radarPt(i, n, R_R * frac);
    return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }).join(' ');
}
const shortTask = (name: string) => name.replace(/（[^）]*）/, '');
function radarLabel(i: number) {
  const n = compareRows.value.length;
  const p = radarPt(i, n, R_R + 12);
  const cos = Math.cos(radarAngle(i, n));
  return { x: p.x, y: p.y + 4, anchor: Math.abs(cos) < 0.35 ? 'middle' : cos > 0 ? 'start' : 'end' };
}
function radarSpeedOf(key: string, task: string): number | null {
  const [runId, model] = key.split('\u0000');
  const cell = compareCell(task, { runId, model });
  return cell && cell.speed != null ? cell.speed : null;
}
// 速度轴用绝对值 t/s，没有天然满分：选中曲线中最高的 t/s 定在 80% 半径（上限 = 最高值/0.8）
const radarSpeedCeiling = computed(() => {
  let max = 0;
  for (const s of radarActive.value) {
    for (const task of compareRows.value) {
      const v = radarSpeedOf(s.key, task);
      if (v != null && v > max) max = v;
    }
  }
  return max > 0 ? max / 0.8 : 0;
});
function radarValue(key: string, task: string): number | null {
  const speed = radarSpeedOf(key, task);
  if (speed != null) return radarSpeedCeiling.value > 0 ? (speed / radarSpeedCeiling.value) * 100 : 0;
  const [runId, model] = key.split('\u0000');
  const cell = compareCell(task, { runId, model });
  return cell && cell.score != null ? Math.round(cell.score * 1000) / 10 : null;
}
function radarDots(key: string) {
  const n = compareRows.value.length;
  return compareRows.value.map((task, i) => radarPt(i, n, (R_R * Math.max(0, Math.min(100, radarValue(key, task) ?? 0))) / 100));
}
function radarPolygon(key: string): string {
  return radarDots(key).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

// ---------- 环境设置 ----------
const profile = ref({ id: 'default', endpoint: cfg.value.endpoint, key: '', rememberKey: false });
async function saveProfile() {
  cfg.value.endpoint = profile.value.endpoint;
  localStorage.setItem('llmCfg', JSON.stringify(cfg.value));
  try {
    await api('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...profile.value, models }) });
    flash('ok', t('连接设置已保存', 'Connection settings saved'));
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
          <strong>{{ t('模型测评台', 'Model Eval Lab') }}</strong>
          <small>Precision Lab</small>
        </div>
      </div>
      <nav class="nav" :aria-label="t('主导航', 'Main navigation')">
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
        <button class="nav-item lang-toggle" type="button" @click="toggleLang" :title="t('切换语言', 'Switch language')">
          {{ lang === 'zh' ? 'EN' : '中文' }}
        </button>
        <span class="dot-row">
          <span class="dot" :class="preflight?.judge?.ok ? 'ok' : 'bad'" :title="preflight?.judge?.ok ? t('判题沙箱在线', 'Judge sandbox online') : t('判题沙箱离线', 'Judge sandbox offline')"></span>
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
              <h3>{{ t('推理服务', 'Inference endpoint') }}</h3>
              <p class="mono">{{ cfg.endpoint }}</p>
              <p>{{ models.length ? `${models.length} ${t('个模型可测', 'models ready')}` : t('尚未获取模型列表（环境设置）', 'No model list yet (Settings)') }}</p>
              <button class="btn" @click="select('new')">{{ t('开始评测', 'Start a run') }}</button>
            </div>
            <div class="card">
              <h3>{{ t('判题沙箱', 'Judge sandbox') }}</h3>
              <p>
                <span class="dot big" :class="preflight?.judge?.ok ? 'ok' : 'bad'"></span>
                {{ preflight?.judge?.ok ? t('在线（Docker 隔离，无外网）', 'Online (Docker isolated, no egress)') : t('离线 — 代码类评测不可用', 'Offline — code benchmarks unavailable') }}
              </p>
              <p class="soft">{{ t('代码与指令遵循判分依赖沙箱：', 'Sandbox-scored benchmarks:') }} HumanEval+ / MBPP+ / LiveCodeBench / DS-1000 / IFEval / IFBench</p>
            </div>
            <div class="card">
              <h3>{{ t('正在运行', 'Running now') }}</h3>
              <p class="big-num">{{ runningRuns.length }}</p>
              <p>{{ t('历史记录', 'History') }} {{ finishedRuns.length }} {{ t('次', 'runs') }}</p>
            </div>
            <div class="card">
              <h3>{{ t('测试协议', 'Protocols') }}</h3>
              <p class="big-num">{{ tasks.length }}</p>
              <p>{{ t('1 连通性 + 4 知识/长文 + 4 代码 + 2 指令遵循 + 2 安全', '1 speed + 4 knowledge/long-ctx + 4 code + 2 instruction + 2 safety') }}</p>
            </div>
          </div>
        </template>

        <!-- 新建评测 -->
        <template v-else-if="active === 'new'">
          <div class="panel head-row">
            <div class="row">
              <label>{{ t('结果名称', 'Run name') }}</label>
              <input v-model="form.name" type="text" class="input" :placeholder="t('例如：Qwen3.8 Q8 vs Q6K', 'e.g. Qwen3.8 Q8 vs Q6K')" />
            </div>
            <div class="row grow">
              <label>{{ t('备注', 'Note') }}</label>
              <input v-model="form.note" type="text" class="input" :placeholder="t('可选', 'optional')" />
            </div>
          </div>

          <fieldset class="panel">
            <legend>{{ t('模型（自上而下即执行顺序，选中后自动出现下一栏）', 'Models (top-down execution order; picking one reveals the next row)') }}</legend>
            <div class="rows-list">
              <div v-for="(m, i) in modelRows" :key="`m${i}`" class="row-line">
                <span class="idx">{{ i + 1 }}</span>
                <select v-model="modelRows[i]" class="input wide" :aria-label="`模型 ${i + 1}`" @change="onModelPicked(i)">
                  <option value="" disabled>{{ t('选择模型…', 'Pick a model…') }}</option>
                  <option v-for="opt in models" :key="opt.id" :value="opt.id">
                    {{ opt.id }} - {{ opt.name || '—' }}{{ opt.description ? ` - ${opt.description}` : '' }}
                  </option>
                </select>
                <button
                  v-if="!(i === modelRows.length - 1 && !m)" class="x" type="button"
                  :aria-label="`移除模型 ${i + 1}`" @click="removeModelRow(i)"
                >×</button>
              </div>
              <p v-if="!models.length" class="soft">{{ t('模型列表为空 — 请先到"环境设置"填写端点并获取模型。', 'Model list is empty - set the endpoint and fetch models in Settings first.') }}</p>
            </div>
          </fieldset>

          <fieldset class="panel">
            <legend>{{ t('测试项目（每行一项，参数可留空用默认值，选中后自动出现下一行）', 'Benchmarks (one per row; blank fields use defaults; picking one reveals the next row)') }}</legend>
            <table class="task-table">
              <thead>
                <tr>
                  <th class="c-task">{{ t('测试项目', 'Benchmark') }}</th>
                  <th>{{ t('题数', 'Items') }}</th>
                  <th>{{ t('重复次数', 'Repeats') }}</th>
                  <th>{{ t('并发请求', 'Concurrency') }}</th>
                  <th>max_tokens</th>
                  <th class="c-note">{{ t('备注', 'Note') }}</th>
                  <th class="c-x"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in taskRows" :key="`t${i}`">
                  <td class="c-task">
                    <div class="dd">
                      <button class="dd-toggle input" type="button" @click.stop="openDd = openDd === i ? -1 : i">
                        {{ taskName(taskById(r.task)) || t('选择测试项目…', 'Pick a benchmark…') }}
                      </button>
                      <ul v-if="openDd === i" class="dd-menu">
                        <li v-for="task in tasks" :key="task.id" @click.stop="pickTask(i, task.id)">
                          <strong>{{ taskName(task) }}</strong>
                          <small>{{ taskAbility(task) }}{{ judgeKinds.includes(task.kind) ? t(' · 需要沙箱', ' · sandbox') : '' }}</small>
                        </li>
                      </ul>
                    </div>
                  </td>
                  <td><input v-model="r.limit" class="input num" type="number" min="1" :placeholder="taskById(r.task)?.defaultLimit || t('全部', 'All')" /></td>
                  <td><input v-model="r.repeats" class="input num" type="number" min="1" placeholder="1" /></td>
                  <td><input v-model="r.concurrency" class="input num" type="number" min="1" placeholder="1" /></td>
                  <td><input v-model="r.maxTokens" class="input num" type="number" min="256" :placeholder="taskById(r.task)?.defaultMaxTokens || 4096" /></td>
                  <td class="c-note soft">
                    <template v-if="taskById(r.task)">{{ taskAbility(taskById(r.task)) }} · {{ judgeKinds.includes(taskById(r.task).kind) ? t('需要判题沙箱', 'sandbox required') : t('无需沙箱', 'no sandbox') }}</template>
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
            <button class="btn primary" @click="submitRun">{{ t('开始评测', 'Start run') }}</button>
            <span class="soft">{{ t('temperature=0 · 默认抑制思维链（AIME / GPQA / LiveCodeBench / IFBench 按官方口径开启思考 xhigh）· 留空的参数使用每项默认值', 'temperature=0 · thinking off by default (AIME / GPQA / LiveCodeBench / IFBench run thinking on, effort xhigh, per official setups) · blank fields use per-task defaults') }}</span>
          </div>
        </template>

        <!-- 运行队列：只显示正在运行的，日志常开、自动滚底 -->
        <template v-else-if="active === 'queue'">
          <p v-if="!runningRuns.length" class="soft">{{ t('当前没有正在运行的评测。', 'No runs are currently executing.') }}</p>
          <article v-for="r in runningRuns" :key="r.id" class="run-card">
            <header>
              <strong>{{ r.name }}</strong>
              <span class="badge running">{{ statusText(r.status) }}</span>
              <button class="btn ghost danger" @click="cancelRun(r.id)">{{ t('中断', 'Stop') }}</button>
            </header>
            <p class="soft">
              {{ (r.models || []).join('、') }} · {{ (r.tasks || []).length }} {{ t('项测试', 'benchmarks') }} · {{ t('进度', 'progress') }} {{ (r.progress?.modelIndex || 0) + 1 }}/{{ r.models.length }}
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
          <p v-if="!finishedRuns.length" class="soft">{{ t('暂无完成的结果。', 'No finished runs yet.') }}</p>
          <article v-for="r in finishedRuns" :key="r.id" class="run-card" :data-run-id="r.id">
            <header>
              <strong>{{ r.name }}</strong>
              <span class="badge" :class="r.status">{{ statusText(r.status) }}</span>
              <span class="soft">{{ new Date(r.startedAt).toLocaleString() }}</span>
              <span class="head-actions">
                <button class="btn act-btn" :class="{ danger: true }" @click="askDelete(r)">{{ t('删除', 'Delete') }}</button>
                <button class="btn act-btn primary-ghost" :class="{ on: comparePicks.includes(r.id) }" @click="toggleCompare(r.id)">
                  {{ comparePicks.includes(r.id) ? t('已选入', 'Picked') : t('选入对比', 'Compare') }}
                </button>
              </span>
            </header>
            <table class="table">
              <thead><tr><th>{{ t('模型', 'Model') }}</th><th>{{ t('测试', 'Benchmark') }}</th><th>{{ t('得分', 'Score') }}</th><th>{{ t('明细', 'Detail') }}</th><th>{{ t('重复', 'Repeats') }}</th></tr></thead>
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
              <summary>{{ t('逐题日志', 'Per-item logs') }}（{{ (r.log || []).length }}{{ t(' 行）', ' lines)') }}</summary>
              <pre class="log">{{ (r.log || []).join('\n') }}</pre>
            </details>
          </article>
        </template>

        <!-- 对比分析：行=测试项目，列=结果名称×模型，下方维度雷达图 -->
        <template v-else-if="active === 'compare'">
          <p v-if="!comparePicks.length" class="soft">{{ t('在"历史记录"中把若干次运行"选入对比"，这里会按测试项目逐行对比每个模型的表现。', 'Pick runs with "Compare" in History to compare them row by row per benchmark.') }}</p>
          <template v-else>
            <table class="table compare">
              <thead>
                <tr>
                  <th class="c-run">{{ t('测试项目', 'Benchmark') }}</th>
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

            <div class="panel radar-panel">
              <h3>{{ t('维度雷达图', 'Dimension radar') }}</h3>
              <div class="radar-legend">
                <button
                  v-for="opt in radarOptions" :key="opt.key" type="button"
                  class="legend-chip" :class="{ on: radarPicks.includes(opt.key) }"
                  :style="radarPicks.includes(opt.key) ? { borderColor: radarColor(opt.key), color: radarColor(opt.key) } : undefined"
                  @click="toggleRadar(opt.key)"
                >
                  <span class="chip-dot" :style="{ background: radarColor(opt.key) }"></span>
                  {{ opt.col.runName }} · {{ opt.col.model }}
                </button>
              </div>
              <div v-if="compareRows.length >= 3" class="radar-wrap">
                <svg :viewBox="`0 0 ${R_W} ${R_H}`" role="img" aria-label="对比维度雷达图">
                  <polygon v-for="f in [0.25, 0.5, 0.75, 1]" :key="`ring${f}`" :points="radarRing(f)" class="ring" />
                  <line
                    v-for="(task, i) in compareRows" :key="`ax${i}`"
                    :x1="R_CX" :y1="R_CY"
                    :x2="radarPt(i, compareRows.length, R_R).x" :y2="radarPt(i, compareRows.length, R_R).y" class="axis"
                  />
                  <text
                    v-for="(task, i) in compareRows" :key="`lb${i}`"
                    :x="radarLabel(i).x" :y="radarLabel(i).y" :text-anchor="radarLabel(i).anchor" class="axis-label"
                  >{{ shortTask(task) }}</text>
                  <g v-for="s in radarActive" :key="s.key">
                    <polygon :points="radarPolygon(s.key)" class="series" :fill="radarColor(s.key)" :stroke="radarColor(s.key)" />
                    <circle v-for="(p, i) in radarDots(s.key)" :key="i" :cx="p.x" :cy="p.y" r="3" :fill="radarColor(s.key)" />
                  </g>
                </svg>
                <p class="soft radar-note">{{ t('外圈 = 100% · 勾选图例绘制曲线 · 未覆盖项目按 0 绘制 · 速度轴按选中最高 t/s 的 80% 定标', 'Outer ring = 100% · tick a legend chip to draw · uncovered items plot as 0 · speed axis scales to 80% of the highest selected t/s') }}</p>
              </div>
              <p v-else class="soft">{{ t('本次对比覆盖的项目不足 3 项，雷达图至少需要 3 个维度。', 'Fewer than 3 benchmarks covered - the radar needs at least 3 axes.') }}</p>
            </div>
          </template>
        </template>

        <!-- 协议与基线 -->
        <template v-else-if="active === 'protocols'">
          <div class="panel">
            <p>{{ t('统一采样口径：temperature=0、单次生成（pass@1）。与官方榜单重叠的协议按官方口径开启思考（AIME 2025 / GPQA Diamond / LiveCodeBench / IFBench，思考档位 xhigh；AIME 输出预算 38912，其余 32768），其余协议默认抑制思维链（enable_thinking=false）。代码与指令类判分只看思考后的正文。选择题只认明确的最终答案（最终答案：X / \boxed{X} / 末行选项字母），推理无结论计"未知"并保留在分母中，避免把截断的推理误判为错误。', 'Common sampling: temperature=0, single generation (pass@1). Protocols overlapping the official leaderboard run with thinking on per the official setup (AIME 2025 / GPQA Diamond / LiveCodeBench / IFBench, effort xhigh; output budget 38,912 for AIME, 32,768 for the rest); all other protocols keep thinking disabled by default (enable_thinking=false). Code and instruction scoring reads only the post-thinking content. MCQ scoring accepts an explicit final answer only; reasoning without a conclusion counts as unknown and stays in the denominator, so truncated reasoning is not graded wrong.') }}</p>
          </div>
          <table class="table">
            <thead><tr><th>{{ t('协议', 'Protocol') }}</th><th>{{ t('能力', 'Ability') }}</th><th>{{ t('判分方式', 'Scoring') }}</th><th>{{ t('默认题数 / 全量', 'Default items / pool') }}</th></tr></thead>
            <tbody>
              <tr v-for="task in tasks" :key="task.id">
                <td>{{ taskName(task) }}</td>
                <td>{{ taskAbility(task) }}</td>
                <td class="soft">{{ ({
                  smoke: t('预热后流式请求：首 token 延迟 + 生成速度（不含首 token）', 'Streaming probe after warmup: TTFT + decode speed (excl. first token)'),
                  gpqa: t('选项字母精确匹配', 'Exact choice-letter match'),
                  aime: t('整数答案精确匹配', 'Exact integer match'),
                  mmlu: t('选项字母精确匹配', 'Exact choice-letter match'),
                  longbench2: t('A/B/C/D 字母精确匹配', 'Exact A/B/C/D letter match'),
                  humanevalplus: t('全部增强测试通过（沙箱执行）', 'All augmented tests pass (sandboxed)'),
                  mbppplus: t('全部增强测试通过（沙箱执行）', 'All augmented tests pass (sandboxed)'),
                  livecodebench: t('隐藏测试全通过（stdin/函数式沙箱）', 'All hidden tests pass (stdin/functional sandbox)'),
                  ds1000: t('官方扰动测试通过（沙箱执行）', 'Official perturbation tests pass (sandboxed)'),
                  ifeval: t('官方校验器：全部约束满足（strict，沙箱执行）', 'Official verifier: all constraints met (strict, sandboxed)'),
                  ifbench: t('官方校验器：域外约束全满足（strict，沙箱执行）', 'Official verifier: all OOD constraints met (strict, sandboxed)'),
                  xstest: t('安全提示应答视为通过，命中拒绝模式视为误拒', 'Answering a safe prompt passes; refusal patterns count as over-refusal'),
                } as Record<string, string>)[task.kind] }}</td>
                <td>{{ task.defaultLimit || '—' }}<template v-if="task.ability.includes('全量')"> / {{ task.ability.split('｜全量 ')[1] }}</template></td>
              </tr>
            </tbody>
          </table>
          <div class="panel">
            <p class="soft">{{ t('代码与指令类题目在 WSL2 Docker 沙箱内判分（无外网、CPU/内存/文件系统受限、单测超时 6-60s）；IFEval/IFBench 判分使用 vendor 的官方校验器（judge/verifiers/）。默认题数是快速抽样口径，把"题数"填成全量即为深度评测。数据集重新生成：node scripts/prepare_*.js（原始数据见 benchmarks/raw，大文件可用 docker/download-benchmarks.sh 重新下载）。', 'Code and instruction benchmarks are judged inside a WSL2 Docker sandbox (no egress, CPU/memory/filesystem limits, 6-60s per-test timeouts); IFEval/IFBench use the vendored official verifiers (judge/verifiers/). Default item counts are quick samples - fill "Items" with the full pool for a deep run. Regenerate datasets with node scripts/prepare_*.js (raw sources under benchmarks/raw; re-download large ones via docker/download-benchmarks.sh).') }}</p>
          </div>
        </template>

        <!-- 环境设置 -->
        <template v-else-if="active === 'settings'">
          <div class="panel">
            <div class="row"><label>{{ t('API 端点', 'API endpoint') }}</label><input v-model="profile.endpoint" class="input" type="text" /></div>
            <div class="row"><label>API Key</label><input v-model="profile.key" class="input" type="password" :placeholder="t('本地服务通常留空', 'usually empty for local services')" /></div>
            <div class="row"><label></label><label class="inline"><input v-model="profile.rememberKey" type="checkbox" /> {{ t('保存 Key（服务端配置）', 'Remember key (server-side config)') }}</label></div>
            <div class="actions">
              <button class="btn primary" @click="saveProfile">{{ t('保存并应用', 'Save & apply') }}</button>
              <button class="btn" :disabled="loadingModels" @click="fetchModels">{{ loadingModels ? t('获取中…', 'Fetching…') : t('重新获取模型', 'Refetch models') }}</button>
            </div>
          </div>
          <div class="panel">
            <h3>{{ t('环境自检', 'Environment self-check') }}</h3>
            <pre class="log">{{ JSON.stringify(preflight, null, 2) }}</pre>
          </div>
        </template>
      </section>
      </Transition>
    </main>

    <!-- 完成通知（右上角，自动消失，红叉手动关闭） -->
    <div class="toast-stack" aria-live="polite">
      <TransitionGroup name="toast">
        <div v-for="toast in toasts" :key="toast.id" class="toast" role="status" @click="toastClick(toast.id)">
          <div class="toast-body">
            <strong>{{ toast.text }}</strong>
            <small>{{ toast.sub }}</small>
          </div>
          <button class="toast-x" type="button" :aria-label="t('关闭通知', 'Dismiss notification')" @click.stop="dismissToast(toast.id)">×</button>
        </div>
      </TransitionGroup>
    </div>

    <!-- 删除确认弹窗 -->
    <Transition name="fade">
      <div v-if="pendingDelete" class="modal-backdrop" @click.self="pendingDelete = null">
        <div class="modal" role="alertdialog" aria-modal="true" :aria-label="t('确认删除', 'Confirm deletion')">
          <h3>{{ t('删除这条测试结果？', 'Delete this run?') }}</h3>
          <p class="modal-name">「{{ pendingDelete.name }}」</p>
          <p class="soft">{{ t('删除后不可恢复。按 Enter 确认，Esc 取消。', 'This cannot be undone. Enter confirms, Esc cancels.') }}</p>
          <div class="modal-actions">
            <button class="btn" type="button" @click="pendingDelete = null">{{ t('取消', 'Cancel') }}</button>
            <button ref="confirmBtn" class="btn primary danger-solid" type="button" @click="confirmDelete">{{ t('删除', 'Delete') }}</button>
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
.brand-text strong { font-family: var(--font-display); font-size: 16px; letter-spacing: .02em; }
.brand-text small { color: var(--color-teal-on-soft); }

.nav { display: flex; flex-direction: column; gap: 2px; }
.nav-item {
  text-align: left; padding: 9px 12px; border: 0; border-radius: var(--radius-sm);
  background: transparent; color: var(--color-teal-on); cursor: pointer;
  font: inherit; font-family: var(--font-display); transition: background var(--motion-fast);
}
.nav-item:hover { background: var(--color-teal-hover); }
.nav-item.active { background: var(--color-teal-active); font-weight: 700; }

.sidenav-foot { margin-top: auto; display: flex; flex-direction: column; gap: 8px; padding: 0 6px; }
.sidenav-foot .lang-toggle {
  text-align: center; width: 100%; padding: 8px 12px; font-weight: 700; letter-spacing: .08em;
  border: 1px solid var(--color-teal-line); color: var(--color-teal-on);
}
.sidenav-foot .lang-toggle:hover { background: var(--color-teal-hover); }
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
fieldset.panel legend { padding: 0 8px; color: var(--color-ink-soft); font-family: var(--font-display); font-size: 13px; }
.card h3, .panel h3 { margin: 0 0 8px; font-family: var(--font-display); font-size: 15px; color: var(--color-ink-soft); font-weight: 700; }
.card p { margin: 4px 0; }
.big-num { font-family: var(--font-display); font-size: 30px; margin: 2px 0 !important; }
.mono { font-family: var(--font-mono); font-size: 12px; }
.soft { color: var(--color-ink-soft); font-size: 12px; }

.head-row { display: flex; gap: 24px; flex-wrap: wrap; }
.head-row .row { flex: 1 1 280px; }

.row { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
.row > label { width: 90px; flex: none; color: var(--color-ink-soft); font-size: 13px; }
.row > label.inline { width: auto; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; cursor: pointer; }

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
.run-card header strong { font-family: var(--font-display); font-size: 15px; }
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
.modal-name { font-family: var(--font-display); }
.modal-name { margin: 4px 0; font-weight: 700; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
.danger-solid { background: var(--color-danger) !important; border-color: var(--color-danger) !important; color: #fff !important; }
.danger-solid:hover { filter: brightness(1.08); }

/* 完成通知 toast（右上角横板卡片） */
.toast-stack { position: fixed; top: 18px; right: 18px; z-index: 80; display: flex; flex-direction: column; gap: 10px; width: min(360px, 90vw); }
.toast {
  display: flex; align-items: center; gap: 10px; padding: 11px 12px 11px 14px; cursor: pointer;
  background: var(--color-paper-raised); border: 1px solid var(--color-line); border-left: 3px solid var(--color-teal);
  border-radius: var(--radius-md); box-shadow: var(--shadow-card);
}
.toast-body { flex: 1; min-width: 0; }
.toast-body strong { display: block; font-size: 13px; }
.toast-body small { color: var(--color-ink-soft); font-size: 12px; }
.toast-x {
  flex: none; width: 22px; height: 22px; border: 0; border-radius: 50%; background: transparent;
  color: var(--color-danger); font-size: 15px; line-height: 1; cursor: pointer;
}
.toast-x:hover { background: var(--color-coral-soft); }
.toast-enter-active, .toast-leave-active, .toast-move { transition: all .25s cubic-bezier(.16, 1, .3, 1); }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(24px); }

/* 对比维度雷达图 */
.radar-panel { margin-top: 16px; }
.radar-legend { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 6px; }
.legend-chip {
  display: inline-flex; align-items: center; gap: 7px; padding: 5px 12px; max-width: 100%;
  border: 1px solid var(--color-line); border-radius: 999px; background: var(--color-paper);
  color: var(--color-ink); font-size: 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: background var(--motion-fast);
}
.legend-chip .chip-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.legend-chip:hover { background: var(--color-teal-soft); }
.legend-chip.on { background: var(--color-paper-raised); font-weight: 600; }
.radar-wrap { max-width: 480px; margin: 4px auto 0; }
.radar-wrap svg { width: 100%; height: auto; display: block; }
.ring { fill: none; stroke: var(--color-line); }
.axis { stroke: var(--color-line); }
.axis-label { fill: var(--color-ink-soft); font-size: 11px; }
.series {
  fill-opacity: .13; stroke-width: 2; stroke-linejoin: round;
  animation: radar-in .35s cubic-bezier(.16, 1, .3, 1);
  transform-box: fill-box; transform-origin: center;
}
@keyframes radar-in { from { opacity: 0; transform: scale(.94); } }
.radar-note { text-align: center; margin: 6px 0 0; }

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
  .toast-enter-active, .toast-leave-active, .toast-move, .series { transition: none; animation: none; }
}
</style>
