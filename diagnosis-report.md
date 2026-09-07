# 本地模型评测工作台诊断报告

日期：2026-09-07

范围：只分析当前工作区的实现、运行记录和测试覆盖。本轮未修改 `server.js`、`src/App.vue` 或其他现有代码。

## 结论摘要

当前问题不是单一的前端显示问题，而是运行状态模型没有细化到“模型 / 测试项目 / 重复轮次 / 题目”这一层级：

1. 题目级得分只存在于 `measure()` 的局部变量中，任务没有跑完时不会写入 `run.rows`，所以中断后只能看到 `repeat=0` 的占位结果。
2. 恢复接口只判断“模型 × 测试项目”是否完成，无法识别某个测试项目已经完成了哪些题，因此未完成的测试项目会从第 1 题重新开始。
3. 后端保存了 `taskIndex`，但前端显示的是 `modelIndex / models.length`，所以单模型五项测试始终可能显示 `1/1`。
4. 当前有两层并发：外层把重复次数并发执行，内层又把题目并发执行。`repeats=2、concurrency=2` 的题目类最多会有 4 个模型请求在途。
5. 思考配置写死在任务类型分支中，不能由新建评测设置；速度探测还单独写死了 `enable_thinking=false`。

## 现场证据

### `mtqlkm1a`：重复和并发确实叠加

`data/runs.json` 中该运行的配置是：

```json
{"id":"gpqa_cached","repeats":2,"concurrency":2}
```

日志在 `10:05:05` 同时出现：

```text
GPQA / 第 1 次：请求中…
GPQA / 第 1 次 / 题目 1/198：请求中…
GPQA / 第 1 次 / 题目 2/198：请求中…
GPQA / 第 2 次：请求中…
GPQA / 第 2 次 / 题目 1/198：请求中…
GPQA / 第 2 次 / 题目 2/198：请求中…
```

这不是日志误读，而是当前两层 `Promise.all` 的直接结果。该运行中 GPQA 最终只有：

```json
{"repeat":0,"average":{"score":0,"correct":0,"incorrect":0,"unknown":0,"total":0,"failedRepeats":2}}
```

### `mtqlkm1a`：继续确实从第 1 题重跑

中断后点击继续的日志是：

```text
10:47:24 继续测评：跳过 1 个已完成项目，其余重跑
10:47:24 跳过已完成：... / 连通性与吐字速度
10:47:24 ... / GPQA / 第 1 次：请求中…
10:47:24 ... / GPQA / 题目 1/198：请求中…
10:47:24 ... / GPQA / 题目 2/198：请求中…
10:47:24 ... / GPQA / 第 2 次：请求中…
10:47:24 ... / GPQA / 题目 1/198：请求中…
10:47:24 ... / GPQA / 题目 2/198：请求中…
```

说明恢复逻辑只跳过完整的“模型 × 项目”对，GPQA 的已完成题目没有被识别。

### `mtqn60d7`：进度显示的直接证据

该运行已有 GPQA 和 MMLU 两行完整结果，`taskConfigs` 有 5 项，但运行状态为：

```json
{"modelIndex":0,"taskIndex":1,"repeat":1,"total":5}
```

前端实际渲染的是：

```text
(progress.modelIndex + 1) / models.length
```

因此单模型运行显示 `1/1`，与已完成的测试项目数量无关。

## 1. 中断后不显示部分分数

### 原因

相关代码在 `D:\AI\llm-test\server.js`：

- `measure()` 在 339-352 行内局部维护 `correct / incorrect / unknown`。
- 每题判完后只调用 `tally()`，没有更新 `run.rows` 或持久化检查点。
- 外层重复 worker 在 264 行检查 `run.cancelRequested`；只要已经请求中断，就不会把 `measure()` 返回值放入 `vals[i]`。
- 任务结束后 278-289 行才统一生成 row。取消时如果没有完整 repeat，进入 286-287 行的占位分支，得到 `total=0`。
- `saveRuns()` 通常只在任务结束或外部点击中断时调用，服务重启时，当前题目级内存状态也可能没有落盘。

所以即使 `measure()` 内部已经判出 99 道正确，也会因为任务未完成而被外层丢掉。

### 建议改法

不要把任务结果只设计为“完成后生成一行”。建议在进入每个模型 × 测试项目时就创建或更新一行，并把结果拆成以下状态：

