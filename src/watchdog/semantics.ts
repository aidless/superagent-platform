/**
 * watchdog/semantics.ts
 *
 * Watchdog 判据语义（dir2 自造三要素）：
 * 输入轨迹 τ=(s0,a1,...,sT) 含中间状态
 *   s_t = { progress_score ∈ [0,1], output_signature, direction_ok ∈ {True,False} }
 * 判定：二值 {ADVANCED, STALLED} + 三值 {on-track, stalled, off-track}
 * 三形式：outcome-only / stepwise / agentic
 */

import { type WatchdogExtended, type WatchdogForm, type WatchdogVerdict } from '../core/types.js';

/** 轨迹状态点 */
export interface TrajectoryState {
  /** 进度得分 [0,1] */
  progressScore: number;
  /** 输出签名（内容指纹，用于检测静默故障） */
  outputSignature: string;
  /** 方向标志 */
  directionOk: boolean;
  /** 步序号 */
  step: number;
  /** 时间戳 */
  at: number;
}

/** agent 轨迹 τ=(s0,a1,...,sT) */
export interface Trajectory {
  states: TrajectoryState[];
  /** 目标完成阈值（如 90% of target） */
  target: number;
  /** 任务描述 */
  taskDescription?: string;
}

/** Watchdog 判定结果 */
export interface WatchdogResult {
  verdict: WatchdogVerdict;
  extended: WatchdogExtended;
  /** 检测依据（哪个步发现冻结/方向偏） */
  evidence?: {
    frozenSteps?: number;
    frozenFromStep?: number;
    finalProgress?: number;
    directionOk?: boolean;
    form: WatchdogForm;
  };
}

/** 判据配置 */
export interface WatchdogConfig {
  form: WatchdogForm;
  /** 逐步检查窗口（连续 k 步零增量 → STALLED，对应 dir2 stallWindowSteps） */
  stallWindowSteps: number;
  /** 单步增量阈值（低于此视为零增量） */
  minProgressStep: number;
  /** 完成阈值（progress >= threshold * target → ADVANCED） */
  completionThreshold: number;
  /** 是否检查方向 */
  checkDirection: boolean;
}

/**
 * evaluate()：按三形式之一判定轨迹
 *
 * dir2 核心结果：
 * - outcome-only 对卡住类判别力 = 0.000（终值相同无法区分冻结与正常推进）
 * - stepwise / agentic 判别力 = 1.000（逐步检查捕获冻结窗口）
 */
export function evaluate(trajectory: Trajectory, config: WatchdogConfig): WatchdogResult {
  const { states, target } = trajectory;
  const finalState = states[states.length - 1];

  // 方向检查（off-track）
  if (config.checkDirection) {
    const dirOk = states.every((s) => s.directionOk);
    if (!dirOk) {
      return {
        verdict: 'STALLED',
        extended: 'off-track',
        evidence: {
          finalProgress: finalState.progressScore,
          directionOk: false,
          form: config.form,
        },
      };
    }
  }

  // 完成阈值（outcome-only 的判定基础）
  const completion = finalState.progressScore >= config.completionThreshold * target;

  switch (config.form) {
    case 'outcome-only': {
      // 只看最终输出（dir2 盲区：冻结在 90% 时终值看似完成）
      return {
        verdict: completion ? 'ADVANCED' : 'STALLED',
        extended: completion ? 'on-track' : 'stalled',
        evidence: {
          finalProgress: finalState.progressScore,
          directionOk: true,
          form: config.form,
        },
      };
    }

    case 'stepwise': {
      // 全轨迹离线：连续 k 步增量 ≤ minProgressStep → STALLED
      const frozen = detectStall(states, config.stallWindowSteps, config.minProgressStep);
      if (frozen.found) {
        return {
          verdict: 'STALLED',
          extended: 'stalled',
          evidence: {
            frozenSteps: frozen.steps,
            frozenFromStep: frozen.fromStep,
            finalProgress: finalState.progressScore,
            directionOk: true,
            form: config.form,
          },
        };
      }
      return {
        verdict: completion ? 'ADVANCED' : 'STALLED',
        extended: completion ? 'on-track' : 'stalled',
        evidence: { finalProgress: finalState.progressScore, directionOk: true, form: config.form },
      };
    }

    case 'agentic': {
      // 在线：单步增量 ≤ minProgressStep 即 STALLED（比 stepwise 更早，1 步窗口）
      const frozen = detectStall(states, 1, config.minProgressStep);
      if (frozen.found) {
        return {
          verdict: 'STALLED',
          extended: 'stalled',
          evidence: {
            frozenSteps: frozen.steps,
            frozenFromStep: frozen.fromStep,
            finalProgress: finalState.progressScore,
            directionOk: true,
            form: config.form,
          },
        };
      }
      return {
        verdict: completion ? 'ADVANCED' : 'STALLED',
        extended: completion ? 'on-track' : 'stalled',
        evidence: { finalProgress: finalState.progressScore, directionOk: true, form: config.form },
      };
    }
  }
}

