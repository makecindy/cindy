import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: true } }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
import { SnapshotHelper } from '../snapshotHost';

// 测试价值：真实 SnapshotHelper 请求入口在管道断开/超时时降级，不让 Cindy 崩溃。
// 原先没有 helper 覆盖；最小失败输入是 stdin error 事件，unit 使用内存流和假时钟。
describe('snapshot helper failure isolation', () => {
  let child: EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: null;
    kill: ReturnType<typeof vi.fn>;
  };
  let helper: SnapshotHelper;
  beforeEach(async () => {
    vi.useFakeTimers();
    // This suite models a packaged Windows helper, independent of the CI host.
    // Linux intentionally returns no helper; test that separate branch below.
    vi.stubGlobal('process', Object.defineProperties(Object.create(process), {
      resourcesPath: { value: 'resources' },
      platform: { value: 'win32' },
    }));
    child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      kill: vi.fn(),
    });
    mocks.spawn.mockReturnValue(child);
    helper = await SnapshotHelper.start();
  });
  afterEach(() => {
    helper?.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('settles pending requests on pipe errors and tolerates late errors after disposal', async () => {
    const result = helper.windows();
    expect(() =>
      child.stdin.emit('error', Object.assign(new Error('closed'), { code: 'EPIPE' })),
    ).not.toThrow();
    await expect(result).resolves.toEqual([]);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(() => child.stdin.emit('error', new Error('late'))).not.toThrow();
    await expect(helper.windows()).resolves.toEqual([]);
  });

  it('degrades when writing throws synchronously', async () => {
    vi.spyOn(child.stdin, 'write').mockImplementation(() => {
      throw new Error('closed');
    });
    await expect(helper.windows()).resolves.toEqual([]);
  });

  it('bounds a stuck helper instead of accumulating timed-out queries', async () => {
    const result = helper.windows();
    await vi.advanceTimersByTimeAsync(1500);
    await expect(result).resolves.toEqual([]);
    expect(child.kill).toHaveBeenCalledTimes(1);
    await expect(helper.windows()).resolves.toEqual([]);
  });

  it('accepts valid geometry and ignores malformed replies', async () => {
    const result = helper.windows();
    child.stdout.write('not json\n');
    child.stdout.write('null\n[]\n');
    child.stdout.write(
      JSON.stringify({
        id: 1,
        windows: [
          { hwnd: 5, pid: 9, rect: [0, 0, 20, 30] },
          { hwnd: 6, rect: [0, 0, -1, 2] },
        ],
      }) + '\n',
    );
    await expect(result).resolves.toEqual([{ handle: 5, pid: 9, rect: [0, 0, 20, 30] }]);
  });

  // Unit: the production start entry on unsupported platforms must keep screen
  // capture optional, without attempting to spawn the Windows helper binary.
  it('does not start a native helper on an unsupported platform', async () => {
    vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: 'linux' }));
    mocks.spawn.mockClear();
    const unsupported = await SnapshotHelper.start();
    expect(mocks.spawn).not.toHaveBeenCalled();
    await expect(unsupported.windows()).resolves.toEqual([]);
    await expect(unsupported.capture({ x: 0, y: 0, width: 2, height: 2 }, 960)).resolves.toBeNull();
    unsupported.dispose();
  });

  // Native video now supplies bytes instead of geometry. A truncated or oversized
  // frame must never reach canvas/IPC; exercise the actual child response path.
  it('accepts bounded native BGRA pixels and rejects inconsistent frame replies', async () => {
    const rect = { x: -100, y: 20, width: 2, height: 2 };
    const good = helper.capture(rect, 960);
    child.stdout.write(JSON.stringify({ id: 1, width: 2, height: 2, pixels: Buffer.alloc(16, 255).toString('base64') }) + '\n');
    await expect(good).resolves.toEqual({ width: 2, height: 2, data: new Uint8Array(16).fill(255) });
    const short = helper.capture(rect, 960);
    child.stdout.write(JSON.stringify({ id: 2, width: 2, height: 2, pixels: 'AAAA' }) + '\n');
    await expect(short).resolves.toBeNull();
    const oversized = helper.capture(rect, 960);
    child.stdout.write(JSON.stringify({ id: 3, width: 961, height: 2, pixels: '' }) + '\n');
    await expect(oversized).resolves.toBeNull();
  });
});