```text
task status: pending | running | partial | done
repeat status: pending | running | partial | done
question verdict: correct | incorrect | unknown | pending
```

每道题完成并得到最终 verdict 后，按以下顺序处理：

1. 写入该重复轮次的题目结果或题目完成集合。
2. 更新 `correct / incorrect / unknown / processed`。
3. 更新部分分数和进度。
4. 持久化运行记录。

部分结果建议单独使用 `processed` 表示已经结束的题目数，不要把它冒充最终 `total`：

```json
{
  "status":"partial",
  "correct":99,
  "incorrect":1,
  "unknown":0,
  "processed":100,
  "total":198,
  "partialScore":0.99
}
```

界面显示为“阶段得分 99.0%（99/100，目标 198）”。完成后再显示最终口径 `correct / total`。否则会把“已经做完的 100 题得 99%”误显示成全量口径的 `50%`，或者被现有 `normalizeRunScores()` 重新覆盖。

重复次数大于 1 时，汇总应同时保留：已完成的完整轮次数、当前部分轮次、每轮题目级检查点。不要只用现有的 `row.repeat`，因为它只能表达完成了几轮，不能表达一轮完成了几题。

## 2. 继续时整类重跑

### 原因

`D:\AI\llm-test\server.js:162-190` 的恢复接口：

- 只根据 `row.average` 和 `row.repeat` 判断某个模型 × 测试项目是否完整。
- 把完整项目放入 `kept`，恢复时传给 `execute()`。
- `execute()` 在 245-247 行只支持跳过整对项目。
- 不完整 row 在恢复前会被 `filter()` 删除，因此部分统计也会丢失。

这套结构天然只能实现“跳过完整项目，重跑不完整项目”，不可能从某道题继续。

### 建议改法

检查点的最小键应至少是：

```text
model + task id + repeat index + question index
```

更稳妥的是保存 `question index` 加数据集/提示词指纹，避免题库顺序发生变化后错误跳题。建议结构类似：

```json
{
  "checkpoint": {
    "taskId":"gpqa_cached",
    "sampleTotal":198,
    "repeatsTarget":2,
    "repeats":[
      {"index":0,"status":"done","items":{"0":"correct","1":"incorrect"}},
      {"index":1,"status":"partial","items":{"0":"correct","1":"correct"}}
    ]
  }
}
```

恢复时：

- 完整重复轮次直接跳过。
- 部分重复轮次只提交尚未有终态的题目。
- 已经完成的测试项目不重新执行。
- 被取消的在途请求不应被标成已完成，恢复时重新请求。
- 题目级 transport error 是否计入 unknown，要沿用当前评分协议；但应单独标注为 error，避免把“用户取消”永久算成 unknown。

并发大于 1 时，不能只保存一个“下一个题号”，因为题目完成顺序可能乱序。应保存已完成题目的集合；如果实际只需要精确从下一题继续，则应要求 `concurrency=1`。当前测试日志里重复题目会同时推进，采用集合检查点更安全。

对现有旧记录：它们没有正式题目检查点，只能从日志中的“题目 N：正确/错误/未知”做有限的兼容解析。不能把日志解析当作长期方案，因为日志可能未落盘、输出被截断，且同一题会因重复和恢复出现多次记录。新运行必须从第一题开始建立结构化检查点。

## 3. 进度显示错误

### 原因

后端创建运行时保存了：

```text
progress.modelIndex
progress.taskIndex
progress.repeat
progress.total
```

但前端 `D:\AI\llm-test\src\App.vue:632` 使用的是：

```text
(r.progress.modelIndex + 1) / r.models.length
```

这是模型维度的进度，不是测试项目维度的进度；`taskIndex` 根本没有被展示。

### 建议改法

后端显式维护，不要让前端从 row 数量猜：

```text
currentModelIndex
currentTaskIndex
completedTaskCount
totalTaskCount
completedPairCount
totalPairCount
currentRepeat
currentQuestion
```

单模型时显示：

```text
已完成测试 2/5 · 当前：第 3 项 IFBench
```

多模型时建议显示两层：

```text
模型 1/2 · 当前模型已完成测试 2/5 · 总进度 7/10
```

`completedTaskCount` 只统计完整完成的项目；当前 partial 项目应单独显示题目级进度，例如“GPQA 100/198”。不要用 `rows.length` 代替，因为恢复、重复和部分 row 都会让它失真。

