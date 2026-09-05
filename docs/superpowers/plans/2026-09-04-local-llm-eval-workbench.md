# Local LLM Evaluation Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the local model evaluation console as a resilient Vue 3 personal workbench with reproducible benchmark protocols, persisted runs, record-level comparisons, and safe WSL/Docker execution adapters.

**Architecture:** Vite builds a typed Vue 3 single-page console served by Express. Express owns SQLite persistence, immutable run snapshots, SSE events, model/profile APIs and run scheduling. Python workers execute protocol adapters through NDJSON events; dynamic adapters use WSL2 Docker isolation and never fall back to host execution.

**Tech Stack:** Vue 3, Vite, TypeScript, Express, better-sqlite3, Zod, SSE, Python 3.12, pytest, Hugging Face datasets, LightEval/Math-Verify-compatible adapters, Docker Engine in WSL2, Playwright.

---

## File Map

Create a `src/` frontend instead of the current CDN template. Keep `server.js` as a thin bootstrap and split its responsibilities:

- `server/app.js`: Express composition, middleware and route registration.
- `server/db.js`: SQLite connection, migrations, transactions and queries.
- `server/validation.js`: Zod schemas for profiles, run specs, events and filters.
- `server/run-manager.js`: run state machine, worker process lifecycle, cancellation and SSE event fan-out.
- `server/model-service.js`: endpoint probing, model cache and profile persistence.
- `server/routes/*.js`: focused route modules for profiles, protocols, runs, history, comparisons and exports.
- `protocols/manifest/*.json`: versioned protocol metadata and baseline fingerprints.
- `worker/runner.py`: worker entrypoint and NDJSON event protocol.
- `worker/protocols/`: static protocol adapters and scorer fixtures.
- `worker/sandbox/`: Docker/WSL preflight and dynamic adapter runner.
- `tests/server/`, `tests/worker/`, `tests/browser/`: unit, integration and browser coverage.
- `src/App.vue`, `src/views/`, `src/components/`, `src/stores/`, `src/lib/`, `src/styles/`: typed Vue application.
- `vite.config.ts`, `tsconfig.json`, `index.html`: frontend build configuration.

## Task 1: Establish the Vue 3 Build Without Losing the Existing API

**Files:**
- Create: `vite.config.ts`, `tsconfig.json`, `src/main.ts`, `src/App.vue`, `src/styles/tokens.css`
- Modify: `package.json`, `public/index.html`, `server.js`
- Test: `tests/browser/smoke.spec.ts`

- [ ] **Step 1: Write the browser smoke test**

```ts
import { test, expect } from '@playwright/test';

test('loads the Vue shell and primary navigation', async ({ page }) => {
  await page.goto('http://127.0.0.1:3000/');
  await expect(page.getByRole('navigation')).toContainText('总览');
  await expect(page.getByRole('button', { name: '新建评测' })).toBeVisible();
});
```

- [ ] **Step 2: Run the test and verify the current CDN page fails the new contract**

Run: `npx playwright test tests/browser/smoke.spec.ts`
Expected: FAIL because the current page has no Vue navigation landmark or `新建评测` button.

- [ ] **Step 3: Add Vite/Vue entrypoints and scripts**

Add `vue`, `vite`, `@vitejs/plugin-vue`, `typescript`, `zod`, `better-sqlite3`, `@playwright/test` and `vitest` dependencies. Define `dev`, `build`, `preview`, `test`, and `test:e2e` scripts. `server.js` must serve `dist/` when it exists and keep `/api/*` available.

- [ ] **Step 4: Build a minimal typed shell**

`src/App.vue` renders a navigation landmark with `总览`, `新建评测`, `运行队列`, `历史记录`, `对比分析`, `协议与基线`, `环境设置`, and a content outlet. `src/styles/tokens.css` defines the Precision Lab warm paper, deep teal, coral and success tokens plus light/dark/system media rules and reduced-motion overrides.

- [ ] **Step 5: Run verification**

Run: `npm run build; npx playwright test tests/browser/smoke.spec.ts`
Expected: build succeeds and the smoke test passes.

