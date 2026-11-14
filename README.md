# superagent-platform

> **English TL;DR**: A production-shaped agent scheduling platform that unifies two research directions: Router-side batch coalescing (explicit `token_budget`, prefix caching, preemption semantics) and Watchdog external supervision (stepwise/agentic criteria, fault-injection benchmark with clean controls). TypeScript, Express + dashboard on :3081. 14/14 vitest tests pass (2026-11-10, 644 ms). Stated boundary: research-integration codebase — the two directions are integrated but not benchmarked against a production baseline.

[![CI](https://github.com/aidless/superagent-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/aidless/superagent-platform/actions/workflows/ci.yml)

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

生产级 agent 调度平台，整合两方向研究成果：

1. **Router 批处理合并**（dir1：统一调度视角下 Agent 批处理与 LLM Serving 的同态结构）
   - `token_budget` 显式化（低风险迁移机制一）
   - 前缀缓存（机制二）
   - 抢占语义（机制三）
2. **Watchdog 外部监督**（dir2：Watchdog 判据的可靠性）
   - 逐步检查判据（stepwise / agentic）
   - 故障注入基准复用（4 类故障 × 干净对照）

## 快速开始

```bash
npm install
npm run build
npm start
# 访问 http://localhost:3081/dashboard
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/triggers` | 提交 Trigger（`{sourceId, threadKey, payload, at, gate, description}`） |
| GET | `/api/threads` | 线程列表 |
| GET | `/api/threads/:key` | 单线程详情 |
| GET | `/api/tickets` | Ticket 列表 |
| GET | `/api/tickets/:id` | 单 Ticket 详情（含执行结果） |
| GET | `/api/stats` | 全平台统计（Router/Executor/Watchdog/DB） |
| GET | `/api/watchdog` | Watchdog 监督记录 |
| GET | `/api/config` | 当前配置 |
| PUT | `/api/config` | 热更新配置 |
| GET | `/api/health` | 健康检查 |
| GET | `/dashboard` | 监控仪表盘（HTML） |

## 架构

```
src/
├── core/        # 域模型 + 调度器（Router）
│   ├── types.ts      # Trigger/Thread/Eval/Ticket/Assignment
│   └── router.ts     # 批处理合并 + token_budget + 抢占
├── watchdog/    # 外部监督（判据三形式）
│   ├── semantics.ts  # 判据语义
│   └── watchdog.ts   # stepwise/agentic 检测
├── executor/    # 多 Worker 并发执行
│   └── executor.ts
├── store/       # 持久化（SQLite）
│   └── db.ts
├── api/         # REST 服务
│   └── server.ts
├── config/      # 配置加载 + 热加载
│   └── config.ts
├── monitor/     # 监控面板
│   └── dashboard.ts
└── index.ts     # 入口
```

## 核心机制

### Router 批处理合并（dir1）
- `start()` 合并 thread.pending 全部 Trigger 成一次 Eval（DeepSeek 现状）
- `token_budget` 显式化：把上下文窗口从隐式升格为显式数值 `ctxBudget`
- 抢占语义：资源不足时驱逐最低优先级（gate.strength + 时间较新）

### Watchdog 监督（dir2）
- 输入：agent 轨迹 τ = (s0, a1, ..., sT) 含中间状态
- 三形式：outcome-only（盲区）/ stepwise / agentic
- 逐步检查捕获冻结窗口（outcome-only 对卡住类判别力=0 的根因）

## 测试与验证

> 2026-11-10 实跑（Node v24，`npm ci` 后）：`npx vitest run` → **Test Files 2 passed (2)，Tests 14 passed (14)，644 ms**。

```bash
# 1. 安装依赖
npm install
# 2. 测试
npx vitest run
# 3. 类型检查（源码 + 测试）
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.tests.json
# 4. 构建
npx tsc
# 5. 启动服务器（监听 3081）
node dist/index.js
```

> **路径提示**：如果你的工作区根目录名里含字面反斜杠（`\`），Node ESM / tsc / esbuild
> 会把它当路径分隔符导致错位。遇到这种情况，把仓库同步到一个**不含反斜杠**的目录再跑：
>
> ```bash
> rsync -a --delete --exclude node_modules --exclude dist --exclude data ./ /path/without/backslash/superagent-platform/
> cd /path/without/backslash/superagent-platform && npm install && npx tsc
> ```

验证结果（2026-11-01）：
- **14/14 测试通过**（router 6 + watchdog 8）
- **源码类型检查 exit 0**（`noUnusedLocals`/`noUnusedParameters` 已开启）
- **测试类型检查 exit 0**（`tsconfig.tests.json`）
- **构建 exit 0**（`dist/` 生成）
- **端到端流水线**：Trigger 提交 → Eval 合并 → 自动判定 accept → Ticket 创建 → Worker 执行 → Watchdog 监督（ADVANCED）→ SQLite 持久化（completed + Assignment 带 watchdog_verdict）

## 审查修复记录（2026-11-01）

三审并集发现 4 Critical + 5 Important 正确性缺陷，全部已修复：

| 级别 | 问题 | 修复 |
|------|------|------|
| C1 | Config 热加载死掉（`configWatcher.start()` 从未调用） | `main()` 调用 `start()`；onReload 更新 Watchdog policy；监视目录容忍缺失文件 |
| C2 | REQUEUES 过期重排 no-op | Eval 保留原 Trigger，`handleExpired`/`preempt` 回填 pending；测试断言 pending>0 |
| C3 | 抢占测试空转（2 参 vs 实现 evalId） | 真实 evalId + 断言 victim 重入 pending；`preempt()` 回填 triggers |
| C4 | Watchdog clean 假阳性 | `generateTrajectory` 达目标后 `break` 停止发状态；新增 clean 控制测试 |
| I1 | `watchdog.enabled` 死配置 | `supervise()` 开头检查 enabled |
| I2 | `PUT /api/config` 无验证 | `PolicySchema.safeParse` 合并校验，失败 400 |
| I3 | Assignment 未创建/持久化 | `onAssignment` 回调接线到 store；`updateAssignmentResult` 更新 watchdog 列 |
| I4 | STALLED→expired 无恢复 | `ticket.expired` 事件触发 `router.resumeTicket` |
| I5 | all-inadmissible 留 pending | `start()` 清空已处理 pending |

## 生产级特性

- **调度**：merge-pending 批处理、PRIORITY 抢占、token_budget 截断、REQUEUES 过期重排
- **监督**：Watchdog 三形式（outcome-only/stepwise/agentic）卡住/偏轨检测 + 恢复重试
- **持久化**：SQLite WAL（threads/evals/tickets/assignments/settings），Assignment 带 watchdog 判决
- **配置**：JSON 文件 + 默认合并，`fs.watch` 热加载
- **API**：Fastify REST（triggers/threads/tickets/stats/watchdog/config/health）+ 实时监控面板
- **执行**：并发 Worker 池 + 人类消息专用槽 + 后台时限 kill + Watchdog 监督

## 测试

```bash
npm test
# 14 测试：Router（合并/strongest/截断/抢占/重排）+ Watchdog（三形式/故障注入/clean 控制）
```

> **构建注意**：若工作区根目录名含字面反斜杠（`\`），tsc/tsx/esbuild/Node ESM
> 会把 `\` 当路径分隔符导致错位。构建需走无反斜杠的副本，见上文「测试与验证」。
>
> 复制 `dist/` 回原工作区时同样要注意目标路径：
>
> ```bash
> cp -r dist /path/to/your/workspace/superagent-platform/
> ```

## 验收标准与复算

**验收判据**：本仓判为合格的条件是 `python3 eval/run_cases.py` 通过率必须为 100%（20/20），且 `make eval` 退出码必须为 0；任何一条失败即判为不合格。

`eval/cases.jsonl` 的 20 条题目**全部真调本仓 API**（用本仓 `src/` 的构建产物 `dist/*.js`：`Router` / `evaluate` / `generateTrajectory` / `PolicySchema` / `computePriority`），期望值由实跑现算，不是抄文档；`source` 指向真实源码行。每条的 `verify` 就是该题的**复算代码**，改一行实现就可能让它变红，这正是这套题的意义。

| axis | 条数 | 覆盖的行为 |
|---|---|---|
| router/batch | 1 | 三个 Trigger 合并成单个 Eval 的批大小 |
| router/strength | 2 | strongest = 强度最高；同强度取时间较新 |
| router/budget | 2 | `tokenBudget` 截断（12→5）与预算内不截断（12→12） |
| router/preempt | 2 | 抢占后 decision=`unavailable`、被驱逐 Trigger 回填 pending |
| router/requeue | 2 | `RequeueTracker` 上限判定、`markAllExpired()` 重排回填 |
| router/ticket | 2 | accept 生成 Ticket 的 `contextBudget` 与 `mandate.action` |
| watchdog/form | 3 | stuck→STALLED、clean→ADVANCED（假阳性守卫）、slow 被 outcome-only 误判 |
| watchdog/trajectory | 2 | 轨迹状态点数：clean 到 target 即停（10）/ stuck 冻结跑满（12） |
| watchdog/fault | 2 | off-track 三值判定；空轨迹 `evaluate()` 抛 `TypeError` |
| model/priority | 1 | `computePriority('high', 1000, 'PRIORITY')` 的数值 |
| config/validate | 1 | `PolicySchema.parse({tokenBudget: 0})` 抛 `ZodError` |

三条命令（在仓库根执行）：

```bash
python3 eval/run_cases.py            # 必须 20/20（退出码 0）
python3 eval/run_cases.py --selftest # 反证：篡改首题期望值 → 必须 19/20 变红且退出码 0
make eval                            # 一键复跑，退出码必须为 0
```

**复算说明**：`python3 eval/run_cases.py --save` 会把本次逐题结果与失败归因写进 `eval/run-report.json`，该文件可随时由同一条命令重建（题目即复算代码，无需人工翻日志）。判据不是 README 里的一句话，而是 `--selftest` 证明过会红的 20 条可执行断言。

> 路径说明：本工作区根目录名含字面反斜杠，Node ESM 直接加载会报 `ERR_INVALID_MODULE_SPECIFIER`。因此每条题目的 `verify` 先用 `rsync` 把 `dist/`、`src/`、`node_modules/zod` 同步到 `/tmp/sap-eval-clean`（无反斜杠），再在那里用 `node --input-type=module` 调本仓 API。题库跑在真实构建产物上，不是重新实现。

**失败归因**（按 axis 汇总，不止报通过率）：`run_cases.py` 与 `run-report.json` 的 `failed_by_axis` 把失败题目按 axis 归桶，例如 `--selftest` 的实跑输出：

```
19/20 cases passed
失败归因（按 axis）：
  router/batch: 1 条 —— SA-01
```

即"批处理合并"这一族断言失效，而不是笼统的"通过率 95%"。定位顺序：先看 axis 桶 → 再按 `source` 打开对应源码行 → 用该题 `verify` 单独复跑。

> 范围声明：本次只新增 `eval/`、根级 `Makefile` 与本 README 小节，未改源码与既有测试。顺带记录一处**只报告不改**的实现缺陷：`src/core/router.ts:158-206` 的 `tokenBudget` 截断路径注释写「剩余留到下一轮」，但第 206 行无条件 `thread.pending = []` 会把截断余下（12→5 时是 7 个）Trigger 直接丢弃，`pending` 实测为 0。
