import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ rename: vi.fn(), replace: vi.fn() }));
vi.mock('node:fs/promises', () => ({ rename: mocks.rename }));
vi.mock('../../windowsAtomicRename.js', () => ({
  atomicReplaceWindowsDirectoryEntry: mocks.replace,
}));
import { replaceFile } from '../replaceFile';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe('verified file publication', () => {
  it.each(['EEXIST', 'EPERM'])('uses native replacement for Windows %s', async (code) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    mocks.rename.mockRejectedValue(Object.assign(new Error('cannot overwrite'), { code }));
    await replaceFile('archive.part', 'archive');
    expect(mocks.replace).toHaveBeenCalledWith(
      path.resolve('archive.part'),
      path.resolve('archive'),
    );
  });
  it.each(['darwin', 'win32'] as const)(
    'uses normal rename on %s when it succeeds',
    async (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
      await replaceFile('current.tmp', 'current.json');
      expect(mocks.replace).not.toHaveBeenCalled();
    },
  );
  it('does not mask permission errors or attempt a destructive fallback', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const failure = Object.assign(new Error('denied'), { code: 'EACCES' });
    mocks.rename.mockRejectedValue(failure);
    await expect(replaceFile('a.part', 'a')).rejects.toBe(failure);
    expect(mocks.replace).not.toHaveBeenCalled();
    mocks.rename.mockRejectedValue(Object.assign(new Error('exists'), { code: 'EEXIST' }));
    mocks.replace.mockRejectedValue(failure);
    await expect(replaceFile('a.part', 'a')).rejects.toBe(failure);
    expect(mocks.rename).toHaveBeenCalledTimes(2);
  });
});
