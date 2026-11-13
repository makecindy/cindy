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
  const store = { write, consolidate: write };
  const deps = {
    beginWrite,
    workdir: '/unused',
    getSessionContext: () => context,
    getManager: () => ({ isEnabled: () => true, getStore: async () => store }),
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

it('rejects shard names beyond the storage limit at the tool boundary', async () => {
  const write = vi.fn(async () => ({ ok: true, filename: 'project_ok.md' }));
  const deps = {
    workdir: '/unused',
    getSessionContext: () => ({ sessionId: 'origin', memoryScopeKey: 'bot:test', workingDir: '/unused' }),
    getManager: () => ({ isEnabled: () => true, getStore: async () => ({ write }) }),
  } as unknown as MemoryMcpDeps;
  const registry = new MemoryToolRegistry();
  registerMemoryWriteTool(registry, deps);
  const call = (name: string, type = 'project') =>
    registry.call('memory_write', { type, name, title: 'T', description: 'D', body: 'B' });

  expect((await call('a'.repeat(64))).isError).not.toBe(true);
  expect((await call('a'.repeat(65))).isError).toBe(true);
  expect((await call(`project_${'a'.repeat(64)}.md`)).isError).not.toBe(true);
  expect((await call(`project_${'a'.repeat(65)}`)).isError).toBe(true);
  // 长度例外只给与 type 匹配的前缀: 别的 type 前缀不能借它绕过 64 限制
  expect((await call(`project_${'a'.repeat(64)}`, 'feedback')).isError).toBe(true);
});
