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

// ---------- 导航指示条：沿左侧轨道滑动到当前项 ----------
const navEls = ref<HTMLElement[]>([]);
const indY = ref(0);
const indH = ref(0);
function syncIndicator() {
  const i = views.value.findIndex((v) => v.id === active.value);
  const el = navEls.value[i];
  if (!el) return;
  indY.value = el.offsetTop + (el.offsetHeight - 26) / 2;
  indH.value = 26;
}
watch(active, () => { nextTick(syncIndicator); });
watch(lang, () => { nextTick(syncIndicator); });
onMounted(() => {
  nextTick(syncIndicator);
  window.addEventListener('resize', syncIndicator);
});
onBeforeUnmount(() => { window.removeEventListener('resize', syncIndicator); });

// ---------- shared state ----------
const preflight = ref<any>(null);
const tasks = ref<any[]>([]);
const models = ref<{ id: string; name?: string; description?: string }[]>([]);
const runs = ref<any[]>([]); // all runs, newest first
const notice = ref<{ kind: 'ok' | 'err'; text: string } | null>(null);

const runningRuns = computed(() => runs.value.filter((r) => r.status === 'running'));
const finishedRuns = computed(() => runs.value.filter((r) => r.status !== 'running'));

// ---------- 数字缓动：数据变化时从当前值滚动到新值 ----------
function useNum(target: () => number, dur = 780) {
  const out = ref(0);
  let raf = 0;
  watch(target, (to) => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { out.value = to; return; }
    cancelAnimationFrame(raf);
    const from = out.value;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      out.value = Math.round(from + (to - from) * e);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }, { immediate: true });
  onBeforeUnmount(() => cancelAnimationFrame(raf));
  return out;
}
const nModels = useNum(() => models.value.length);
const nRunning = useNum(() => runningRuns.value.length);
const nFinished = useNum(() => finishedRuns.value.length);
const nTasks = useNum(() => tasks.value.length);

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
      body: JSON.stringify({ endpoint: cfg.value.endpoint, key: cfg.value.key, protocol: profile.value.protocol }),
    });
    models.value = body.models || [];
    flash('ok', `${t('已获取', 'Fetched')} ${models.value.length} ${t('个模型', 'models')}（${body.protocol}）`);
  } catch (e: any) {
    flash('err', t('获取模型失败：', 'Failed to fetch models: ') + e.message);
  } finally {
    loadingModels.value = false;
  }
}

let timer: number | undefined;
onMounted(async () => {
  document.addEventListener('click', closeMenus);
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
function scrollLogToLatest(log: HTMLElement | null) {
  if (!log) return;
  log.scrollTo({ top: log.scrollHeight, behavior: 'auto' });
  // A details element or a view transition can complete layout one frame
  // after the event handler. Repeat after layout so returning to a view and
  // opening history logs both land on the actual latest line.
  requestAnimationFrame(() => {
    if (log.isConnected) log.scrollTo({ top: log.scrollHeight, behavior: 'auto' });
  });
}

function scrollQueueLogsToLatest() {
  nextTick(() => {
    document.querySelectorAll<HTMLElement>('.auto-scroll').forEach((el) => scrollLogToLatest(el));
  });
}

function onViewEnter() {
  if (active.value === 'queue') scrollQueueLogsToLatest();
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
    scrollLogToLatest(card.querySelector<HTMLElement>('.log'));
  }, 380); // 等待视图过渡完成
}

function onHistoryLogToggle(e: Event) {
  const details = e.currentTarget as HTMLDetailsElement;
  if (!details.open) return;
  nextTick(() => scrollLogToLatest(details.querySelector<HTMLElement>('.log')));
}

let lastPreflightAt = 0;
async function refreshRuns() {
  // 左下角判题状态依赖 preflight，随轮询低频刷新（每 10s）
  if (Date.now() - lastPreflightAt > 10000) { lastPreflightAt = Date.now(); refreshPreflight(); }
  try {
    const fresh = await api('/api/runs');
    runs.value = fresh;
    for (const r of fresh) {
      const prev = prevStatuses.get(r.id);
      if (statusSeeded && prev === 'running' && r.status !== 'running') {
        if (active.value === 'queue') select('history');
        else pushToast(r);
      }
      prevStatuses.set(r.id, r.status);
    }
    statusSeeded = true;
  } catch { /* keep last */ }
}

// auto-scroll queue logs as they grow and whenever the user returns to Queue
watch(() => runs.value.map((r) => (r.log || []).length).join(','), () => {
  if (active.value === 'queue') scrollQueueLogsToLatest();
});
watch(active, (view) => { if (view === 'queue') scrollQueueLogsToLatest(); });

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

/* 下拉：让菜单展开时把当前已选项滚到眼前 + 该项文本 */
const idxOf = <T,>(list: T[], isHit: (x: T) => boolean) => Math.max(0, list.findIndex(isHit));
const curTaskIndex = (i: number) => idxOf(tasks.value, (x) => x.id === taskRows.value[i]?.task);
const curModelIndex = (i: number) => idxOf(models.value, (x) => x.id === modelRows.value[i]);
const curEffortIndex = (i: number) => idxOf(reasoningEfforts, (x) => x.id === taskRows.value[i]?.reasoningEffort);
const curProtocolIndex = () => idxOf(MODEL_PROTOCOLS, (p) => p.id === profile.value.protocol);
const effortLabel = (id: string) => {
  const x = reasoningEfforts.find((e) => e.id === id);
  return x ? (lang.value === 'en' ? x.en : x.zh) : id;
};
const protocolLabel = (id: string) => {
  const p = MODEL_PROTOCOLS.find((x) => x.id === id);
  return p ? (lang.value === 'en' ? p.label_en : p.label) : id;
};
function removeModelRow(i: number) {
  modelRows.value.splice(i, 1);
  if (!modelRows.value.length) modelRows.value.push('');
  const last = modelRows.value.length - 1;
  if (modelRows.value[last]) modelRows.value.push('');
}

// ---------- 新建评测：测试项目表格（逐行下拉 + 每行参数） ----------
type TaskRow = {
  task: string;
  limit: string;
  repeats: string;
  concurrency: string;
  maxTokens: string;
  thinking: boolean;
  reasoningEffort: string;
};
const newTaskRow = (): TaskRow => ({ task: '', limit: '', repeats: '', concurrency: '', maxTokens: '', thinking: false, reasoningEffort: 'xhigh' });
const taskRows = ref<TaskRow[]>([newTaskRow()]);

// 自定义下拉：openKey 标识当前展开的菜单（'' = 全部关闭）
// 一次只开一个，所以 ddActive（键盘高亮下标）可以全局共用
const openKey = ref('');
const ddActive = ref(0); // 键盘高亮下标
const ddUp = ref(false); // 触发按钮距视口底部不足 300px 时向上翻转，避免菜单被屏幕切断
const ddOpen = (key: string) => openKey.value === key;
const nearBottom = (box: Element) => window.innerHeight - box.getBoundingClientRect().bottom < 300;
function ddClose() { openKey.value = ''; }
function ddToggle(e: Event, key: string, start = 0) {
  if (openKey.value === key) { openKey.value = ''; return; }
  const box = (e.currentTarget as HTMLElement)?.closest?.('.dd');
  if (box) ddUp.value = nearBottom(box);
  openKey.value = key;
  ddActive.value = start;
}
function closeMenus(e: Event) {
  if (!(e.target as HTMLElement).closest('.dd')) ddClose();
}
// 键盘：Enter/Space/↓ 展开 · ↑↓ 移动高亮 · Enter 选中 · Esc 关闭并把焦点还给按钮
function onDdKey(e: KeyboardEvent, key: string, len: number, pick: (k: number) => void) {
  if (openKey.value !== key) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const box = e.currentTarget as HTMLElement;
      if (box?.getBoundingClientRect) ddUp.value = nearBottom(box);
      openKey.value = key;
      ddActive.value = 0;
    }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    ddClose();
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.dd-toggle')?.focus();
    return;
  }
  if (e.key === 'Tab') { ddClose(); return; }
  if (!len) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); ddActive.value = (ddActive.value + 1) % len; return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); ddActive.value = (ddActive.value - 1 + len) % len; return; }
  if (e.key === 'Enter') { e.preventDefault(); pick(ddActive.value); return; }
}
// 键盘移动时把高亮项带进可视区
watch(ddActive, () => {
  nextTick(() => { document.querySelector('.dd-menu .is-active')?.scrollIntoView({ block: 'nearest' }); });
});
watch(active, () => { ddClose(); });
const judgeKinds = ['humanevalplus', 'mbppplus', 'livecodebench', 'ds1000', 'ifeval', 'ifbench'];
const reasoningEfforts = [
  { id: 'low', zh: 'low', en: 'low' },
  { id: 'medium', zh: 'medium', en: 'medium' },
  { id: 'high', zh: 'high', en: 'high' },
  { id: 'xhigh', zh: 'xhigh（官方常用）', en: 'xhigh (official-style)' },
];
const taskById = (id: string) => tasks.value.find((t) => t.id === id);

