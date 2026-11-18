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

  it('treats the wrapped transfer failure as a cancellation symptom too', async () => {
    // IpcError 包装后消息是 `[DEVICE_LINK_MEDIA_TRANSFER_FAILED] UPLOAD_CANCELLED`,
    // 标记仍要认得出来,否则中止又会被当成普通故障顶掉作用域原因。
    const scope = scopeError();
    const wrapped = Object.assign(new Error('[DEVICE_LINK_MEDIA_TRANSFER_FAILED] FILE_PEER_CANCELLED'), {
      code: 'DEVICE_LINK_MEDIA_TRANSFER_FAILED',
    });
    const result = withSourceFileAccessRecovery({
      selectFile: async () => null,
      assertCurrent: () => { throw scope; },
    }, async () => { throw wrapped; });
    await expect(result).rejects.toBe(scope);
    expect((scope as Error).cause).toBe(wrapped);
  });

  // #10906 review:路径里含 cancel 的真实故障不能再被误判成中止症状。
  // 最小失败输入:一个文案带着 `/tmp/cancel/report.pdf` 的 ENOENT。
  it('keeps a real read failure primary when its path merely contains cancel', async () => {
    const scope = scopeError();
    const missing = Object.assign(new Error("ENOENT: no such file or directory, stat '/tmp/cancel/report.pdf'"), {
      code: 'ENOENT', syscall: 'stat', path: '/tmp/cancel/report.pdf',
    });
    const result = withSourceFileAccessRecovery({
      selectFile: async () => null,
      assertCurrent: () => { throw scope; },
    }, async () => { throw missing; });
    await expect(result).rejects.toBe(missing);
    expect((missing as Error).cause).toBe(scope);
  });

  // #10906 review P2:IpcError 包装会把 readFile 的 signal 中止包成一句没有标记的消息,
  // 但原错误挂在 cause 上;只要本作用域的信号确实已中止,仍要判成作用域拆坏的症状。
  it('lets the scope failure lead when a wrapped abort carries the scope signal', async () => {
    const controller = new AbortController();
    const scope = scopeError();
    const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
    const wrapped = Object.assign(new Error('[DEVICE_LINK_MEDIA_TRANSFER_FAILED] The operation was aborted'), {
      code: 'DEVICE_LINK_MEDIA_TRANSFER_FAILED',
      cause: aborted,
    });
    controller.abort();
    const result = withSourceFileAccessRecovery({
      signal: controller.signal,
      selectFile: async () => null,
      assertCurrent: () => { throw scope; },
    }, async () => { throw wrapped; });
    await expect(result).rejects.toBe(scope);
    expect((scope as Error).cause).toBe(wrapped);
  });

  // #10906 review P2:标记必须锚在**整条消息**上 —— 路径里带 token 的真实故障不能被当成中止。
  // 最小失败输入:ENOENT 的路径段就叫 `UPLOAD_CANCELLED`,再套上传输失败包装层。
  it('keeps a wrapped read failure primary when its path contains a cancellation token', async () => {
    const scope = scopeError();
    const missing = Object.assign(new Error("ENOENT: no such file or directory, open '/tmp/UPLOAD_CANCELLED/report.pdf'"), {
      code: 'ENOENT', syscall: 'open', path: '/tmp/UPLOAD_CANCELLED/report.pdf',
    });
    const wrapped = Object.assign(
      new Error('[DEVICE_LINK_MEDIA_TRANSFER_FAILED] ' + missing.message),
      { code: 'DEVICE_LINK_MEDIA_TRANSFER_FAILED', cause: missing },
    );
    const result = withSourceFileAccessRecovery({
      selectFile: async () => null,
      assertCurrent: () => { throw scope; },
    }, async () => { throw wrapped; });
    await expect(result).rejects.toBe(wrapped);
    // 主错误仍是真实读取故障,不能被作用域的 PERMISSION_DENIED 顶替。
    expect((wrapped as Error).cause).toBe(missing);
  });

  // 反过来:信号没中止时,cause 上的中止不是本作用域拆坏的证据(可能是远端自己的中止),
  // 包装后的传输失败必须保持主错误,否则又重新顶替真实故障。
  it('keeps a wrapped abort primary when this scope was not aborted', async () => {
    const scope = scopeError();
    const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
    const wrapped = Object.assign(new Error('[DEVICE_LINK_MEDIA_TRANSFER_FAILED] The operation was aborted'), {
      code: 'DEVICE_LINK_MEDIA_TRANSFER_FAILED',
      cause: aborted,
    });
    const result = withSourceFileAccessRecovery({
      signal: new AbortController().signal,
      selectFile: async () => null,
      assertCurrent: () => { throw scope; },
    }, async () => { throw wrapped; });
    await expect(result).rejects.toBe(wrapped);
    expect((wrapped as Error).cause).toBe(aborted);
  });
});

// #10906 review:内层复查也会顶替真实原因 —— 读取被拒后、准备弹选择框前那次
// assertCurrent() 原来直接抛作用域错误,把 EPERM/EACCES/ACCESS_DENIED 盖掉。
describe('attachment read failure keeps its own reason', () => {
  const source = '/private/wechat/test.pdf';
  const denied = () => Object.assign(new Error('source denied'), { code: 'EPERM', syscall: 'open', path: source });
  const stale = () => Object.assign(new Error('scope is no longer current'), { code: 'PERMISSION_DENIED' });

  it('keeps the read error primary when the scope expires during the read', async () => {
    const scope = stale();
    const readError = denied();
    const selectFile = vi.fn(async () => source);
    // 作用域在读完后才失效:入口复查必须放过,否则测不到内层那次复查。
    let expired = false;
    const read = vi.fn(async () => { expired = true; throw readError; });
    const failure = await withSourceFileAccessRecovery({
      selectFile, assertCurrent: () => { if (expired) throw scope; },
    }, () => readWithSourceFileAccessRecovery(source, read)).catch((error: unknown) => error);
    // 作用域在读取期间失效:第一次复查就命中,不得再弹选择框,读取错误仍是主错误。
    expect(failure).toBe(readError);
    expect((readError as Error).cause).toBe(scope);
    expect(selectFile).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
  });

  it('still reports the scope reason when the read itself is fine', async () => {
    const read = vi.fn().mockResolvedValue('uploaded');
    await expect(withSourceFileAccessRecovery({ selectFile: async () => null, assertCurrent: () => {} },
      () => readWithSourceFileAccessRecovery(source, read))).resolves.toBe('uploaded');
    expect(read).toHaveBeenCalledOnce();
  });
});
