import { describe, expect, it, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';

const writeFileMock = vi.fn();
const mkdtempMock = vi.fn();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdtemp: (...args: Parameters<typeof actual.promises.mkdtemp>) => mkdtempMock(...args),
      writeFile: (...args: unknown[]) => writeFileMock(...args),
    },
  };
});

// 被测模块导入的是被 mock 过的命名空间, 断言侧要走真实实现, 否则会自我递归。
const realFs = (await vi.importActual<typeof import('node:fs')>('node:fs')).promises;

const { materializeClaudeFlagSettings, CLAUDE_INLINE_SETTINGS_ARGV_BUDGET } = await import(
  '../flag-settings-file.js'
);

const longSettings = () => ({
  availableModels: Array.from({ length: 1000 }, (_, index) => `vendor/model-${index}-gateway-route`),
});

const createdDirs: string[] = [];

beforeEach(() => {
  writeFileMock.mockReset();
  mkdtempMock.mockReset();
  createdDirs.length = 0;
  writeFileMock.mockImplementation(realFs.writeFile);
  mkdtempMock.mockImplementation(async (...args: Parameters<typeof realFs.mkdtemp>) => {
    const dir = await realFs.mkdtemp(...args);
    createdDirs.push(dir);
    return dir;
  });
});

describe('materializeClaudeFlagSettings', () => {
  it('keeps short settings inline without touching the filesystem', async () => {
    const settings = { apiKeyHelper: '' };
    await expect(materializeClaudeFlagSettings(settings)).resolves.toEqual({ kind: 'inline', settings });
    expect(mkdtempMock).not.toHaveBeenCalled();
  });

  it('removes the temp directory when the first write fails', async () => {
    writeFileMock.mockRejectedValueOnce(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));

    await expect(materializeClaudeFlagSettings(longSettings())).rejects.toMatchObject({ code: 'ENOSPC' });

    // mkdtemp 已经建成目录, 写入失败时调用方拿不到 disposer, 只能由这里删掉。
    expect(createdDirs).toHaveLength(1);
    expect(path.dirname(createdDirs[0])).toBe(os.tmpdir());
    await expect(realFs.stat(createdDirs[0])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes a long catalog to a file and disposes it', async () => {
    const delivery = await materializeClaudeFlagSettings(longSettings());
    expect(delivery.kind).toBe('file');
    if (delivery.kind !== 'file') return;
    const parsed = JSON.parse(await realFs.readFile(delivery.settingsPath, 'utf8')) as {
      availableModels: string[];
    };
    expect(parsed.availableModels).toHaveLength(1000);
    expect(JSON.stringify(longSettings()).length).toBeGreaterThan(CLAUDE_INLINE_SETTINGS_ARGV_BUDGET);
    await delivery.dispose();
    await expect(realFs.stat(delivery.settingsPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
