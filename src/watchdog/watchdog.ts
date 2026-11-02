/**
 * watchdog/watchdog.ts
 *
 * Watchdog 监督器：对执行中的 Ticket/Assignment 做逐步检查
 * 集成 dir2 判据三形式（outcome-only / stepwise / agentic）
 *
 * 核心机制（dir2 结论）：
 * - outcome-only 对卡住类判别力 = 0.000 → 默认禁用（有盲区）
 * - stepwise / agentic 判别力 = 1.000 → 推荐配置
 */

import { type Policy, type WatchdogForm } from '../core/types.js';
import { type Trajectory, type WatchdogResult, evaluate, generateTrajectory } from './semantics.js';

/** Watchdog 对单个执行单元的监督记录 */
export interface SupervisionRecord {
  ticketId: string;
  assignmentId: string;
  /** 采样到的轨迹 */
  trajectory: Trajectory;
  /** 判定结果 */
  result: WatchdogResult;
  /** 判定时间 */
  at: number;
  /** 判据形式 */
  form: WatchdogForm;
}

/** Watchdog 监督器 */
export class Watchdog {
  private records = new Map<string, SupervisionRecord[]>();

  constructor(private policy: Policy) {}

  /** 热加载：更新内部 policy 引用 */
  setPolicy(policy: Policy): void {
    this.policy = policy;
  }

  /**
   * 监督一次执行：构造轨迹 → 判定
   *
   * @param ticketId 被监督的 Ticket
   * @param assignmentId 绑定的 Assignment
   * @param states 已采样的轨迹状态（逐步检查需要中间状态）
   */
  supervise(ticketId: string, assignmentId: string, states: Trajectory['states']): WatchdogResult {
    // I1：watchdog.enabled 门禁 —— 关闭时跳过监督
    if (!this.policy.watchdog.enabled) {
      return { verdict: 'ADVANCED', extended: 'on-track' };
    }
    const wdConfig = this.policy.watchdog;
    const trajectory: Trajectory = { states, target: 100 };

    const result = evaluate(trajectory, {
      form: wdConfig.form,
      stallWindowSteps: wdConfig.stallWindowSteps,
      minProgressStep: wdConfig.minProgressStep,
      completionThreshold: wdConfig.completionThreshold,
      checkDirection: wdConfig.checkDirection,
    });

    const record: SupervisionRecord = {
      ticketId,
      assignmentId,
      trajectory,
      result,
      at: Date.now(),
      form: wdConfig.form,
    };

    const list = this.records.get(ticketId) ?? [];
    list.push(record);
    this.records.set(ticketId, list);

    return result;
  }

  /** 查询某 Ticket 的监督记录 */
  getRecords(ticketId: string): SupervisionRecord[] {
    return this.records.get(ticketId) ?? [];
  }

  /** 统计（监控面板用） */
  getStats() {
    let total = 0;
    let stalled = 0;
    let advanced = 0;
    let offTrack = 0;
    for (const list of this.records.values()) {
      for (const r of list) {
        total++;
        if (r.result.verdict === 'STALLED') stalled++;
        else if (r.result.extended === 'off-track') offTrack++;
        else advanced++;
      }
    }
    return { total, stalled, advanced, offTrack };
  }
}

/**
 * 故障注入基准复用（dir2_fault_injection.py 的 TS 版）
 * 用于集成测试：构造已知故障轨迹验证 Watchdog 判别力
 */
export function makeFaultTrajectory(
  fault: 'clean' | 'stuck' | 'silent-stuck' | 'off-track' | 'slow',
  nSteps = 12,
): Trajectory {
  return generateTrajectory({
    nSteps,
    baseProgressPerStep: 10,
    fault,
    faultStartStep: nSteps - 3,
    target: 100,
  });
}

export type { WatchdogResult, Trajectory };
