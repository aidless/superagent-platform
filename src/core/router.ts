/**
 * core/router.ts
 *
 * Router 调度器（对应 DeepSeek Super-agent 原型 engine.ts evaluateDue() + evals.ts start()）
 *
 * dir1 迁移机制的落地：
 * - 机制一：token_budget 显式化（evals.ts:110 加预算截断）
 * - 机制三：抢占语义（资源不足时驱逐最低优先级，对应 scheduler.py:936-985）
 *
 * 批处理合并逻辑（DeepSeek 现状保留）：
 * - evaluateDue()：①过期Eval重排②恢复中断Ticket③启动等待中无evaluating的Thread的Eval
 * - start()：合并 thread.pending 全部 Trigger 成一次 Eval，取 strongest
 */

import {
  type Thread,
  type Trigger,
  type Eval,
  type EvalDecision,
  type EvalId,
  type Policy,
  type Ticket,
  type TicketId,
  genId,
  strengthValue,
} from './types.js';

/** Eval 过期重排的入队器（对应 evals.ts REQUEUES 逻辑） */
export class RequeueTracker {
  private count = new Map<string, number>();
  constructor(private readonly maxRequeues: number) {}

  /** 检查是否可重排（未超 REQUEUES 上限） */
  canRequeue(evalId: string): boolean {
    const c = this.count.get(evalId) ?? 0;
    return c < this.maxRequeues;
  }

  /** 记录一次重排 */
  record(evalId: string): void {
    const c = this.count.get(evalId) ?? 0;
    this.count.set(evalId, c + 1);
  }

  getCount(evalId: string): number {
    return this.count.get(evalId) ?? 0;
  }
}

/** 调度统计（监控面板用） */
export interface SchedulerStats {
  totalEvals: number;
  totalTickets: number;
  totalPreemptions: number;
  totalExpired: number;
  totalUnavailable: number;
  /** 批大小分布 */
  batchSizes: number[];
  /** 平均批大小 */
  avgBatchSize: number;
  /** 最近 100 次 Eval 耗时（ms） */
  recentEvalDurations: number[];
}

export class Router {
  private threads = new Map<string, Thread>();
  private evals = new Map<string, Eval>();
  private tickets = new Map<string, Ticket>();
  private requeueTracker: RequeueTracker;
  private stats: SchedulerStats = {
    totalEvals: 0,
    totalTickets: 0,
    totalPreemptions: 0,
    totalExpired: 0,
    totalUnavailable: 0,
    batchSizes: [],
    avgBatchSize: 0,
    recentEvalDurations: [],
  };

  /** 监听器：Eval 开始/判定/过期 */
  private listeners: Array<(event: RouterEvent) => void> = [];

  constructor(private policy: Policy) {
    this.requeueTracker = new RequeueTracker(policy.requeues);
  }

  // ============================================================
  // 公开 API
  // ============================================================

