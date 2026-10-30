import { describe, expect, it, vi } from 'vitest';
import { listCodexModels } from './list-models.js';

describe('complete Codex model snapshots', () => {
  it('reads all pages, including an empty intermediate page', async () => {
    const read = vi.fn().mockResolvedValueOnce({ data: [{ model: 'one' }], nextCursor: 'two' })
      .mockResolvedValueOnce({ data: [], nextCursor: 'three' })
      .mockResolvedValueOnce({ data: [{ model: 'three' }], nextCursor: null });
    expect(await listCodexModels(read)).toEqual([{ model: 'one' }, { model: 'three' }]);
    expect(read.mock.calls).toEqual([[null], ['two'], ['three']]);
  });
  it('rejects cyclic pagination and does not return a partial catalog', async () => {
    const read = vi.fn().mockResolvedValue({ data: [{ model: 'partial' }], nextCursor: 'same' });
    await expect(listCodexModels(read)).rejects.toThrow('cursor');
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('does not hide RPC errors or invalid responses', async () => {
    await expect(listCodexModels(vi.fn().mockRejectedValue(new Error('offline')))).rejects.toThrow('offline');
    await expect(listCodexModels(vi.fn().mockResolvedValue({ nextCursor: null }))).rejects.toThrow('Invalid');
  });
});