/** 检测冻结窗口（连续 k 步增量 ≤ 阈值） */
function detectStall(
  states: TrajectoryState[],
  windowSteps: number,
  minProgressStep: number,
): { found: boolean; steps: number; fromStep: number } {
  let run = 0;
  let fromStep = -1;
  for (let i = 1; i < states.length; i++) {
    const delta = states[i].progressScore - states[i - 1].progressScore;
    if (delta <= minProgressStep) {
      if (run === 0) fromStep = i;
      run++;
      if (run >= windowSteps) {
        return { found: true, steps: run, fromStep };
      }
    } else {
      run = 0;
      fromStep = -1;
    }
  }
  return { found: false, steps: 0, fromStep: -1 };
}

/** 轨迹生成器（故障注入基准复用，dir2_fault_injection.py 的 TS 版） */
export interface TrajectoryGenOptions {
  /** 总步数 */
  nSteps: number;
  /** 每步正常推进量（基准） */
  baseProgressPerStep: number;
  /** 故障类型 */
  fault: 'clean' | 'stuck' | 'silent-stuck' | 'off-track' | 'slow';
  /** 故障注入步（晚注入构造真盲区） */
  faultStartStep?: number;
  /** 目标完成阈值 */
  target?: number;
  /** 随机种子 */
  seed?: number;
}

/** 生成合成轨迹（oracle 锚定：注入的故障 = 已知真值） */
export function generateTrajectory(opts: TrajectoryGenOptions): Trajectory {
  const {
    nSteps,
    baseProgressPerStep,
    fault,
    faultStartStep = nSteps - 3,
    target = 100,
  } = opts;

  const states: TrajectoryState[] = [];
  let progress = 0;
  let frozen = false;
  let lastScore = 0;

  for (let step = 0; step < nSteps; step++) {
    // 已完成（到达 target）后停止发状态 —— 已完成任务不应被"不进展"误判为卡住
    if (progress >= target) {
      break;
    }

    // 故障注入：晚注入冻结在 90%（= target 的 90%）
    if (fault !== 'clean' && step >= faultStartStep) {
      frozen = true;
    }

    let delta = baseProgressPerStep;
    switch (fault) {
      case 'stuck':
        // 无进展但继续输出（progress 冻结，output_signature 变化）
        delta = frozen ? 0 : baseProgressPerStep;
        break;
      case 'silent-stuck':
        // 无进展且输出冻结（更隐蔽）
        delta = frozen ? 0 : baseProgressPerStep;
        break;
      case 'off-track':
        // 方向偏离但进展正常
        break;
      case 'slow':
        // 进展慢但非卡住（单调非减，最终 < 90% 阈值）
        // dir2 原逻辑：slow_gain = max(0.1, (st - last_score) * 0.1)
        delta = frozen ? Math.max(0.1, (progress - lastScore) * 0.1) : baseProgressPerStep * 0.85;
        break;
      case 'clean':
        break;
    }

    // 冻结在 90% of target
    if (frozen && progress >= 0.9 * target) {
      delta = 0;
    }

    progress = Math.min(progress + delta, target);
    lastScore = progress;

    states.push({
      progressScore: progress,
      outputSignature: fault === 'silent-stuck' && frozen ? `frozen_${step}` : `sig_${step}_${progress.toFixed(2)}`,
      directionOk: fault === 'off-track' && frozen ? false : true,
      step,
      at: step * 100,
    });
  }

  return { states, target };
}