  /** 提交一个 Trigger（外部入口） */
  submitTrigger(trigger: Trigger): void {
    let thread = this.threads.get(trigger.threadKey.value);
    if (!thread) {
      thread = {
        key: trigger.threadKey,
        sourceId: trigger.sourceId,
        pending: [],
        history: [],
        status: 'idle',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      this.threads.set(trigger.threadKey.value, thread);
    }
    thread.pending.push(trigger);
    thread.lastActiveAt = Date.now();
    this.emit({ type: 'trigger.submitted', trigger });
  }

  /**
   * evaluateDue()：核心调度循环（对应 engine.ts:75-85）
   * ① 过期 Eval 重排（超 REQUEUES 记 unavailable）
   * ② 恢复中断 Ticket
   * ③ 启动等待中且无 evaluating 的 Thread 的 Eval（合并积压）
   */
  evaluateDue(): Eval[] {
    const started: Eval[] = [];

    // ① 过期 Eval 重排
    const now = Date.now();
    for (const evalObj of this.evals.values()) {
      if (evalObj.decision === undefined && now > evalObj.deadline) {
        this.handleExpired(evalObj);
      }
    }

    // ② 恢复中断 Ticket（pending 状态的 Ticket 重新入队）
    for (const ticket of this.tickets.values()) {
      if (ticket.status === 'pending' && ticket.updatedAt < now - 1000) {
        // 已在 pending 队列，无需额外动作
      }
    }

    // ③ 启动等待中且无 evaluating 的 Thread 的 Eval
    for (const thread of this.threads.values()) {
      if (thread.pending.length > 0 && !thread.evaluating && thread.status !== 'paused') {
        const ev = this.start(thread.key.value);
        if (ev) started.push(ev);
      }
    }

    return started;
  }

  /**
   * start()：合并 thread.pending 全部 Trigger 成一次 Eval（对应 evals.ts:71-119）
   *
   * token_budget 显式化：若 pending 数 > policy.tokenBudget，只取前 tokenBudget 个
   * （机制一：上下文窗口从隐式升格为显式数值截断）
   */
  start(threadKeyValue: string): Eval | null {
    const thread = this.threads.get(threadKeyValue);
    if (!thread || thread.pending.length === 0 || thread.evaluating) return null;

    // 机制一：token_budget 显式化截断
    const budget = this.policy.tokenBudget;
    let toProcess: Trigger[];
    if (budget === Infinity || thread.pending.length <= budget) {
      toProcess = [...thread.pending];
    } else {
      toProcess = thread.pending.slice(0, budget);
      // 剩余留到下一轮
      thread.pending = thread.pending.slice(budget);
    }

    // 取 strongest（gate.strength 比较 + trigger.at 时间较新者）
    let strongest: Trigger = toProcess[0];
    for (const t of toProcess.slice(1)) {
      if (
        strengthValue(t.gate.strength) > strengthValue(strongest.gate.strength) ||
        (strengthValue(t.gate.strength) === strengthValue(strongest.gate.strength) && t.at > strongest.at)
      ) {
        strongest = t;
      }
    }

    // 全部不可准入 → ignore（清空 pending，避免每泵周期重扫）
    if (!toProcess.some((t) => t.gate.admissible)) {
      thread.pending = thread.pending.filter((t) => !toProcess.includes(t));
      this.recordDecision(thread, toProcess, 'ignore', 'all inadmissible');
      return null;
    }

    // 构造 Eval（对应 evals.ts:107 evalId=key('eval',...thread.pending)）
    const evalId: EvalId = { value: genId('eval') };
    const evalObj: Eval = {
      id: evalId,
      threadKey: thread.key,
      triggerIds: toProcess.map((t) => t.id),
      triggers: toProcess,
      primaryTriggerId: strongest.id,
      strength: strongest.gate.strength,
      actor: 'router',
      basis: 'gate-strength',
      policyVersion: this.policy.version,
      startedAt: Date.now(),
      deadline: Date.now() + this.policy.evalTimeoutMs,
      requeueCount: 0,
    };
    thread.evaluating = evalObj;
    thread.status = 'evaluating';

    // 清空 pending（已合并进 Eval）
    thread.pending = [];

    this.evals.set(evalId.value, evalObj);
    this.stats.totalEvals++;
    this.stats.batchSizes.push(toProcess.length);

    this.emit({ type: 'eval.started', eval: evalObj, batchSize: toProcess.length });
    return evalObj;
  }

  /**
   * decide()：Eval 判定结果（对应 evals.ts decide()）
   * accept → 创建 Ticket（Mandate 授权）；stop → 结束 Thread；ignore → 丢弃
   */
  decide(evalId: string, decision: EvalDecision, basis?: string): Ticket | null {
    const evalObj = this.evals.get(evalId);
    if (!evalObj || evalObj.decision !== undefined) return null;

    evalObj.decision = decision;
    evalObj.completedAt = Date.now();
    evalObj.basis = basis ?? evalObj.basis;

    const thread = this.threads.get(evalObj.threadKey.value);
    if (thread) {
      thread.history.push({
        triggerIds: evalObj.triggerIds,
        decision,
        at: Date.now(),
        strength: evalObj.strength,
      });
      thread.evaluating = undefined;
      thread.status = decision === 'stop' ? 'done' : 'idle';
      thread.lastActiveAt = Date.now();
    }

    this.emit({ type: 'eval.decided', eval: evalObj, decision });

    if (decision === 'accept') {
      return this.createTicket(evalObj);
    }
    return null;
  }

  /**
   * 抢占：资源不足时驱逐最低优先级（对应 scheduler.py:936-985, _preempt_request:1808）
   * 被驱逐的 Eval → 重新入队（重算粒度 = Eval 级，对应 num_computed_tokens=0 整请求重算）
   */
  preempt(evalId: string): boolean {
    const evalObj = this.evals.get(evalId);
    if (!evalObj || evalObj.decision !== undefined) return false;

    // 驱逐最低优先级（PRIORITY 用 max((priority, arrival_time))；FCFS 用 running[-1]）
    let victim: Eval | null = null;
    let victimScore = Infinity;
    for (const e of this.evals.values()) {
      if (e.decision !== undefined) continue;
      const score = this.preemptionScore(e);
      if (score < victimScore) {
        victimScore = score;
        victim = e;
      }
    }

    if (!victim || victim.id.value !== evalId) return false;

    // 重算（整请求重算语义）：标记过期并重排
    victim.decision = 'unavailable';
    victim.completedAt = Date.now();
    this.stats.totalPreemptions++;
    this.emit({ type: 'eval.preempted', eval: victim });

    // 重新入队 Thread 的 pending（把该 Eval 的 Trigger 放回）
    const thread = this.threads.get(victim.threadKey.value);
    if (thread) {
      thread.evaluating = undefined;
      thread.status = 'idle';
      thread.pending.push(...victim.triggers);
      thread.lastActiveAt = Date.now();
      // 重新触发
      this.requeueTracker.record(victim.id.value);
      this.emit({ type: 'eval.requeued', eval: victim });
    }
    return true;
  }

  /** 恢复中断 Ticket */
  resumeTicket(ticketId: string): boolean {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) return false;
    if (ticket.status === 'completed' || ticket.status === 'failed') return false;
    ticket.status = 'pending';
    ticket.updatedAt = Date.now();
    this.emit({ type: 'ticket.resumed', ticket });
    return true;
  }

