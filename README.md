# superagent-platform

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
