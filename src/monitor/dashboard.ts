/**
 * monitor/dashboard.ts
 *
 * 监控仪表盘：生成 HTML 页面（实时状态/指标/轨迹）
 * 提供 /dashboard 路由挂载
 */

import { type Router } from '../core/router.js';
import { type Executor } from '../executor/executor.js';
import { type Watchdog } from '../watchdog/watchdog.js';

/** 生成 HTML 仪表盘（单文件，内嵌 JS 轮询 API） */
export function renderDashboard(
  router: Router,
  executor: Executor,
  watchdog: Watchdog,
): string {
  const stats = router.getStats();
  const execStats = executor.getStats();
  const wdStats = watchdog.getStats();

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Superagent Platform Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }
  h1 { font-size: 24px; margin-bottom: 8px; color: #58a6ff; }
  .sub { color: #8b949e; font-size: 14px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .card .label { color: #8b949e; font-size: 13px; margin-bottom: 4px; }
  .card .value { font-size: 28px; font-weight: 600; color: #e6edf3; }
  .card .value.good { color: #3fb950; }
  .card .value.warn { color: #d29922; }
  .card .value.bad { color: #f85149; }
  .section { margin-bottom: 24px; }
  .section h2 { font-size: 18px; margin-bottom: 12px; color: #e6edf3; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: 500; }
  td { color: #c9d1d9; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; }
  .badge.green { background: rgba(63,185,80,0.15); color: #3fb950; }
  .badge.yellow { background: rgba(210,153,34,0.15); color: #d29922; }
  .badge.red { background: rgba(248,81,73,0.15); color: #f85149; }
  .badge.gray { background: rgba(139,148,158,0.15); color: #8b949e; }
  #refresh { margin-bottom: 24px; }
  button { background: #238636; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; }
  button:hover { background: #2ea043; }
</style>
</head>
<body>
<h1>Superagent Platform Dashboard</h1>
<div class="sub">Router 批处理合并 + Watchdog 外部监督 · 自动刷新 5s</div>

<div class="grid">
  <div class="card"><div class="label">总 Eval 数</div><div class="value">${stats.totalEvals}</div></div>
  <div class="card"><div class="label">总 Ticket 数</div><div class="value">${stats.totalTickets}</div></div>
  <div class="card"><div class="label">平均批大小</div><div class="value">${stats.avgBatchSize.toFixed(2)}</div></div>
  <div class="card"><div class="label">抢占数</div><div class="value">${stats.totalPreemptions}</div></div>
  <div class="card"><div class="label">过期数</div><div class="value">${stats.totalExpired}</div></div>
  <div class="card"><div class="label">unavailable</div><div class="value">${stats.totalUnavailable}</div></div>
</div>

<div class="section">
  <h2>执行器</h2>
  <div class="grid">
    <div class="card"><div class="label">运行中</div><div class="value">${execStats.running}</div></div>
    <div class="card"><div class="label">队列</div><div class="value">${execStats.queued}</div></div>
    <div class="card"><div class="label">已完成</div><div class="value good">${execStats.completed}</div></div>
    <div class="card"><div class="label">空闲 Worker</div><div class="value">${execStats.idleWorkers}/${execStats.totalWorkers}</div></div>
  </div>
</div>

<div class="section">
  <h2>Watchdog 监督</h2>
  <div class="grid">
    <div class="card"><div class="label">监督总数</div><div class="value">${wdStats.total}</div></div>
    <div class="card"><div class="label">ADVANCED</div><div class="value good">${wdStats.advanced}</div></div>
    <div class="card"><div class="label">STALLED</div><div class="value bad">${wdStats.stalled}</div></div>
    <div class="card"><div class="label">off-track</div><div class="value warn">${wdStats.offTrack}</div></div>
  </div>
</div>

<div class="section">
  <h2>线程列表</h2>
  <table id="threads"><thead><tr><th>Key</th><th>状态</th><th>Pending</th><th>Eval</th><th>最近活跃</th></tr></thead><tbody></tbody></table>
</div>

<div class="section">
  <h2>Ticket 列表</h2>
  <table id="tickets"><thead><tr><th>ID</th><th>线程</th><th>状态</th><th>上下文</th><th>优先级</th></tr></thead><tbody></tbody></table>
</div>

<script>
async function refresh() {
  try {
    const [threadsRes, ticketsRes] = await Promise.all([
      fetch('/api/threads'), fetch('/api/tickets')
    ]);
    const threads = (await threadsRes.json()).threads || [];
    const tickets = (await ticketsRes.json()).tickets || [];

    const tBody = document.querySelector('#threads tbody');
    tBody.innerHTML = threads.map(t => \`
      <tr>
        <td>\${t.key}</td>
        <td><span class="badge \${t.status === 'evaluating' ? 'yellow' : t.status === 'done' ? 'green' : 'gray'}">\${t.status}</span></td>
        <td>\${t.pendingCount}</td>
        <td>\${t.evaluating || '-'}</td>
        <td>\${new Date(t.lastActiveAt).toLocaleTimeString()}</td>
      </tr>\`).join('');

    const tkBody = document.querySelector('#tickets tbody');
    tkBody.innerHTML = tickets.map(t => \`
      <tr>
        <td>\${t.id}</td>
        <td>\${t.threadKey}</td>
        <td><span class="badge \${t.status === 'completed' ? 'green' : t.status === 'failed' ? 'red' : t.status === 'expired' ? 'red' : 'yellow'}">\${t.status}</span></td>
        <td>\${t.contextUsed}/\${t.contextBudget}</td>
        <td>\${t.priority.toFixed(0)}</td>
      </tr>\`).join('');
  } catch (e) {
    console.error('refresh failed', e);
  }
}
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;
}