function pickTask(i: number, id: string) {
  taskRows.value[i].task = id;
  ddClose();
  if (i === taskRows.value.length - 1) taskRows.value.push(newTaskRow());
}
function pickModel(i: number, id: string) {
  modelRows.value[i] = id;
  ddClose();
  onModelPicked(i);
}
function pickEffort(i: number, id: string) {
  taskRows.value[i].reasoningEffort = id;
  ddClose();
}
function pickProtocol(id: string) {
  profile.value.protocol = id;
  ddClose();
}
function removeTaskRow(i: number) {
  taskRows.value.splice(i, 1);
  if (!taskRows.value.length) taskRows.value.push(newTaskRow());
  const last = taskRows.value[taskRows.value.length - 1];
  if (last.task) taskRows.value.push(newTaskRow());
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
      t.thinking = r.thinking === true;
      if (t.thinking) t.reasoningEffort = r.reasoningEffort || 'xhigh';
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

// 继续：从中断/出错的运行接着跑（已完成项目自动跳过）
async function resumeRun(run: any) {
  try {
    const res = await fetch(`/api/runs/${run.id}/resume`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    flash('ok', t('已继续执行（已完成项目自动跳过）', 'Resumed — completed items are skipped'));
    select('queue');
    refreshRuns();
  } catch (e: any) { flash('err', e.message); }
}

function elapsedMin(run: any) {
  const mins = Math.max(1, Math.round((Date.now() - new Date(run.startedAt).getTime()) / 60000));
  return t(`已运行 ${mins} 分钟`, `running for ${mins} min`);
}
// 运行进度百分比（模型数 × 项目数 为总量）
const runPct = (run: any) => {
  const total = (run.models?.length || 0) * ((run.tasks || []).length || 1);
  return total ? Math.max(0, Math.min(100, Math.round(((run.donePairs ?? 0) / total) * 100))) : 0;
};

function durationText(run: any) {
  if (!run.finishedAt) return '';
  const mins = Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 60000);
  return mins >= 1 ? t(`耗时 ${mins} 分钟`, `took ${mins} min`) : t('耗时不足 1 分钟', 'took <1 min');
}
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
function onDeleteModalKey(e: KeyboardEvent) {
  if (!pendingDelete.value) return;
  if (e.key === 'Enter') { e.preventDefault(); confirmDelete(); }
  else if (e.key === 'Escape') { e.preventDefault(); pendingDelete.value = null; }
}
watch(pendingDelete, (v) => {
  if (v) {
    window.addEventListener('keydown', onDeleteModalKey);
    nextTick(() => confirmBtn.value?.focus());
  } else {
    window.removeEventListener('keydown', onDeleteModalKey);
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

// 对比条形图：百分制直接用数值，速度行按本行最高值定标；每行最优标成强调色
function cellNum(task: string, col: { runId: string; model: string }): number | null {
  const cell = compareCell(task, col);
  if (!cell) return null;
  return cell.speed != null ? cell.speed : cell.score != null ? cell.score * 100 : null;
}
function rowBest(task: string): number | null {
  const vals = compareCols.value.map((c) => cellNum(task, c)).filter((v): v is number => v != null);
  return vals.length ? Math.max(...vals) : null;
}
function barWidth(task: string, col: { runId: string; model: string }): string {
  const v = cellNum(task, col);
  if (v == null) return '0%';
  const best = rowBest(task);
  const cell = compareCell(task, col);
  const pct = cell && cell.speed != null && best ? (v / best) * 100 : v;
  return `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
}
function isBest(task: string, col: { runId: string; model: string }): boolean {
  const v = cellNum(task, col);
  const best = rowBest(task);
  return v != null && best != null && v === best && compareCols.value.filter((c) => cellNum(task, c) === best).length > 0;
}
// 条形图先渲染 0 宽，下一帧再写到目标宽度，才有生长动画
const barsReady = ref(false);
watch([active, comparePicks], () => {
  barsReady.value = false;
  nextTick(() => requestAnimationFrame(() => { barsReady.value = true; }));
}, { immediate: true });

// 历史行里的旧题库名称（“…（缓存题库）”）归一到当前口径，老结果也能和新结果同表对比
const TASK_ALIAS: Record<string, string> = {
  'GPQA Diamond（缓存题库）': 'GPQA Diamond（科学推理）',
  'AIME 2025（缓存题库）': 'AIME 2025（数学推理）',
  'MMLU-Pro（缓存题库）': 'MMLU-Pro（综合知识）',
};
const normTask = (n: string) => TASK_ALIAS[n] || n;

// 历史/对比行的任务名是运行时固化的中文快照，英文态按注册表 name_en 映射显示
const taskEnByName = computed(() => {
  const m: Record<string, string> = {};
  for (const t of tasks.value) if (t?.name && t.name_en) m[t.name] = t.name_en;
  return m;
});
function rowTaskName(name: string) {
  if (lang.value !== 'en') return name;
  return taskEnByName.value[normTask(name)] || name;
}

// 左下角判题服务状态：离线 / 判题中（运行中的评测含沙箱类任务）/ 健康
const judgeBusy = computed(() => runningRuns.value.some((r) => (r.tasks || []).some((id: string) => {
  const t = taskById(id);
  return !!t && judgeKinds.includes(t.kind);
})));
const judgeStatusText = computed(() => {
  if (!preflight.value?.judge?.ok) return t('判题服务离线', 'Judge service offline');
  return judgeBusy.value ? t('判题中', 'Judging') : t('判题服务健康', 'Judge service healthy');
});

// ---------- 对比分析：维度雷达图（轴=本次覆盖的项目，系列=运行×模型，默认不绘制） ----------
const RADAR_COLORS = ['#E2593C', '#14161A', '#8E9398', '#C74A2F', '#54585E', '#BFC2C5', '#F07A5D', '#3A3F44'];
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
const profile = ref({ id: 'default', endpoint: cfg.value.endpoint, key: '', rememberKey: false, protocol: 'openai' });
const MODEL_PROTOCOLS = [
  { id: 'openai', label: 'OpenAI 兼容 /v1/models', label_en: 'OpenAI-compatible /v1/models' },
  { id: 'llama-swap', label: 'llama-swap（/v1 + /mu/models）', label_en: 'llama-swap (/v1 + /mu/models)' },
];
// 已获取模型：点击按钮弹出完整列表（同新建评测的下拉样式，只读）
const showModels = ref(false);

// ---------- 历史记录：编辑名称 / 备注 ----------
const editingRun = ref<any>(null);
const editForm = ref({ name: '', note: '' });
function askRename(run: any) {
  editingRun.value = run;
  editForm.value = { name: run.name || '', note: run.note || '' };
}
async function confirmRename() {
  const run = editingRun.value;
  if (!run) return;
  if (!editForm.value.name.trim()) { flash('err', t('名称不能为空', 'Name cannot be empty')); return; }
  try {
    await api(`/api/results/${run.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editForm.value.name, note: editForm.value.note }),
    });
    flash('ok', t('已更新名称与备注', 'Name and note updated'));
    editingRun.value = null;
    refreshRuns();
  } catch (e: any) { flash('err', e.message); }
}
// 名称后的备注括号：有备注才显示
const nameWithNote = (run: any) => (run.note ? `${run.name}（${run.note}）` : run.name || run.id);
function onRenameKey(e: KeyboardEvent) {
  if (!editingRun.value) return;
  if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA') { e.preventDefault(); confirmRename(); }
  else if (e.key === 'Escape') { e.preventDefault(); editingRun.value = null; }
}
watch(editingRun, (v) => {
  if (v) window.addEventListener('keydown', onRenameKey);
  else window.removeEventListener('keydown', onRenameKey);
});

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
        <span
          class="nav-indicator" aria-hidden="true"
          :style="{ transform: `translateY(${indY}px)`, height: `${indH}px`, opacity: indH ? 1 : 0 }"
        ></span>
        <button
          v-for="v in views"
          :key="v.id"
          ref="navEls"
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
        <span class="dot-row" :title="judgeStatusText">
          <span class="dot" :class="!preflight?.judge?.ok ? 'bad' : judgeBusy ? 'busy' : 'ok'"></span>
          {{ judgeStatusText }}
        </span>
      </div>
    </aside>
    <main class="content">
      <header class="content-head">
        <h1 class="view-title"><span class="tmask"><span :key="active" class="tinner">{{ activeView.label }}</span></span></h1>
        <p v-if="notice" class="notice" :class="notice.kind">{{ notice.text }}</p>
      </header>
      <Transition name="view" mode="out-in" @after-enter="onViewEnter">
        <section class="view-body" :data-view="active" :key="active">

        <!-- 总览 -->
        <template v-if="active === 'overview'">
          <div class="cards">
            <div class="card" style="--i:0ms">
              <h3>{{ t('推理服务', 'Inference endpoint') }}</h3>
              <p class="mono">{{ cfg.endpoint }}</p>
              <p>{{ nModels ? `${nModels} ${t('个模型可测', 'models ready')}` : t('尚未获取模型列表（环境设置）', 'No model list yet (Settings)') }}</p>
              <button class="btn primary" @click="select('new')">{{ t('开始评测', 'Start a run') }}</button>
            </div>
            <div class="card" style="--i:70ms">
              <h3>{{ t('判题沙箱', 'Judge sandbox') }}</h3>
              <p>
                <span class="dot big" :class="preflight?.judge?.ok ? 'ok' : 'bad'"></span>
                {{ preflight?.judge?.ok ? t('在线（Docker 隔离，无外网）', 'Online (Docker isolated, no egress)') : t('离线 — 代码类评测不可用', 'Offline — code benchmarks unavailable') }}
              </p>
              <p class="soft">{{ t('代码与指令遵循判分依赖沙箱：', 'Sandbox-scored benchmarks:') }} HumanEval+ / MBPP+ / LiveCodeBench / DS-1000 / IFEval / IFBench</p>
            </div>
            <div class="card" style="--i:140ms">
              <h3>{{ t('正在运行', 'Running now') }}</h3>
              <p class="big-num">{{ nRunning }}</p>
              <p>{{ t('历史记录', 'History') }} {{ nFinished }} {{ t('次', 'runs') }}</p>
            </div>
            <div class="card" style="--i:210ms">
              <h3>{{ t('测试协议', 'Protocols') }}</h3>
              <p class="big-num">{{ nTasks }}</p>
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
              <div v-for="(m, i) in modelRows" :key="`m${i}`" class="row-line" :style="{ '--i': `${i * 50}ms` }">
                <span class="idx">{{ i + 1 }}</span>
                <div class="dd wide" :class="{ 'is-up': ddUp && ddOpen(`model${i}`) }" @keydown="onDdKey($event, `model${i}`, models.length, (k) => pickModel(i, models[k].id))">
                  <button
                    class="dd-toggle input wide" type="button"
                    :class="{ 'is-open': ddOpen(`model${i}`), 'is-empty': !modelRows[i] }"
                    role="combobox" aria-haspopup="listbox" :aria-expanded="ddOpen(`model${i}`)"
                    :aria-label="`模型 ${i + 1}`"
                    @click.stop="ddToggle($event, `model${i}`, curModelIndex(i))"
                  >
                    <span class="dd-val">{{ modelRows[i] || t('选择模型…', 'Pick a model…') }}</span>
                    <svg class="dd-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.2 4.8 6 7.6 8.8 4.8" /></svg>
                  </button>
                  <ul v-if="ddOpen(`model${i}`)" class="dd-menu" role="listbox" :aria-label="`模型 ${i + 1}`">
                    <li
                      v-for="(opt, k) in models" :key="opt.id" class="dd-opt" role="option"
                      :class="{ 'is-active': ddActive === k, 'is-picked': modelRows[i] === opt.id }"
                      :aria-selected="modelRows[i] === opt.id"
                      :style="{ '--i': `${Math.min(k, 14) * 18}ms` }"
                      @click.stop="pickModel(i, opt.id)" @mouseenter="ddActive = k"
                    >
                      <strong>{{ opt.id }}</strong>
                      <small v-if="opt.name || opt.description">{{ opt.name || '—' }}{{ opt.description ? ` · ${opt.description}` : '' }}</small>
                    </li>
                  </ul>
                </div>
                <button
                  v-if="!(i === modelRows.length - 1 && !m)" class="x" type="button"
                  :aria-label="`移除模型 ${i + 1}`" @click="removeModelRow(i)"
                >×</button>
              </div>
              <p v-if="!models.length" class="soft">{{ t('模型列表为空 — 请先到"环境设置"填写端点并获取模型。', 'Model list is empty - set the endpoint and fetch models in Settings first.') }}</p>
            </div>
          </fieldset>

          <fieldset class="panel">
            <legend>{{ t('测试项目（每行一项；思考默认关闭；参数可留空用默认值）', 'Benchmarks (one per row; thinking is off by default; blank fields use defaults)') }}</legend>
            <table class="task-table">
              <thead>
                <tr>
                  <th class="c-task">{{ t('测试项目', 'Benchmark') }}</th>
                  <th>{{ t('题数', 'Items') }}</th>
                  <th>{{ t('重复次数', 'Repeats') }}</th>
                  <th>{{ t('并发请求', 'Concurrency') }}</th>
                  <th>max_tokens</th>
                  <th class="c-thinking">{{ t('思考', 'Thinking') }}</th>
                  <th class="c-effort">{{ t('思考等级', 'Effort') }}</th>
                  <th class="c-x"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in taskRows" :key="`t${i}`" :style="{ '--i': `${i * 45}ms` }">
                  <td class="c-task">
                    <div class="dd" :class="{ 'is-up': ddUp && ddOpen(`task${i}`) }" @keydown="onDdKey($event, `task${i}`, tasks.length, (k) => pickTask(i, tasks[k].id))">
                      <button
                        class="dd-toggle input" type="button"
                        :class="{ 'is-open': ddOpen(`task${i}`), 'is-empty': !r.task }"
                        role="combobox" aria-haspopup="listbox" :aria-expanded="ddOpen(`task${i}`)"
                        @click.stop="ddToggle($event, `task${i}`, curTaskIndex(i))"
                      >
                        <span class="dd-val">{{ taskName(taskById(r.task)) || t('选择测试项目…', 'Pick a benchmark…') }}</span>
                        <svg class="dd-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.2 4.8 6 7.6 8.8 4.8" /></svg>
                      </button>
                      <ul v-if="ddOpen(`task${i}`)" class="dd-menu" role="listbox">
                        <li
                          v-for="(task, k) in tasks" :key="task.id" class="dd-opt" role="option"
                          :class="{ 'is-active': ddActive === k, 'is-picked': r.task === task.id }"
                          :aria-selected="r.task === task.id"
                          :style="{ '--i': `${Math.min(k, 14) * 22}ms` }"
                          @click.stop="pickTask(i, task.id)" @mouseenter="ddActive = k"
                        >
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
                  <td class="c-thinking">
                    <input v-model="r.thinking" type="checkbox" :aria-label="`${t('开启思考', 'Enable thinking')} ${i + 1}`" />
                  </td>
                  <td>
                    <div class="dd narrow" :class="{ 'is-up': ddUp && ddOpen(`effort${i}`) }" @keydown="onDdKey($event, `effort${i}`, reasoningEfforts.length, (k) => pickEffort(i, reasoningEfforts[k].id))">
                      <button
                        class="dd-toggle input" type="button" :disabled="!r.thinking"
                        :class="{ 'is-open': ddOpen(`effort${i}`) }"
                        role="combobox" aria-haspopup="listbox" :aria-expanded="ddOpen(`effort${i}`)"
                        :aria-label="`${t('思考等级', 'Thinking effort')} ${i + 1}`"
                        @click.stop="r.thinking && ddToggle($event, `effort${i}`, curEffortIndex(i))"
                      >
                        <span class="dd-val">{{ effortLabel(r.reasoningEffort) }}</span>
                        <svg class="dd-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.2 4.8 6 7.6 8.8 4.8" /></svg>
                      </button>
                      <ul v-if="ddOpen(`effort${i}`)" class="dd-menu narrow" role="listbox">
                        <li
                          v-for="(effort, k) in reasoningEfforts" :key="effort.id" class="dd-opt flat" role="option"
                          :class="{ 'is-active': ddActive === k, 'is-picked': r.reasoningEffort === effort.id }"
                          :aria-selected="r.reasoningEffort === effort.id"
                          :style="{ '--i': `${k * 26}ms` }"
                          @click.stop="pickEffort(i, effort.id)" @mouseenter="ddActive = k"
                        >
                          <strong>{{ lang === 'en' ? effort.en : effort.zh }}</strong>
                        </li>
                      </ul>
                    </div>
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
            <span class="soft">{{ t('temperature=0 · 每项默认关闭思考；按行开启后可选择思考等级 · 留空的参数使用每项默认值', 'temperature=0 · thinking is off by default for every benchmark; enable it per row to choose an effort · blank fields use per-task defaults') }}</span>
          </div>
        </template>

        <!-- 运行队列：只显示正在运行的，日志常开、自动滚底 -->
        <template v-else-if="active === 'queue'">
          <p v-if="!runningRuns.length" class="soft">{{ t('当前没有正在运行的评测。', 'No runs are currently executing.') }}</p>
          <article v-for="r in runningRuns" :key="r.id" class="run-card is-running">
            <header>
              <strong>{{ r.name }}</strong>
              <span class="badge running">{{ statusText(r.status) }}</span>
              <button class="btn ghost danger" @click="cancelRun(r.id)">{{ t('中断', 'Stop') }}</button>
            </header>
            <div class="pbar"><i class="pbar-fill" :style="{ width: `${runPct(r)}%` }"></i></div>
            <p class="soft">
              {{ (r.models || []).join('、') }} · {{ t('进度', 'progress') }} {{ r.donePairs ?? 0 }}/{{ r.models.length * (r.tasks || []).length }} {{ t('项', 'items') }} · {{ elapsedMin(r) }}
              <template v-if="r.current"> — {{ r.current }}</template>
            </p>
            <div v-if="r.rows?.length" class="mini-table">
              <div v-for="(row, i) in r.rows" :key="i" class="mini-row" :style="{ '--i': `${i * 60}ms` }">
                <span>{{ row.model }}</span><span>{{ rowTaskName(row.task) }}</span><strong>{{ scoreOf(row) }}</strong>
                <small class="soft">{{ scoreDetail(row) }}</small>
              </div>
            </div>
            <pre class="log auto-scroll">{{ (r.log || []).join('\n') }}</pre>
          </article>
        </template>

        <!-- 历史记录 -->
        <template v-else-if="active === 'history'">
          <p v-if="!finishedRuns.length" class="soft">{{ t('暂无完成的结果。', 'No finished runs yet.') }}</p>
          <article v-for="(r, ri) in finishedRuns" :key="r.id" class="run-card" :data-run-id="r.id" :style="{ '--i': `${ri * 90}ms` }">
            <header>
              <strong>{{ nameWithNote(r) }}</strong>
              <span class="badge" :class="r.status">{{ statusText(r.status) }}</span>
              <span class="soft">{{ new Date(r.startedAt).toLocaleString() }}<template v-if="r.finishedAt"> · {{ durationText(r) }}</template></span>
              <span class="head-actions">
                <button class="btn act-btn" :class="{ danger: true }" @click="askDelete(r)">{{ t('删除', 'Delete') }}</button>
                <button class="btn act-btn rename-btn" :title="t('编辑名称与备注', 'Edit name and note')" @click="askRename(r)">{{ t('改名', 'Rename') }}</button>
                <button v-if="r.status !== 'done'" class="btn act-btn resume-btn" :title="t('从中断处继续：已完成的轮次和题目自动跳过', 'Resume: completed repeats and items are skipped')" @click="resumeRun(r)">{{ t('继续', 'Resume') }}</button>
                <button class="btn act-btn primary-ghost" :class="{ on: comparePicks.includes(r.id) }" @click="toggleCompare(r.id)">
                  {{ comparePicks.includes(r.id) ? t('已选入', 'Picked') : t('选入对比', 'Compare') }}
                </button>
              </span>
            </header>
            <table class="table">
              <thead><tr><th>{{ t('模型', 'Model') }}</th><th>{{ t('测试', 'Benchmark') }}</th><th>{{ t('得分', 'Score') }}</th><th>{{ t('明细', 'Detail') }}</th><th>{{ t('重复', 'Repeats') }}</th></tr></thead>
              <tbody>
                <tr v-for="(row, i) in r.rows" :key="i" :style="{ '--i': `${Math.min(i, 14) * 26}ms` }">
                  <td>{{ row.model }}</td>
                  <td>{{ rowTaskName(row.task) }}</td>
                  <td><strong>{{ scoreOf(row) }}</strong></td>
                  <td class="soft">{{ scoreDetail(row) }}</td>
                  <td>{{ row.repeat }}</td>
                </tr>
              </tbody>
            </table>
            <details @toggle="onHistoryLogToggle">
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
                <tr v-for="(task, ri) in compareRows" :key="task" :style="{ '--i': `${Math.min(ri, 16) * 34}ms` }">
                  <td class="c-run"><strong>{{ rowTaskName(task) }}</strong></td>
                  <td
                    v-for="(col, ci) in compareCols" :key="col.runId + col.model" class="cmp-cell"
                    :style="{ '--delay': `${Math.min(ri, 16) * 34 + ci * 28}ms` }"
                  >
                    <template v-if="compareCell(task, col)">
                      <div class="bar-meta">
                        <span class="cell-val" :class="{ 'is-best': isBest(task, col) }">{{ cellScore(task, col) }}</span>
                        <span v-if="isBest(task, col)" class="best-chip">{{ t('最优', 'BEST') }}</span>
                      </div>
                      <div class="bar-track">
                        <i
                          class="bar-fill" :class="{ 'is-best': isBest(task, col) }"
                          :style="{ width: barsReady ? barWidth(task, col) : '0%' }"
                        ></i>
                      </div>
                      <small class="soft">{{ compareCell(task, col)!.detail }}</small>
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
                  >{{ shortTask(rowTaskName(task)) }}</text>
                  <g v-for="(s, si) in radarActive" :key="s.key">
                    <polygon :points="radarPolygon(s.key)" class="series" :fill="radarColor(s.key)" :stroke="radarColor(s.key)" :style="{ '--i': `${si * 130}ms` }" />
                    <circle v-for="(p, i) in radarDots(s.key)" :key="i" :cx="p.x" :cy="p.y" r="3" :fill="radarColor(s.key)" :style="{ '--i': `${si * 130 + 380 + i * 42}ms` }" />
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
            <p>{{ t('统一采样口径：temperature=0、单次生成（pass@1）。新建评测中所有项目默认关闭思考（enable_thinking=false），可在项目行单独开启并选择 low / medium / high / xhigh；如需复现官方榜单口径，再按项目说明手动开启对应等级（通常为 xhigh，AIME 输出预算 38912，其余 32768）。代码与指令类判分只看思考后的正文。选择题只认明确的最终答案（最终答案：X / \boxed{X} / 末行选项字母），推理无结论计"未知"并保留在分母中，避免把截断的推理误判为错误。', 'Common sampling: temperature=0, single generation (pass@1). New runs disable thinking for every benchmark by default (enable_thinking=false); enable it per benchmark row and choose low / medium / high / xhigh. To reproduce an official leaderboard setup, turn on the level stated by that benchmark (usually xhigh; AIME budget 38,912 and the others 32,768). Code and instruction scoring reads only the post-thinking content. MCQ scoring accepts an explicit final answer only; reasoning without a conclusion counts as unknown and stays in the denominator, so truncated reasoning is not graded wrong.') }}</p>
          </div>
          <table class="table">
            <thead><tr><th>{{ t('协议', 'Protocol') }}</th><th>{{ t('能力', 'Ability') }}</th><th>{{ t('判分方式', 'Scoring') }}</th><th>{{ t('默认题数 / 全量', 'Default items / pool') }}</th></tr></thead>
            <tbody>
              <tr v-for="(task, i) in tasks" :key="task.id" :style="{ '--i': `${i * 32}ms` }">
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
            <div class="row">
              <label>{{ t('获取协议', 'Fetch protocol') }}</label>
              <div class="dd wide" :class="{ 'is-up': ddUp && ddOpen('protocol') }" @keydown="onDdKey($event, 'protocol', MODEL_PROTOCOLS.length, (k) => pickProtocol(MODEL_PROTOCOLS[k].id))">
                <button
                  class="dd-toggle input wide" type="button"
                  :class="{ 'is-open': ddOpen('protocol') }"
                  role="combobox" aria-haspopup="listbox" :aria-expanded="ddOpen('protocol')"
                  :aria-label="t('获取协议', 'Fetch protocol')"
                  @click.stop="ddToggle($event, 'protocol', curProtocolIndex())"
                >
                  <span class="dd-val">{{ protocolLabel(profile.protocol) }}</span>
                  <svg class="dd-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.2 4.8 6 7.6 8.8 4.8" /></svg>
                </button>
                <ul v-if="ddOpen('protocol')" class="dd-menu" role="listbox">
                  <li
                    v-for="(p, k) in MODEL_PROTOCOLS" :key="p.id" class="dd-opt flat" role="option"
                    :class="{ 'is-active': ddActive === k, 'is-picked': profile.protocol === p.id }"
                    :aria-selected="profile.protocol === p.id"
                    :style="{ '--i': `${k * 26}ms` }"
                    @click.stop="pickProtocol(p.id)" @mouseenter="ddActive = k"
                  >
                    <strong>{{ lang === 'en' ? p.label_en : p.label }}</strong>
                  </li>
                </ul>
              </div>
            </div>
            <div class="row"><label></label><label class="inline"><input v-model="profile.rememberKey" type="checkbox" /> {{ t('保存 Key（服务端配置）', 'Remember key (server-side config)') }}</label></div>
            <div class="actions">
              <button class="btn primary" @click="saveProfile">{{ t('保存并应用', 'Save & apply') }}</button>
              <button class="btn" :disabled="loadingModels" @click="fetchModels">{{ loadingModels ? t('获取中…', 'Fetching…') : t('重新获取模型', 'Refetch models') }}</button>
              <button class="btn" :disabled="!models.length" @click="showModels = true">
                {{ t('查看已获取模型', 'View fetched models') }}（{{ models.length }}）
              </button>
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

    <!-- 编辑名称 / 备注弹窗 -->
    <Transition name="fade">
      <div v-if="editingRun" class="modal-backdrop" @click.self="editingRun = null">
        <div class="modal" role="dialog" aria-modal="true" :aria-label="t('编辑名称与备注', 'Edit name and note')">
          <h3>{{ t('编辑名称与备注', 'Edit name and note') }}</h3>
          <div class="row">
            <label>{{ t('名称', 'Name') }}</label>
            <input ref="renameInput" v-model="editForm.name" class="input" type="text" />
          </div>
          <div class="row">
            <label>{{ t('备注', 'Note') }}</label>
            <input v-model="editForm.note" class="input" type="text" :placeholder="t('可选；显示在名称后的括号里', 'optional; shown in parentheses after the name')" />
          </div>
          <p class="soft">{{ t('Enter 保存，Esc 取消。', 'Enter saves, Esc cancels.') }}</p>
          <div class="modal-actions">
            <button class="btn" type="button" @click="editingRun = null">{{ t('取消', 'Cancel') }}</button>
            <button class="btn primary" type="button" @click="confirmRename">{{ t('保存', 'Save') }}</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 已获取模型列表弹窗 -->
    <Transition name="fade">
      <div v-if="showModels" class="modal-backdrop" @click.self="showModels = false">
        <div class="modal modal-wide" role="dialog" aria-modal="true" :aria-label="t('已获取的模型', 'Fetched models')">
          <h3>{{ t('已获取的模型', 'Fetched models') }}（{{ models.length }}）</h3>
          <ul class="model-list">
            <li v-for="(m, i) in models" :key="m.id" :style="{ '--i': `${i * 40}ms` }">
              <strong class="mono">{{ m.id }}</strong>
              <small v-if="m.name" class="soft">{{ m.name }}</small>
              <small v-if="m.description" class="soft"> — {{ m.description }}</small>
            </li>
          </ul>
          <div class="modal-actions">
            <button class="btn" type="button" @click="showModels = false">{{ t('关闭', 'Close') }}</button>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* ══ 布局骨架 ══════════════════════════════════════════════ */
