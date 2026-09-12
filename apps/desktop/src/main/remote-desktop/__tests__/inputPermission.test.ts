import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDesktopInputPermission } from '../inputHost';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  access: vi.fn(),
  app: {
    isPackaged: false,
    getAppPath: () => '/fixture/desktop',
    getPath: () => '/fixture/profile',
  },
}));
vi.mock('electron', () => ({ app: mocks.app, screen: {} }));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return {
    ...original,
    execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.exec }),
  };
});
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => 'fixture source'),
    access: mocks.access,
    mkdir: vi.fn(),
    mkdtemp: vi.fn(async () => '/fixture/compile'),
    writeFile: vi.fn(),
    rm: vi.fn(),
    rename: vi.fn(),
  },
}));

describe('desktop input permission detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    mocks.app.isPackaged = false;
    mocks.access.mockResolvedValue(undefined);
    mocks.exec.mockResolvedValue({ stdout: 'ready\n' });
  });
  afterEach(() => vi.restoreAllMocks());

  it('detects an existing grant on a cold dev build without requesting authorization', async () => {
    mocks.access.mockRejectedValue(new Error('ENOENT'));
    expect(await readDesktopInputPermission()).toBe('granted');
    expect(mocks.exec.mock.calls.map(([binary, args]) => [binary === 'swiftc', args[0]])).toEqual([
      [true, '-D'],
      [false, '--check'],
    ]);
  });

  it.each([
    ['ready\n', 'granted'],
    ['permission\n', 'missing'],
    ['unexpected\n', 'unknown'],
  ])('maps helper output %j to %s without prompting', async (stdout, expected) => {
    mocks.exec.mockResolvedValue({ stdout });
    expect(await readDesktopInputPermission()).toBe(expected);
    expect(mocks.exec).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(path.join('remote-desktop', 'native')),
      ['--check'],
      { timeout: 5000, maxBuffer: 1024 },
    );
  });

  it('does not claim a grant when preparation fails', async () => {
    mocks.access.mockRejectedValue(new Error('ENOENT'));
    mocks.exec.mockRejectedValue(new Error('compiler unavailable'));
    expect(await readDesktopInputPermission()).toBe('unknown');
  });

  it('does not probe Accessibility on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(await readDesktopInputPermission()).toBe('notRequired');
    expect(mocks.exec).not.toHaveBeenCalled();
  });
});
