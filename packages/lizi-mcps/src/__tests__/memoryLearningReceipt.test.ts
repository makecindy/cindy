import { it, expect, vi } from 'vitest';
import { MemoryToolRegistry } from '../cindy_memoryToolRegistry.js';
import { registerMemoryWriteTool } from '../memory/write.js';
import { registerMemoryConsolidateTool } from '../memory/consolidate.js';
import type { MemoryMcpDeps } from '../types.js';
it('captures ownership before storage, emits only successful write and consolidate receipts', async () => {
  const receipt = vi.fn(),
    write = vi.fn(async () => ({ ok: true, filename: 'feedback_test.md' }));
  const context = { sessionId: 'origin', memoryScopeKey: 'bot:test', workingDir: '/unused' };
  const beginWrite = vi.fn(() => receipt);
  // read: 工具先查文件在哪一份记忆里, 再决定写到哪; 这里目标与来源都当作已存在。
  const store = { write, consolidate: write, read: async () => ({}), resolveFilename: async () => 'feedback_test.md' };
  const deps = {
    beginWrite,
    workdir: '/unused',
    getSessionContext: () => context,
    getManager: () => ({
      isEnabled: () => true,
      getStore: async () => store,
      // 伙伴作用域只有它自己那一份记忆。
      memoryScopesFor: (scopeKey: string) => ({ user: null, project: scopeKey }),
    }),
  } as unknown as MemoryMcpDeps;
  const registry = new MemoryToolRegistry();
  registerMemoryWriteTool(registry, deps);
  registerMemoryConsolidateTool(registry, deps);
  const args = {
    type: 'feedback',
    name: 'test',
    title: 'Preference',
    description: 'A stable preference',
    body: 'Details',
  };
  expect((await registry.call('memory_write', args)).isError).not.toBe(true);
  expect(beginWrite).toHaveBeenCalledWith(context);
  expect(beginWrite.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
  expect(receipt).toHaveBeenLastCalledWith({
    key: 'feedback_test.md',
    title: 'Preference',
    action: 'created',
  });
  await registry.call('memory_consolidate', { sources: ['feedback_old.md'], target: args });
  expect(receipt).toHaveBeenLastCalledWith({
    key: 'feedback_test.md',
    title: 'Preference',
    action: 'updated',
  });
  write.mockRejectedValueOnce(new Error('write failed'));
  receipt.mockClear();
  expect((await registry.call('memory_write', { ...args, mode: 'update' })).isError).toBe(true);
  expect(receipt).not.toHaveBeenCalled();
});

// 整理别的项目的记忆同样出回执 (cindy-memory.md §8)。回执里的 `project` 指当前任务的项目,
// 所以写进另一个项目时不带 scope (点开到记忆页, 而不是没有这条记忆的那一页); 并进「关于你」照常带。
it('emits a receipt for a write to another project, without claiming it is the task\'s own project', async () => {
  const receipt = vi.fn();
  const beginWrite = vi.fn(() => receipt);
  const store = {
    write: async () => ({ ok: true, filename: 'feedback_test.md' }),
    consolidate: async () => ({ ok: true, filename: 'feedback_test.md', deletedSources: [] }),
    read: async () => ({}), list: async () => [], resolveFilename: async () => 'feedback_test.md',
  };
  const deps = {
    beginWrite,
    workdir: '/task',
    getSessionContext: () => ({ sessionId: 'origin', workingDir: '/task', memoryScopeKey: '/task' }),
    getManager: () => ({
      isEnabled: () => true,
      getStore: async () => store,
      memoryScopesFor: (scopeKey: string) => ({ user: 'user:account', project: scopeKey }),
      listScopes: async () => [{ scopeKey: '/other', kind: 'project', count: 1 }],
    }),
  } as unknown as MemoryMcpDeps;
  const registry = new MemoryToolRegistry();
  registerMemoryWriteTool(registry, deps);
  registerMemoryConsolidateTool(registry, deps);
  const args = { type: 'feedback', name: 'test', title: 'Preference', description: 'A stable preference', body: 'Details' };

  expect((await registry.call('memory_write', { ...args, project: '/other' })).isError).not.toBe(true);
  expect((await registry.call('memory_consolidate', { sources: ['feedback_old.md'], target: args, scope: 'project', project: '/other' })).isError).not.toBe(true);
  expect((await registry.call('memory_consolidate', { sources: ['feedback_old.md'], target: args, scope: 'user', project: '/other' })).isError).not.toBe(true);
  expect((await registry.call('memory_write', args)).isError).not.toBe(true);

  expect(receipt.mock.calls.map(([sent]) => sent)).toEqual([
    { key: 'feedback_test.md', title: 'Preference', action: 'created' },
    { key: 'feedback_test.md', title: 'Preference', action: 'updated' },
    { key: 'feedback_test.md', title: 'Preference', action: 'updated', scope: 'user' },
    { key: 'feedback_test.md', title: 'Preference', action: 'created', scope: 'project' },
  ]);
});