.shell {
  display: grid;
  grid-template-columns: 252px 1fr;
  min-height: 100vh;
}

.sidenav {
  position: sticky; top: 0; height: 100vh; overflow: hidden auto;
  display: flex; flex-direction: column; gap: 24px;
  padding: 26px 18px 20px;
  background: var(--color-teal);
  border-right: 1px solid var(--color-line);
  transition: background var(--dur-3) var(--ease-expo), border-color var(--dur-3) var(--ease-expo);
}

/* 品牌 */
.brand { display: flex; align-items: center; gap: 11px; padding: 0 8px; }
.brand-mark {
  display: grid; place-items: center; flex: none;
  width: 38px; height: 38px; border-radius: var(--radius-md);
  background: var(--color-ink); color: var(--color-paper);
  font-family: var(--font-display); font-size: 19px;
  transition: transform var(--dur-2) var(--ease-spring), border-radius var(--dur-2) var(--ease-spring);
}
.brand:hover .brand-mark {
  transform: rotate(-4deg) scale(1.06);
  border-radius: var(--radius-sm) var(--radius-lg) var(--radius-sm) var(--radius-lg);
}
.brand-text { display: flex; flex-direction: column; line-height: 1.3; min-width: 0; }
.brand-text strong { font-family: var(--font-display); font-size: 15px; font-weight: 600; letter-spacing: .01em; }
.brand-text small { font-size: 10.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--color-ink-soft); }