- [ ] **Step 6: Commit**

```text
git add package.json package-lock.json vite.config.ts tsconfig.json index.html public/index.html src tests/browser/smoke.spec.ts server.js
git commit -m "feat: establish typed Vue evaluation console"
```

## Task 2: Add SQLite Persistence and Profile/Model Cache

**Files:**
- Create: `server/db.js`, `server/validation.js`, `server/model-service.js`, `server/routes/profiles.js`, `tests/server/db.test.js`
- Modify: `server/app.js`, `server.js`, `package.json`

- [ ] **Step 1: Write failing persistence tests**

Cover migrations, named profile insert/update, encrypted-key reference storage without logging, cached model list, stale timestamp, and immutable run snapshot insert. Use a temporary SQLite file per test.

- [ ] **Step 2: Run tests to verify missing persistence fails**

Run: `npm test -- tests/server/db.test.js`
Expected: FAIL because `server/db.js` does not exist.

- [ ] **Step 3: Implement migrations and transactions**

Create tables `schema_migrations`, `profiles`, `profile_models`, `protocols`, `runs`, `questions`, `attempts`, `run_events`, `comparisons`, `comparison_records`, `baselines`. Enable foreign keys and WAL mode. Every migration runs in a transaction; the DB path defaults to `.data/llm-test.sqlite` and is created outside `public/`.

- [ ] **Step 4: Implement profile and model APIs**

Validate endpoint URLs as HTTP(S), normalize a trailing `/v1`, persist display name and key reference, and cache `/models` JSON with `refreshed_at`. Return stale caches with `stale: true`; never include plaintext keys in responses or logs.

- [ ] **Step 5: Run tests and commit**

Run: `npm test -- tests/server/db.test.js`
Expected: PASS.

```text
git add server/db.js server/validation.js server/model-service.js server/routes/profiles.js server/app.js server.js tests/server/db.test.js package.json package-lock.json
git commit -m "feat: persist profiles and model cache"
```

## Task 3: Model/Protocol Composer and Saved Defaults

**Files:**
- Create: `src/lib/api.ts`, `src/stores/useSettings.ts`, `src/stores/useComposer.ts`, `src/views/EvaluationComposer.vue`, `src/components/ProtocolCard.vue`, `src/components/PreflightSummary.vue`, `tests/browser/composer.spec.ts`
- Modify: `src/App.vue`, `src/styles/tokens.css`

- [ ] **Step 1: Write browser tests**

Verify a saved profile loads automatically, cached models are selectable without clicking refresh, standard mode disables mutable protocol fields, exploration mode exposes count/category/difficulty/context/seed/repeat/concurrency controls, and the preflight summary flags missing runtime requirements.

- [ ] **Step 2: Run the tests to establish failures**

Run: `npx playwright test tests/browser/composer.spec.ts`
Expected: FAIL because the composer is not implemented.

- [ ] **Step 3: Implement typed API helpers and stores**

Define `Profile`, `CachedModel`, `ProtocolManifest`, `RunDraft` and `PreflightResult` types. Store drafts in local storage with a schema version. Load the last profile/model/protocol on mount and preserve user aliases separately from raw IDs.

- [ ] **Step 4: Implement the composer UI**

Use protocol cards with source, revision, sample count, context range and comparability badge. Standard mode renders locked values with an explanation; exploration mode renders bounded numeric inputs and selects. The right summary shows request count, context target, environment requirements and a warning when a subset cannot match a baseline.

- [ ] **Step 5: Verify and commit**

Run: `npm run build; npx playwright test tests/browser/composer.spec.ts`
Expected: PASS.

```text
git add src/App.vue src/lib src/stores src/views/EvaluationComposer.vue src/components tests/browser/composer.spec.ts
git commit -m "feat: add saved evaluation composer"
```

## Task 4: Versioned Protocol Manifests and HF Cache

