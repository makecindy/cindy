/**
 * Cindy 记忆「需要时才整理」的触发点 (docs/product-rules/cindy-memory.md §3)。
 *
 * 保护的契约: 只有写过记忆的任务在一轮成功结束时才让 manager 检查那一份记忆;
 * 没写过的任务结束时不碰 manager; 换账号后旧任务的待检查项作废。
 * 新文件: memoryTidyTrigger.ts 是新模块, 没有可并入的相邻测试。
 */
import { describe, expect, it, vi } from 'vitest';
import type { MakerMemoryManager } from '@cindy/maker-core';

import { createMemoryTidyTrigger } from '../memoryTidyTrigger.js';

function fakeManager(owner: { key: string }) {
  const tidy = vi.fn(async () => ({ status: 'not-due' as const }));
  const manager = { tidy, currentOwnerScopeKey: () => owner.key } as unknown as MakerMemoryManager;
  return { tidy, getManager: () => manager };
}

describe('memoryTidyTrigger', () => {
  it('一轮结束时只检查这个任务写过的那几份记忆, 每份一次, 且只检查一回', async () => {
    const { tidy, getManager } = fakeManager({ key: 'owner-a' });
    const trigger = createMemoryTidyTrigger();

    await trigger.onTurnDone('task-1');
    expect(tidy).not.toHaveBeenCalled();

    trigger.noteWrite('task-1', '/repo', getManager);
    trigger.noteWrite('task-1', '/repo', getManager);
    trigger.noteWrite('task-1', 'user:account', getManager);
    trigger.noteWrite(undefined, '/other', getManager);
    await trigger.onTurnDone('task-2');
    expect(tidy).not.toHaveBeenCalled();

    await trigger.onTurnDone('task-1');
    expect(tidy.mock.calls).toEqual([['/repo', 'auto'], ['user:account', 'auto']]);
    await trigger.onTurnDone('task-1');
    expect(tidy).toHaveBeenCalledTimes(2);
  });

  it('换账号后旧任务的待检查项作废, 整理失败不向任务抛错', async () => {
    const owner = { key: 'owner-a' };
    const { tidy, getManager } = fakeManager(owner);
    const trigger = createMemoryTidyTrigger();

    trigger.noteWrite('task-1', '/repo', getManager);
    owner.key = 'owner-b';
    await trigger.onTurnDone('task-1');
    expect(tidy).not.toHaveBeenCalled();

    tidy.mockRejectedValueOnce(new Error('memory:not-ready'));
    trigger.noteWrite('task-1', '/repo', getManager);
    await expect(trigger.onTurnDone('task-1')).resolves.toBeUndefined();
    expect(tidy).toHaveBeenCalledTimes(1);
  });
});
