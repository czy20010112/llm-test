# Model Eval Lab (llm-test)

简体中文 | **English**

A local LLM evaluation workbench for Windows, built with Vue 3 + Node. It talks to any OpenAI-compatible endpoint (default: llama-swap at `http://127.0.0.1:9292/v1`); code benchmarks are judged inside a WSL2 Docker sandbox.

## Quick start

```powershell
cd D:\AI\llm-test
npm install
npm run build          # build the frontend (npm run dev for development)
node server.js         # http://127.0.0.1:3000/
```

Judge sandbox (required for code & instruction benchmarks, one-time setup):

```bash
# inside WSL
cd /mnt/d/AI/llm-test/docker
docker compose -f judge-compose.yaml up -d --build
# host reaches it via 127.0.0.1:8901 (internal network + socat forwarder, see docker/judge-compose.yaml)
```

## Protocols (13)

Common sampling: temperature=0, single generation (pass@1). Thinking is disabled by default (`enable_thinking=false`) except LiveCodeBench, which follows the official setup with thinking on; code and instruction scoring reads only the post-thinking content. MCQ scoring accepts an explicit final answer only (最终答案：X / \boxed{X} / trailing choice letter); reasoning without a conclusion counts as "unknown" and stays in the denominator.

| Protocol | Pool | Scoring | Notes |
|---|---|---|---|
| Connectivity & decode speed | — | Warmup + streaming: TTFT & decode speed (excl. first token) | Fixed ~800-word essay prompt; cold model loads don't pollute the numbers |
| GPQA Diamond | 198 | Choice-letter match | Graduate-level science reasoning |
| AIME 2025 | 30 | Exact integer match | Competition math |
| MMLU-Pro | 12032 | Choice-letter match | Broad multidisciplinary knowledge |
| LongBench v2 | 503 | A/B/C/D letter match | Full context in prompt, first 30 by default |
| HumanEval+ | 164 | All augmented tests pass | Sandboxed |
| MBPP+ | 378 | All augmented tests pass | Sandboxed |
| LiveCodeBench | 342 (v5+v6) | All hidden tests pass | stdin via stdout diff; functional via JSON args (≤100 cases / 1MB per problem) |
| DS-1000 | 1000 | Official perturbation tests (`test_execution`) | Sandbox ships the 2021-2023 scientific stack: numpy 1.24 / pandas 1.5 / scipy 1.10 / sklearn 1.2 / matplotlib 3.7 / seaborn / pillow |
| IFEval | 541 | Official verifier, strict | Google verifiable instructions; vendored in `judge/verifiers/ifeval/` |
| IFBench | 300 | Official verifier, strict | AllenAI 2025 OOD constraints, `judge/verifiers/ifbench/`; sandbox needs nltk/emoji/syllapy/langdetect |
| SafetyBench (Chinese) | 11435 | Choice-letter match | THU 7-category safety MCQ; official answers from the source repo `opensource_data/` |
| XSTest | 250 | Refusal-pattern detection (EN+CN) | 250 safe-but-scary prompts; answering passes, refusing counts as over-refusal |

- Code problems are pass@1: one generation at temperature 0, all sampled tests must pass.
- Question-level failures (context overflow, judge down) count as "unknown" and never crash a run.

## UI

`/` — Overview / New run (cascading model rows, benchmark table with per-row items/repeats/concurrency/max_tokens) / Queue (running only, live auto-scrolling log) / History (per-run delete, compare picker; on completion auto-jumps or shows a top-right toast) / Compare (rows = benchmarks, columns = run×model, plus a dimension radar with overlay series; the speed axis scales to 80% of the highest selected t/s) / Protocols / Settings. The UI follows the browser language (Chinese/English) with a toggle in the sidebar.

## Data preparation

Raw sources live in `benchmarks/raw/` (re-download large ones via `docker/download-benchmarks.sh` behind a proxy), converted to task JSONL:

```powershell
python scripts/prepare_cached_tasks.py   # GPQA / AIME / MMLU-Pro (data/*.parquet -> scripts/data/)
node scripts/prepare_benchmarks.js       # LongBench v2 / LCB (zlib+pickle unpack) / DS-1000 / HE+ -> scripts/data/
node scripts/prepare_if_safety.js        # IFEval / IFBench / SafetyBench-zh / XSTest -> scripts/data/
```

Generated JSONL files are large (LongBench v2 ≈ 465MB) and gitignored; `scripts/data/` is the data source for runs and pipeline validation.

## Verification

```powershell
npm test                          # scorer/runner unit tests
node scripts/validate_pipeline.js # walk official reference answers through the judge (no GPU needed)
npm run test:e2e                  # Playwright (headless, channel=chromium)
```

## Judge sandbox security

`judge/app.py` runs on an internal Docker network (no default route, no egress). Every test gets CPU/memory (RLIMIT_AS 6GiB)/file-size/process rlimits and 6-30s wall-clock timeouts; the container is read-only + 2g tmpfs.
