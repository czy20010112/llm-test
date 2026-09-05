# 模型测评台 (llm-test)

Windows 本地运行的 Vue 3 + Node 评测工作台，默认连接 llama-swap 的 OpenAI Compatible 接口（`http://127.0.0.1:9292/v1`），代码类基准在 WSL2 Docker 判题沙箱内执行。

## 启动

```powershell
cd D:\AI\llm-test
npm install
npm run build          # 构建前端（开发时用 npm run dev）
node server.js         # http://127.0.0.1:3000/
```

判题沙箱（代码类评测必需，一次性配置）：

```bash
# WSL 内
cd /mnt/d/AI/llm-test/docker
docker compose -f judge-compose.yaml up -d --build
# 宿主通过 127.0.0.1:8901 访问（internal 网络 + socat 转发，见 docker/judge-compose.yaml 注释）
```

## 测试协议（9 项）

统一口径：temperature=0、抑制思维链（`enable_thinking=false`）；选择题只认明确的最终答案（`最终答案：X` / `\boxed{X}` / 末行独立字母），推理无结论计"未知"并保留在分母中。

| 协议 | 题池 | 判分 | 说明 |
|---|---|---|---|
| 连通性与吐字速度 | — | 请求成功 + 首 token + tok/s | 冒烟用 |
| GPQA Diamond | 198 题 | 字母匹配 | 高难度科学推理 |
| AIME 2025 | 30 题 | 整数匹配 | 竞赛数学 |
| MMLU-Pro | 12032 题 | 字母匹配 | 广泛学科 |
| LongBench v2 | 503 题 | A/B/C/D 字母匹配 | 超长上下文（context 全文入 prompt，默认取前 30 题） |
| HumanEval+ | 164 题 | evalplus 增强测试全通过 | 沙箱执行 |
| MBPP+ | 378 题 | evalplus 增强测试全通过 | 沙箱执行 |
| LiveCodeBench | 342 题 (v5+v6) | 隐藏测试全通过 | stdin 用 stdout 比对；函数式用 JSON 参数调函数（每题最多 100 用例 / 1MB） |
| DS-1000 | 1000 题 | 官方扰动测试（`test_execution`） | 沙箱含 2021-2023 科学栈：numpy 1.24 / pandas 1.5 / scipy 1.10 / sklearn 1.2 / matplotlib 3.7 / seaborn / pillow |

- 代码题判分 = pass@1：温度 0 生成一次，全部抽样测试通过才计正确。
- 题目级失败（上下文超限、judge 不可达）计"未知"，不会让整次运行崩溃。

## 界面

新控制台（`/`）：总览 / 新建评测（模型逐栏下拉、测试项目参数表格，题数/重复/并发/max_tokens 可逐行覆盖）/ 运行队列（只显示进行中的运行，日志实时滚动）/ 历史记录（逐条删除、选入对比）/ 对比分析（行=测试项目，列=结果×模型）/ 协议与基线 / 环境设置。
旧控制台（`/legacy/`）仍完整可用，两者共用同一套 API 与结果存储（`data/runs.json`）。

## 数据准备

原始数据在 `benchmarks/raw/`（HF 下载），转换为任务 JSONL：

```powershell
python scripts/prepare_cached_tasks.py   # GPQA / AIME / MMLU-Pro（data/*.parquet -> scripts/data/）
node scripts/prepare_benchmarks.js       # LongBench v2 / LCB（含 zlib+pickle 解包）/ DS-1000 / HE+ -> scripts/data/
```

生成的 JSONL 较大（LongBench v2 ≈ 465MB），已加入 .gitignore。

## 验证

```powershell
npm test                          # 判分器/runner 单元测试
node scripts/validate_pipeline.js # 用官方参考答案走通 judge 全链路（无需 GPU）
npm run test:e2e                  # Playwright（headless，channel=chromium）
```

## 判题沙箱安全

`judge/app.py` 运行在 internal Docker 网络（无默认路由、无外网出口），每个测试有 CPU/内存(RLIMIT_AS 6GiB)/文件大小/进程数 rlimit 和 6-30s 墙钟超时，容器只读 + 2g tmpfs。
