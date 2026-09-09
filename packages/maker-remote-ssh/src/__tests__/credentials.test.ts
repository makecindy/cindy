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

import { describe, expect, it } from 'vitest';

import {
  KEY_FILE_NOT_FOUND_CODE,
  resolveAuth,
  SSH_CONFIG_AUTH_UNSUPPORTED_CODE,
} from '../credentials.js';
import {
  previewAgentEndpoint,
  resolveAgentEndpoint,
  SSH_AGENT_UNAVAILABLE_CODE,
} from '../sshAuthentication.js';
import type { HostConfig } from '../types.js';

function keyHost(over: Partial<HostConfig> & Pick<HostConfig, 'identityFile'>): HostConfig {
  return {
    id: 'lan-host',
    hostname: '10.0.0.5',
    port: 22,
    user: 'admin',
    authMethod: 'key',
    source: 'manual',
    managedByCindy: false,
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

  it('fails closed before reading a key when discovery marked the SSH config unsupported', async () => {
    const host = keyHost({
      identityFile: '/tmp/does-not-need-to-exist.key',
      sshAuthentication: {
        identitiesOnly: false,
        configuredIdentityFiles: [],
        identityFileDirectiveSeen: false,
        identityFileNoneSeen: false,
        unsupportedReason: 'Cindy does not evaluate a Match block that may affect this SSH host',
      },
    });

    await expect(resolveAuth(host)).rejects.toMatchObject({
      code: SSH_CONFIG_AUTH_UNSUPPORTED_CODE,
    });
  });
});

describe('resolveAuth OpenSSH agent metadata', () => {
  it('treats only exact lowercase IdentityAgent none as the disable sentinel', () => {
    expect(previewAgentEndpoint('none')).toMatchObject({
      unsupportedReason: expect.stringContaining('disables SSH Agent'),
    });
    expect(previewAgentEndpoint('NONE')).toMatchObject({ endpoint: 'NONE' });
  });

  it('rejects unsupported IdentityAgent percent-token expansion', () => {
    expect(previewAgentEndpoint('%d/.ssh/agent')).toMatchObject({
      unsupportedReason: expect.stringContaining('percent-token'),
    });
  });

  it('rejects a missing IdentityAgent environment variable', () => {
    const name = 'CINDY_TEST_MISSING_AGENT_SOCKET';
    const previous = process.env[name];
    delete process.env[name];
    try {
      expect(previewAgentEndpoint(`$${name}`)).toMatchObject({
        unavailableReason: expect.stringContaining('environment variable is not set'),
      });
    } finally {
      if (previous !== undefined) process.env[name] = previous;
    }
  });

  it('classifies a missing default agent endpoint as unavailable, not unsupported', async () => {
    if (process.platform === 'win32') return;
    const previous = process.env.SSH_AUTH_SOCK;
    delete process.env.SSH_AUTH_SOCK;
    try {
      await expect(resolveAgentEndpoint()).rejects.toMatchObject({
        code: SSH_AGENT_UNAVAILABLE_CODE,
      });
    } finally {
      if (previous !== undefined) process.env.SSH_AUTH_SOCK = previous;
    }
  });


  it('keeps an external IdentityFile host unfiltered when IdentitiesOnly is unset', async () => {
    const previous = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = '/tmp/cindy-test-agent.sock';
    try {
      const resolved = await resolveAuth({
        id: 'lab',
        hostname: '192.0.2.10',
        port: 22,
        user: 'developer',
        authMethod: 'agent',
        source: 'ssh-config',
        managedByCindy: false,
        sshAuthentication: {
          identitiesOnly: false,
          identityAgent: undefined,
          configuredIdentityFiles: ['/Users/me/.ssh/lab.key'],
          identityFileDirectiveSeen: true,
          identityFileNoneSeen: false,
        },
      });
      expect(resolved).toMatchObject({
        // Windows OpenSSH uses its named pipe by default; POSIX uses the
        // SSH_AUTH_SOCK environment variable.
        agent: process.platform === 'win32'
          ? '\\\\.\\pipe\\openssh-ssh-agent'
          : '/tmp/cindy-test-agent.sock',
        label: 'ssh-agent',
      });
    } finally {
      if (previous === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = previous;
    }
  });

  it('does not fall back to the default agent for IdentityAgent none', async () => {
    await expect(resolveAuth({
      id: 'disabled-agent',
      hostname: '192.0.2.11',
      port: 22,
      user: 'developer',
      authMethod: 'agent',
      source: 'ssh-config',
      managedByCindy: false,
      sshAuthentication: {
        identitiesOnly: false,
        identityAgent: 'none',
        configuredIdentityFiles: [],
        identityFileDirectiveSeen: false,
        identityFileNoneSeen: false,
      },
    })).rejects.toMatchObject({ code: SSH_CONFIG_AUTH_UNSUPPORTED_CODE });
  });

  it('rejects an empty IdentitiesOnly allow-list', async () => {
    const previous = process.env.SSH_AUTH_SOCK;
    delete process.env.SSH_AUTH_SOCK;
    try {
      await expect(resolveAuth({
        id: 'empty-pin',
        hostname: '192.0.2.12',
        port: 22,
        user: 'developer',
        authMethod: 'agent',
        source: 'ssh-config',
        managedByCindy: false,
        sshAuthentication: {
          identitiesOnly: true,
          configuredIdentityFiles: [],
          identityFileDirectiveSeen: true,
          identityFileNoneSeen: true,
        },
      })).rejects.toMatchObject({ code: SSH_CONFIG_AUTH_UNSUPPORTED_CODE });
    } finally {
      if (previous === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = previous;
    }
  });
});
