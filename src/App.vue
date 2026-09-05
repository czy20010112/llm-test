<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

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
const runs = ref<any[]>([]); // all runs, newest first (queue view)
const results = ref<any[]>([]); // finished runs
const notice = ref<{ kind: 'ok' | 'err'; text: string } | null>(null);

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
  try {
    runs.value = await api('/api/runs');
    results.value = runs.value.filter((r) => r.status !== 'running');
  } catch { /* keep last */ }
}
async function fetchModels() {
  loadingModels.value = true;
  try {
    const body = await api('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: cfg.value.endpoint, key: cfg.value.key }),
    });
    models.value = (body.data || []).map((m: any) => m.id);
    flash('ok', `已获取 ${models.value.length} 个模型`);
  } catch (e: any) {
    models.value = [];
    flash('err', '获取模型失败：' + e.message);
  } finally {
    loadingModels.value = false;
  }
}

let timer: number | undefined;
onMounted(async () => {
  await Promise.all([refreshPreflight(), refreshTasks(), refreshRuns()]);
  timer = window.setInterval(refreshRuns, 2000);
});
onBeforeUnmount(() => window.clearInterval(timer));

// ---------- 新建评测 ----------
const loadingModels = ref(false);
const form = ref({
  name: '本地模型评测',
  note: '',
  models: [] as string[],
  tasks: [] as string[],
  repeats: 1,
  concurrency: 1,
  limit: 0,
  maxTokens: 4096,
});
const judgeKinds = ['humanevalplus', 'mbppplus', 'livecodebench', 'ds1000'];

function toggle(list: string[], v: string) {
  const i = list.indexOf(v);
  if (i >= 0) list.splice(i, 1); else list.push(v);
}

