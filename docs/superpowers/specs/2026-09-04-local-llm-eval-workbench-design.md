# Local LLM Evaluation Workbench Design

## 1. Goal and Product Boundary

Refactor the existing local model evaluation console into a Vue 3 personal evaluation workbench. The primary user is one operator running local or reachable OpenAI-compatible model endpoints from Windows. The product must be useful for repeated experiments involving data processing, code writing, computer troubleshooting, daily agents, CTF, red-team and blue-team workflows.

The product is local-first and does not add accounts, collaboration, cloud result storage, or automatic model/server restarts. The default server binds to `127.0.0.1`. Network access is limited to the configured model endpoint and explicitly requested dataset/baseline downloads.

Two evaluation modes are first-class:

- **Standard evaluation** uses a locked protocol package: dataset revision, prompt template, few-shot policy, option ordering, generation parameters, answer extraction, scorer and protocol version. It can be compared with a public baseline only when the protocol fingerprint matches.
- **Exploration evaluation** allows a bounded subset and controlled changes such as question count, category, difficulty, context length, random seed, repeats, concurrency, maximum output and reasoning mode. It is always labeled exploratory and is not presented as a full public-benchmark result.

## 2. Architecture

The application has four layers:

1. **Vue 3 + Vite + TypeScript** renders the personal control console, evaluation composer, run queue, history, comparison workspace, protocol catalog and environment settings.
2. **Express** owns the local HTTP API, validation, run scheduling, SSE event stream, model discovery, cancellation and worker lifecycle.
3. **SQLite** stores connection profiles, cached model lists, protocol metadata, immutable run snapshots, per-question attempts, events, comparisons, aliases and export metadata.
4. **Python worker** executes standard protocol adapters and dynamic evaluation adapters. It communicates with Express using newline-delimited structured events over stdio or a local child-process channel. The worker receives an immutable run specification and never reads mutable UI state.

The first implementation should keep one Node process and one worker process per active run. The boundaries must permit later replacement by a worker pool without changing the Vue API.

## 3. Protocol Packages and Sources

Each protocol package declares:

- stable id and semantic protocol version;
- source repository or paper URL;
- dataset identifier, split, revision/commit and local cache checksum;
- prompt and few-shot policy;
- model request parameters and stop policy;
- answer extraction and scoring implementation;
- supported run modes and required execution environment;
- public baseline snapshots and their source dates.

The initial catalog is layered:

### Static and API-safe protocols

- GPQA Diamond: four-choice question answering with controlled option shuffling and explicit final-letter extraction. The implementation must preserve the chosen option order in the per-question record.
- MMLU-Pro: ten-choice questions, category-aware few-shot CoT policy, fixed answer extraction and per-category accuracy. Dataset revision and validation examples are part of the protocol fingerprint.
- AIME 2025: zero-shot math prompt with a boxed final answer and math-aware equivalence/integer scoring. A raw last-number regex is not sufficient as the sole scorer.
- LongBench v2: multiple-choice long-context evaluation with length and domain metadata. Exploration filters may target 8K, 32K, 64K, 128K and approximately 200K context budgets, but the UI must show actual token counts and truncation status.
- BFCL: function-call generation and execution checks. The first version may support non-live and local deterministic categories; live web-search categories require explicit credentials and are disabled by default.

### Sandboxed dynamic protocols

- DS-1000 and LiveCodeBench for data-science/code generation and execution. Every sample runs in a fresh restricted process/container; code and test output are stored as artifacts and never executed on the Windows host.
- Terminal-Bench and selected daily troubleshooting tasks in isolated WSL/Docker environments.
- Cybench/BoxPwnr-style CTF and authorized red/blue tasks only through an explicit task adapter and isolated network. No arbitrary target or host discovery is added by the application.
- OSWorld is a separate high-cost adapter requiring a VM provider. It is not silently enabled just because WSL/KVM exists.

The app may download additional Hugging Face datasets on demand, but downloads use a temporary file, checksum/revision verification and atomic rename into the cache. A protocol is not marked ready until its data and runtime prerequisites pass preflight.

## 4. Evaluation Semantics

Every run stores an immutable specification snapshot containing connection profile id and resolved endpoint, model id, user-facing model/record label, protocol fingerprint, generation parameters, random seed, selection filters, requested count, expected count, concurrency, context target, worker version and environment preflight result.

The smoke/diagnostic protocol is explicitly non-academic. It uses a streaming Chat Completions request and reports:

- time to first streamed content token (TTFT), separately from request start and queue time;
- decode throughput over content-token deltas after the first token;
- total wall time, completion token count and finish reason;
- connection, HTTP and stream error class.

Standard benchmark tasks do not automatically retry wrong answers. Retry policy is limited to classified transient transport failures and is recorded per attempt. Exploration mode may enable bounded retries, but the UI and result export show the retry policy.

Score aggregation includes both answered and unattempted counts. A cancelled or failed run never silently treats missing questions as wrong or correct.

## 5. Run Lifecycle, Cancellation and Recovery

The run state machine is `queued -> preflight -> running -> stopping -> completed | partial | failed | crashed`. Each question transitions independently through `pending`, `running`, `succeeded`, `incorrect`, `error`, `cancelled` or `skipped`.

After each question attempt, Express commits the raw request metadata, response text/reasoning when enabled, extracted answer, score, latency, token usage, error class and timestamps in one SQLite transaction. SSE events include a monotonic event id; reconnecting clients request events after the last id.

Manual stop cancels every active request for the run, stops future scheduling, waits for worker acknowledgement up to a bounded grace period, then marks the run `partial` with a reason. Completed rows remain queryable and exportable. On process restart, runs left in an active state become `crashed` and offer “continue unfinished questions” using the original snapshot, not the current form.

