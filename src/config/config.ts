/**
 * config/config.ts
 *
 * 配置加载 + 热加载（文件变更自动重载）
 * - 默认配置内置（研究参数默认值）
 * - JSON 文件覆盖
 * - fs.watch 热加载
 */

import { readFileSync, watch, type FSWatcher } from 'fs';
import { existsSync } from 'fs';
import { dirname, basename } from 'path';
import { PolicySchema, type Policy } from '../core/types.js';

/** 默认配置（对应 dir1/dir2 研究参数的默认值） */
export function defaultPolicy(): Policy {
  return {
    version: '1.0.0',
    schedulingMode: 'merge-pending',
    tokenBudget: 50,
    contextWindowBudget: 10000,
    preemptionPolicy: 'PRIORITY',
    evalTimeoutMs: 60000,
    requeues: 2,
    watchdog: {
      enabled: true,
      form: 'stepwise',
      stallWindowSteps: 2,
      minProgressStep: 0.05,
      completionThreshold: 0.9,
      checkDirection: true,
    },
  };
}

/** 加载配置（JSON 文件 + 默认合并） */
export function loadPolicy(configPath?: string): Policy {
  const base = defaultPolicy();
  if (!configPath) return base;

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    const parsed = PolicySchema.parse({ ...base, ...raw });
    return parsed as Policy;
  } catch (err) {
    console.warn(`[config] 加载 ${configPath} 失败，使用默认: ${err instanceof Error ? err.message : err}`);
    return base;
  }
}

/** 配置热加载器 */
export class ConfigWatcher {
  private watcher?: FSWatcher;
  private current: Policy;

  constructor(
    private configPath: string | undefined,
    private onReload: (policy: Policy) => void,
  ) {
    this.current = loadPolicy(configPath);
  }

  get(): Policy {
    return this.current;
  }

  start(): void {
    if (!this.configPath) return;
    // 文件不存在：watch 直接抛 ENOENT → 改为监视目录（文件创建后也能捕获）
    if (existsSync(this.configPath)) {
      this.watcher = watch(this.configPath, (_event, filename) => {
        if (!filename || filename.endsWith('.json')) {
          const next = loadPolicy(this.configPath);
          this.current = next;
          this.onReload(next);
          console.log(`[config] 热加载成功: ${this.configPath}`);
        }
      });
    } else {
      const dir = dirname(this.configPath);
      const base = basename(this.configPath);
      this.watcher = watch(dir, (_event, filename) => {
        if (filename === base) {
          const next = loadPolicy(this.configPath);
          this.current = next;
          this.onReload(next);
          console.log(`[config] 热加载成功（文件创建）: ${this.configPath}`);
        }
      });
    }
  }

  stop(): void {
    this.watcher?.close();
  }
}
