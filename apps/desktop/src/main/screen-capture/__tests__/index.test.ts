import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScreenCaptureRegionResult } from '../../../shared/screenCapture.js';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  ipcOn: vi.fn(),
  execFile: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(async () => undefined),
  assertTrusted: vi.fn(),
  clipboardWriteImage: vi.fn(),
  createFromBuffer: vi.fn((buffer: Buffer) => ({ buffer })),
  overlayCapture: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle, on: mocks.ipcOn },
  clipboard: { writeImage: mocks.clipboardWriteImage },
  nativeImage: { createFromBuffer: mocks.createFromBuffer },
}));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile, rm: mocks.rm }));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: mocks.assertTrusted,
}));
vi.mock('../overlayCapture.js', () => ({
  captureRegionViaOverlay: mocks.overlayCapture,
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { hasRegionCaptureTarget, registerScreenCaptureIpc } from '../index.js';

type Handler = (event: unknown, payload?: unknown) => Promise<ScreenCaptureRegionResult>;

function registerAndGetHandler(platform: string): Handler {
  registerScreenCaptureIpc(platform);
  const call = mocks.handle.mock.calls.at(-1);
  expect(call?.[0]).toBe('screen-capture:region');
  return call?.[1] as Handler;
}

/** execFile 的 callback 形态实现(promisify 走 (file, args, opts, cb))。 */
function execFileResolving(run: () => Error | null) {
  mocks.execFile.mockImplementation(
    (_file: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: unknown) => void) => {
      cb(run(), { stdout: '', stderr: '' });
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerScreenCaptureIpc', () => {
  it('dispatches non-darwin platforms to the overlay capture path', async () => {
    const bytes = Buffer.from([1, 2, 3]);
    mocks.overlayCapture.mockResolvedValue({ cancelled: false, data: bytes });
    const handler = registerAndGetHandler('win32');
    await expect(handler({})).resolves.toEqual({ ok: true, cancelled: false, data: bytes });
    expect(mocks.overlayCapture).toHaveBeenCalledTimes(1);
    expect(mocks.execFile).not.toHaveBeenCalled();
    // 剪贴板写入是平台无关的共享成功尾部
    expect(mocks.clipboardWriteImage).toHaveBeenCalledTimes(1);
  });

  // 覆盖层配色: 合法主题色值透传; 非法值(CSS 注入/var 引用)逐字段回退默认 ——
  // 配色会拼进覆盖层 <style>, sanitize 是防样式注入的唯一闸口(review P1)。
  it('passes validated palette colors through and falls back on unsafe values', async () => {
    mocks.overlayCapture.mockResolvedValue({ cancelled: true });
    const handler = registerAndGetHandler('win32');

    await handler({}, {
      overlayPalette: {
        scrim: 'rgba(0, 0, 0, 0.5)',
        selectionBorder: '#fff',
        pillBg: 'hsl(60, 2%, 12%)',
        pillFg: ' #fafafa ',
      },
    });
    expect(mocks.overlayCapture).toHaveBeenLastCalledWith(expect.any(Number), expect.any(String), {
      scrim: 'rgba(0, 0, 0, 0.5)',
      selectionBorder: '#fff',
      pillBg: 'hsl(60, 2%, 12%)',
      pillFg: '#fafafa',
    });

    await handler({}, {
      overlayPalette: {
        scrim: 'red; } body { background: url(https://evil) }',
        selectionBorder: 'var(--text-primary)',
        pillBg: 'url(javascript:1)',
        pillFg: 42,
      },
    });
    expect(mocks.overlayCapture).toHaveBeenLastCalledWith(expect.any(Number), expect.any(String), {
      scrim: 'rgba(0, 0, 0, 0.7)',
      selectionBorder: 'rgba(255, 255, 255, 0.9)',
      pillBg: '#1f1f1e',
      pillFg: '#ffffff',
    });

    // 未传配色 → 全默认
    await handler({});
    expect(mocks.overlayCapture).toHaveBeenLastCalledWith(expect.any(Number), expect.any(String), {
      scrim: 'rgba(0, 0, 0, 0.7)',
      selectionBorder: 'rgba(255, 255, 255, 0.9)',
      pillBg: '#1f1f1e',
      pillFg: '#ffffff',
    });
  });

  it('propagates overlay cancel as cancelled', async () => {
    mocks.overlayCapture.mockResolvedValue({ cancelled: true });
    const handler = registerAndGetHandler('linux');
    await expect(handler({})).resolves.toEqual({ ok: true, cancelled: true });
    expect(mocks.clipboardWriteImage).not.toHaveBeenCalled();
  });

  // 非取消类失败(无可用帧/覆盖层加载失败)统一转稳定 IPC 错误码, renderer
  // 据此弹本地化提示; 已带 code 的 IpcError 原样透传(review P1)。
  it('normalizes raw capture failures to a coded IPC error', async () => {
    mocks.overlayCapture.mockRejectedValue(new Error('desktopCapturer returned no usable screen frame'));
    const handler = registerAndGetHandler('win32');
    await expect(handler({})).rejects.toMatchObject({ code: 'INTERNAL' });

    const coded = Object.assign(new Error('already coded'), { code: 'PERMISSION_DENIED' });
    mocks.overlayCapture.mockRejectedValue(coded);
    await expect(handler({})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('returns PNG bytes on successful capture and cleans up the temp file', async () => {
    execFileResolving(() => null);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mocks.readFile.mockResolvedValue(bytes);
    const handler = registerAndGetHandler('darwin');

    const result = await handler({});
    expect(result).toEqual({ ok: true, cancelled: false, data: bytes });
    const [bin, args] = mocks.execFile.mock.calls[0];
    expect(bin).toBe('/usr/sbin/screencapture');
    expect(args).toContain('-i');
    expect(mocks.rm).toHaveBeenCalledTimes(1);
    // 成功路径同步写系统剪贴板(其它 composer 直接 ⌘V)。
    expect(mocks.createFromBuffer).toHaveBeenCalledWith(bytes);
    expect(mocks.clipboardWriteImage).toHaveBeenCalledTimes(1);
  });

  it('treats non-zero screencapture exit as user cancel', async () => {
    execFileResolving(() => new Error('exit 1'));
    const handler = registerAndGetHandler('darwin');
    await expect(handler({})).resolves.toEqual({ ok: true, cancelled: true });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.clipboardWriteImage).not.toHaveBeenCalled();
  });

  // 只静默"可确认的用户取消"(干净非零退出): 超时强杀、spawn 失败、带 stderr
  // 的真实失败(权限被拒等)都要走稳定 IPC 错误 → renderer 失败提示(review P2)。
  it('surfaces killed/spawn/stderr screencapture failures as INTERNAL instead of cancel', async () => {
    const handler = registerAndGetHandler('darwin');
    for (const err of [
      Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' }),
      Object.assign(new Error('spawn failed'), { code: 'ENOENT' }),
      Object.assign(new Error('exit 1'), {
        code: 1,
        stderr: 'screencapture: could not create image from rect',
      }),
    ]) {
      execFileResolving(() => err);
      await expect(handler({})).rejects.toMatchObject({ code: 'INTERNAL' });
    }
    expect(mocks.clipboardWriteImage).not.toHaveBeenCalled();
  });

  it('treats a missing output file as cancel but surfaces other read errors', async () => {
    execFileResolving(() => null);
    mocks.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const handler = registerAndGetHandler('darwin');
    await expect(handler({})).resolves.toEqual({ ok: true, cancelled: true });

    mocks.readFile.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(handler({})).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('reports an empty output file as INTERNAL', async () => {
    execFileResolving(() => null);
    mocks.readFile.mockResolvedValue(Buffer.alloc(0));
    const handler = registerAndGetHandler('darwin');
    await expect(handler({})).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('dedupes concurrent captures: second call resolves cancelled without spawning', async () => {
    let release!: () => void;
    mocks.execFile.mockImplementation(
      (_file: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: unknown) => void) => {
        release = () => cb(null, { stdout: '', stderr: '' });
      },
    );
    mocks.readFile.mockResolvedValue(Buffer.from([1]));
    const handler = registerAndGetHandler('darwin');

    const first = handler({});
    const second = await handler({});
    expect(second).toEqual({ ok: true, cancelled: true });
    expect(mocks.execFile).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toMatchObject({ ok: true, cancelled: false });
  });

  // 截图目标可用性: renderer 随路由上报, webview guest 快捷键转发据此决定
  // 是否拦截(无目标不拦, 不吞网页原生处理, review P2)。
  it('tracks per-renderer capture target availability from trusted senders only', () => {
    registerScreenCaptureIpc('win32');
    const call = mocks.ipcOn.mock.calls.at(-1);
    expect(call?.[0]).toBe('screen-capture:target-available');
    const listener = call?.[1] as (event: unknown, available?: unknown) => void;

    const sender = { id: 71, once: vi.fn() };
    expect(hasRegionCaptureTarget(71)).toBe(false); // 缺省: 无目标(不拦截)
    listener({ sender }, true);
    expect(hasRegionCaptureTarget(71)).toBe(true);
    listener({ sender }, false);
    expect(hasRegionCaptureTarget(71)).toBe(false);
    listener({ sender }, 'yes'); // 非布尔按无目标处理
    expect(hasRegionCaptureTarget(71)).toBe(false);

    // renderer 销毁 → 状态清理
    listener({ sender }, true);
    expect(hasRegionCaptureTarget(71)).toBe(true);
    const destroyedCb = (sender.once.mock.calls as unknown[][]).find(
      (c) => c[0] === 'destroyed',
    )?.[1] as (() => void) | undefined;
    expect(destroyedCb).toBeDefined();
    destroyedCb?.();
    expect(hasRegionCaptureTarget(71)).toBe(false);

    // 不信任来源被忽略(且不抛: ipcMain.on 同步监听器抛异常是 fatal)
    mocks.assertTrusted.mockImplementationOnce(() => {
      throw Object.assign(new Error('untrusted'), { code: 'PERMISSION_DENIED' });
    });
    expect(() => listener({ sender: { id: 72, once: vi.fn() } }, true)).not.toThrow();
    expect(hasRegionCaptureTarget(72)).toBe(false);
  });

  it('gates every call on the trusted-renderer check', async () => {
    execFileResolving(() => null);
    mocks.readFile.mockResolvedValue(Buffer.from([1]));
    mocks.assertTrusted.mockImplementation(() => {
      throw Object.assign(new Error('untrusted'), { code: 'PERMISSION_DENIED' });
    });
    const handler = registerAndGetHandler('darwin');
    await expect(handler({})).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
