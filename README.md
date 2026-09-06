# 模型测评台 (llm-test)

**简体中文** | [English](README.en.md)

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

## 测试协议（13 项）

统一口径：temperature=0、默认抑制思维链（`enable_thinking=false`）；与官方榜单重叠的四项按官方口径开启思考（`reasoning_effort=xhigh`）：AIME 2025 输出预算 38,912、GPQA Diamond / LiveCodeBench / IFBench 为 32,768（依据 Qwen3 技术报告与 Qwen3.8-27B 模型卡）。选择题只认明确的最终答案（`最终答案：X` / `\boxed{X}` / 末行独立字母），推理无结论计"未知"并保留在分母中。

| 协议 | 题池 | 判分 | 说明 |
|---|---|---|---|
| 连通性与吐字速度 | — | 预热后流式请求：首 token 延迟 + 生成速度（不含首 token） | 固定 800 字散文题，持续输出数千 token，冷启动加载不计入 |
| GPQA Diamond | 198 题 | 字母匹配 | 高难度科学推理 |
| AIME 2025 | 30 题 | 整数匹配 | 竞赛数学 |
| MMLU-Pro | 12032 题 | 字母匹配 | 广泛学科 |
| LongBench v2 | 503 题 | A/B/C/D 字母匹配 | 超长上下文（context 全文入 prompt，默认取前 30 题） |
| HumanEval+ | 164 题 | evalplus 增强测试全通过 | 沙箱执行 |
| MBPP+ | 378 题 | evalplus 增强测试全通过 | 沙箱执行 |
| LiveCodeBench | 342 题 (v5+v6) | 隐藏测试全通过 | stdin 用 stdout 比对；函数式用 JSON 参数调函数（每题最多 100 用例 / 1MB） |
| DS-1000 | 1000 题 | 官方扰动测试（`test_execution`） | 沙箱含 2021-2023 科学栈：numpy 1.24 / pandas 1.5 / scipy 1.10 / sklearn 1.2 / matplotlib 3.7 / seaborn / pillow |
| IFEval | 541 题 | 官方校验器 strict（全部约束满足） | Google 可验证指令（格式/字数/关键词…），判分代码 vendor 在 `judge/verifiers/ifeval/` |
| IFBench | 300 题 | 官方校验器 strict | AllenAI 2025 域外约束泛化，`judge/verifiers/ifbench/`；判题沙箱需 nltk/emoji/syllapy/langdetect |
| SafetyBench（中文） | 11435 题 | 选项字母匹配 | 清华 7 类风险场景 MCQ，官方答案取自源仓库 `opensource_data/` |
| XSTest | 250 题 | 拒绝模式检测（中英） | 250 条"看似危险实际安全"的提示，误拒=错、正常作答=对 |

- 代码题判分 = pass@1：温度 0 生成一次，全部抽样测试通过才计正确。
- 题目级失败（上下文超限、judge 不可达）计"未知"，不会让整次运行崩溃。

## 界面

新控制台（`/`）：总览 / 新建评测（模型逐栏下拉、测试项目参数表格，题数/重复/并发/max_tokens 可逐行覆盖）/ 运行队列（只显示进行中的运行，日志实时滚动）/ 历史记录（逐条删除、选入对比；运行结束时自动跳转或弹出右上角完成通知）/ 对比分析（行=测试项目，列=结果×模型，下方维度雷达图可叠加多条"结果×模型"曲线，速度轴按选中最高 t/s 的 80% 定标）/ 协议与基线 / 环境设置。

## 数据准备

原始数据在 `benchmarks/raw/`（大文件可用 `docker/download-benchmarks.sh` 经代理重新下载），转换为任务 JSONL：

```powershell
python scripts/prepare_cached_tasks.py   # GPQA / AIME / MMLU-Pro（data/*.parquet -> scripts/data/）
node scripts/prepare_benchmarks.js       # LongBench v2 / LCB（含 zlib+pickle 解包）/ DS-1000 / HE+ -> scripts/data/
node scripts/prepare_if_safety.js        # IFEval / IFBench / SafetyBench-zh / XSTest -> scripts/data/
```

生成的 JSONL 较大（LongBench v2 ≈ 465MB），已加入 .gitignore；`scripts/data/` 是评测运行与判分校验的实际数据源。

## 验证

```powershell
npm test                          # 判分器/runner 单元测试
node scripts/validate_pipeline.js # 用官方参考答案走通 judge 全链路（无需 GPU）
npm run test:e2e                  # Playwright（headless，channel=chromium）
```

## 判题沙箱安全

`judge/app.py` 运行在 internal Docker 网络（无默认路由、无外网出口），每个测试有 CPU/内存(RLIMIT_AS 6GiB)/文件大小/进程数 rlimit 和 6-30s 墙钟超时，容器只读 + 2g tmpfs。
