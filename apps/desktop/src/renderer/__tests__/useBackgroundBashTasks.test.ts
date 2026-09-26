import { describe, expect, it } from 'vitest';

import { listRunningBashTasks } from '@/hooks/useBackgroundBashTasks';
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

describe('listRunningBashTasks', () => {
  it('lists only running claude-code local_bash tasks, deduped across alias keys', () => {
    const tasks = listRunningBashTasks(
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

  it('远程镜像口径:includePiTasks 放开 PI 后台命令,仍排除 codex', () => {
    const map = toMap([
      { provider: 'pi', taskId: 'p1', status: 'running', taskType: 'local_bash', title: 'pi bg' },
      // codex 连被控端也没有 stopTask 通道 → 两端口径一致地不列(假入口)。
      { provider: 'codex', taskId: 'c1', status: 'running', taskType: 'local_bash' },
      // 终态照旧不进列表
      { provider: 'pi', taskId: 'p2', status: 'completed', taskType: 'local_bash' },
    ]);

    expect(listRunningBashTasks(map, { includePiTasks: true })).toEqual([
      { taskId: 'p1', title: 'pi bg' },
    ]);
    // 默认(本机会话)口径不变:PI 后台命令本地没有 stopTask 通道
    expect(listRunningBashTasks(map)).toEqual([]);
  });

  it('returns an empty list for empty or missing maps', () => {
    expect(listRunningBashTasks(undefined)).toEqual([]);
    expect(listRunningBashTasks(new Map())).toEqual([]);
  });
});
