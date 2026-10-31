import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ app: { getAppPath: () => '/app', getPath: () => '/unused' } }));
vi.mock('node:child_process', () => ({ spawn: mock.spawn, execFile: vi.fn() }));
vi.mock('node:fs', () => ({ default: { existsSync: () => true } }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn() }) }));
import { MacDesktopCompanionNativeHost } from '../nativeHost.js';

function helper() {
  const child = new EventEmitter();
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const stdin = {
    write: vi.fn((line: string) => {
      const { id } = JSON.parse(line);
      queueMicrotask(() => stdout.emit('data', JSON.stringify({ id, ok: true }) + '\n'));
    }),
    end: vi.fn(),
  };
  return Object.assign(child, { stdout, stderr, stdin, killed: false });
}

beforeEach(() => { mock.spawn.mockReset(); });

describe('wallpaper helper owner boundary', () => {
  it('shares a pending start and validates the owner before writing', async () => {
    const child = helper();
    mock.spawn.mockReturnValue(child);
    const host = new MacDesktopCompanionNativeHost();
    const results = await Promise.allSettled([
      host.setWallpaper('/a.webp', () => {}),
      host.setWallpaper('/old-owner.webp', () => { throw new Error('ACCOUNT_CHANGED'); }),
    ]);
    expect(mock.spawn).toHaveBeenCalledTimes(1);
    expect(results[1]).toMatchObject({ status: 'rejected', reason: new Error('ACCOUNT_CHANGED') });
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    expect(child.stdin.write.mock.calls[0][0]).toContain('/a.webp');
  });

  it('cancels a pending start when the old owner is torn down', async () => {
    const host = new MacDesktopCompanionNativeHost();
    const pending = host.setWallpaper('/old-owner.webp', () => {});
    const stopped = host.stop();
    const results = await Promise.allSettled([pending, stopped]);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: new Error('HOST_STOPPED') });
    expect(results[1].status).toBe('fulfilled');
    expect(mock.spawn).not.toHaveBeenCalled();
  });

  it('waits for helper exit before allowing another owner to start', async () => {
    const old = helper();
    const next = helper();
    mock.spawn.mockReturnValueOnce(old).mockReturnValueOnce(next);
    const host = new MacDesktopCompanionNativeHost();
    await host.setWallpaper('/old-owner.webp', () => {});
    const stopped = host.stop();
    await Promise.resolve();
    expect(old.stdin.end).toHaveBeenCalled();
    await expect(host.setWallpaper('/next.webp', () => {})).rejects.toThrow('HOST_STOPPED');
    expect(mock.spawn).toHaveBeenCalledTimes(1);
    old.emit('exit', 0);
    await stopped;
    await host.setWallpaper('/next.webp', () => {});
    expect(mock.spawn).toHaveBeenCalledTimes(2);
  });
});