/* 导航 */
.nav { position: relative; display: flex; flex-direction: column; gap: 1px; padding-left: 10px; }
.nav-indicator {
  position: absolute; left: 0; top: 0; width: 2px; height: 0; opacity: 0;
  border-radius: 2px; background: var(--accent); pointer-events: none;
  transition: transform var(--dur-3) var(--ease-expo), height var(--dur-3) var(--ease-expo), opacity var(--dur-2) var(--ease-expo);
}
.nav-item {
  position: relative; z-index: 1;
  text-align: left; padding: 9px 12px; border: 0; border-radius: var(--radius-sm);
  background: transparent; color: var(--color-ink-2); cursor: pointer;
  font: inherit; font-size: 13.5px; letter-spacing: .01em;
  transition: color var(--dur-1) var(--ease-expo), background var(--dur-1) var(--ease-expo), transform var(--dur-1) var(--ease-expo);
}
.nav-item:hover { background: var(--color-teal-hover); color: var(--color-ink); }
.nav-item:active { transform: scale(.985); }
.nav-item.active { background: var(--color-teal-active); color: var(--color-ink); font-family: var(--font-display); font-weight: 600; }

.sidenav-foot { margin-top: auto; display: flex; flex-direction: column; gap: 10px; padding: 0 8px; }
.sidenav-foot .lang-toggle {
  text-align: center; width: 100%; padding: 7px 12px; cursor: pointer;
  border: 1px solid var(--color-teal-line); border-radius: 99px;
  background: transparent; color: var(--color-ink-2);
  font-size: 11.5px; letter-spacing: .04em;
  transition: color var(--dur-1), border-color var(--dur-1), background var(--dur-1), transform var(--dur-1) var(--ease-spring);
}
.sidenav-foot .lang-toggle:hover { color: var(--color-ink); border-color: var(--color-ink-faint); background: var(--color-teal-hover); }
.sidenav-foot .lang-toggle:active { transform: scale(.97); }
.dot-row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--color-ink-soft); }

