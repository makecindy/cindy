import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const readFileSync = vi.hoisted(() => vi.fn());
const readFile = vi.hoisted(() => vi.fn());
const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:fs', () => ({ default: { readFileSync, promises: { readFile } } }));
vi.mock('node:child_process', () => ({ execFile }));

import { syncWindowsVersionAfterUpdate, windowsInstallKey } from '../windowsInstallationVersion';

// Windows paths, independent of the runner's OS. No registry or user files are
// accessed: the shared PowerShell implementation is tested with in-memory keys.
const options = {
  platform: 'win32' as NodeJS.Platform,
  packaged: true,
  version: '0.1.80',
  appId: 'com.xd.cindy',
  exePath: ['C:', 'Programs', 'Cindy', 'Cindy.exe'].join(String.fromCharCode(92)),
  resourcesPath: 'resources',
  patchInfoPath: 'patch-info.json',
  warn: vi.fn(),
};
afterEach(() => vi.resetAllMocks());

describe('Windows installed version metadata', () => {
  it('matches the released winget ProductCode and isolates other app identities', () => {
    expect(windowsInstallKey('com.xd.cindy')).toBe('5a59f1e9-8f21-5646-8eed-e6da4126bb5c');
    expect(new Set(['com.xd.cindy', 'com.xd.cindycn', 'com.xd.cindydev'].map(windowsInstallKey)).size).toBe(3);
  });

  it.each([
    { platform: 'darwin' as NodeJS.Platform },
    { platform: 'linux' as NodeJS.Platform },
    { packaged: false },
    { version: '0.0.0' },
    { version: '0.0.0-beta' },
  ])('does no I/O outside a released Windows installation: %j', async (override) => {
    await syncWindowsVersionAfterUpdate({ ...options, ...override });
    expect(readFileSync).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { version: '0.1.80' },
    { version: '0.1.80', applyAttempts: 0 },
    { version: '0.1.80', applyAttempts: '1' },
    { version: '0.1.81', applyAttempts: 1 },
    { version: '0.1.79', applyAttempts: 1 },
  ])('leaves normal launches and unapplied/failed updates alone: %j', async (patch) => {
    readFileSync.mockReturnValueOnce(JSON.stringify(patch));
    await syncWindowsVersionAfterUpdate(options);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('repairs after an old updater succeeds even though the ZIP has been removed', async () => {
    readFileSync.mockReturnValueOnce(JSON.stringify({ version: options.version, applyAttempts: 1 }));
    readFile.mockResolvedValueOnce('# trusted script');
    execFile.mockImplementation((_file, _args, _opts, callback) => callback(null, '', ''));
    await syncWindowsVersionAfterUpdate(options);
    expect(execFile).toHaveBeenCalledOnce();
    const [file, args, opts] = execFile.mock.calls[0]!;
    expect(file).toBe(path.win32.join(process.env.SystemRoot ?? ['C:', 'Windows'].join(String.fromCharCode(92)), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(Buffer.from(args[3], 'base64').toString('utf16le')).toBe('# trusted script');
    expect(opts).toMatchObject({ windowsHide: true, timeout: 5000, env: {
      CINDY_VERSION_SYNC_KEY: '5a59f1e9-8f21-5646-8eed-e6da4126bb5c',
      CINDY_VERSION_SYNC_EXE: options.exePath, CINDY_VERSION_SYNC_EXPECTED: options.version,
    } });
    expect(options.warn).not.toHaveBeenCalled();
  });

  it('keeps paths out of shell code, including spaces and metacharacters', async () => {
    readFileSync.mockReturnValueOnce(JSON.stringify({ version: options.version, applyAttempts: 1 }));
    readFile.mockResolvedValueOnce('# trusted script');
    execFile.mockImplementation((_file, _args, _opts, callback) => callback(null, '', ''));
    const exePath = "C:\\Cindy & 'test' $(ignored)\\Cindy.exe";
    await syncWindowsVersionAfterUpdate({ ...options, exePath });
    expect(execFile.mock.calls[0]![2].env.CINDY_VERSION_SYNC_EXE).toBe(exePath);
    expect(execFile.mock.calls[0]![1].join(' ')).not.toContain(exePath);
  });

  it('does not reject or change the update result when metadata repair fails', async () => {
    readFileSync.mockReturnValueOnce(JSON.stringify({ version: options.version, applyAttempts: 1 }));
    readFile.mockResolvedValueOnce('# script');
    execFile.mockImplementation((_file, _args, _opts, callback) => callback(new Error('timeout'), '', ''));
    await expect(syncWindowsVersionAfterUpdate(options)).resolves.toBeUndefined();
    expect(options.warn).toHaveBeenCalledOnce();
  });

  it('ignores a missing receipt without starting a repair process', async () => {
    readFileSync.mockImplementationOnce(() => { throw new Error('ENOENT'); });
    await syncWindowsVersionAfterUpdate(options);
    expect(execFile).not.toHaveBeenCalled();
  });
});
