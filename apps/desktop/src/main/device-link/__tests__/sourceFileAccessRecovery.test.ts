import { describe, expect, it, vi } from 'vitest';
const stat = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', () => ({ stat }));
import { readWithSourceFileAccessRecovery, withSourceFileAccessRecovery } from '../sourceFileAccessRecovery';

// #6530 / review r4356768707: readWithSourceFileAccessRecovery must resume a
// denied original selected with different Windows casing, while rejecting another file.
// Existing outboundMedia tests cover exact POSIX spelling only. This separate unit
// fixture mocks filesystem identity and isolates process.platform without loading IPC.
// Minimal input: one EPERM followed by a same-case-folded selection (same/different inode).
// Windows can return a different casing for the same selection. File identity,
// rather than case folding alone, must still reject distinct case-sensitive files.
describe('native attachment source selection on Windows', () => {
  it.each(['same', 'different', 'unavailable', 'unsupported'] as const)('checks filesystem identity when casing differs: %s', async identity => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    stat.mockReset();
    const source = 'C:\\WeChat\\Test.pdf';
    const selected = 'c:\\wechat\\test.pdf';
    if (identity === 'unavailable') stat.mockRejectedValue(new Error('denied'));
    else stat.mockResolvedValueOnce({ isFile: () => true, dev: 1n, ino: identity === 'unsupported' ? 0n : 42n })
      .mockResolvedValueOnce({ isFile: () => true, dev: 1n, ino: identity === 'same' ? 42n : 43n });
    const denied = Object.assign(new Error('denied'), { code: 'EPERM', syscall: 'open', path: source });
    const read = vi.fn().mockRejectedValueOnce(denied).mockResolvedValue('uploaded');
    try {
      const result = withSourceFileAccessRecovery({ selectFile: async () => selected, assertCurrent: () => {} },
        () => readWithSourceFileAccessRecovery(source, read));
      if (identity === 'same') await expect(result).resolves.toBe('uploaded');
      else await expect(result).rejects.toMatchObject({ code: 'DEVICE_LINK_MEDIA_ACCESS_DENIED' });
      expect(read).toHaveBeenCalledTimes(identity === 'same' ? 2 : 1);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });
});
