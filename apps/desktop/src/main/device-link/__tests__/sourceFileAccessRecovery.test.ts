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

// #10852: 兜底复查不得顶替真实故障原因;反过来,中止症状要让位给作用域原因。
// 传输超时/离线/附件读失败才是主错误,守卫复查失败只能作为 cause 补充;
// 中止类错误(UPLOAD_CANCELLED)只是被掐断的症状,根因是作用域作废 —— 守卫错误当主错误。
describe('send failure error primacy', () => {
  const transportError = () => Object.assign(new Error('no invoke-result within 30000ms'), {
    code: 'DEVICE_LINK_TIMEOUT',
  });
  const scopeError = () => Object.assign(new Error('scope is no longer current'), {
    code: 'PERMISSION_DENIED',
  });

  it('keeps the transport error primary and records the scope check failure as cause', async () => {
    const transport = transportError();
    const scope = scopeError();
    const result = withSourceFileAccessRecovery({
      selectFile: async () => null,
      assertCurrent: () => { throw scope; },
    }, async () => { throw transport; });
    await expect(result).rejects.toBe(transport);
    expect((transport as Error).cause).toBe(scope);
  });

  it('leaves the original error untouched when the scope is still valid', async () => {
    const transport = transportError();
    const result = withSourceFileAccessRecovery({
      selectFile: async () => null,
      assertCurrent: () => {},
    }, async () => { throw transport; });
    await expect(result).rejects.toBe(transport);
    expect((transport as Error).cause).toBeUndefined();
  });

  it('does not crash on a failure that is not an error object', async () => {
    const result = withSourceFileAccessRecovery({
      selectFile: async () => null,
      assertCurrent: () => { throw scopeError(); },
    }, async () => { throw 'plain failure'; });
    await expect(result).rejects.toBe('plain failure');
  });

  it('lets the scope failure lead when the operation only reports a cancellation', async () => {
    // 中止类错误只说明"被掐断了",不说明"为什么";作用域守卫知道。
    const scope = scopeError();
    const cancelled = new Error('UPLOAD_CANCELLED');
    const result = withSourceFileAccessRecovery({
      selectFile: async () => null,
      assertCurrent: () => { throw scope; },
    }, async () => { throw cancelled; });
    await expect(result).rejects.toBe(scope);
    expect((scope as Error).cause).toBe(cancelled);
  });
});
