/**
 * core/types.ts
 *
 * 域模型定义（对应 DeepSeek Super-agent 原型 001-domain + 003-execution 的关键限制）
 *
 * 核心：Source(事件流) → Trigger(不可变事件) → Thread(时间序，最多一个Eval同时跑)
 *      → Eval(判断：gate+assessment) → Mandate(授权) → Ticket(工作单元)
 *      → Assignment(Ticket绑定Executor) → Subscription(Ticket↔Thread多对多)
 */

import { z } from 'zod';

// ============================================================
// 枚举 / 常量
// ============================================================

/** Trigger 强度等级（gate 判定用，对应 gate.strength 比较） */
export const GateStrength = z.enum(['low', 'medium', 'high', 'critical']);
export type GateStrength = z.infer<typeof GateStrength>;

/** Eval 判定结果（对应 DeepSeek 001-domain 的 Decision） */
export const EvalDecision = z.enum(['accept', 'stop', 'ignore', 'unavailable']);
export type EvalDecision = z.infer<typeof EvalDecision>;

/** Ticket 状态（工作单元生命周期） */
export const TicketStatus = z.enum([
  'pending',      // 已创建未分派
  'assigned',     // 已绑定 Executor
  'running',      // 执行中
  'completed',    // 成功完成
  'failed',       // 失败
  'cancelled',    // 取消
  'expired',      // 过期（超时）
]);
export type TicketStatus = z.infer<typeof TicketStatus>;

/** Assignment 状态 */
export const AssignmentStatus = z.enum([
  'active',       // 绑定中
  'completed',    // 完成
  'interrupted',  // 中断（会话结束/抢占）
  'failed',       // 失败
]);
export type AssignmentStatus = z.infer<typeof AssignmentStatus>;

/** Thread 状态 */
export const ThreadStatus = z.enum([
  'idle',         // 无 Eval 在跑
  'evaluating',   // 有 Eval 在跑
  'paused',       // 暂停（等待人类/策略）
  'done',         // 完成
]);
export type ThreadStatus = z.infer<typeof ThreadStatus>;

/** Watchdog 判定（dir2：二值主判定 + 三值扩展） */
export const WatchdogVerdict = z.enum(['ADVANCED', 'STALLED']);
export type WatchdogVerdict = z.infer<typeof WatchdogVerdict>;

export const WatchdogExtended = z.enum(['on-track', 'stalled', 'off-track']);
export type WatchdogExtended = z.infer<typeof WatchdogExtended>;

/** Watchdog 判据形式（dir2 三形式） */
export const WatchdogForm = z.enum(['outcome-only', 'stepwise', 'agentic']);
export type WatchdogForm = z.infer<typeof WatchdogForm>;

// ============================================================
// 基础 ID 类型
// ============================================================

export interface SourceId { value: string; }
export interface TriggerId { value: string; }
export interface ThreadKey { value: string; }
export interface EvalId { value: string; }
export interface TicketId { value: string; }
export interface AssignmentId { value: string; }

// ============================================================
// Source / Trigger / Thread
// ============================================================

/** 事件源（消息/命令/外部事件流） */
export interface Source {
  id: SourceId;
  name: string;
  /** 来源类型：human / system / external */
  kind: 'human' | 'system' | 'external';
  /** 可选的订阅 Thread 列表（订阅直通） */
  subscribedThreads: ThreadKey[];
}

/** Trigger：不可变事件（对应 001-domain） */
export interface Trigger {
  id: TriggerId;
  sourceId: SourceId;
  threadKey: ThreadKey;
  /** 事件载荷 */
  payload: unknown;
  /** 产生时间（epoch ms） */
  at: number;
  /** gate 强度（Fast Path / LLM Slow Path 两级过滤） */
  gate: {
    strength: GateStrength;
    admissible: boolean;
    /** Fast Path 程序判定（同步、确定性） */
    fastPath?: boolean;
    /** 是否允许触发新 Eval 或 spawn 重复 Ticket */
    started?: boolean;
    delivered?: boolean;
  };
  /** 触发描述 */
  description: string;
}

/** Thread：时间序事件容器，最多一个 Eval 同时跑 */
export interface Thread {
  key: ThreadKey;
  sourceId: SourceId;
  /** 时间序 Trigger 队列（pending = 待合并成 Eval） */
  pending: Trigger[];
  /** 当前在跑的 Eval（若有） */
  evaluating?: Eval;
  /** 历史已判定 Trigger */
  history: EvalHistoryEntry[];
  status: ThreadStatus;
  /** 创建时间 */
  createdAt: number;
  /** 最后活跃时间 */
  lastActiveAt: number;
}

/** Eval 历史条目 */
export interface EvalHistoryEntry {
  triggerIds: TriggerId[];
  decision: EvalDecision;
  at: number;
  strength: GateStrength;
}

// ============================================================
// Eval / Mandate / Ticket / Assignment
// ============================================================

