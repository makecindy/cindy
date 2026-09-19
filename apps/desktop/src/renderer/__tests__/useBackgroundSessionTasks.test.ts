import { describe, expect, it } from 'vitest';

import {
  countUnconfirmedRunningTasks,
  listRunningBackgroundTasks,
  selectFailedStopTaskIds,
} from '@/hooks/useBackgroundSessionTasks';
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

describe('listRunningBackgroundTasks', () => {
  it('lists running claude-code local_bash tasks, deduped across alias keys', () => {
    const tasks = listRunningBackgroundTasks(
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
        // wake 型任务不属于本列表(状态栏另有 proxy 活动信号覆盖)
        { provider: 'claude-code', taskId: 'a1', status: 'running', taskType: 'local_agent' },
        // codex 任务没有 stopTask 通道,不列
        { provider: 'codex', taskId: 'c1', status: 'running', taskType: 'local_bash' },
      ]),
    );
    expect(tasks).toEqual([{ taskId: 'b1', kind: 'bash', title: 'pnpm test:unit' }]);
  });

  it('lists PI background commands and durable subagents as distinct kinds', () => {
    const tasks = listRunningBackgroundTasks(
      toMap([
        {
          provider: 'pi',
          taskId: 'pi-bash-1',
          status: 'running',
          taskType: 'local_bash',
          title: 'pnpm dev',
        },
        {
          provider: 'pi',
          taskId: 'pi-sub-1',
          status: 'running',
          taskType: 'pi_subagent',
          title: 'scout: find call sites',
        },
        // PI 前台的 subagent(没有 durable run / taskType)不可停,不列
        { provider: 'pi', taskId: 'pi-foreground', status: 'running' },
        // PI diagnostic 投影是 failed 终态,不列
        {
          provider: 'pi',
          taskId: 'pi-diag',
          status: 'failed',
          taskType: 'pi_subagent_diagnostic',
        },
        // terminal durable run 不列
        { provider: 'pi', taskId: 'pi-sub-2', status: 'completed', taskType: 'pi_subagent' },
      ]),
    );
    expect(tasks).toEqual([
      { taskId: 'pi-bash-1', kind: 'bash', title: 'pnpm dev' },
      { taskId: 'pi-sub-1', kind: 'subagent', title: 'scout: find call sites' },
    ]);
  });

  it('returns an empty list for empty or missing maps', () => {
    expect(listRunningBackgroundTasks(undefined)).toEqual([]);
    expect(listRunningBackgroundTasks(new Map())).toEqual([]);
  });
});

describe('selectFailedStopTaskIds', () => {
  const targets = [{ taskId: 'a' }, { taskId: 'b' }, { taskId: 'c' }];

  it('collects only the rejected task ids, in target order', () => {
    const failed = selectFailedStopTaskIds(targets, [
      { status: 'fulfilled', value: undefined },
      { status: 'rejected', reason: new Error('still running after SIGKILL') },
      { status: 'rejected', reason: new Error('still running after SIGKILL') },
    ]);
    expect([...failed]).toEqual(['b', 'c']);
  });

  it('is empty when every stop was confirmed (no false 停止未确认 hint)', () => {
    const failed = selectFailedStopTaskIds(targets, [
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined },
    ]);
    expect(failed.size).toBe(0);
  });

  it('tolerates a shorter result list (defensive: never invent a task id)', () => {
    const failed = selectFailedStopTaskIds(targets, [
      { status: 'rejected', reason: new Error('x') },
    ]);
    expect([...failed]).toEqual(['a']);
  });
});

describe('countUnconfirmedRunningTasks', () => {
  it('counts only failures that are still running (提示随任务真停自动消失)', () => {
    const failed = new Set(['a', 'b']);
    // b 已经不在运行集里(重试成功 / 自然退出)→ 只报 a。
    expect(countUnconfirmedRunningTasks(failed, [{ taskId: 'a' }, { taskId: 'c' }])).toBe(1);
  });

  it('is zero when nothing failed, or when every failure has since stopped', () => {
    expect(countUnconfirmedRunningTasks(new Set(), [{ taskId: 'a' }])).toBe(0);
    expect(countUnconfirmedRunningTasks(new Set(['a']), [{ taskId: 'b' }])).toBe(0);
    expect(countUnconfirmedRunningTasks(new Set(['a']), [])).toBe(0);
  });
});