/* ══ 内容区 ════════════════════════════════════════════════ */
.content { padding: 40px 52px 90px; min-width: 0; }
.content > * { max-width: 1180px; }

.content-head { display: flex; align-items: baseline; gap: 16px; margin-bottom: 28px; }
.view-title {
  font-family: var(--font-display); font-size: 34px; font-weight: 500;
  line-height: 1.22; letter-spacing: -.01em; margin: 0;
}
/* 标题遮罩：切视图时整行从下方推上来（不是淡入） */
.tmask { display: block; overflow: hidden; padding-bottom: .06em; margin-bottom: -.06em; }
.tinner { display: block; animation: titleRise 620ms var(--ease-expo) both; }
@keyframes titleRise { from { transform: translateY(105%); } to { transform: none; } }

.notice {
  margin: 0; padding: 5px 12px; border-radius: 99px; font-size: 12.5px;
  animation: rise var(--dur-2) var(--ease-expo) backwards;
}
.notice.ok { background: var(--color-success-soft); color: var(--color-success); }
.notice.err { background: var(--color-coral-soft); color: var(--color-coral-strong); }
@keyframes rise { from { opacity: 0; transform: translateY(9px); } to { opacity: 1; transform: none; } }

/* ══ 通用容器 ══════════════════════════════════════════════ */
.card, .panel, .run-card {
  position: relative;
  background: var(--color-paper-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  padding: 18px 20px;
  transition: transform var(--dur-2) var(--ease-expo), box-shadow var(--dur-2) var(--ease-expo),
              border-color var(--dur-2) var(--ease-expo), background var(--dur-3) var(--ease-expo);
}
.card:hover { transform: translateY(-3px); box-shadow: var(--shadow-lift); border-color: var(--color-line-2); }
/* hover 时顶部从中间展开的一道强调线 */
.card::before, .panel::before, .run-card::before {
  content: ''; position: absolute; left: 0; right: 0; top: 0; height: 2px;
  background: var(--accent); border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  transform: scaleX(0); transform-origin: center; transition: transform var(--dur-3) var(--ease-expo);
}
.card:hover::before, .run-card:hover::before { transform: scaleX(1); }

.panel { margin-bottom: 14px; }
fieldset.panel { border: 1px solid var(--color-line); }
fieldset.panel legend {
  padding: 0 8px; color: var(--color-ink-soft);
  font-family: var(--font-display); font-size: 13px;
}
.card h3, .panel h3 {
  margin: 0 0 8px; font-family: var(--font-display); font-size: 15px;
  color: var(--color-ink-soft); font-weight: 600;
}
.card p { margin: 4px 0; }
.big-num {
  font-family: var(--font-display); font-size: 34px; line-height: 1.15;
  font-variant-numeric: tabular-nums; letter-spacing: -.02em; margin: 2px 0 !important;
}
.mono { font-family: var(--font-mono); font-size: 12px; letter-spacing: -.01em; }
.soft { color: var(--color-ink-soft); font-size: 12px; }

/* 总览卡片网格 */
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(232px, 1fr)); gap: 14px; }
.cards .card { animation: rise 560ms var(--ease-expo) backwards; animation-delay: var(--i, 0ms); }
.card .btn { margin-top: 12px; }