/** Eval：判断（gate+assessment），输入 = Trigger batch + Thread 快照 + Tickets + Policy */
export interface Eval {
  id: EvalId;
  threadKey: ThreadKey;
  /** 本 Eval 合并的 Trigger 集（批处理） */
  triggerIds: TriggerId[];
  /** 原始 Trigger 对象（保留引用用于过期/抢占重排的忠实回填） */
  triggers: Trigger[];
  /** 最强 Trigger（primary） */
  primaryTriggerId: TriggerId;
  strength: GateStrength;
  /** 判定者：router / assessor（LLM Slow Path） */
  actor: 'router' | 'assessor';
  /** 判定依据 */
  basis: string;
  policyVersion: string;
  /** 开始时间 */
  startedAt: number;
  /** 截止时间（超时 → 重排/抢占） */
  deadline: number;
  /** 判定结果 */
  decision?: EvalDecision;
  /** 完成时间 */
  completedAt?: number;
  /** 是否已过期重排（REQUEUES 计数） */
  requeueCount: number;
}

/** Mandate：授权（Eval → Ticket） */
export interface Mandate {
  id: string;
  evalId: EvalId;
  /** 授权动作：exec / observe / notify / reject */
  action: 'exec' | 'observe' | 'notify' | 'reject';
  /** 授权的工作描述 */
  description: string;
  /** 创建时间 */
  at: number;
}

/** Ticket：工作单元，只由 Eval 创建 */
export interface Ticket {
  id: TicketId;
  evalId: EvalId;
  threadKey: ThreadKey;
  mandate: Mandate;
  status: TicketStatus;
  /** 上下文预算（token_budget 显式化：本 Ticket 可消耗的等价 token） */
  contextBudget: number;
  /** 已消耗上下文 */
  contextUsed: number;
  createdAt: number;
  updatedAt: number;
  /** 优先级（抢占用：gate.strength 数值 + 到达时间） */
  priority: number;
}

/** Assignment：Ticket 绑定 Executor */
export interface Assignment {
  id: AssignmentId;
  ticketId: TicketId;
  executorId: string;
  status: AssignmentStatus;
  startedAt: number;
  completedAt?: number;
  /** Watchdog 监督结果 */
  watchdogVerdict?: WatchdogVerdict;
  watchdogExtended?: WatchdogExtended;
  /** 执行结果 */
  result?: unknown;
  error?: string;
}

// ============================================================
// Policy（调度策略）
// ============================================================

/** 调度策略配置（token_budget 显式化 + 抢占） */
export interface Policy {
  version: string;
  /** 调度器模式 */
  schedulingMode: 'merge-pending' | 'no-merge' | 'merge-with-priority';
  /** token_budget：一次 Eval 可合并的最大 Trigger 数（显式预算，∞ 表示不截断） */
  tokenBudget: number;
  /** 上下文窗口上限（等价 token） */
  contextWindowBudget: number;
  /** 抢占策略：PRIORITY（gate.strength+时间较新）或 FCFS */
  preemptionPolicy: 'PRIORITY' | 'FCFS';
  /** Eval 超时（ms） */
  evalTimeoutMs: number;
  /** 过期重排上限（REQUEUES=2，对应 evals.ts:19） */
  requeues: number;
  /** Watchdog 配置 */
  watchdog: {
    enabled: boolean;
    form: WatchdogForm;
    /** 逐步检查窗口（连续 k 步零增量 → STALLED） */
    stallWindowSteps: number;
    /** 单步增量阈值 */
    minProgressStep: number;
    /** 完成阈值（progress >= 阈值 → ADVANCED） */
    completionThreshold: number;
    /** 方向标志（direction_ok=False → off-track） */
    checkDirection: boolean;
  };
}

// ============================================================
// Zod schemas（API 验证用）
// ============================================================

export const TriggerSchema = z.object({
  sourceId: z.string(),
  threadKey: z.string(),
  payload: z.unknown(),
  strength: GateStrength.default('medium'),
  description: z.string(),
});

export type TriggerInput = z.infer<typeof TriggerSchema>;

export const PolicySchema = z.object({
  schedulingMode: z.enum(['merge-pending', 'no-merge', 'merge-with-priority']).default('merge-pending'),
  tokenBudget: z.number().int().positive().default(50),
  contextWindowBudget: z.number().int().positive().default(10000),
  preemptionPolicy: z.enum(['PRIORITY', 'FCFS']).default('PRIORITY'),
  evalTimeoutMs: z.number().int().positive().default(60000),
  requeues: z.number().int().min(0).default(2),
  watchdog: z.object({
    enabled: z.boolean().default(true),
    form: WatchdogForm.default('stepwise'),
    stallWindowSteps: z.number().int().min(1).default(2),
    minProgressStep: z.number().min(0.001).default(0.05),
    completionThreshold: z.number().min(0).max(1).default(0.9),
    checkDirection: z.boolean().default(true),
  }).default({
    enabled: true,
    form: 'stepwise',
    stallWindowSteps: 2,
    minProgressStep: 0.05,
    completionThreshold: 0.9,
    checkDirection: true,
  }),
});

export type PolicyInput = z.infer<typeof PolicySchema>;

// ============================================================
// 工具函数
// ============================================================

/** 生成随机 ID（对应 key('eval',...) 的哈希风格） */
export function genId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}_${time}_${rand}`;
}

/** gate.strength 数值化（抢占优先级比较） */
export function strengthValue(s: GateStrength): number {
  switch (s) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
  }
}

/** 计算抢占优先级：PRIORITY 用 max((priority, arrival_time))，FCFS 用 arrival */
export function computePriority(strength: GateStrength, at: number, policy: 'PRIORITY' | 'FCFS'): number {
  if (policy === 'FCFS') return at;
  // PRIORITY：max((priority, arrival_time)) —— 高优先或新到者胜出
  return Math.max(strengthValue(strength) * 1e9 + at, at);
}
