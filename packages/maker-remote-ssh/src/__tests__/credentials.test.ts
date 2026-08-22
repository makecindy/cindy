/**
 * resolveAuth — identityFile path-resolution regression (#1837).
 *
 * 背景:用户配了 LAN 主机 + 私钥路径,直接连接正常,但解锁/连接时报
 * "找不到私钥文件"。根因之一是 `~` 展开在 ADD/UPDATE 边界缺失(connect
 * 用 fs.readFile 读配置里的 identityFile,而 Node 不会展开 `~`),另一个是
 * fs ENOENT 被吞成笼统的 SSH_CONNECT_FAILED。
 *
 * 这里固定两条不变量:
 *   1. identityFile 指向不存在的文件 → resolveAuth 抛 `identity file not
 *      found: <path>`(可被 connect IPC 分类为 SSH_KEY_FILE_NOT_FOUND,而不是
 *      泛化的 SSH_CONNECT_FAILED)。
 *   2. 其它 IO 错误仍保留原有 "failed to read identityFile" 包装。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  KEY_FILE_NOT_FOUND_CODE,
  resolveAuth,
  resolvePinnedPublicKeyPath,
} from '../credentials.js';
import type { HostConfig } from '../types.js';

function keyHost(over: Partial<HostConfig> & Pick<HostConfig, 'identityFile'>): HostConfig {
  return {
    id: 'lan-host',
    hostname: '10.0.0.5',
    port: 22,
    user: 'admin',
    authMethod: 'key',
    source: 'manual',
    ...over,
  };
}

describe('resolveAuth key-mode identityFile handling', () => {
  it('throws a distinguishable error when the private key file is missing (ENOENT)', async () => {
    const missing = String.raw`C:\Users\someone\.ssh\id_ed25519`;
    await expect(resolveAuth(keyHost({ identityFile: missing }))).rejects.toThrow(
      `identity file not found: ${missing}`,
    );
  });

  it('tags the ENOENT error with the stable KEY_FILE_NOT_FOUND_CODE so classification never pattern-matches the message', async () => {
    const missing = String.raw`C:\Users\someone\.ssh\id_ed25519`;
    try {
      await resolveAuth(keyHost({ identityFile: missing }));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe(KEY_FILE_NOT_FOUND_CODE);
    }
  });

  it('does not swallow a tilde-prefixed path into a generic message — surfaces the raw path', async () => {
    // `~` 未展开时 fs.readFile 也会 ENOENT;报错应把真实路径说清楚。
    const tilde = String.raw`~\foo\.ssh\id_ed25519`;
    await expect(resolveAuth(keyHost({ identityFile: tilde }))).rejects.toThrow(/identity file not found:/);
  });

  it('still wraps non-ENOENT read failures with the original message', async () => {
    // 指向一个目录,fs.readFile 会抛 EISDIR(而非 ENOENT)→ 保留原包装。
    const host = keyHost({ identityFile: process.cwd() });
    await expect(resolveAuth(host)).rejects.toThrow(/failed to read identityFile .*EISDIR|failed to read identityFile/);
  });
});

describe('agent pinned public-key companion resolution', () => {
  let scratchDir: string | undefined;

  afterEach(async () => {
    if (scratchDir) await fs.rm(scratchDir, { recursive: true, force: true });
    scratchDir = undefined;
  });

  it('resolves guru.key to guru.pub', async () => {
    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'credentials-test-'));
    const privatePath = path.join(scratchDir, 'guru.key');
    const publicPath = path.join(scratchDir, 'guru.pub');
    await fs.writeFile(privatePath, 'encrypted private key placeholder');
    await fs.writeFile(publicPath, 'ssh-ed25519 AAAA test');

    await expect(resolvePinnedPublicKeyPath(privatePath)).resolves.toBe(publicPath);
  });

  it('prefers the conventional foo.key.pub companion when foo.pub is absent', async () => {
    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'credentials-test-'));
    const privatePath = path.join(scratchDir, 'foo.key');
    const publicPath = path.join(scratchDir, 'foo.key.pub');
    await fs.writeFile(publicPath, 'ssh-ed25519 AAAA test');

    await expect(resolvePinnedPublicKeyPath(privatePath)).resolves.toBe(publicPath);
  });
});