/* ══ 表单 ══════════════════════════════════════════════════ */
.head-row { display: flex; gap: 24px; flex-wrap: wrap; }
.head-row .row { flex: 1 1 280px; }
.row { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
.row > label { width: 90px; flex: none; color: var(--color-ink-soft); font-size: 13px; }
.row > label.inline { width: auto; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; cursor: pointer; }

.input {
  background: var(--color-paper); color: var(--color-ink);
  border: 1px solid var(--color-line); border-radius: var(--radius-sm);
  padding: 8px 12px; font: inherit; min-width: 0; outline: none;
  transition: border-color var(--dur-2) var(--ease-expo), box-shadow var(--dur-2) var(--ease-expo), background var(--dur-2);
}
.input:hover { border-color: var(--color-line-2); }
.input:focus { border-color: var(--accent); background: var(--color-paper-raised); box-shadow: 0 0 0 3px var(--accent-soft); }
.input.wide { width: 100%; }
.input.num { width: 100%; text-align: right; }
.input.num::placeholder, .input::placeholder { color: var(--color-ink-faint); }
select.input { appearance: none; cursor: pointer; padding-right: 30px; }
/* 模型/协议行内的下拉容器要吃掉剩余宽度 */
.row > .dd, .row-line .dd { flex: 1; min-width: 0; }

.rows-list { display: flex; flex-direction: column; gap: 10px; }
.row-line { display: flex; align-items: center; gap: 10px; animation: rise 420ms var(--ease-expo) backwards; animation-delay: var(--i, 0ms); }
.row-line .idx { width: 22px; text-align: right; color: var(--color-ink-soft); font-family: var(--font-mono); font-size: 12px; flex: none; }
.x {
  width: 30px; height: 30px; flex: none; border: 1px solid transparent; border-radius: var(--radius-sm);
  background: transparent; color: var(--color-ink-faint); cursor: pointer; font-size: 15px; line-height: 1;
  transition: color var(--dur-1), background var(--dur-1), transform var(--dur-1) var(--ease-spring), border-color var(--dur-1);
}
.x:hover { color: var(--color-danger); background: var(--color-teal-hover); border-color: var(--color-line); }
.x:active { transform: scale(.9); }
.add { align-self: flex-start; }

/* 测试项目表格
 * 注意：这里必须用 border-collapse: separate —— 之前为了圆角加的 overflow: hidden
 * 会把表格内绝对定位的下拉菜单整块裁掉（菜单一超出表格底边就消失）。
 * separate + border-spacing:0 同样能出圆角，且不做裁剪。 */
.task-table {
  width: 100%; border-collapse: separate; border-spacing: 0;
  border: 1px solid var(--color-line); border-radius: var(--radius-md);
}
.task-table thead th:first-child { border-top-left-radius: var(--radius-md); }
.task-table thead th:last-child { border-top-right-radius: var(--radius-md); }
.task-table tbody tr:last-child td { border-bottom: 0; }
.task-table th, .task-table td { padding: 8px 10px; text-align: left; vertical-align: middle; font-size: 13px; border-bottom: 1px solid var(--color-line); }
.task-table thead th { background: var(--color-teal-soft); color: var(--color-ink-soft); font-weight: 500; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; white-space: nowrap; }
.task-table tbody tr { animation: rise 420ms var(--ease-expo) backwards; animation-delay: var(--i, 0ms); }
.task-table .c-task { width: 30%; min-width: 220px; }
.task-table .c-thinking { width: 72px; text-align: center; }
.task-table .c-effort { width: 150px; }
.task-table .c-x { width: 36px; text-align: center; border: 0 !important; background: transparent; }
.task-table td .input { border-color: transparent; background: transparent; }
.task-table td .input:focus { background: var(--color-paper-raised); }

/* ══ 自定义下拉（模型 / 测试项目 / 思考等级 / 协议 共用一套） ══
 * 原生 <select> 的弹出面板由操作系统绘制，CSS 完全无法介入 —— 所以想要统一的
 * 圆角、主题和动效，只能换成这套自定义 combobox。 */
.dd { position: relative; }
/* 兜底保险：任何祖先一旦因 transform / opacity 意外形成层叠上下文，内部 z-index 就被困住，
   菜单只能按 DOM 顺序跟后面的卡片、按钮排队。展开时把下拉盒子和它所在的面板整体提上来。 */
.dd:has(.dd-menu) { z-index: 5; }
.panel:has(.dd-menu) { z-index: 20; }
.dd-toggle {
  display: flex; align-items: center; gap: 8px; width: 100%;
  text-align: left; cursor: pointer;
}
.dd-toggle:disabled { opacity: .45; cursor: not-allowed; }
.dd-val { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dd-toggle.is-empty .dd-val { color: var(--color-ink-faint); }
.dd-toggle.is-open { border-color: var(--accent); background: var(--color-paper-raised); box-shadow: 0 0 0 3px var(--accent-soft); }
/* 表格里的输入框默认透明无边框，下拉展开时要能盖回来 */
.task-table td .dd-toggle.is-open { border-color: var(--accent); background: var(--color-paper-raised); }

.dd-caret {
  width: 12px; height: 12px; flex: none;
  fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round;
  color: var(--color-ink-faint);
  transition: transform var(--dur-2) var(--ease-spring), color var(--dur-2);
}
.dd-toggle.is-open .dd-caret { transform: rotate(180deg); color: var(--accent); }

.dd-menu {
  position: absolute; z-index: 70; top: calc(100% + 6px); left: 0;
  min-width: 100%; width: max-content; max-width: 480px;
  margin: 0; padding: 6px; list-style: none;
  background: var(--color-paper-raised); border: 1px solid var(--color-line-2);
  border-radius: var(--radius-md); box-shadow: var(--shadow-pop); max-height: 320px; overflow: auto;
  overscroll-behavior: contain; scroll-behavior: smooth;
  transform-origin: top left;
  animation: ddIn 220ms var(--ease-expo) both;
}
/* 触发按钮离视口底部太近时向上翻转 */
.dd.is-up .dd-menu { top: auto; bottom: calc(100% + 6px); transform-origin: bottom left; }
.dd-menu.narrow { min-width: 100%; max-width: 200px; }
@keyframes ddIn { from { opacity: 0; transform: translateY(-6px) scale(.97); } to { opacity: 1; transform: none; } }

.dd-opt {
  position: relative; padding: 7px 10px 7px 13px; cursor: pointer;
  border-radius: var(--radius-sm);
  animation: rise 260ms var(--ease-expo) backwards; animation-delay: var(--i, 0ms);
  transition: background var(--dur-1), box-shadow var(--dur-1);
}
.dd-opt:hover, .dd-opt.is-active { background: var(--color-teal-soft); }
.dd-opt.is-active { box-shadow: inset 0 0 0 1px var(--color-line-2); }
.dd-opt.flat { padding-left: 10px; }
.dd-opt strong { display: block; font-size: 13px; font-weight: 500; }
.dd-opt small { display: block; color: var(--color-ink-soft); font-size: 11.5px; }
.dd-opt.is-picked::before {
  content: ''; position: absolute; left: 4px; top: 50%; translate: 0 -50%;
  width: 2px; height: 13px; border-radius: 2px; background: var(--accent);
}

/* ══ 按钮 ══════════════════════════════════════════════════ */
.btn {
  position: relative; overflow: hidden; isolation: isolate;
  border: 1px solid var(--color-line-2); background: var(--color-paper-raised); color: var(--color-ink);
  border-radius: var(--radius-sm); padding: 8px 16px; cursor: pointer; font: inherit; font-size: 13px;
  transition: transform var(--dur-1) var(--ease-spring), border-color var(--dur-1), box-shadow var(--dur-1), color var(--dur-1);
}
.btn::before {
  content: ''; position: absolute; inset: 0; z-index: -1;
  background: var(--color-teal-soft); transform: scaleX(0); transform-origin: left;
  transition: transform var(--dur-2) var(--ease-expo);
}
.btn:hover::before { transform: scaleX(1); }
.btn:hover { border-color: var(--color-ink-faint); }
.btn:active { transform: scale(.972); }
.btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--accent-soft); border-color: var(--accent); }
.btn:disabled { opacity: .45; cursor: default; transform: none; }
.btn:disabled::before { transform: scaleX(0); }