## 4. 重复次数与并发次数叠加

### 原因

当前结构在 `D:\AI\llm-test\server.js:249-277`：

```text
外层：Promise.all(worker for repeats)
内层：measure() -> Promise.all(qworker for concurrency)
```

因此题目类的最大模型请求数约为：

```text
repeats × concurrency
```

速度探测没有内层题目队列，所以它通常只会同时有 `repeats` 个速度请求；这正是“有些测试像 4 个，有些不像 4 个”的原因。默认空值为 1 时也不会显出叠加效果。

### 建议改法

重复轮次应严格串行，题目并发只存在于当前轮次内部：

```text
for repeat = 1 .. repeats:
    await measure(one repeat, concurrency)
```

这样 `repeats=2、concurrency=2` 的含义就是：第一轮最多 2 个题目请求；第一轮全部结束后，第二轮最多 2 个题目请求。不能再用外层 repeat worker 的 `Promise.all`。

建议在日志里明确写：

```text
第 1/2 轮：题目并发 2
第 1/2 轮完成
第 2/2 轮：题目并发 2
```

同时修复取消控制器：

- `D:\AI\llm-test\server.js:55` 当前是 `Map<runId, AbortController>`，同一运行的多个请求会互相覆盖。
- `D:\AI\llm-test\server.js:156-158` 取消时最多只能 abort 最后写入的 controller。
- `chatStream()` 在 487-489 行拿到响应头后就删除 controller，但流式 body 还没有读完，此后流式请求无法被取消。

建议改成 `Map<runId, Set<AbortController>>`，请求开始加入集合，请求完整结束后删除；取消时 abort 该运行的全部 controller，并等待在途请求完成清理。取消后的请求不能再启动新的题目，也不能把取消产生的半截响应当成合法答案。

## 5. 思考开关、等级和备注列

以下“当前原因/建议改法”记录的是收尾前状态；对应改动已在文末“本轮收尾”中落地。

### 当前原因

当前新建评测只提交：

```text
limit / repeats / concurrency / maxTokens
```

见 `D:\AI\llm-test\src\App.vue:211-225` 和 `D:\AI\llm-test\server.js:200-205`。

思考参数在服务端按任务类型硬编码：

- GPQA：`thinking: task.kind === 'gpqa'`
- AIME：`thinking: true`
- LiveCodeBench：`thinking: true`
- IFBench：`thinking: task.kind === 'ifbench'`
- 其他普通任务默认关闭
- 速度探测的 `chatStream()` 又固定发送 `enable_thinking:false`

因此当前界面无法统一做“全关闭思考”的量化 A/B，也无法选择等级。

### 建议改法

思考配置应成为每个测试项目配置的一部分，默认值为：

```json
{"thinking":false,"reasoningEffort":"medium"}
```

建议使用每行配置，因为不同测试项目可能需要不同设置；必要时再提供“全部应用为关闭”的快捷操作。等级选项可以限制为服务支持的集合，例如 `low / medium / high / xhigh`，由服务端白名单校验。

请求规则：

- `thinking=false`：发送 `enable_thinking:false`，不要发送 `reasoning_effort`。
- `thinking=true`：发送 `enable_thinking:true` 和所选 `reasoning_effort`。
- 所有任务分支，包括速度探测，都从同一个任务配置读取，不再按 `task.kind` 强制覆盖。
- 配置必须保存到 `run.taskConfigs`，恢复时使用原运行配置，不能依赖当前页面后来选择的值。
- 历史旧运行缺少该字段时按 `false` 兼容。

### 备注列

当前测试项目下拉选项已经在 `D:\AI\llm-test\src\App.vue:590-593` 展示了项目能力说明；表格又在 579、602-604 行重复展示备注。按需求应删除表格中的 `备注` 表头和单元格，保留下拉菜单中的 `<small>` 说明。现有浏览器测试 `D:\AI\llm-test\tests\browser\views.spec.ts:24-35` 仍断言选中后存在 `.c-note`，需要改成断言：打开下拉菜单时能看到说明，选中后表格不再出现备注列。

## 推荐实现顺序

1. 先把重复调度改成“重复串行、题目按 concurrency 并行”。
2. 增加题目级检查点和部分 row，取消/服务重启时也持久化。
3. 用检查点实现恢复，保留完整项目、完整轮次，只重跑未完成题目。
4. 增加明确的任务进度和题目进度字段，修正前端显示。
5. 把 thinking / reasoning effort 放入任务配置，默认全部关闭。
6. 删除表格备注列，更新浏览器测试。
7. 最后补齐取消控制器集合，验证多请求取消不会遗留在途请求。

