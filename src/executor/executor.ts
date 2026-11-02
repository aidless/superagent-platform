/**
 * executor/executor.ts
 *
 * 多 Worker 并发执行器（对应 DeepSeek 003-execution 关键限制）
 * - 上下文隔离：每个 Worker 独立上下文
 * - 并发槽位：普通槽 + 1 个人类消息专用槽（槽满时人消息可插队）
 * - 后台任务时限：每轮后台最多 30 分钟，到点 kill 并报 waiting
 */

import { type Ticket } from '../core/types.js';
import { type Watchdog } from '../watchdog/watchdog.js';
import { type TrajectoryState } from '../watchdog/semantics.js';

/** 执行器配置 */
export interface ExecutorConfig {
  /** 并发 Worker 数 */
  maxConcurrent: number;
  /** 人类消息专用槽 */
  humanSlot: boolean;
  /** 后台任务时限（ms） */
  maxBackendRunMs: number;
  /** 输出消息重试 backoff（ms） */
  retryBackoffMs: number;
  /** 可选：Assignment 生命周期回调（I3 接线，持久化用） */
  onAssignment?: (assignment: {
    id: string;
    ticketId: string;
    executorId: string;
    status: 'active' | 'completed' | 'failed';
    startedAt: number;
    completedAt?: number;
    watchdogVerdict?: string;
    watchdogExtended?: string;
  }) => void;
}

/** Worker 执行单元 */
export interface Worker {
  id: string;
  /** 当前绑定 Ticket */
  currentTicket?: Ticket;
  /** 当前状态 */
  status: 'idle' | 'busy';
  /** 上下文（隔离） */
  context: {
    messages: unknown[];
    tokensUsed: number;
  };
  /** 执行开始时间 */
  startedAt?: number;
}

/** 执行结果 */
export interface ExecResult {
  ticketId: string;
  status: 'completed' | 'failed' | 'expired';
  result?: unknown;
  error?: string;
  /** 最终轨迹（Watchdog 监督输入） */
  trajectory: TrajectoryState[];
  /** 是否被抢占（Watchdog 拦截） */
  preempted?: boolean;
}

/** 任务执行函数（注入的 worker 实现） */
export type TaskRunner = (
  ticket: Ticket,
  worker: Worker,
  signal: AbortSignal,
) => Promise<{ result?: unknown; error?: string; trajectory: TrajectoryState[] }>;

export type ExecutorEvent =
  | { type: 'ticket.completed'; ticket: Ticket; result: ExecResult }
  | { type: 'ticket.failed'; ticket: Ticket; result: ExecResult }
  | { type: 'ticket.expired'; ticket: Ticket; result: ExecResult };

export class Executor {
  private workers: Worker[] = [];
  private queue: Ticket[] = [];
  private running = new Map<string, AbortController>();
  private completed = new Map<string, ExecResult>();
  private runner: TaskRunner;
  private listeners: Array<(e: ExecutorEvent) => void> = [];

  constructor(
    private config: ExecutorConfig,
    runner: TaskRunner,
    private watchdog: Watchdog,
  ) {
    this.runner = runner;
    for (let i = 0; i < config.maxConcurrent; i++) {
      this.workers.push({
        id: `worker-${i + 1}`,
        status: 'idle',
        context: { messages: [], tokensUsed: 0 },
      });
    }
  }

  /** 入队 Ticket */
  enqueue(ticket: Ticket, isHumanMessage = false): void {
    // 人类消息可插队（专用槽）
    if (isHumanMessage) {
      // 插到队首，绕过普通槽
      this.queue.unshift(ticket);
    } else {
      this.queue.push(ticket);
    }
    this.pump();
  }

  /** 泵：分配空闲 Worker */
  private pump(): void {
    for (const worker of this.workers) {
      if (worker.status === 'idle' && this.queue.length > 0) {
        const ticket = this.queue.shift()!;
        this.assign(worker, ticket);
      }
    }
  }

