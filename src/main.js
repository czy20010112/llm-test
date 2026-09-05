import { createApp, ref, onMounted, computed } from 'vue';
import './style.css';

const api = async (url, options) => {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
};

const App = {
  setup() {
    const page = ref('results');
    const tasks = ref([]);
    const results = ref([]);
    const models = ref([]);
    const activeRuns = ref([]);
    const comparisons = ref([]);
    const selectedRecords = ref([]);
    const comparisonName = ref('');
    const comparisonAliases = ref({});
    const loading = ref(false);
    const modelToAdd = ref('');
    const cfg = ref(JSON.parse(localStorage.getItem('llmCfg') || '{"endpoint":"http://127.0.0.1:9292/v1","key":""}'));
    const form = ref({ name: '本地模型评测', note: '', mode: 'exploration', models: [], selected: [], repeats: 1, concurrency: 1, limit: 10, category: 'all', difficulty: 'all', contextTarget: 8192, seed: 42 });
    const theme = ref(localStorage.getItem('theme') || 'system');
    const active = computed(() => activeRuns.value.length > 0);
    const recordOptions = computed(() => results.value.flatMap((run) => (run.rows || []).map((row, index) => ({ id: `${run.id}:${index}`, runId: run.id, model: row.model, task: row.task, ability: row.ability, average: row.average, status: run.status, label: `${row.model} · ${row.task}` }))));

    function applyTheme() { document.documentElement.dataset.theme = theme.value; localStorage.setItem('theme', theme.value); }
    function formatMetric(average) {
      if (!average) return '-';
      if (average.score !== undefined) return `${(Number(average.score) * 100).toFixed(1)}% · ${average.correct || 0}/${average.total || 0}${average.unknown ? ` · 未知 ${average.unknown}` : ''}`;
      return average.tokPerSec !== undefined ? `${Number(average.tokPerSec).toFixed(1)} tok/s` : '-';
    }
    async function load() {
      tasks.value = await api('/api/tasks');
      results.value = await api('/api/results');
      comparisons.value = await api('/api/comparisons').catch(() => []);
      const profileData = await api('/api/profiles').catch(() => ({ profiles: [], models: [] }));
      if (profileData.profiles?.[0]) cfg.value = { ...cfg.value, ...profileData.profiles[0] };
      if (profileData.models?.length && !models.value.length) models.value = profileData.models;
    }
    async function getModels() {
      loading.value = true;
      localStorage.setItem('llmCfg', JSON.stringify(cfg.value));
      try {
        const payload = await api('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg.value) });
        models.value = payload.data || [];
        await api('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cfg.value, models: models.value }) });
      } catch (error) { alert(error.message); } finally { loading.value = false; }
    }
    function addModel() { if (modelToAdd.value && !form.value.models.includes(modelToAdd.value)) form.value.models.push(modelToAdd.value); modelToAdd.value = ''; }
    function removeModel(index) { form.value.models.splice(index, 1); }
    async function start() {
      if (!form.value.models.length || !form.value.selected.length) return alert('请选择模型和测试项目');
      try {
        const payload = await api('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form.value, tasks: form.value.selected, endpoint: cfg.value.endpoint, key: cfg.value.key }) });
        activeRuns.value = [{ id: payload.id, name: form.value.name, status: 'running', log: [] }];
        localStorage.setItem('activeRunId', payload.id);
        page.value = 'running';
        poll(payload.id);
      } catch (error) { alert(error.message); }
    }
    async function poll(id) {
      const payload = await api(`/api/runs/${id}`).catch(() => null);
      const run = activeRuns.value.find((item) => item.id === id);
      if (run && payload) Object.assign(run, payload);
      if (payload?.status === 'running') setTimeout(() => poll(id), 700);
      else if (payload) { activeRuns.value = activeRuns.value.filter((item) => item.id !== id); localStorage.removeItem('activeRunId'); await load(); page.value = 'results'; }
    }
    async function cancelRun(id = activeRuns.value[0]?.id) { if (id) await fetch(`/api/runs/${id}`, { method: 'DELETE' }); }
    function beginComparison() {
      if (selectedRecords.value.length < 2) return alert('请先选择至少两条运行记录');
      comparisonName.value = `对比 · ${new Date().toLocaleDateString()}`;
      comparisonAliases.value = Object.fromEntries(selectedRecords.value.map((id) => { const record = recordOptions.value.find((item) => item.id === id); return [id, record?.label || id]; }));
      page.value = 'compare';
    }
    function openSavedComparison(comparison) {
      const records = (comparison.records || []).filter((record) => recordOptions.value.some((item) => item.id === record.id));
      if (records.length < 2) return alert('该对比引用的历史记录已不在当前结果集中');
      selectedRecords.value = records.map((record) => record.id);
      comparisonName.value = comparison.name || '';
      comparisonAliases.value = Object.fromEntries(records.map((record) => [record.id, record.alias || record.id]));
      page.value = 'compare';
    }
    async function saveComparison() {
      if (!comparisonName.value.trim() || selectedRecords.value.length < 2) return alert('请填写对比名称并选择至少两条记录');
      const records = selectedRecords.value.map((id) => { const record = recordOptions.value.find((item) => item.id === id); return { id, runId: record?.runId, model: record?.model, task: record?.task, ability: record?.ability, average: record?.average, alias: comparisonAliases.value[id] || record?.label || id }; });
      const saved = await api('/api/comparisons', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: comparisonName.value.trim(), records }) });
      comparisons.value.push(saved);
      page.value = 'results';
    }
    onMounted(async () => { applyTheme(); await load(); if (!models.value.length) getModels(); const id = localStorage.getItem('activeRunId'); if (id) { const run = await api(`/api/runs/${id}`).catch(() => null); if (run?.status === 'running') { activeRuns.value = [run]; page.value = 'running'; poll(id); } } });

    return { page, tasks, results, models, activeRuns, comparisons, selectedRecords, comparisonName, comparisonAliases, recordOptions, loading, modelToAdd, cfg, form, theme, active, formatMetric, applyTheme, getModels, addModel, removeModel, start, cancelRun, beginComparison, openSavedComparison, saveComparison };
  },
  template: `<div class="shell"><aside class="side"><div class="brand"><span></span>模型测评台</div><nav aria-label="主导航"><button :class="{active:page==='results'}" @click="page='results'">结果总览</button><button :class="{active:page==='new'}" @click="page='new'">添加测试任务</button><button :class="{active:page==='compare'}" @click="page='compare'">对比工作区</button><button :class="{active:page==='config'}" @click="page='config'">连接设置</button></nav><div class="side-foot">本地运行 · 记录自动保存</div></aside><main class="main"><section v-if="page==='results'"><div class="top"><div><div class="eyebrow">Evaluation desk</div><h1>结果总览</h1></div><div class="actions"><button class="btn" :disabled="selectedRecords.length<2" @click="beginComparison">对比已选 {{selectedRecords.length}}</button><button class="btn orange" @click="page='new'">＋ 新建测试</button></div></div><div v-if="active" class="live-panel"><b>实时进展</b><button class="btn small" @click="cancelRun()">中止</button><div v-for="run in activeRuns" :key="run.id"><strong>{{run.name}}</strong><span class="meta">{{run.current}}</span><pre>{{(run.log||[]).join('\\n')}}</pre></div></div><div v-if="!results.length" class="empty">还没有测试结果。<button class="btn" @click="page='new'">创建第一个测试</button></div><details class="result" v-for="run in results" :key="run.id" open><summary><strong>{{run.name}}</strong><span class="meta">{{run.status==='partial'?'部分完成':run.status}} · {{run.finishedAt ? new Date(run.finishedAt).toLocaleString() : ''}}</span></summary><table><thead><tr><th></th><th>模型 / 记录</th><th>测试项目</th><th>能力</th><th>平均结果</th></tr></thead><tbody><tr v-for="(row,index) in run.rows" :key="index"><td><input type="checkbox" :value="run.id + ':' + index" v-model="selectedRecords" aria-label="选择运行记录"></td><td>{{row.model}}<small class="meta block">{{run.note || '对比时可添加别名'}}</small></td><td>{{row.task}}</td><td>{{row.ability}}</td><td>{{formatMetric(row.average)}}</td></tr></tbody></table><details class="log-view"><summary>查看完整日志（{{run.log?.length || 0}} 条）</summary><pre>{{(run.log||[]).join('\\n')}}</pre></details></details><div v-if="comparisons.length" class="saved-comparisons"><h2>已保存的对比</h2><button v-for="comparison in comparisons" :key="comparison.id" class="comparison-item" @click="openSavedComparison(comparison)"><strong>{{comparison.name}}</strong><span class="meta">{{comparison.records?.length||0}} 条记录</span></button></div></section><section v-else-if="page==='new'"><div class="top"><h1>添加测试任务</h1></div><div class="panel"><label>评测模式<select v-model="form.mode"><option value="standard">标准评测（固定口径）</option><option value="exploration">探索测试（可调参数）</option></select></label><p class="hint" v-if="form.mode==='standard'">标准评测锁定数据版本、提示词、采样和评分规则，仅允许选择题量用于快速预览。</p><label>结果名称<input v-model="form.name"></label><label>备注（量化 / KV / 上下文）<textarea v-model="form.note"></textarea></label><label>模型队列<select v-model="modelToAdd"><option value="">选择模型</option><option v-for="model in models" :key="model.id" :value="model.id">{{model.id}}</option></select><button class="btn" @click="addModel">加入</button></label><div class="chips"><span v-for="(model,index) in form.models" :key="model">{{index+1}}. {{model}} <button @click="removeModel(index)" aria-label="移除模型">×</button></span></div><label>题库数量<input type="number" min="1" v-model.number="form.limit"></label><template v-if="form.mode==='exploration'"><label>上下文深度目标<input type="number" min="1024" max="262000" v-model.number="form.contextTarget"></label><label>类别<select v-model="form.category"><option value="all">全部类别</option><option value="data">数据处理</option><option value="code">代码编写</option><option value="troubleshooting">电脑问题排查</option><option value="agent">日常 Agent</option><option value="ctf">CTF / 红蓝对抗</option></select></label><label>难度<select v-model="form.difficulty"><option value="all">全部难度</option><option value="easy">基础</option><option value="medium">中等</option><option value="hard">高难</option></select></label><label>随机种子<input type="number" v-model.number="form.seed"></label><label>重复次数<input type="number" min="1" max="20" v-model.number="form.repeats"></label><label>并发数<input type="number" min="1" max="16" v-model.number="form.concurrency"></label></template><label v-else>标准协议参数<span class="locked">数据版本、提示词、评分和生成参数已锁定</span></label><label>测试项目</label><div v-for="task in tasks" :key="task.id" class="task"><input type="checkbox" :value="task.id" v-model="form.selected"><span>{{task.name}}</span><small>{{task.ability}}</small></div><button class="btn orange" @click="start">开始测试</button></div></section><section v-else-if="page==='running'"><div class="top"><h1>实时测试</h1><button class="btn orange" @click="cancelRun()">中止测试</button></div><div v-for="run in activeRuns" :key="run.id" class="live-panel"><b>{{run.name}}</b><span class="meta">{{run.current}}</span><pre>{{(run.log||[]).join('\\n')}}</pre></div></section><section v-else-if="page==='compare'"><div class="top"><div><div class="eyebrow">Comparison workspace</div><h1>记录对比</h1></div><button class="btn orange" @click="saveComparison">保存对比</button></div><div class="panel"><label>对比名称<input v-model="comparisonName" placeholder="例如：Qwen3.8 Q8 / KV 对比"></label><p class="hint">对比对象是具体运行记录，不是模型 ID；可用别名标记量化、KV、上下文和张量分配。</p><table class="compare-table"><thead><tr><th>记录别名</th><th>模型</th><th>测试项目</th><th>结果</th><th>TTFT</th><th>吞吐</th></tr></thead><tbody><tr v-for="id in selectedRecords" :key="id"><td><input v-model="comparisonAliases[id]" aria-label="记录别名"></td><td>{{recordOptions.find(item=>item.id===id)?.model}}</td><td>{{recordOptions.find(item=>item.id===id)?.task}}</td><td>{{formatMetric(recordOptions.find(item=>item.id===id)?.average)}}</td><td>{{recordOptions.find(item=>item.id===id)?.average?.firstMs ? recordOptions.find(item=>item.id===id).average.firstMs+' ms' : '-'}}</td><td>{{recordOptions.find(item=>item.id===id)?.average?.tokPerSec ? recordOptions.find(item=>item.id===id).average.tokPerSec.toFixed(1)+' tok/s' : '-'}}</td></tr></tbody></table></div></section><section v-else><div class="top"><h1>连接设置</h1></div><div class="panel"><label>端点<input v-model="cfg.endpoint"></label><label>Key<input type="password" v-model="cfg.key" autocomplete="off"></label><button class="btn orange" @click="getModels">{{loading?'获取中…':'获取模型'}}</button><p class="hint">已发现 {{models.length}} 个模型；模型列表会保存在本机</p><label>外观<select v-model="theme" @change="applyTheme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label></div></section></main></div>`
};

createApp(App).mount('#app');
