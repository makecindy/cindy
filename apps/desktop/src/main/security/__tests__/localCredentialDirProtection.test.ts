import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CACHEDIR_TAG_CONTENT,
  MACOS_TIME_MACHINE_EXCLUDE_PLIST_HEX,
  MACOS_TIME_MACHINE_EXCLUDE_XATTR,
  hardenLocalCredentialDirectory,
  resetLocalCredentialDirHardeningCacheForTests,
} from '../localCredentialDirProtection.js';

/*
 * 测试价值
 * - 生产入口与可观察结果：hardenLocalCredentialDirectory（创建/收紧 0o700 权限、按需写入
 *   CACHEDIR.TAG 与 .metadata_never_index、调用 macOS xattr Time Machine 排除与 Windows icacls /
 *   attrib +I、失败时降级不抛错且不缓存失败状态）。
 * - Bug／规则依据：docs/dev-rules/credentials-and-local-storage.md（本地文件型多账号凭证目录隔离，
 *   防止备份工具、桌面索引和同机其他账户读取）。
 * - 现有覆盖缺口：新模块；plugin-engine-accounts/paths.ts 此前只做 mkdir(0o700)，无备份/索引排除与 Windows ACL。
 * - 最小失败输入：已存在 0o755 宽权限目录、macOS 带/不带 writeMarkers、Windows 主体 ACL 含域账户、
 *   execFile 抛出 ENOENT。
 * - tier：unit（临时目录 + 注入 execFile，不执行外部系统命令）。实测耗时：< 1s。
 */

describe('hardenLocalCredentialDirectory', () => {
  let root: string;

  beforeEach(async () => {
    resetLocalCredentialDirHardeningCacheForTests();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-cred-dir-protect-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('tightens permissions, writes backup/Spotlight markers, and sets macOS Time Machine exclusion', async () => {
    const dir = path.join(root, 'plugin-engine-accounts');
    await fs.mkdir(dir, { recursive: true, mode: 0o755 });
    if (process.platform !== 'win32') await fs.chmod(dir, 0o755);

    const calls: Array<{ file: string; args: readonly string[] }> = [];
    await hardenLocalCredentialDirectory(dir, {
      writeMarkers: true,
      platform: 'darwin',
      execFile: async (file, args) => {
        calls.push({ file, args });
      },
    });

    if (process.platform !== 'win32') {
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    }
    expect(await fs.readFile(path.join(dir, 'CACHEDIR.TAG'), 'utf8')).toBe(CACHEDIR_TAG_CONTENT);
    expect(await fs.readFile(path.join(dir, '.metadata_never_index'), 'utf8')).toBe('');
    expect(calls).toEqual([
      {
        file: '/usr/bin/xattr',
        args: ['-wx', MACOS_TIME_MACHINE_EXCLUDE_XATTR, MACOS_TIME_MACHINE_EXCLUDE_PLIST_HEX, dir],
      },
    ]);
  });

  it('omits marker files when writeMarkers is false', async () => {
    const dir = path.join(root, 'account-leaf');
    const execFile = vi.fn(async () => undefined);

    await hardenLocalCredentialDirectory(dir, {
      writeMarkers: false,
      platform: 'darwin',
      execFile,
    });

    const entries = await fs.readdir(dir);
    expect(entries).toEqual([]);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('tightens Windows ACL with inheritance removed and marks directory not content-indexed', async () => {
    const dir = path.join(root, 'win-accounts');
    const calls: Array<{ file: string; args: readonly string[]; windowsHide?: boolean }> = [];

    await hardenLocalCredentialDirectory(dir, {
      writeMarkers: true,
      platform: 'win32',
      principal: 'CORP\\alice',
      execFile: async (file, args, options) => {
        calls.push({ file, args, windowsHide: options.windowsHide });
      },
    });

    expect(await fs.readFile(path.join(dir, 'CACHEDIR.TAG'), 'utf8')).toBe(CACHEDIR_TAG_CONTENT);
    await expect(fs.stat(path.join(dir, '.metadata_never_index'))).rejects.toThrow();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.file.toLowerCase()).toMatch(/icacls\.exe$/);
    expect(calls[0]!.args).toEqual([
      dir,
      '/inheritance:r',
      '/grant:r',
      'CORP\\alice:(OI)(CI)F',
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F',
    ]);
    expect(calls[0]!.windowsHide).toBe(true);
    expect(calls[1]!.file.toLowerCase()).toMatch(/attrib\.exe$/);
    expect(calls[1]!.args).toEqual(['+I', dir]);
    expect(calls[1]!.windowsHide).toBe(true);
  });

  it('degrades gracefully when OS hardening commands fail instead of blocking account creation', async () => {
    const dir = path.join(root, 'best-effort');
    const execFile = vi.fn(async () => {
      throw Object.assign(new Error('missing tool'), { code: 'ENOENT' });
    });

    await expect(
      hardenLocalCredentialDirectory(dir, { writeMarkers: true, platform: 'darwin', execFile }),
    ).resolves.toBeUndefined();
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(dir, 'CACHEDIR.TAG'), 'utf8')).toBe(CACHEDIR_TAG_CONTENT);
  });
});
