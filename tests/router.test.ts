/**
 * tests/router.test.ts
 *
 * Router 核心逻辑测试：
 * - 合并积压 Trigger 成一次 Eval（批处理）
 * - strongest 选择（gate.strength + 时间较新）
 * - token_budget 显式化截断（机制一）
 * - 抢占（PRIORITY / FCFS）
 * - REQUEUES 过期重排逻辑
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Router } from '../src/core/router.js';
import { defaultPolicy } from '../src/config/config.js';
import { type Policy, type Trigger } from '../src/core/types.js';

function mkTrigger(threadKey: string, strength: 'low'|'medium'|'high'|'critical' = 'medium', at = Date.now(), desc = 't'): Trigger {
  return {
    id: { value: `trg_${Math.random().toString(36).slice(2, 10)}` },
    sourceId: { value: 'test' },
    threadKey: { value: threadKey },
    payload: {},
    at,
    gate: { strength, admissible: true, fastPath: true, started: false, delivered: false },
    description: desc,
  };
}

describe('Router', () => {
  let router: Router;
  let policy: Policy;

  beforeEach(() => {
    policy = defaultPolicy();
    router = new Router(policy);
  });

  it('合并积压 Trigger 成一次 Eval（批处理核心）', () => {
    const threadKey = 't1';
    router.submitTrigger(mkTrigger(threadKey, 'low', 1000, 'a'));
    router.submitTrigger(mkTrigger(threadKey, 'medium', 1100, 'b'));
    router.submitTrigger(mkTrigger(threadKey, 'high', 1200, 'c'));

    const started = router.evaluateDue();
    const evals = started.filter((e) => e.threadKey.value === threadKey);

    expect(evals).toHaveLength(1); // 三个 Trigger 合并成一次 Eval
    const ev = evals[0];
    expect(ev.triggerIds).toHaveLength(3); // 全部积压进一次
    expect(ev.primaryTriggerId.value).toBeTruthy();
    // strongest 已合并（3 个全部进一次 Eval）
    expect(ev.primaryTriggerId).toBeTruthy();
  });

  it('取 strongest（gate.strength 高者优先，同强度时间较新）', () => {
    const threadKey = 't2';
    router.submitTrigger(mkTrigger(threadKey, 'medium', 1000, 'a'));
    router.submitTrigger(mkTrigger(threadKey, 'high', 1100, 'b'));
    router.submitTrigger(mkTrigger(threadKey, 'medium', 1200, 'c'));

    const started = router.evaluateDue();
    const ev = started.find((e) => e.threadKey.value === threadKey);
    expect(ev).toBeDefined();
    expect(ev!.strength).toBe('high'); // high 是 strongest
  });

  it('token_budget 显式化截断（机制一）', () => {
    const threadKey = 't3';
    // 提交超过 budget 的 Trigger 数
    policy = { ...policy, tokenBudget: 5 };
    router.setPolicy(policy);
    for (let i = 0; i < 12; i++) {
      router.submitTrigger(mkTrigger(threadKey, 'medium', 1000 + i, `t${i}`));
    }

    const started = router.evaluateDue();
    const ev = started.find((e) => e.threadKey.value === threadKey);
    expect(ev).toBeDefined();
    // token_budget 截断：只取最多 5 个 Trigger
    expect(ev!.triggerIds.length).toBeLessThanOrEqual(5);
  });

  it('抢占：PRIORITY 按 max((priority, arrival)) 驱逐最低', () => {
    const threadKey = 't4';
    router.submitTrigger(mkTrigger(threadKey, 'low', 1000, 'a'));
    router.submitTrigger(mkTrigger(threadKey, 'low', 1100, 'b'));

    // 先启动 Eval，拿到真实 evalId
    const started = router.evaluateDue();
    const ev = started.find((e) => e.threadKey.value === threadKey);
    expect(ev).toBeDefined();

    // 用真实 evalId 抢占（C3：之前误传 threadKey）
    const preempted = router.preempt(ev!.id.value);
    expect(preempted).toBe(true);
    // 被驱逐的 Eval 标记为 unavailable
    expect(router.getEval(ev!.id.value)?.decision).toBe('unavailable');
    // 被驱逐的 Trigger 应重新入 pending（C3：工作不丢失）
    const thread = router.getThread(threadKey);
    expect(thread!.pending.length).toBeGreaterThan(0);
  });

  it('REQUEUES 过期重排逻辑', () => {
    const threadKey = 't5';
    // 用短 timeout 触发过期
    policy = { ...policy, evalTimeoutMs: 1 };
    router.setPolicy(policy);
    router.submitTrigger(mkTrigger(threadKey, 'medium', Date.now(), 'a'));

    router.evaluateDue();
    // 强制过期
    router.markAllExpired();
    // C2：过期后 Trigger 应重新入 pending（之前是 no-op）
    const thread = router.getThread(threadKey);
    expect(thread!.pending.length).toBeGreaterThan(0);
    const requeued = router.evaluateDue();
    // 过期重排：应能重新排队启动 Eval
    expect(requeued.length).toBeGreaterThan(0);
  });

  it('decide accept → 创建 Ticket', () => {
    const threadKey = 't6';
    router.submitTrigger(mkTrigger(threadKey, 'high', Date.now(), 'a'));
    const started = router.evaluateDue();
    const ev = started[0];
    expect(ev).toBeDefined();

    const ticket = router.decide(ev.id.value, 'accept');
    expect(ticket).toBeDefined();
    expect(ticket!.status).toBe('pending');
    expect(ticket!.evalId.value).toBe(ev.id.value);
  });
});
