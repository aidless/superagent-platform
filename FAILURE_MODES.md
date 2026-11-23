# Failure modes

## What the grid does not measure

The scored grid is one synthetic trajectory per planted label and criterion form. `generateTrajectory` accepts a seed and ignores it, so the grid is not a repeated draw and it has no interval. Labels are the planted role, written before `evaluate` runs. A positive prediction is a stall mark.

`silent-stuck` changes the output signature while progress is frozen. `evaluate` does not read that signature, so the silent planting scores the same as `stuck`. That is a property of this checker, not evidence that the two plantings are the same phenomenon.

The agentic form uses a one-step window instead of the configured stall window. On this grid its from-step matches stepwise. A shorter window is not, by itself, an earlier alarm.

Off-track is caught by the direction check that runs before the form switch. It is not evidence that outcome-only can see a progress freeze. The outcome-only misses are freezes that stop on the completion threshold, so the final score still looks finished.

The slow control keeps a positive step after the planted point. Flagging it is a false positive from the completion rule, including stepwise and agentic, and those cells do not carry a freeze window.

An empty state list throws `TypeError` inside `evaluate`. That crash is not a cell in the grid.

There is no live model, no API key, no production trace, and no production baseline. Passing the unit tests is a regression check, not a reliability result. The regression file `eval/cases.jsonl` compares calls against stored expectations. `make check` tampers with one expectation and requires that case to go red. Those cases are not the headline result.

## Router

Prefix caching is not implemented anywhere under `src/`.

`Router.start` slices a batch down to the token budget and then assigns an empty pending list. The tail is discarded, not deferred to a later evaluation. The comment in that function says so. The unit test checks the kept batch length and does not check that the tail survives.

Preemption and requeue are covered by unit tests. Those tests are not a capacity result or a latency result.

## What `make check` does not run

`make check` does not bind the HTTP port and does not open the SQLite file. The default task runner in `src/index.ts` sleeps and writes a synthetic progress trace. It is not a model client.

The HTTP server is Fastify. Older text called it Express.

An absolute filesystem path that contains a backslash makes Node ESM reject the module specifier. The regression harness copies the build into a temporary directory so that case still runs. A clone whose path has no backslash does not need a manual copy.

## Withdrawn wording

Older README and package text called this production-grade, named Express, and named prefix caching. The files in this repo do not support those claims.

Older README text reported a wall-clock duration from one machine and a Node version from that same machine. Wall-clock duration is not a claim. The Node pin that is checked is the `node-version` field in the CI workflow.

Older text presented single-trajectory assertions as a fault-injection benchmark and wrote three-decimal discrimination rates into comments. Those rates were not counts over a frozen label set. The scored artifact is the grid in the README. A unit-test pass is not a reliability result.

A previous GitHub Actions workflow was named as a PyPI publish and completed successfully while the upload step was skipped. There is no Python packaging metadata and no npm publish script. The workflow now refuses to present a skipped upload as a publish. Dependabot used to watch the pip ecosystem even though there is no Python package. It now watches npm and GitHub Actions.

## Versions

The package version and the default policy version field count different things. Both are quoted in the README and read back from `package.json` and `src/config/config.ts`.
