import { describe, expect, it } from 'vitest';

import { countWorkingBashTasks, listRunningClaudeBashTasks } from '@/hooks/useBackgroundBashTasks';
import type { AgentTaskUpdate } from '@/lib/makerChatStore';

function toMap(updates: AgentTaskUpdate[]): ReadonlyMap<string, AgentTaskUpdate> {
  // 与 makerChatStore 同构:同一任务按 taskId / parentToolUseId 双 key 存两份。
  const map = new Map<string, AgentTaskUpdate>();
  for (const u of updates) {
    map.set(u.taskId, u);
    if (u.parentToolUseId) map.set(u.parentToolUseId, u);
  }
  return map;
}

describe('listRunningClaudeBashTasks', () => {
  it('lists only running claude-code local_bash tasks, deduped across alias keys', () => {
    const tasks = listRunningClaudeBashTasks(
      toMap([
        {
          provider: 'claude-code',
          taskId: 'b1',
          parentToolUseId: 'tu-b1',
          status: 'running',
          taskType: 'local_bash',
          title: 'pnpm test:unit',
        },
        // 终态 bash 不进列表
        { provider: 'claude-code', taskId: 'b2', status: 'completed', taskType: 'local_bash' },
        // wake 型任务不属于 bash 列表(状态栏另有 proxy 活动信号覆盖)
        { provider: 'claude-code', taskId: 'a1', status: 'running', taskType: 'local_agent' },
        // codex 任务没有 stopTask 通道,不列
        { provider: 'codex', taskId: 'c1', status: 'running', taskType: 'local_bash' },
      ]),
    );
    expect(tasks).toEqual([{ taskId: 'b1', title: 'pnpm test:unit' }]);
  });

  // 状态栏按种类选文案:有命令仍在工作 →「正在后台工作」;只剩长驻服务 →「后台服务运行中」。
  it('marks long-lived services so only commands still working count as work', () => {
    const tasks = listRunningClaudeBashTasks(
      toMap([
        { provider: 'claude-code', taskId: 'tests', status: 'running', taskType: 'local_bash', backgroundCommandKind: 'work' },
        { provider: 'claude-code', taskId: 'server', status: 'running', taskType: 'local_bash', backgroundCommandKind: 'service' },
        // 种类未知按工作算
        { provider: 'claude-code', taskId: 'unknown', status: 'running', taskType: 'local_bash' },
      ]),
    );
    expect(tasks).toEqual([{ taskId: 'tests' }, { taskId: 'server', service: true }, { taskId: 'unknown' }]);
    expect(countWorkingBashTasks(tasks)).toBe(2);
    expect(countWorkingBashTasks(tasks.filter((task) => task.service))).toBe(0);
  });

  it('returns an empty list for empty or missing maps', () => {
    expect(listRunningClaudeBashTasks(undefined)).toEqual([]);
    expect(listRunningClaudeBashTasks(new Map())).toEqual([]);
  });
});
