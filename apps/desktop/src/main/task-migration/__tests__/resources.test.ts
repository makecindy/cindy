import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import v8 from 'node:v8';
import { assertDiskCapacity, assertMemoryCapacity } from '../resources';
afterEach(() => vi.restoreAllMocks());
const GB = 1024 ** 3;
function disk(free: number, separate = false) {
  vi.spyOn(fs, 'stat').mockImplementation(
    async (name) => ({ dev: separate && name === '/project' ? 2n : 1n }) as never,
  );
  vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: BigInt(free), bsize: 1n } as never);
}
describe('migration resource budgets', () => {
  it('permits projects larger than 2 GB when the destination has space', async () => {
    disk(20 * GB);
    await expect(
      assertDiskCapacity([{ path: '/project', bytes: 8 * GB }]),
    ).resolves.toBeUndefined();
  });
  it('combines staging and project allocations on one disk', async () => {
    disk(10 * GB);
    await expect(
      assertDiskCapacity([
        { path: '/staging', bytes: 5 * GB },
        { path: '/project', bytes: 5 * GB },
      ]),
    ).rejects.toThrow('MIGRATION_NO_SPACE');
  });
  it('checks separate destination volumes independently', async () => {
    disk(10 * GB, true);
    await expect(
      assertDiskCapacity([
        { path: '/staging', bytes: 5 * GB },
        { path: '/project', bytes: 5 * GB },
      ]),
    ).resolves.toBeUndefined();
  });
  it('adapts context budget to available memory and heap rather than 256 MB', () => {
    vi.spyOn(os, 'freemem').mockReturnValue(16 * GB);
    vi.spyOn(process, 'availableMemory').mockReturnValue(16 * GB);
    vi.spyOn(v8, 'getHeapStatistics').mockReturnValue({
      heap_size_limit: 8 * GB,
      used_heap_size: GB,
    } as never);
    expect(() => assertMemoryCapacity(GB)).not.toThrow();
    vi.mocked(os.freemem).mockReturnValue(GB);
    expect(() => assertMemoryCapacity(GB)).toThrow('MIGRATION_NO_MEMORY');
  });
});