**Files:**
- Create: `protocols/manifest/gpqa-diamond.v1.json`, `protocols/manifest/mmlu-pro.v1.json`, `protocols/manifest/aime-2025.v1.json`, `protocols/manifest/longbench-v2.v1.json`, `server/protocol-catalog.js`, `server/routes/protocols.js`, `worker/protocols/manifest.py`, `tests/server/protocols.test.js`
- Modify: `server/db.js`, `server/app.js`

- [ ] **Step 1: Add manifest fixture tests**

Assert each manifest has source URL, dataset revision, prompt policy, generation policy, scorer id, protocol version, context policy and baseline fingerprint fields. Reject a manifest with a missing revision or mutable URL-only dataset reference.

- [ ] **Step 2: Implement catalog loading**

Load manifests at startup, calculate a canonical SHA-256 fingerprint from normalized JSON, persist metadata in SQLite, and expose ready/not-ready status. Do not allow a run to start from an unrecognized manifest.

- [ ] **Step 3: Implement Python cache helper**

Use Hugging Face `datasets` with a pinned revision where supported. Download into a temporary cache path, verify expected row schema and atomically move the prepared JSONL into `.data/datasets/<protocol>/<revision>/`. Record checksum and row count.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- tests/server/protocols.test.js`
Expected: PASS.

```text
git add protocols server/protocol-catalog.js server/routes/protocols.js worker/protocols/manifest.py tests/server/protocols.test.js
git commit -m "feat: add versioned protocol catalog"
```

## Task 5: Python Worker Event Contract and Standard Scorers

**Files:**
- Create: `worker/runner.py`, `worker/protocols/base.py`, `worker/protocols/gpqa.py`, `worker/protocols/mmlu_pro.py`, `worker/protocols/aime.py`, `worker/protocols/longbench.py`, `worker/tests/test_scorers.py`, `worker/requirements.txt`
- Modify: `protocols/manifest/*.json`

- [ ] **Step 1: Write scorer fixtures first**

Create fixtures for GPQA option order, MMLU-Pro A-J extraction and per-category totals, AIME boxed integer/math-equivalent answers, LongBench choice extraction, malformed output and truncated output. Assert missing answers become `unknown`, not wrong.

- [ ] **Step 2: Run worker tests and verify failures**

Run: `py -3.12 -m pytest worker/tests/test_scorers.py -q`
Expected: FAIL because adapters are missing.

- [ ] **Step 3: Implement protocol adapters**

Each adapter receives an immutable run spec, renders the exact prompt, sends a request through a shared streaming client, emits `question_started`, `token`, `question_finished` or `question_error`, and returns a score object with raw response, extraction evidence and scorer version. Seed every randomized option shuffle with the run seed plus question id.

- [ ] **Step 4: Implement NDJSON worker contract**

Input messages: `start`, `stop`, `continue`. Output messages include `ready`, `preflight`, `run_started`, `question_*`, `log`, `run_finished`, `run_partial`, `run_failed`, and `heartbeat`, each with `run_id`, monotonic `seq` and ISO timestamp. Flush stdout after every message.

- [ ] **Step 5: Verify and commit**

Run: `py -3.12 -m pytest worker/tests/test_scorers.py -q`
Expected: PASS.

```text
git add worker protocols/manifest
git commit -m "feat: implement reproducible standard protocol worker"
```

## Task 6: Run Manager, SSE, Cancellation and Recovery

**Files:**
- Create: `server/run-manager.js`, `server/routes/runs.js`, `server/routes/history.js`, `server/sse.js`, `tests/server/run-manager.test.js`
- Modify: `server/app.js`, `server/db.js`, `server/validation.js`

- [ ] **Step 1: Write lifecycle tests**

Use a fake worker process to test `queued -> preflight -> running`, one transaction per question, SSE replay after `Last-Event-ID`, stop-all cancellation, partial completion, transport retry classification and startup recovery of active runs as `crashed`.

- [ ] **Step 2: Run tests and verify failures**

Run: `npm test -- tests/server/run-manager.test.js`
Expected: FAIL because the run manager and SSE endpoints are missing.

- [ ] **Step 3: Implement worker supervision**

Spawn Python with `py -3.12` on Windows and `python` inside an explicitly configured venv/WSL environment. Validate every event against a schema. Kill the worker only after sending `stop` and waiting for the grace period. On exit without a terminal event, mark the run `crashed`.

- [ ] **Step 4: Implement SSE replay**

Persist events before publishing them. `GET /api/runs/:id/events` sends events after `Last-Event-ID`, emits keepalive comments every 15 seconds, and closes with a terminal event. Reject cross-run event ids.

- [ ] **Step 5: Implement run/history routes**

Create immutable snapshots from validated drafts, expose run detail with question rows, implement stop/pause/continue/retry endpoints, and return history filters with completeness and comparability reasons.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- tests/server/run-manager.test.js`
Expected: PASS.

```text
git add server/run-manager.js server/routes server/sse.js server/db.js server/validation.js tests/server/run-manager.test.js
git commit -m "feat: add resumable runs and SSE progress"
```

## Task 7: Overview, Run Queue and History UI

**Files:**
- Create: `src/stores/useRuns.ts`, `src/views/OverviewView.vue`, `src/views/RunQueueView.vue`, `src/views/HistoryView.vue`, `src/components/RunCard.vue`, `src/components/HistoryTable.vue`, `tests/browser/runs.spec.ts`
- Modify: `src/App.vue`, `src/lib/api.ts`

- [ ] **Step 1: Write browser tests**

Stub the API/SSE and verify live progress, reconnect from an event id, stop now, partial-result badge, continuation action, history filters and raw log opening.

- [ ] **Step 2: Implement SSE store**

Use `EventSource`, retain the last event id per run, reconnect with exponential backoff, merge question updates idempotently by question id, and surface a stale-connection warning without losing local state.

- [ ] **Step 3: Build Precision Lab views**

Overview shows active runs, environment health, recent records and a comparison shortcut. Queue uses fixed-width progress rows and accessible stop/pause controls. History uses dense but readable rows with mode, protocol fingerprint, completeness, label, score and status.

- [ ] **Step 4: Verify and commit**

Run: `npm run build; npx playwright test tests/browser/runs.spec.ts`
Expected: PASS.

```text
git add src/stores/useRuns.ts src/views src/components src/App.vue src/lib/api.ts tests/browser/runs.spec.ts
git commit -m "feat: add live queue and history views"
```

## Task 8: Record-Level Comparisons and Baseline Snapshots

**Files:**
- Create: `server/routes/comparisons.js`, `server/baselines.js`, `src/views/ComparisonView.vue`, `src/views/BaselinesView.vue`, `src/components/ComparisonBuilder.vue`, `src/components/MetricChart.vue`, `tests/server/comparisons.test.js`, `tests/browser/comparison.spec.ts`
- Modify: `server/db.js`, `server/app.js`, `src/App.vue`, `src/lib/api.ts`

- [ ] **Step 1: Write comparison tests**

Assert records can be selected independent of model id, aliases are stored, comparison names are editable, incompatible protocol fingerprints produce reasons instead of a comparable badge, and partial runs disable external comparison.

- [ ] **Step 2: Implement comparison persistence/API**

Create comparison rows and ordered record alias rows. Return common metrics, per-category values, latency/throughput, disagreement rows, baseline snapshot and compatibility reasons. Never rewrite the raw run snapshot.

- [ ] **Step 3: Implement UI**

History multi-select opens a dedicated comparison builder. Require a custom comparison name, prefill aliases from model labels, retain raw model ids, and show saved comparisons in the nav. Use CSS/SVG charts only for deterministic local rendering; include table values for export and accessibility.

- [ ] **Step 4: Add baseline catalog/refresh**

Implement explicit refresh that fetches reviewed source metadata, validates protocol fingerprint and date, stores a new snapshot, and never overwrites prior snapshots. Show source URL, revision, capture date and reviewer note.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/server/comparisons.test.js; npx playwright test tests/browser/comparison.spec.ts`
Expected: PASS.

```text
git add server/routes/comparisons.js server/baselines.js src/views/ComparisonView.vue src/views/BaselinesView.vue src/components/ComparisonBuilder.vue src/components/MetricChart.vue tests/server/comparisons.test.js tests/browser/comparison.spec.ts
git commit -m "feat: add named record comparisons and baselines"
```

## Task 9: Accurate Streaming Smoke Metrics

**Files:**
- Create: `worker/protocols/smoke.py`, `worker/tests/test_smoke_metrics.py`, `tests/server/fake-openai-server.test.js`
- Modify: `worker/runner.py`, `protocols/manifest/smoke.v1.json`, `server/run-manager.js`

- [ ] **Step 1: Write fake-stream tests**

Emit a delayed first token, steady token deltas, usage-only final chunk, connection reset and malformed stream. Assert TTFT excludes queue time, decode tok/s starts after first content token, total wall time is separate, and failure class is stable.

- [ ] **Step 2: Implement streaming client metrics**

Parse SSE `data:` frames, timestamp first content delta, count provider usage when present, otherwise count tokenizer-estimated content tokens and mark the estimate. Record queue, TTFT, decode duration and total duration separately.

- [ ] **Step 3: Verify and commit**

Run: `npm test -- tests/server/fake-openai-server.test.js; py -3.12 -m pytest worker/tests/test_smoke_metrics.py -q`
Expected: PASS.

```text
git add worker/protocols/smoke.py worker/tests/test_smoke_metrics.py tests/server/fake-openai-server.test.js protocols/manifest/smoke.v1.json worker/runner.py server/run-manager.js
git commit -m "fix: measure real streaming latency and throughput"
```

## Task 10: WSL/Docker Preflight and Dynamic Adapters

**Files:**
- Create: `server/environment-service.js`, `server/routes/environment.js`, `worker/sandbox/preflight.py`, `worker/sandbox/docker_runner.py`, `worker/protocols/ds1000.py`, `worker/protocols/livecodebench.py`, `worker/protocols/bfcl.py`, `worker/protocols/terminal_bench.py`, `worker/tests/test_sandbox_policy.py`, `tests/server/environment.test.js`
- Modify: `server/app.js`, `src/views/EnvironmentView.vue`, `src/components/PreflightSummary.vue`, `protocols/manifest/*.json`

- [ ] **Step 1: Write policy tests before enabling execution**

Assert a dynamic run is rejected when Docker/WSL is absent, the generated command includes no network, read-only image, non-root user, resource limits, timeout and isolated workdir, and no adapter can execute through Node child process on the Windows host.

- [ ] **Step 2: Implement read-only environment checks**

Probe WSL distro, Docker Engine, `/dev/kvm`, available disk and memory. Return actionable PowerShell/WSL installation guidance without running installation commands automatically.

- [ ] **Step 3: Implement restricted Docker runner**

Use an allow-listed image per protocol, `--network none` by default, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root UID, explicit bind mount to a temporary workdir, CPU/memory/pids limits and hard timeout. For CTF multi-container fixtures, create an ephemeral internal network with only declared services and tear it down in `finally`.

- [ ] **Step 4: Add adapters with explicit environment requirements**

DS-1000 and LiveCodeBench store generated code and execution reports as artifacts. BFCL starts with deterministic non-live categories. Terminal-Bench uses only approved task fixtures. OSWorld/Cybench adapters expose preflight/unsupported status until their VM/task provider is explicitly configured.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/server/environment.test.js; py -3.12 -m pytest worker/tests/test_sandbox_policy.py -q`
Expected: PASS; no dynamic test is allowed to pass by executing on the host.

```text
git add server/environment-service.js server/routes/environment.js worker/sandbox worker/protocols worker/tests/test_sandbox_policy.py tests/server/environment.test.js src/views/EnvironmentView.vue src/components/PreflightSummary.vue protocols/manifest
git commit -m "feat: add isolated dynamic evaluation runtime"
```

## Task 11: Export, Settings, Recovery UX and Documentation

**Files:**
- Create: `server/routes/exports.js`, `src/views/SettingsView.vue`, `src/components/ExportMenu.vue`, `scripts/setup-worker.ps1`, `scripts/setup-worker.sh`, `scripts/check-environment.ps1`, `docs/operations.md`, `tests/browser/settings.spec.ts`
- Modify: `README.md`, `server/app.js`, `src/App.vue`

- [ ] **Step 1: Write export/settings tests**

Verify JSON/CSV export includes protocol fingerprint, raw model id, alias, per-question status, attempts, partial reason and baseline metadata. Verify settings expose theme, reduced motion, data location, worker status and safe environment checks.

- [ ] **Step 2: Implement exports and recovery controls**

Export immutable snapshots without secrets. Add “continue unfinished”, “retry transport failures” and “open raw log” controls. Include an explicit partial/crashed warning in every exported report.

- [ ] **Step 3: Add setup/check scripts and docs**

Document Python venv creation, locked worker dependencies, WSL Docker setup, HF cache location, endpoint profile setup, backup/restore and the fact that installation is never automatic from the Node server.

- [ ] **Step 4: Verify and commit**

Run: `npm run build; npx playwright test tests/browser/settings.spec.ts`
Expected: PASS.

```text
git add server/routes/exports.js src/views/SettingsView.vue src/components/ExportMenu.vue scripts docs README.md server/app.js src/App.vue tests/browser/settings.spec.ts
git commit -m "feat: add safe exports settings and recovery guidance"
```

## Task 12: Full Validation and Real Endpoint Smoke Run

**Files:**
- Modify: `README.md`, `package.json`, `worker/requirements.txt`
- Test: all `tests/` and `worker/tests/`

- [ ] **Step 1: Run all automated checks**

Run: `npm test; npm run build; npx playwright test; py -3.12 -m pytest worker/tests -q`
Expected: all tests pass; browser tests run against a local fake API unless explicitly marked endpoint smoke.

- [ ] **Step 2: Run environment and data checks**

Run: `pwsh -File scripts/check-environment.ps1; py -3.12 -m worker.runner --preflight`
Expected: a structured report for WSL/Docker/KVM, protocol cache readiness and missing optional adapters.

- [ ] **Step 3: Run a bounded real endpoint smoke**

Start the app, use the saved llama-swap profile, run one exploration smoke request and one small standard fixture with a strict question limit. Confirm streaming TTFT, persisted question row, SSE progress, stop/recovery behavior and comparison eligibility. Do not run a full 12K-question dataset during release verification.

- [ ] **Step 4: Check visual and accessibility behavior**

Capture desktop and mobile screenshots in light, dark and system themes. Verify reduced-motion mode disables sweep/transition effects, text does not overflow, buttons have familiar icons/tooltips where applicable, and tables remain readable.

- [ ] **Step 5: Update documentation and commit**

Record exact startup, worker setup, protocol limitations and comparison semantics in `README.md` and `docs/operations.md`.

```text
git add README.md docs/operations.md package.json worker/requirements.txt
git commit -m "docs: document evaluation workbench operations"
```

## Plan Self-Review

- **Spec coverage:** architecture and persistence are covered by Tasks 1-3; protocol manifests and standard scoring by Tasks 4-5; SSE/cancellation/recovery by Tasks 6-7; named record comparisons and baselines by Task 8; accurate TTFT/tok/s by Task 9; WSL/Docker safety and dynamic scenarios by Task 10; exports/settings and operations by Task 11; final browser/runtime validation by Task 12.
- **Placeholder scan:** no placeholder markers or unspecified error-handling steps are used. Unsupported OSWorld/Cybench behavior is explicitly defined as preflight/unsupported until configured.
- **Type consistency:** `RunDraft`, `ProtocolManifest`, `PreflightResult`, run event names and run states are introduced before their consumers; the worker `run_id`/`seq` contract is shared by Node, SSE and Vue stores.
- **Scope guard:** dynamic protocols are adapters behind explicit runtime checks, not a reason to expand the personal tool into a multi-user platform.
