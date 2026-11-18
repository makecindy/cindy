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

// 改另一个项目的记忆是整理, 不是这轮对话学到了什么: 不出保存回执 (回执点开只认当前任务的项目)。
it('emits no receipt when a write targets another project', async () => {
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
  expect(beginWrite).not.toHaveBeenCalled();

  // 当前项目的写入照旧出回执。
  expect((await registry.call('memory_write', args)).isError).not.toBe(true);
  expect(receipt).toHaveBeenCalledTimes(1);
});