  /** 公开泵：驱动队列分配（供 index.ts 周期性调用） */
  drain(): void {
    this.pump();
  }

  /** 订阅执行器事件 */
  on(listener: (e: ExecutorEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(e: ExecutorEvent): void {
    for (const l of this.listeners) l(e);
  }

  private async assign(worker: Worker, ticket: Ticket): Promise<void> {
    worker.status = 'busy';
    worker.currentTicket = ticket;
    worker.startedAt = Date.now();
    worker.context.messages = [];
    worker.context.tokensUsed = 0;

    const controller = new AbortController();
    this.running.set(ticket.id.value, controller);

    // I3：Assignment 创建（持久化回调）
    const assignmentId = `asg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const assignmentStartedAt = Date.now();
    this.config.onAssignment?.({
      id: assignmentId,
      ticketId: ticket.id.value,
      executorId: worker.id,
      status: 'active',
      startedAt: assignmentStartedAt,
    });

    // 后台时限（003-execution：每轮后台最多 maxBackendRunMs，到点 kill）
    const timer = setTimeout(() => controller.abort(), this.config.maxBackendRunMs);

    try {
      const { result, error, trajectory } = await this.runner(ticket, worker, controller.signal);

      // Watchdog 监督（逐步检查）
      const wdResult = this.watchdog.supervise(ticket.id.value, worker.id, trajectory ?? []);
      const preempted = wdResult.verdict === 'STALLED';

      const execResult: ExecResult = {
        ticketId: ticket.id.value,
        status: preempted ? 'expired' : error ? 'failed' : 'completed',
        result,
        error,
        trajectory: trajectory ?? [],
        preempted,
      };
      this.completed.set(ticket.id.value, execResult);
      ticket.status = preempted ? 'expired' : error ? 'failed' : 'completed';
      ticket.contextUsed = worker.context.tokensUsed;
      ticket.updatedAt = Date.now();
      // I3：Assignment 完成（持久化回调）
      this.config.onAssignment?.({
        id: assignmentId,
        ticketId: ticket.id.value,
        executorId: worker.id,
        status: preempted ? 'failed' : error ? 'failed' : 'completed',
        startedAt: assignmentStartedAt,
        completedAt: Date.now(),
        watchdogVerdict: wdResult.verdict,
        watchdogExtended: wdResult.extended,
      });
      this.emit({
        type: preempted ? 'ticket.expired' : error ? 'ticket.failed' : 'ticket.completed',
        ticket,
        result: execResult,
      });
    } catch (err) {
      const execResult: ExecResult = {
        ticketId: ticket.id.value,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        trajectory: [],
      };
      this.completed.set(ticket.id.value, execResult);
      ticket.status = 'failed';
      ticket.updatedAt = Date.now();
      // I3：Assignment 失败（持久化回调）
      this.config.onAssignment?.({
        id: assignmentId,
        ticketId: ticket.id.value,
        executorId: worker.id,
        status: 'failed',
        startedAt: assignmentStartedAt,
        completedAt: Date.now(),
      });
      this.emit({ type: 'ticket.failed', ticket, result: execResult });
    } finally {
      clearTimeout(timer);
      this.running.delete(ticket.id.value);
      worker.status = 'idle';
      worker.currentTicket = undefined;
      worker.startedAt = undefined;
      this.pump();
    }
  }

  // ============================================================
  // 查询 API
  // ============================================================

  getRunningCount(): number {
    return [...this.running.keys()].length;
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  getResult(ticketId: string): ExecResult | undefined {
    return this.completed.get(ticketId);
  }

  getAllResults(): ExecResult[] {
    return [...this.completed.values()];
  }

  getWorkers(): Worker[] {
    return this.workers;
  }

  getStats() {
    return {
      running: this.getRunningCount(),
      queued: this.getQueueLength(),
      completed: this.completed.size,
      idleWorkers: this.workers.filter((w) => w.status === 'idle').length,
      totalWorkers: this.workers.length,
    };
  }
}