  // ============================================================
  // 查询 API（监控/API 用）
  // ============================================================

  getThread(threadKey: string): Thread | undefined {
    return this.threads.get(threadKey);
  }

  getEval(evalId: string): Eval | undefined {
    return this.evals.get(evalId);
  }

  getTicket(ticketId: string): Ticket | undefined {
    return this.tickets.get(ticketId);
  }

  getAllThreads(): Thread[] {
    return [...this.threads.values()];
  }

  getAllTickets(): Ticket[] {
    return [...this.tickets.values()];
  }

  getStats(): SchedulerStats {
    const sizes = this.stats.batchSizes;
    const avg = sizes.length > 0 ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0;
    return { ...this.stats, avgBatchSize: avg };
  }

  setPolicy(policy: Policy): void {
    this.policy = policy;
  }

  getPolicy(): Policy {
    return this.policy;
  }

  /** 强制把所有进行中的 Eval 标记为过期（测试用） */
  markAllExpired(): void {
    const now = Date.now();
    for (const [, evalObj] of this.evals.entries()) {
      if (evalObj.decision === undefined) {
        evalObj.deadline = now - 1; // 强制过期
        this.handleExpired(evalObj);
      }
    }
  }

  on(event: (e: RouterEvent) => void): void {
    this.listeners.push(event);
  }

  // ============================================================
  // 内部
  // ============================================================

  private handleExpired(evalObj: Eval): void {
    // 超 REQUEUES 上限 → unavailable
    if (!this.requeueTracker.canRequeue(evalObj.id.value)) {
      evalObj.decision = 'unavailable';
      evalObj.completedAt = Date.now();
      this.stats.totalUnavailable++;
      this.emit({ type: 'eval.unavailable', eval: evalObj });
      return;
    }

    // 可重排：重新入队（对应 evals.ts expire() 重排 Triggers）
    this.requeueTracker.record(evalObj.id.value);
    this.stats.totalExpired++;
    evalObj.decision = 'unavailable';
    evalObj.completedAt = Date.now();
    this.emit({ type: 'eval.expired', eval: evalObj });

    // 把 Trigger 放回 Thread.pending 重新评估（忠实回填原始 Trigger 对象）
    const thread = this.threads.get(evalObj.threadKey.value);
    if (thread) {
      thread.evaluating = undefined;
      thread.status = 'idle';
      thread.pending.push(...evalObj.triggers);
      thread.lastActiveAt = Date.now();
      this.emit({ type: 'eval.requeued', eval: evalObj });
    }
  }

  private createTicket(evalObj: Eval): Ticket {
    const ticketId: TicketId = { value: genId('ticket') };
    const ticket: Ticket = {
      id: ticketId,
      evalId: evalObj.id,
      threadKey: evalObj.threadKey,
      mandate: {
        id: genId('mandate'),
        evalId: evalObj.id,
        action: 'exec',
        description: `Execute ${evalObj.triggerIds.length} trigger(s) from thread ${evalObj.threadKey.value}`,
        at: Date.now(),
      },
      status: 'pending',
      // 机制一：token_budget 显式化 → 每个 Ticket 分得上下文预算
      contextBudget: this.policy.contextWindowBudget,
      contextUsed: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      priority: this.preemptionScore(evalObj),
    };
    this.tickets.set(ticketId.value, ticket);
    this.stats.totalTickets++;
    this.emit({ type: 'ticket.created', ticket });
    return ticket;
  }

  private preemptionScore(e: Eval): number {
    if (this.policy.preemptionPolicy === 'FCFS') return e.startedAt;
    // PRIORITY：max((priority, arrival_time)) —— 低分者先被驱逐
    const strength = strengthValue(e.strength);
    return strength * 1e9 + e.startedAt;
  }

  private recordDecision(
    thread: Thread,
    triggers: Trigger[],
    decision: EvalDecision,
    basis: string,
  ): void {
    thread.history.push({
      triggerIds: triggers.map((t) => t.id),
      decision,
      at: Date.now(),
      strength: triggers[0]?.gate.strength ?? 'medium',
    });
    thread.status = 'idle';
    this.emit({ type: 'eval.decided', decision, basis } as RouterEvent);
  }

  private emit(event: RouterEvent): void {
    for (const l of this.listeners) l(event);
  }
}

/** Router 事件（监控/日志用） */
export type RouterEvent =
  | { type: 'trigger.submitted'; trigger: Trigger }
  | { type: 'eval.started'; eval: Eval; batchSize: number }
  | { type: 'eval.decided'; eval: Eval; decision: EvalDecision; basis?: string }
  | { type: 'eval.expired'; eval: Eval }
  | { type: 'eval.unavailable'; eval: Eval }
  | { type: 'eval.preempted'; eval: Eval }
  | { type: 'eval.requeued'; eval: Eval }
  | { type: 'ticket.created'; ticket: Ticket }
  | { type: 'ticket.resumed'; ticket: Ticket };
