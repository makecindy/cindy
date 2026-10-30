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