.btn.primary { background: var(--color-coral); border-color: var(--color-coral); color: #fff; font-weight: 500; }
.btn.primary::before { background: rgba(255, 255, 255, .16); }
.btn.primary:hover { border-color: var(--color-coral-strong); box-shadow: 0 4px 14px -4px var(--color-coral); }
.btn.ghost { background: transparent; border-color: transparent; color: var(--color-ink-2); }
.btn.ghost::before { background: var(--color-teal-soft); }
.btn.ghost:hover { color: var(--color-ink); }
.btn.ghost.danger { color: var(--color-danger); border-color: var(--color-line-2); }
.btn.ghost.danger:hover { border-color: var(--color-danger); background: transparent; }
.btn.on { border-color: var(--accent); color: var(--accent-strong); }

.actions { display: flex; align-items: center; gap: 14px; margin: 6px 0 24px; flex-wrap: wrap; }

/* 运行状态标签 */
.badge {
  border-radius: 999px; padding: 2px 10px; font-size: 11.5px;
  display: inline-flex; align-items: center; gap: 6px; flex: none;
  background: var(--color-teal-soft); color: var(--color-ink-2);
}
.badge.running { background: var(--color-coral-soft); color: var(--color-coral-strong); animation: soft-pulse 1.6s ease-in-out infinite; }
.badge.done { background: var(--color-success-soft); color: var(--color-success); }
.badge.error, .badge.crashed { background: var(--color-coral-soft); color: var(--color-danger); }

/* ══ 运行卡片 ══════════════════════════════════════════════ */
.run-card { margin-bottom: 16px; padding: 20px 22px; border-radius: var(--radius-xl); animation: rise 520ms var(--ease-expo) backwards; animation-delay: var(--i, 0ms); }
.run-card:hover { border-color: var(--color-line-2); box-shadow: var(--shadow-lift); }
.run-card header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
.run-card header strong { font-family: var(--font-display); font-size: 16px; font-weight: 600; }
.run-card.is-running { border-left: 2px solid var(--accent); }
header .btn { margin-left: auto; }

/* 进度条 */
.pbar { position: relative; height: 3px; border-radius: 99px; background: var(--color-teal-soft); overflow: hidden; margin: 12px 0 10px; }
.pbar-fill {
  position: absolute; inset: 0 auto 0 0; border-radius: 99px; background: var(--accent);
  transition: width 900ms var(--ease-expo);
}
.pbar-fill::after {
  content: ''; position: absolute; inset: 0; border-radius: 99px;
  background: linear-gradient(90deg, transparent, light-dark(rgba(255,255,255,.65), rgba(255,255,255,.18)), transparent);
  transform: translateX(-100%); animation: sheen 1.9s var(--ease-expo) infinite;
}
@keyframes sheen { to { transform: translateX(100%); } }

/* 运行时的小型结果格 */
.mini-table {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 1px; margin: 12px 0 0;
  background: var(--color-line); border: 1px solid var(--color-line); border-radius: var(--radius-md); overflow: hidden;
}
.mini-row {
  display: flex; flex-direction: column; gap: 2px;
  background: var(--color-paper-raised); padding: 10px 13px; font-size: 13px;
  transition: background var(--dur-1);
  animation: rise 480ms var(--ease-expo) backwards; animation-delay: var(--i, 0ms);
}
.mini-row:hover { background: var(--color-teal-soft); }
/* 重排顺序：题库名 → 分数 → 模型 → 明细 */
.mini-row > span:first-child { order: 3; font-size: 11px; color: var(--color-ink-faint); font-family: var(--font-mono); }
.mini-row > span:nth-child(2) { order: 1; font-size: 11.5px; color: var(--color-ink-soft); }
.mini-row > strong { order: 2; font-family: var(--font-display); font-variant-numeric: tabular-nums; font-size: 17px; }
.mini-row > small { order: 4; font-size: 11px; color: var(--color-ink-faint); font-family: var(--font-mono); }

/* ══ 表格 ══════════════════════════════════════════════════ */
.table { width: 100%; border-collapse: collapse; margin: 10px 0; }
.table th, .table td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--color-line); font-size: 13px; vertical-align: top; }
.table thead th { color: var(--color-ink-soft); font-weight: 500; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; white-space: nowrap; }
.table tbody tr { position: relative; transition: background var(--dur-1) var(--ease-expo); animation: rise 420ms var(--ease-expo) backwards; animation-delay: var(--i, 0ms); }
.table tbody tr:hover { background: var(--color-teal-soft); }
.table tbody tr:last-child td { border-bottom: 0; }
.table.compare th { border-bottom: 1px solid var(--color-line-2); }
.col-task { display: block; font-weight: 600; color: var(--color-ink); }
.col-model { display: block; font-family: var(--font-mono); font-size: 11px; }
.c-run { white-space: nowrap; }

/* 对比单元格：数值 + 条形 + 最优标记 */
.cmp-cell { min-width: 150px; }
.bar-meta { display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px; }
.cell-val { font-family: var(--font-display); font-variant-numeric: tabular-nums; font-size: 14px; }
.cell-val.is-best { color: var(--accent-strong); }
.best-chip { font-size: 9.5px; letter-spacing: .1em; color: var(--accent-strong); animation: rise var(--dur-2) var(--ease-expo) backwards; }
.bar-track { position: relative; height: 4px; border-radius: 99px; background: var(--color-teal-soft); overflow: hidden; }
.bar-fill {
  position: absolute; inset: 0 auto 0 0; width: 0; border-radius: 99px; background: var(--color-ink-faint);
  transition: width var(--dur-4) var(--ease-expo) var(--delay, 0ms), background var(--dur-2);
}
.bar-fill.is-best { background: var(--accent); }

/* 日志 */
details { margin-top: 10px; }
summary {
  cursor: pointer; color: var(--color-ink-soft); font-size: 12px;
  display: flex; align-items: center; gap: 7px; padding: 8px 0; list-style: none;
  transition: color var(--dur-1);
}
summary::-webkit-details-marker { display: none; }
summary::before {
  content: ''; width: 5px; height: 5px; flex: none;
  border-right: 1.4px solid currentColor; border-bottom: 1.4px solid currentColor;
  transform: rotate(-45deg); transition: transform var(--dur-2) var(--ease-spring);
}
details[open] summary::before { transform: rotate(45deg); }
summary:hover { color: var(--color-ink); }
.log {
  margin-top: 8px; max-height: 320px; overflow: auto; background: var(--color-paper);
  border: 1px solid var(--color-line); border-radius: var(--radius-md);
  padding: 12px 14px; font-family: var(--font-mono); font-size: 11.5px; line-height: 1.75; white-space: pre-wrap;
  animation: rise var(--dur-3) var(--ease-expo) backwards;
}
.run-card .log { max-height: 420px; }