The UI exposes pause scheduling, stop now, retry failed transport attempts, continue unfinished questions and open raw logs. It must not claim that a partial run is externally comparable.

## 6. Connections and Model Cache

Connection profiles are named and persisted locally. A profile contains protocol, endpoint, optional key reference, display name, last successful check and cached model list with refresh timestamp. The default profile and last-used model/protocol are restored when composing a run.

Model discovery occurs on first setup or an explicit refresh. Cached models remain selectable when temporarily offline, with a stale indicator. A run records the resolved model list entry so later model-list changes cannot alter historical meaning.

Secrets are not logged. If “remember key” is enabled, the implementation should use Windows DPAPI through a narrowly scoped local helper; otherwise the key remains process/session-only. The UI must clearly distinguish a model label from the raw model id and allow a record label such as `Qwen3.8 Q8 / KV q8_0 / ctx 200k`.

## 7. UI and Information Architecture

Default visual direction is **Precision Lab**: warm paper background, deep teal navigation, coral action color, restrained green success state, dense but readable tables, and Playfair Display/Merriweather-style heading treatment. For Chinese glyph stability, package or load `Noto Serif SC` for large headings at weight 500; retain a serif fallback and use a neutral sans stack for controls and dense data. The UI supports light, dark and system themes and honors `prefers-reduced-motion`.

Navigation:

`Overview`, `New Evaluation`, `Run Queue`, `History`, `Comparisons`, `Protocols & Baselines`, `Environment`.

Overview shows current runs, endpoint/environment health, recent records and the most relevant comparison shortcut. New Evaluation is a single workspace with Standard/Exploration mode, saved connection/model defaults, protocol cards, preflight summary and a reviewable run plan. The right-side summary shows expected requests, context budget, required runtime, estimated disk use and comparability status.

History supports filtering by protocol fingerprint, mode, status, model label, date and completeness. Records are selectable independently of model id. “Create comparison” opens a dedicated comparison workspace where the comparison title and each selected record alias are editable. Raw model id, run id, protocol fingerprint and all parameters remain visible as evidence.

Comparison views include common metrics, score by category, latency/throughput, per-question disagreement, baseline snapshot and a clear warning when records differ in protocol or completeness. A comparison can be saved and later extended with another compatible record.

## 8. Baselines and External Comparability

The app ships with manually reviewed baseline snapshots, each including model name, score, source URL, protocol fingerprint, dataset revision, publication/capture date and reviewer note. Baselines are not fetched on every page load. A user-triggered refresh downloads source metadata, validates it and adds a new snapshot without rewriting old snapshots.

The comparison UI only shows “comparable” when all selected records and the baseline share the required fingerprint fields. Otherwise it shows a reason such as different prompt policy, data revision, sampling count, subset, or incomplete run.

## 9. Sandboxing and Security

Dynamic code, terminal and security protocols run in WSL2 Docker Engine when available. Default container policy is no network, read-only image, one-time writable work directory, dropped capabilities, non-root user, CPU/memory/pids limits and hard wall-clock timeout. CTF multi-container tasks use an isolated internal network with explicit task-defined services only.

If the runtime is absent, the protocol remains visible with a preflight explanation and installation guide; the application does not silently execute a fallback on the host. Docker setup is opt-in and performed through documented PowerShell/WSL commands, not by the Node server.

## 10. Verification Plan

- Protocol fixtures verify prompt rendering, option ordering, answer extraction, math equivalence and aggregate scores against known upstream examples.
- A fake OpenAI-compatible server emits delayed streaming tokens, disconnects, malformed usage and concurrent responses to verify TTFT, decode rate, retry classification and all-request cancellation.
- SQLite tests kill the process between question commits and verify recovery, partial status and continuation.
- Dataset cache tests verify revision/checksum mismatch, interrupted download and atomic replacement.
- Sandbox tests verify host-file isolation, no default network, resource limits and timeout cleanup.
- Vue browser tests cover saved profiles, cached models, standard/exploration restrictions, preflight warnings, run controls, SSE reconnection, aliases, comparisons and exports.
- Visual checks cover desktop/mobile layouts, light/dark/system themes and reduced-motion behavior.
- Before release, run a short exploration against the configured llama-swap endpoint and one small standard-protocol fixture. Do not claim full benchmark completion without a full, untruncated run.

## 11. Non-Goals for This Iteration

- No accounts, multi-user permissions, cloud sync or public sharing.
- No automatic llama-swap or model configuration edits.
- No arbitrary host command execution, real-world target scanning or unsandboxed code execution.
- No single blended score across unrelated protocols.
- No promise that a 200K context experiment is externally comparable unless the selected protocol explicitly defines that context and the run records complete, untruncated evidence.

## 12. Reference Sources Consulted

- Promptfoo Web UI: result matrix, filters, cell details, exports and charts.
- EleutherAI lm-evaluation-harness GPQA task definitions.
- LightEval task definitions for GPQA, MMLU-Pro and AIME 2025.
- TIGER-AI-Lab MMLU-Pro official evaluation repository.
- OpenCompass AIME 2025 configuration.
- LongBench v2 official repository and dataset description.
- LiveCodeBench official repository and release/version semantics.
- BigCodeBench official repository and execution-based scoring.
- DS-1000 official repository.
- Berkeley Function Calling Leaderboard official repository.
- Terminal-Bench/Harbor, OSWorld, Cybench and BoxPwnr repository descriptions.

## Status

Design approved in conversation on 2026-09-04. The workspace is not a Git repository, so this document cannot be committed until version control is initialized by the user or explicitly requested.
