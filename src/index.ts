/**
 * index.ts
 *
 * Superagent Platform 入口
 * 装配：Router + Executor + Watchdog + Store + API + Dashboard
 */

import { Router } from './core/router.js';
import { Executor, type TaskRunner } from './executor/executor.js';
import { Watchdog } from './watchdog/watchdog.js';
import { Store } from './store/db.js';
import { createServer } from './api/server.js';
import { renderDashboard } from './monitor/dashboard.js';
import { ConfigWatcher, defaultPolicy } from './config/config.js';
import { type Policy, type Ticket } from './core/types.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// 配置
// ============================================================

const configPath = process.env.CONFIG_PATH ?? join(__dirname, '../config.json');
const dbPath = process.env.DB_PATH ?? join(__dirname, '../data/superagent.db');
const port = Number(process.env.PORT ?? 3081);

// ============================================================
// 装配
// ============================================================

const store = new Store(dbPath);
let policy: Policy = defaultPolicy();

const router = new Router(policy);
const watchdog = new Watchdog(policy);

// 默认 TaskRunner（演示用：模拟 agent 执行）
const defaultRunner: TaskRunner = async (ticket: Ticket, worker, signal) => {
  // 模拟进度：逐步推进 10 步，每步 100ms
  const trajectory = [];
  let progress = 0;
  for (let step = 0; step < 10; step++) {
    if (signal.aborted) throw new Error('aborted');
    progress = Math.min(progress + 10, 100);
    trajectory.push({
      progressScore: progress,
      outputSignature: `sig_${step}_${progress}`,
      directionOk: true,
      step,
      at: Date.now(),
    });
    worker.context.tokensUsed += 100;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { result: { completed: true, ticketId: ticket.id.value }, trajectory };
};

const executor = new Executor(
  {
    maxConcurrent: 4,
    humanSlot: true,
    maxBackendRunMs: 60000,
    retryBackoffMs: 5000,
    onAssignment: (a) => {
      if (a.status === 'active') {
        store.insertAssignment(a.id, a.ticketId, a.executorId, 'active', a.startedAt);
      } else {
        store.updateAssignmentResult(
          a.id, a.status, a.completedAt ?? Date.now(),
          undefined, a.watchdogVerdict === 'STALLED' ? 'stalled' : undefined,
          a.watchdogVerdict, a.watchdogExtended,
        );
      }
    },
  },
  defaultRunner,
  watchdog,
);

// 执行器事件 → 持久化 + STALLED 恢复
executor.on((e) => {
  if (e.type === 'ticket.completed' || e.type === 'ticket.failed' || e.type === 'ticket.expired') {
    store.updateTicketStatus(
      e.ticket.id.value,
      e.ticket.status,
      e.ticket.contextUsed,
      Date.now(),
    );
    // I4：STALLED（preempted）→ 恢复重试（不静默丢工作）
    if (e.type === 'ticket.expired' && e.result.preempted) {
      console.log(`[superagent-platform] Watchdog STALLED，恢复 Ticket ${e.ticket.id.value}`);
      router.resumeTicket(e.ticket.id.value);
    }
  }
});

// 路由事件 → 持久化
router.on((event) => {
  switch (event.type) {
    case 'eval.started':
      // 确保线程存在（FK 约束）
      store.upsertThread(
        event.eval.threadKey.value,
        event.eval.triggerIds[0]?.value ?? 'unknown',
        'evaluating',
        Date.now(),
        Date.now(),
      );
      store.insertEval(
        event.eval.id.value, event.eval.threadKey.value,
        event.eval.triggerIds.map((t) => t.value).join(','),
        event.eval.primaryTriggerId.value, event.eval.strength,
        event.eval.actor, event.eval.startedAt,
      );
      break;
    case 'eval.decided':
      if (event.eval?.decision) {
        store.updateEvalDecision(event.eval.id.value, event.eval.decision, event.eval.completedAt ?? Date.now());
      }
      break;
    case 'ticket.created':
      store.insertTicket(
        event.ticket.id.value, event.ticket.evalId.value, event.ticket.threadKey.value,
        event.ticket.status, event.ticket.contextBudget, event.ticket.priority,
        event.ticket.createdAt, event.ticket.updatedAt,
      );
      break;
    case 'ticket.resumed':
      store.updateTicketStatus(event.ticket.id.value, event.ticket.status, event.ticket.contextUsed, Date.now());
      break;
  }
});

// Watchdog 监督 → 执行器（通过 executor 的 supervise 在内部调用）

// 配置热加载
const configWatcher = new ConfigWatcher(configPath, (next) => {
  policy = next;
  router.setPolicy(next);
  watchdog.setPolicy(next);
});

// ============================================================
// API 服务
// ============================================================

const server = createServer({
  router,
  executor,
  watchdog,
  store,
  getPolicy: () => policy,
  setPolicy: (p) => { policy = p; router.setPolicy(p); },
});

// 仪表盘路由
server.get('/dashboard', async (_req, reply) => {
  return reply.type('text/html').send(renderDashboard(router, executor, watchdog));
});

// ============================================================
// 启动
// ============================================================

async function main() {
  await server.listen({ port, host: '0.0.0.0' });
  console.log(`[superagent-platform] API: http://localhost:${port}`);
  console.log(`[superagent-platform] Dashboard: http://localhost:${port}/dashboard`);
  console.log(`[superagent-platform] DB: ${dbPath}`);
  console.log(`[superagent-platform] Policy: mode=${policy.schedulingMode} budget=${policy.tokenBudget} watchdog=${policy.watchdog.form}`);

  // 配置热加载启动（C1：fs.watch 实际开始监听）
  configWatcher.start();

  // 演示：提交一个测试 Trigger
  router.submitTrigger({
    id: { value: 'demo_trg_1' },
    sourceId: { value: 'demo' },
    threadKey: { value: 'thread_demo' },
    payload: { task: 'hello' },
    at: Date.now(),
    gate: { strength: 'medium', admissible: true },
    description: 'Demo trigger',
  });

  // 周期性调度泵：驱动 evaluateDue 循环（对应 engine.ts 的循环驱动）
  setInterval(() => {
    const started = router.evaluateDue();
    if (started.length > 0) {
      console.log(`[superagent-platform] 调度 ${started.length} 个 Eval`);
      // 演示：对每个新 Eval 自动判定为 accept（模拟 Router 轻量模型判定）
      for (const ev of started) {
        const ticket = router.decide(ev.id.value, 'accept', 'demo-auto');
        if (ticket) {
          executor.enqueue(ticket);
          console.log(`[superagent-platform] 创建 Ticket ${ticket.id.value} 并入队`);
        }
      }
    }
    // 执行器泵：处理队列
    executor.drain();
  }, 500);
}

// 优雅关闭
process.on('SIGINT', async () => {
  console.log('\n[superagent-platform] 关闭中...');
  await server.close();
  store.close();
  configWatcher.stop();
  process.exit(0);
});

main().catch((err) => {
  console.error('[superagent-platform] 启动失败:', err);
  process.exit(1);
});