/* 状态点 */
.dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; flex: none; position: relative; }
.dot.big { width: 7px; height: 7px; }
.dot.ok { background: var(--color-success); }
.dot.bad { background: var(--color-danger); }
.dot.busy { background: var(--accent); animation: soft-pulse 1.1s ease-in-out infinite; }
.dot-row .dot.ok::after {
  content: ''; position: absolute; inset: -4px; border-radius: 99px;
  border: 1px solid var(--color-success); opacity: 0; animation: halo 2.4s var(--ease-expo) infinite;
}
@keyframes halo { 0% { transform: scale(.6); opacity: .7; } 70%, 100% { transform: scale(1.3); opacity: 0; } }

/* 历史卡片操作按钮 */
.head-actions { margin-left: auto; display: flex; gap: 8px; flex: none; }
.act-btn { width: 88px; text-align: center; padding: 7px 0; }
.act-btn.danger { color: var(--color-danger); border-color: var(--color-line-2); background: transparent; }
.act-btn.danger:hover { border-color: var(--color-danger); }
.act-btn.primary-ghost { color: var(--color-ink-2); border-color: var(--color-line-2); background: transparent; }
.act-btn.primary-ghost.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.act-btn.rename-btn { color: var(--color-ink-soft); }

/* ══ 弹窗 ══════════════════════════════════════════════════ */
.modal-backdrop {
  position: fixed; inset: 0; z-index: 90;
  background: color-mix(in srgb, var(--color-ink) 32%, transparent);
  backdrop-filter: blur(7px) saturate(.9); -webkit-backdrop-filter: blur(7px) saturate(.9);
  display: grid; place-items: center;
}
.modal {
  width: min(430px, 92vw); max-height: 86vh; overflow: auto;
  background: var(--color-paper-raised); color: var(--color-ink);
  border: 1px solid var(--color-line); border-radius: var(--radius-xl);
  box-shadow: var(--shadow-pop); padding: 24px 26px 22px;
  animation: modalIn 380ms var(--ease-spring) both;
}
@keyframes modalIn { from { opacity: 0; transform: translateY(10px) scale(.955); } to { opacity: 1; transform: none; } }
.modal h3 { margin: 0 0 8px; font-family: var(--font-display); font-size: 18px; }
.modal-name { font-family: var(--font-display); margin: 4px 0; font-weight: 600; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
.modal-wide { width: min(560px, 92vw); }
.model-list { margin: 10px 0 0; padding: 0; list-style: none; max-height: 50vh; overflow: auto; }
.model-list li { padding: 9px 4px; border-bottom: 1px solid var(--color-line); animation: rise 320ms var(--ease-expo) backwards; animation-delay: var(--i, 0ms); }
.model-list li:last-child { border-bottom: 0; }
.model-list strong { font-size: 12.5px; }
.model-list small { margin-left: 8px; }
.danger-solid { background: var(--color-danger) !important; border-color: var(--color-danger) !important; color: #fff !important; }
.danger-solid:hover { filter: brightness(1.08); }

/* ══ Toast ═════════════════════════════════════════════════ */
.toast-stack { position: fixed; top: 20px; right: 20px; z-index: 100; display: flex; flex-direction: column; gap: 10px; width: min(356px, 92vw); }
.toast {
  position: relative; overflow: hidden;
  display: flex; align-items: center; gap: 10px; padding: 12px 12px 13px 15px; cursor: pointer;
  background: var(--color-paper-raised); border: 1px solid var(--color-line);
  border-radius: var(--radius-md); box-shadow: var(--shadow-pop);
}
.toast::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--accent); }
.toast-body { flex: 1; min-width: 0; }
.toast-body strong { display: block; font-family: var(--font-display); font-size: 13.5px; font-weight: 600; }
.toast-body small { color: var(--color-ink-soft); font-size: 11.5px; }
.toast-x {
  flex: none; width: 22px; height: 22px; border: 0; border-radius: 50%; background: transparent;
  color: var(--color-ink-faint); font-size: 15px; line-height: 1; cursor: pointer;
  transition: color var(--dur-1), background var(--dur-1), transform var(--dur-1) var(--ease-spring);
}
.toast-x:hover { color: var(--color-danger); background: var(--color-teal-soft); }
.toast-x:active { transform: scale(.9); }
.toast-enter-active, .toast-leave-active, .toast-move { transition: all 300ms var(--ease-expo); }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(28px) scale(.96); }

/* ══ 雷达图 ════════════════════════════════════════════════ */
.radar-panel { margin-top: 16px; padding: 20px 22px; }
.radar-legend { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 6px; }
.legend-chip {
  display: inline-flex; align-items: center; gap: 8px; padding: 6px 13px; max-width: 100%;
  border: 1px solid var(--color-line); border-radius: 999px; background: transparent;
  color: var(--color-ink-2); font-size: 12px; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: color var(--dur-2), border-color var(--dur-2), background var(--dur-2), transform var(--dur-1) var(--ease-spring);
}
.legend-chip .chip-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; opacity: .3; transition: opacity var(--dur-2), transform var(--dur-2) var(--ease-spring); }
.legend-chip:hover { transform: translateY(-1px); border-color: var(--color-line-2); }
.legend-chip:active { transform: scale(.97); }
.legend-chip.on { color: var(--color-ink); background: var(--color-paper-raised); }
.legend-chip.on .chip-dot { opacity: 1; transform: scale(1.15); }
.radar-wrap { max-width: 520px; margin: 4px auto 0; }
.radar-wrap svg { width: 100%; height: auto; display: block; overflow: visible; }
.ring { fill: none; stroke: var(--color-line); stroke-width: 1; animation: fadeIn 500ms var(--ease-expo) both; }
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.axis { stroke: var(--color-line); stroke-width: 1; stroke-dasharray: 200; stroke-dashoffset: 200; animation: dashDraw 700ms var(--ease-expo) both; }
@keyframes dashDraw { to { stroke-dashoffset: 0; } }
.axis-label { fill: var(--color-ink-soft); font-size: 10.5px; opacity: 0; animation: fadeIn 500ms var(--ease-expo) forwards; animation-delay: 300ms; }
.series {
  fill-opacity: .11; stroke-width: 1.8; stroke-linejoin: round;
  transform-box: fill-box; transform-origin: center;
  animation: seriesIn 780ms var(--ease-expo) both; animation-delay: var(--i, 0ms);
}
@keyframes seriesIn { from { opacity: 0; transform: scale(.28); } to { opacity: 1; transform: none; } }
.radar-wrap circle { animation: dotPop 460ms var(--ease-spring) both; animation-delay: var(--i, 0ms); }
@keyframes dotPop { from { opacity: 0; r: 0; } to { opacity: 1; r: 3; } }
.radar-note { text-align: center; margin: 10px 0 0; font-size: 11.5px; }

/* ══ 视图切换 ══════════════════════════════════════════════ */
.view-enter-active { transition: opacity var(--dur-3) var(--ease-expo), transform var(--dur-3) var(--ease-expo), filter var(--dur-3) var(--ease-expo); }
.view-leave-active { transition: opacity 130ms var(--ease-expo), transform 130ms var(--ease-expo), filter 130ms var(--ease-expo); }
.view-enter-from { opacity: 0; transform: translateY(12px) scale(.994); filter: blur(3px); }
.view-leave-to { opacity: 0; transform: translateY(-6px) scale(.996); filter: blur(2px); }

.fade-enter-active, .fade-leave-active { transition: opacity 200ms var(--ease-expo); }
.fade-enter-from, .fade-leave-to { opacity: 0; }

@keyframes soft-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .45; }
}

@media (max-width: 860px) {
  .shell { grid-template-columns: 1fr; }
  .sidenav { position: static; height: auto; }
  .content { padding: 26px 22px 60px; }
}

@media (prefers-reduced-motion: reduce) {
  .card, .panel, .run-card, .btn, .nav-item, .nav-indicator { transition: none; }
}
</style>