## 建议的回归测试

### 调度测试

使用 4 道假题、`repeats=2、concurrency=2`，模型请求用可控 mock：

- 断言最大活动模型请求数为 2，不是 4。
- 断言第 2 轮的第一个请求只能出现在第 1 轮 4 道题全部结束之后。
- 断言速度探测的两轮也按轮次串行。

### 部分结果测试

让第 1 轮完成 3 道题后触发取消，第 4 题处于在途状态：

- 运行记录立即有 partial row。
- `correct / incorrect / unknown / processed` 与已结束题目一致。
- UI 显示阶段性分数，不显示 `total=0`。
- 被取消的在途题目不计入已完成集合。

### 恢复测试

在第 2 题后中断，恢复时断言只请求第 3、4 题；已经完成的测试项目不再请求。再覆盖“第 1 轮完成、第 2 轮中断”的情况，确保只恢复第 2 轮未完成题目。

### 进度测试

模拟单模型五项任务，在两项 row 完成、第三项运行中时，API 返回 `completedTaskCount=2,totalTaskCount=5`，页面显示 `2/5`；同时显示当前项目题目进度。

### 思考配置测试

分别提交 `thinking=false` 和 `thinking=true + reasoningEffort=xhigh`，检查每个任务分支最终发出的请求体：关闭时没有 `reasoning_effort`，开启时有正确的等级。速度探测也要覆盖。

### 真实人工验收顺序

先用 4-6 道小题验证中断/恢复和并发日志，再用 GPQA 的小题数验证 partial score，最后才跑 198 题和多轮任务。全量测试前应确认 `data/runs.json` 能在每道题后持久化，避免再次产生无法恢复的旧式记录。

## 本轮收尾：Q8 日志与已落地改动

### Q8 运行 `mtqn60d7` 的未知原因

该运行共跑了 528 个采样题（GPQA 198、MMLU-Pro 100、IFBench 100、IFEval 100、LiveCodeBench 30），并发配置为 GPQA=2。逐题日志按“请求中”到“未知”配对后的结果如下：

| 测试项目 | 未知数 | 日志原因 | 请求到结果 |
|---|---:|---|---:|
| GPQA | 40 | `fetch failed` | 302-307 秒 |
| MMLU-Pro | 11 | `输出达到长度上限` | 41-50 秒 |
| IFBench | 2 | `fetch failed` | 303-304 秒 |
| IFEval | 0 | — | — |
| LiveCodeBench | 11 | `fetch failed` | 304-306 秒 |

结论：这次 64 个未知中，GPQA/IFBench/LiveCodeBench 是约 5 分钟后请求失败/被中止，不是 32K 输出上限；MMLU-Pro 的 11 个才是模型在 `max_tokens=4096` 内没有产出可判答案并以 length 结束。该运行由 2026-09-07 早些时候启动的旧服务进程完成；当前源码已改为非思考请求默认 10 分钟、开启思考默认 15 分钟，因此重启后的默认行为和这条旧记录不同。

处理建议：思考开启的本地模型先使用并发 1 验证单题耗时；如果需要并发 2，建议单题请求上限先设 10 分钟，长上下文或明确要复现极慢思考时再放宽到 15-20 分钟。超过上限应保留 `timeout` 作为独立失败原因，不要和普通 `fetch failed` 混在同一类 unknown 中。

### 已落地的收尾改动

- 新建评测的每个测试项目现在支持 `thinking` 和 `reasoningEffort`，新配置默认关闭思考；开启后可选 `low / medium / high / xhigh`，服务端按白名单写入请求。
- 所有题型、速度预热和速度流式请求都读取同一任务配置；旧运行缺字段时仍按旧的官方思考默认恢复。
- 新建评测表格删除重复的备注列，能力说明仍保留在测试项目下拉选项中。
- 运行队列切回时日志滚动到最新；运行完成从队列自动跳转历史时逐题日志默认折叠；用户展开日志时自动滚动到最新。
- 继续运行时保留 partial row，不再提前过滤掉题目级 checkpoint。

`zx-bench` 的对比另见 `D:\AI\llm-test\zx-bench-comparison.md`。