async function submitRun() {
  if (!form.value.models.length || !form.value.tasks.length) {
    flash('err', '请至少选择一个模型和一个测试项目');
    return;
  }
  try {
    const body: any = { ...form.value };
    if (body.limit <= 0) delete body.limit; // 0 = 使用每个测试的默认题数
    await api('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    flash('ok', '评测已加入运行队列');
    select('queue');
    refreshRuns();
  } catch (e: any) {
    flash('err', e.message);
  }
}

async function cancelRun(id: string) {
  try {
    await api(`/api/runs/${id}`, { method: 'DELETE' });
    flash('ok', '已请求中断');
    refreshRuns();
  } catch (e: any) { flash('err', e.message); }
}

function statusText(s: string) {
  return ({ running: '运行中', done: '已完成', error: '有错误', partial: '已中断', crashed: '崩溃' } as Record<string, string>)[s] || s;
}

// ---------- 历史记录 ----------
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

// ---------- 对比分析 ----------
const comparePicks = ref<string[]>([]);
const compareTable = computed(() => {
  const picked = results.value.filter((r) => comparePicks.value.includes(r.id));
  const rows = new Map<string, any>();
  for (const run of picked) {
    for (const row of run.rows || []) {
      const key = row.task;
      if (!rows.has(key)) rows.set(key, { task: key, ability: row.ability, cells: [] });
      rows.get(key).cells.push({ run: run.name || run.id, model: row.model, score: row.average?.score, detail: scoreDetail(row) });
    }
  }
  return [...rows.values()];
});

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
      <section class="view-body" :data-view="active">

        <!-- 总览 -->
        <template v-if="active === 'overview'">
          <div class="cards">
            <div class="card">
              <h3>推理服务</h3>
              <p class="mono">{{ cfg.endpoint }}</p>
              <p>{{ models.length ? `${models.length} 个模型可测` : '尚未获取模型列表' }}</p>
              <button class="btn" @click="fetchModels(); select('new')">开始评测</button>
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
              <h3>最近运行</h3>
              <p class="big-num">{{ runs.length }}</p>
              <p>{{ runs.filter(r => r.status === 'running').length }} 个运行中</p>
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
          <div class="panel">
            <div class="row">
              <label>结果名称</label>
              <input v-model="form.name" type="text" placeholder="例如：Qwen3.8 Q8 vs Q6K" />
            </div>
            <div class="row">
              <label>备注</label>
              <input v-model="form.note" type="text" placeholder="可选" />
            </div>
            <div class="row">
              <label>推理端点</label>
              <div class="grow">
                <input v-model="cfg.endpoint" type="text" />
                <button class="btn ghost" :disabled="loadingModels" @click="fetchModels">{{ loadingModels ? '获取中…' : '获取模型' }}</button>
              </div>
            </div>
          </div>

          <fieldset class="panel">
            <legend>模型（多选，按选择顺序执行）</legend>
            <p v-if="!models.length" class="soft">先点击"获取模型"。</p>
            <div class="chips">
              <button
                v-for="m in models" :key="m" type="button" class="chip"
                :class="{ on: form.models.includes(m) }"
                @click="toggle(form.models, m)"
              >{{ m }}</button>
            </div>
          </fieldset>

          <fieldset class="panel">
            <legend>测试项目</legend>
            <div class="task-grid">
              <label v-for="t in tasks" :key="t.id" class="task-card" :class="{ on: form.tasks.includes(t.id) }">
                <input type="checkbox" :checked="form.tasks.includes(t.id)" @change="toggle(form.tasks, t.id)" />
                <div>
                  <strong>{{ t.name }}</strong>
                  <small>{{ t.ability }}</small>
                  <small v-if="t.defaultLimit" class="soft">默认题数 {{ t.defaultLimit }}</small>
                  <small v-if="judgeKinds.includes(t.kind)" class="warn">需要判题沙箱</small>
                </div>
              </label>
            </div>
          </fieldset>

          <div class="panel params">
            <div class="row"><label>重复次数</label><input v-model.number="form.repeats" type="number" min="1" max="20" /></div>
            <div class="row"><label>并发请求</label><input v-model.number="form.concurrency" type="number" min="1" max="16" /></div>
            <div class="row"><label>题数上限</label><input v-model.number="form.limit" type="number" min="0" placeholder="0 = 用默认题数" /></div>
            <div class="row"><label>max_tokens</label><input v-model.number="form.maxTokens" type="number" min="256" max="8192" /></div>
          </div>

          <div class="actions">
            <button class="btn primary" @click="submitRun">开始评测</button>
            <span class="soft">temperature=0 · 抑制思维链 · 代码题由沙箱判分</span>
          </div>
        </template>

        <!-- 运行队列 -->
        <template v-else-if="active === 'queue'">
          <p v-if="!runs.length" class="soft">暂无运行。</p>
          <article v-for="r in runs" :key="r.id" class="run-card">
            <header>
              <strong>{{ r.name }}</strong>
              <span class="badge" :class="r.status">{{ statusText(r.status) }}</span>
              <button v-if="r.status === 'running'" class="btn ghost danger" @click="cancelRun(r.id)">中断</button>
            </header>
            <p class="soft">
              {{ r.models.join('、') }} · {{ r.tasks.length }} 项测试 · 进度 {{ (r.progress?.modelIndex || 0) + 1 }}/{{ r.models.length }}
              <template v-if="r.current"> — {{ r.current }}</template>
            </p>
            <div v-if="r.rows?.length" class="mini-table">
              <div v-for="(row, i) in r.rows" :key="i" class="mini-row">
                <span>{{ row.model }}</span><span>{{ row.task }}</span><strong>{{ scoreOf(row) }}</strong>
                <small class="soft">{{ scoreDetail(row) }}</small>
              </div>
            </div>
            <details>
              <summary>运行日志（{{ r.log.length }}）</summary>
              <pre class="log">{{ r.log.slice(-40).join('\n') }}</pre>
            </details>
          </article>
        </template>

        <!-- 历史记录 -->
        <template v-else-if="active === 'history'">
          <p v-if="!results.length" class="soft">暂无完成的结果。</p>
          <article v-for="r in results" :key="r.id" class="run-card">
            <header>
              <strong>{{ r.name }}</strong>
              <span class="badge" :class="r.status">{{ statusText(r.status) }}</span>
              <span class="soft">{{ new Date(r.startedAt).toLocaleString() }}</span>
              <button class="btn ghost" :class="{ on: comparePicks.includes(r.id) }" @click="toggle(comparePicks, r.id)">
                {{ comparePicks.includes(r.id) ? '已选入对比' : '选入对比' }}
              </button>
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
              <summary>逐题日志</summary>
              <pre class="log">{{ (r.rows[0]?.log || []).join('\n') }}</pre>
            </details>
          </article>
        </template>

        <!-- 对比分析 -->
        <template v-else-if="active === 'compare'">
          <p v-if="!comparePicks.length" class="soft">在"历史记录"中把若干次运行"选入对比"，这里会按测试项目并排列出得分。</p>
          <table v-else class="table">
            <thead>
              <tr><th>测试项目</th><th v-for="id in comparePicks" :key="id">{{ results.find(r => r.id === id)?.name || id }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in compareTable" :key="row.task">
                <td>{{ row.task }}<br /><small class="soft">{{ row.ability }}</small></td>
                <td v-for="(c, i) in row.cells" :key="i">
                  <strong>{{ c.score != null ? (c.score * 100).toFixed(1) + '%' : '—' }}</strong>
                  <br /><small class="soft">{{ c.detail }}</small>
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
            <div class="row"><label>API 端点</label><input v-model="profile.endpoint" type="text" /></div>
            <div class="row"><label>API Key</label><input v-model="profile.key" type="password" placeholder="本地服务通常留空" /></div>
            <div class="row"><label></label><label class="inline"><input v-model="profile.rememberKey" type="checkbox" /> 保存 Key（服务端配置）</label></div>
            <div class="actions">
              <button class="btn primary" @click="saveProfile">保存并应用</button>
              <button class="btn" @click="fetchModels">重新获取模型</button>
            </div>
          </div>
          <div class="panel">
            <h3>环境自检</h3>
            <pre class="log">{{ JSON.stringify(preflight, null, 2) }}</pre>
          </div>
        </template>
      </section>
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 232px 1fr;
  min-height: 100vh;
}

.sidenav {
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
.card h3, .panel h3 { margin: 0 0 8px; font-size: 14px; color: var(--color-ink-soft); font-weight: 700; }
.card p { margin: 4px 0; }
.big-num { font-family: var(--font-display); font-size: 30px; margin: 2px 0 !important; }
.mono { font-family: var(--font-mono); font-size: 12px; }
.soft { color: var(--color-ink-soft); font-size: 12px; }
.warn { color: var(--color-warn); font-size: 12px; display: block; }

.row { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
.row > label { width: 90px; flex: none; color: var(--color-ink-soft); font-size: 13px; }
.grow { display: flex; gap: 8px; flex: 1; }
.grow input { flex: 1; }

input[type='text'], input[type='password'], input[type='number'] {
  background: var(--color-paper); color: var(--color-ink);
  border: 1px solid var(--color-line); border-radius: var(--radius-sm);
  padding: 7px 10px; font: inherit; min-width: 0;
}
input:focus { outline: 2px solid var(--color-teal-line); outline-offset: 1px; }

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

.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip {
  border: 1px solid var(--color-line); background: var(--color-paper); color: var(--color-ink);
  border-radius: 999px; padding: 5px 12px; cursor: pointer; font: inherit; font-size: 13px;
}
.chip.on { background: var(--color-teal); color: var(--color-teal-on); border-color: var(--color-teal); }

.task-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
.task-card {
  display: flex; gap: 10px; padding: 10px 12px; border: 1px solid var(--color-line);
  border-radius: var(--radius-sm); cursor: pointer; background: var(--color-paper);
}
.task-card.on { border-color: var(--color-teal); outline: 1px solid var(--color-teal); background: var(--color-teal-soft); }
.task-card strong { display: block; font-size: 13px; }
.task-card small { display: block; color: var(--color-ink-soft); }

.params { display: flex; flex-wrap: wrap; gap: 0 24px; }
.params .row { flex: 1 1 200px; }
.inline { display: flex; align-items: center; gap: 6px; color: var(--color-ink-soft); font-size: 13px; }
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

details { margin-top: 6px; }
summary { cursor: pointer; color: var(--color-ink-soft); font-size: 13px; }
.log {
  max-height: 320px; overflow: auto; background: var(--color-paper);
  border: 1px solid var(--color-line); border-radius: var(--radius-sm);
  padding: 10px; font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap;
}

.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.dot.big { width: 12px; height: 12px; }
.dot.ok { background: var(--color-success); }
.dot.bad { background: var(--color-danger); }
</style>
