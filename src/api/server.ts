/**
 * api/server.ts
 *
 * REST API 服务（Fastify）
 * - POST /api/triggers      提交 Trigger
 * - GET  /api/threads       查询 Thread 列表
 * - GET  /api/threads/:key  查询单 Thread 详情
 * - GET  /api/tickets       查询 Ticket 列表
 * - GET  /api/tickets/:id   查询单 Ticket
 * - GET  /api/stats         调度统计
 * - GET  /api/watchdog      Watchdog 统计
 * - GET  /api/config        当前配置
 * - PUT  /api/config        更新配置
 * - GET  /api/health        健康检查
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { type Router } from '../core/router.js';
import { type Executor } from '../executor/executor.js';
import { type Watchdog } from '../watchdog/watchdog.js';
import { TriggerSchema, PolicySchema, type TriggerInput, type Policy } from '../core/types.js';
import { type Store } from '../store/db.js';

export interface ApiDeps {
  router: Router;
  executor: Executor;
  watchdog: Watchdog;
  store: Store;
  getPolicy: () => Policy;
  setPolicy: (p: Policy) => void;
}

export function createServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  // ============================================================
  // Triggers
  // ============================================================

  app.post('/api/triggers', async (request, reply) => {
    const parsed = TriggerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_trigger', details: parsed.error.flatten() });
    }
    const input = parsed.data as TriggerInput;
    const trigger = {
      id: { value: `trg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` },
      sourceId: { value: input.sourceId },
      threadKey: { value: input.threadKey },
      payload: input.payload,
      at: Date.now(),
      gate: {
        strength: input.strength,
        admissible: true,
        fastPath: true,
        started: false,
        delivered: false,
      },
      description: input.description,
    };
    deps.router.submitTrigger(trigger);
    return reply.code(201).send({ ok: true, triggerId: trigger.id.value });
  });

  // ============================================================
  // Threads
  // ============================================================

  app.get('/api/threads', async () => {
    const threads = deps.router.getAllThreads();
    return {
      threads: threads.map((t) => ({
        key: t.key.value,
        status: t.status,
        pendingCount: t.pending.length,
        historyCount: t.history.length,
        evaluating: t.evaluating?.id.value ?? null,
        lastActiveAt: t.lastActiveAt,
      })),
    };
  });

  app.get('/api/threads/:key', async (request) => {
    const { key } = request.params as { key: string };
    const thread = deps.router.getThread(key);
    if (!thread) return { error: 'not_found' };
    return {
      thread: {
        key: thread.key.value,
        status: thread.status,
        pending: thread.pending.map((t) => ({ id: t.id.value, strength: t.gate.strength, description: t.description, at: t.at })),
        history: thread.history,
        evaluating: thread.evaluating,
      },
    };
  });

  // ============================================================
  // Tickets
  // ============================================================

  app.get('/api/tickets', async () => {
    const tickets = deps.router.getAllTickets();
    return {
      tickets: tickets.map((t) => ({
        id: t.id.value,
        evalId: t.evalId.value,
        threadKey: t.threadKey.value,
        status: t.status,
        contextBudget: t.contextBudget,
        contextUsed: t.contextUsed,
        priority: t.priority,
      })),
    };
  });

  app.get('/api/tickets/:id', async (request) => {
    const { id } = request.params as { id: string };
    const ticket = deps.router.getTicket(id);
    if (!ticket) return { error: 'not_found' };
    const result = deps.executor.getResult(id);
    return { ticket, result };
  });

  // ============================================================
  // Stats
  // ============================================================

  app.get('/api/stats', async () => {
    return {
      router: deps.router.getStats(),
      executor: deps.executor.getStats(),
      watchdog: deps.watchdog.getStats(),
      db: deps.store.getTicketCounts(),
    };
  });

  app.get('/api/watchdog', async () => {
    return {
      stats: deps.watchdog.getStats(),
      form: deps.getPolicy().watchdog.form,
      enabled: deps.getPolicy().watchdog.enabled,
    };
  });

  // ============================================================
  // Config
  // ============================================================

  app.get('/api/config', async () => {
    return deps.getPolicy();
  });

  app.put('/api/config', async (request, reply) => {
    const body = request.body as Partial<Policy>;
    // I2：PolicySchema 校验，拒绝非法值（tokenBudget<0、watchdog 垃圾等）
    const merged = PolicySchema.safeParse({ ...deps.getPolicy(), ...body });
    if (!merged.success) {
      return reply.code(400).send({ error: 'invalid_config', details: merged.error.flatten() });
    }
    deps.setPolicy(merged.data as Policy);
    return { ok: true, config: deps.getPolicy() };
  });

  // ============================================================
  // Health
  // ============================================================

  app.get('/api/health', async () => {
    return {
      status: 'ok',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      router: deps.router.getStats().totalEvals,
      executor: deps.executor.getRunningCount(),
    };
  });

  return app;
}
