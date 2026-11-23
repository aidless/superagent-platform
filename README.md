# superagent-platform

<!-- problem:start -->
A scheduler that folds several triggers into one evaluation can report a finished progress score while the trajectory has already stopped moving.
This repository connects that router to an external watchdog with three criteria — outcome-only, stepwise, and agentic — and scores them on synthetic trajectories whose labels are fixed before the checker runs.
It does not call a live model, and it is not a production scheduler.
<!-- problem:end -->

Result (n = 15 cells: 5 labels × 3 forms, one trajectory each). The watchdog records 7 hits and 2 misses out of 9 planted-defect cells, and false-flags 3 of 6 non-defect controls.

Both misses are outcome-only on a progress freeze that stops on the completion threshold: `silent-stuck/outcome-only` and `stuck/outcome-only`.

All 3 false positives are the slow control (`slow/agentic`, `slow/outcome-only`, `slow/stepwise`), and none of them comes from a freeze window.

The 3 true negatives are the clean control on every form.

The 3 off-track cells are all flagged, and that flag is the shared direction check rather than a form-specific freeze window.

Stepwise and agentic flag the stuck trajectory from step 9, the same index; frozen-step counts at detection are 2 (stepwise) and 1 (agentic).

`silent-stuck` differs from `stuck` in the output signature at 3 positions and still receives the same verdict on all 3 forms.

Passing the 14 unit tests (2 files: router 6, watchdog 8, 0 failed) is a regression check, not a reliability result.

A separate 20-case regression harness passes 20 of 20 under `make check`.

Limits: the grid is the generator's full label × form table under the parameter set in `eval/watchdog_labels.json`, one trajectory per cell, not a sample and not a production trace. No API key and no live model host.

## Reproduce

```bash
npm ci
make check
```

`make check` reruns the grid, the unit tests, and the regression harness, then diffs the claims block below. It fails if a documented number drifts. It also tampers with one stored expectation and requires that case to go red. It does not boot the server and does not call a model.

Labels are `eval/watchdog_labels.json` (planted role only, no checker output). `eval/score_watchdog.ts` runs `generateTrajectory` and `evaluate`.

The HTTP server defaults to port 3081.

```bash
npm run build
npm start
```

The dashboard is served at `/dashboard`. The process reads `PORT`, `CONFIG_PATH`, and `DB_PATH` (see `.env.example`). It does not read an API key.

## What this repository is

Fastify serves the HTTP API. The router merges the pending triggers on one thread into one evaluation and can truncate that batch with an explicit token budget. The watchdog classifies a trajectory as advanced or stalled. package.json version is 0.1.0; the default policy version field is 1.0.0. Those two strings count different things.

GitHub About is outside git. The in-repo description, which is the proposed GitHub About text, is:

> 研究集成原型，不是生产调度器：Router 把同线程 Trigger 合并进一次 Eval，并用显式 token_budget 截断；Watchdog 在合成轨迹上对照植入故障与干净/慢速控制。不连接在线模型，也没有对生产基线做基准。

There is no npm publish script and no Python packaging metadata. This repository does not publish a package.

GitHub Actions `ci.yml` pins Node 20.

| Method | Path | Role |
| --- | --- | --- |
| POST | `/api/triggers` | Submit one trigger |
| GET | `/api/threads` | List threads |
| GET | `/api/threads/:key` | One thread |
| GET | `/api/tickets` | List tickets |
| GET | `/api/tickets/:id` | One ticket |
| GET | `/api/stats` | Router, executor, watchdog, and database counters |
| GET | `/api/watchdog` | Watchdog records |
| GET | `/api/config` | Current policy |
| PUT | `/api/config` | Replace the policy after schema validation |
| GET | `/api/health` | Health check |
| GET | `/dashboard` | HTML dashboard |

## Claims

<!-- claims:start -->
```json
{
  "ci_node": 20,
  "control_cells": 6,
  "control_false_positives": 3,
  "control_true_negatives": 3,
  "default_port": 3081,
  "eval_cases": 20,
  "eval_passed": 20,
  "forms_silent_verdict_equals_stuck": 3,
  "fp_ids": [
    "slow/agentic",
    "slow/outcome-only",
    "slow/stepwise"
  ],
  "grid_cells": 15,
  "grid_forms": 3,
  "grid_labels": 5,
  "labels_sha256": "568552f406a439d30f598dfce603e5cf55b6d2214948c2dcd672d264ca913185",
  "miss_ids": [
    "silent-stuck/outcome-only",
    "stuck/outcome-only"
  ],
  "offtrack_cells_flagged_off_track": 3,
  "outcome_only_planted_stall_misses": 2,
  "package_version": "0.1.0",
  "planted_cells": 9,
  "planted_hits": 7,
  "planted_misses": 2,
  "policy_version": "1.0.0",
  "router_tests": 6,
  "signature_positions_differing": 3,
  "slow_false_positives_without_freeze_window": 3,
  "stuck_agentic_from_step": 9,
  "stuck_agentic_frozen_steps": 1,
  "stuck_stepwise_from_step": 9,
  "stuck_stepwise_frozen_steps": 2,
  "unit_test_files": 2,
  "unit_tests": 14,
  "unit_tests_failed": 0,
  "watchdog_tests": 8
}
```
<!-- claims:end -->

## Layout

```
src/core/        router and domain types
src/watchdog/    trajectory generator and evaluate
src/executor/    in-process worker pool
src/store/       SQLite
src/api/         Fastify routes
src/monitor/     dashboard HTML
eval/            frozen labels, grid scorer, regression cases
tests/           router and watchdog unit tests
```

## License

MIT. See `LICENSE`.

Known gaps and withdrawn wording are in `FAILURE_MODES.md`.
