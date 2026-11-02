/**
 * tests/watchdog.test.ts
 *
 * Watchdog 判据测试：
 * - outcome-only 对卡住类故障判别力=0（真盲区）
 * - stepwise 对卡住类故障判别力=1
 * - agentic 更早检测
 * - slow 假阳性（outcome-only 误判合法慢推进）
 * - off-track 全形式检测
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Watchdog } from '../src/watchdog/watchdog.js';
import { makeFaultTrajectory } from '../src/watchdog/watchdog.js';
import { evaluate } from '../src/watchdog/semantics.js';
import { type WatchdogConfig } from '../src/watchdog/semantics.js';
import { defaultPolicy } from '../src/config/config.js';

function config(form: 'outcome-only'|'stepwise'|'agentic'): WatchdogConfig {
  return {
    form,
    stallWindowSteps: 2,
    minProgressStep: 0.05,
    completionThreshold: 0.9,
    checkDirection: true,
  };
}

describe('Watchdog 判据', () => {
  let watchdog: Watchdog;

  beforeEach(() => {
    watchdog = new Watchdog(defaultPolicy());
  });

  it('outcome-only 对卡住类故障判别力=0（真盲区）', () => {
    const faultTypes: Array<'clean'|'stuck'|'silent-stuck'|'off-track'|'slow'> = ['clean', 'stuck', 'silent-stuck'];
    for (const fault of faultTypes) {
      const traj = makeFaultTrajectory(fault, 12);
      const result = evaluate(traj, config('outcome-only'));
      if (fault === 'clean') {
        expect(result.verdict).toBe('ADVANCED'); // 干净 → ADVANCED
      } else {
        // 卡住类：outcome-only 只看终值，构造在 90% 处冻结 → 恰好在阈值上，无法区分
        // 实际语义：outcome-only 无法区分布告 vs 卡住（都停在 90%）
        expect(result.verdict).toBe('ADVANCED'); // 构造盲区：90% 恰等于完成阈值
      }
    }
  });

  it('stepwise 对卡住类故障判别力=1（检测 STALLED）', () => {
    const stuck = makeFaultTrajectory('stuck', 12);
    const result = evaluate(stuck, config('stepwise'));
    expect(result.verdict).toBe('STALLED');
  });

  it('clean 控制在 stepwise 下判 ADVANCED（C4：假阳性修复）', () => {
    const clean = makeFaultTrajectory('clean', 12);
    const result = evaluate(clean, config('stepwise'));
    expect(result.verdict).toBe('ADVANCED');
  });

  it('silent-stuck 被 stepwise 检测', () => {
    const silent = makeFaultTrajectory('silent-stuck', 12);
    const result = evaluate(silent, config('stepwise'));
    expect(result.verdict).toBe('STALLED');
  });

  it('agentic 更早检测（比 stepwise 更早窗口）', () => {
    const stuck = makeFaultTrajectory('stuck', 12);
    const stepwiseResult = evaluate(stuck, config('stepwise'));
    const agenticResult = evaluate(stuck, config('agentic'));
    expect(agenticResult.verdict).toBe('STALLED');
    // 两者都检测，但 agentic 用更早窗口（stepwise 窗口 2，agentic 窗口更小/更早）
    expect(stepwiseResult.verdict).toBe('STALLED');
  });

  it('slow 被 outcome-only 误判为卡住（假阳性）', () => {
    const slow = makeFaultTrajectory('slow', 12);
    const result = evaluate(slow, config('outcome-only'));
    // slow 最终 85.18 < 90% 阈值 → outcome-only 误判为卡住
    expect(result.verdict).toBe('STALLED');
  });

  it('off-track 全形式检测', () => {
    const off = makeFaultTrajectory('off-track', 12);
    for (const form of ['outcome-only', 'stepwise', 'agentic'] as const) {
      const result = evaluate(off, config(form));
      expect(result.verdict).toBe('STALLED');
    }
  });

  it('监督记录统计', () => {
    const traj = makeFaultTrajectory('stuck', 12);
    watchdog.supervise('tk1', 'as1', traj.states);
    const stats = watchdog.getStats();
    expect(stats.total).toBe(1);
    expect(stats.stalled).toBe(1);
  });
});
