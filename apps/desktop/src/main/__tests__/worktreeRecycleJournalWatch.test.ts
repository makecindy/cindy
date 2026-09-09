import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ watch: vi.fn(), mkdir: vi.fn(), close: vi.fn(), on: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => path.resolve('test-user-data') } }));
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), watch: mocks.watch }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, default: { ...fs, mkdir: mocks.mkdir } };
});
import { watchRecycleJournal } from '../worktree/recycleJournal';

describe('worktree journal notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.watch.mockReturnValue({ on: mocks.on, close: mocks.close });
  });
  it('listens for atomic journal replacements without watching recovery archive writes', async () => {
    const changed = vi.fn(); const error = vi.fn();
    const stop = await watchRecycleJournal(changed, error);
    expect(mocks.watch).toHaveBeenCalledWith(path.join(path.resolve('test-user-data'), 'worktree-recycle'), { persistent: false }, expect.any(Function));
    const listener = mocks.watch.mock.calls[0][2];
    const id = 'a'.repeat(64);
    for (const name of [id + '.json.tmp', id + '.tar.gz.enc', 'history']) listener('rename', name);
    expect(changed).not.toHaveBeenCalled();
    listener('rename', id + '.json'); listener('change', Buffer.from(id + '.json')); listener('rename', null);
    expect(changed).toHaveBeenCalledTimes(3);
    expect(mocks.on).toHaveBeenCalledWith('error', error);
    stop(); expect(mocks.close).toHaveBeenCalledOnce();
  });
  it('propagates watch setup failures so maintenance can retry them', async () => {
    mocks.watch.mockImplementationOnce(() => { throw new Error('watch unavailable'); });
    await expect(watchRecycleJournal(vi.fn(), vi.fn())).rejects.toThrow('watch unavailable');
  });
});
