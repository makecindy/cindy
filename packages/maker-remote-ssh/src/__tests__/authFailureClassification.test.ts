/**
 * isAuthFailure ↔ authFailureHint 的 invariant 回归。
 *
 * 背景（2026-07 cindy_ssh PR review 发现）：connect() 失败时会把 ssh2 原始
 * auth 错误改写成 authFailureHint 的友好文案再 reject / 存进 lastError，而
 * 后续所有"是否认证失败"的判定（RemoteHost 自身的 reconnect 跳过、desktop
 * ensureRemoteHostReady 的 IPC 错误码分类、cindy_ssh 工具错误码）都跑在改写
 * 后的字符串上。若 isAuthFailure 不识别自家 hint 文案，确定性的认证失败会
 * 被降级成"可重试的连接失败"，引发无意义重连/重试。
 *
 * 因此硬性 invariant：authFailureHint 的每一种输出都必须让 isAuthFailure
 * 返回 true。改 hint 措辞时本测试会红，提醒同步 isAuthFailure 的关键词表。
 */

import { describe, it, expect } from 'vitest';

import {
  isAuthFailure,
  authFailureDetail,
  authFailureHint,
  describeIdentityPath,
  formatAuthFailureHint,
} from '../RemoteHost.js';
import type { AuthFailureKind, HostConfig } from '../types.js';

function cfg(partial: Partial<HostConfig>): HostConfig {
  return {
    id: 'web-1',
    hostname: '10.0.0.5',
    port: 22,
    user: 'deploy',
    authMethod: 'agent',
    source: 'manual',
    managedByCindy: false,
    ...partial,
  };
}

describe('isAuthFailure recognizes every authFailureHint variant', () => {
  it('agent mode hint', () => {
    expect(isAuthFailure(authFailureHint(cfg({ authMethod: 'agent' })))).toBe(true);
  });

  it('agent mode hint with non-default port', () => {
    expect(isAuthFailure(authFailureHint(cfg({ authMethod: 'agent', port: 2222 })))).toBe(true);
  });

  it('pinned agent hint tells the user to load the matching key', () => {
    const hint = authFailureHint(cfg({
      authMethod: 'agent',
      sshAuthentication: {
        identitiesOnly: true,
        configuredIdentityFiles: ['/home/u/.ssh/id_ed25519'],
        identityFileDirectiveSeen: true,
        identityFileNoneSeen: false,
        allowedAgentFingerprints: ['SHA256:test'],
      },
    }));
    expect(hint).toContain('ssh-add');
    expect(isAuthFailure(hint)).toBe(true);
  });

  it('key mode hint (with and without identityFile)', () => {
    const hint = authFailureHint(cfg({
      authMethod: 'key',
      identityFile: '/home/u/.ssh/custom-private.key',
    }));
    expect(isAuthFailure(hint)).toBe(true);
    expect(hint).toContain('<public-key-file>');
    expect(hint).not.toContain('/home/u/.ssh');
    expect(hint).not.toContain('custom-private.key.pub');
    expect(isAuthFailure(authFailureHint(cfg({ authMethod: 'key' })))).toBe(true);
  });

  it('fallback hint', () => {
    // authMethod 越界时走兜底文案("Authentication failed connecting as ...")。
    expect(
      isAuthFailure(authFailureHint(cfg({ authMethod: 'password' as HostConfig['authMethod'] }))),
    ).toBe(true);
  });
});

describe('authFailureHint names the identity set and keeps the real reason (#4201)', () => {
  const pinnedCfg = cfg({
    authMethod: 'agent',
    sshAuthentication: {
      identitiesOnly: true,
      configuredIdentityFiles: ['/home/u/.ssh/id_ed25519_github'],
      identityFileDirectiveSeen: true,
      identityFileNoneSeen: false,
      allowedAgentFingerprints: ['SHA256:test'],
    },
  });

  it('pinned agent, offered count unknown: neutral wording that names the IdentityFile and never asserts a cause', () => {
    const hint = authFailureHint(pinnedCfg, { homeDir: '/home/u' });
    expect(hint).toContain('IdentityFile: ~/.ssh/id_ed25519_github');
    expect(hint).toContain('Authentication failed for deploy@10.0.0.5 with the configured identity set');
    expect(hint).not.toContain('has no key');
    expect(hint).not.toContain('rejected every key');
    expect(hint).not.toContain('no key was offered');
    // 绝对路径不进用户可见文案(主目录缩写),也不猜 .pub 文件名。
    expect(hint).not.toContain('/home/u/.ssh');
    expect(hint).not.toContain('.pub');
    expect(isAuthFailure(hint)).toBe(true);
  });

  it('pinned agent, nothing offered (key not loaded): says so and points at ssh-add, not at the remote', () => {
    const hint = authFailureHint(pinnedCfg, {
      homeDir: '/home/u',
      agentOutcome: { offeredCount: 0, signedCount: 0, signFailureCount: 0 },
    });
    expect(hint).toContain('none of the configured identities (IdentityFile: ~/.ssh/id_ed25519_github) is currently loaded in ssh-agent');
    expect(hint).toContain('ssh-add');
    expect(hint).not.toContain('rejected');
    expect(isAuthFailure(hint)).toBe(true);
  });

  // ssh2 只在服务端回 USERAUTH_PK_OK(愿意接受该公钥)之后才让 agent 签名,
  // 所以「签过名」证明的是远端认这把 key,而不是「远端拒绝了 key / 公钥没装」。
  // signedCount 也不是身份去重计数:同一把 RSA key 会按 rsa-sha2-512 →
  // rsa-sha2-256 → ssh-rsa 逐个算法重签。因此既不能断言「每把 key 都被拒」,
  // 也不能把用户引去检查公钥是否安装。
  it('pinned agent, key signed: never claims the remote rejected every key or that the public key is missing', () => {
    const hint = authFailureHint(pinnedCfg, {
      homeDir: '/home/u',
      agentOutcome: { offeredCount: 1, signedCount: 1, signFailureCount: 0 },
    });
    expect(hint).toContain('the remote was willing to accept a key from the configured identity set (IdentityFile: ~/.ssh/id_ed25519_github) and ssh-agent signed with it, but authentication still did not complete');
    expect(hint).not.toContain('rejected every key');
    expect(hint).not.toContain('public key is installed');
    expect(hint).not.toContain('ssh-add');
    expect(isAuthFailure(hint)).toBe(true);
  });

  it('counter-example: one RSA key re-signed per algorithm (signedCount >= offeredCount) still does not claim every key was tried', () => {
    // 两把 key 被枚举,但只有第一把(RSA)按三种算法各签了一次;第二把根本没轮到。
    const hint = authFailureHint(pinnedCfg, {
      homeDir: '/home/u',
      agentOutcome: { offeredCount: 2, signedCount: 3, signFailureCount: 0 },
    });
    expect(hint).not.toContain('every key');
    expect(hint).not.toContain('every identity');
    expect(authFailureDetail(pinnedCfg, {
      agentOutcome: { offeredCount: 2, signedCount: 3, signFailureCount: 0 },
    }).kind).toBe('agent-signed-not-accepted');
    expect(isAuthFailure(hint)).toBe(true);
  });

  it('several keys offered but only some signed: same conservative wording, no "before every identity" claim either', () => {
    const hint = authFailureHint(pinnedCfg, {
      homeDir: '/home/u',
      agentOutcome: { offeredCount: 3, signedCount: 1, signFailureCount: 0 },
    });
    expect(hint).toContain('ssh-agent signed with it, but authentication still did not complete');
    expect(hint).not.toContain('rejected the key');
    expect(hint).not.toContain('before every identity was tried');
    expect(isAuthFailure(hint)).toBe(true);
  });

  it('pinned agent, key offered but the agent could not sign: local problem, never blamed on the remote', () => {
    const hint = authFailureHint(pinnedCfg, {
      homeDir: '/home/u',
      agentOutcome: { offeredCount: 1, signedCount: 0, signFailureCount: 1 },
    });
    expect(hint).toContain('ssh-agent could not sign with the configured identity (IdentityFile: ~/.ssh/id_ed25519_github)');
    expect(hint).not.toContain('rejected');
    expect(isAuthFailure(hint)).toBe(true);
    // 枚举到了但一次签名都没发生(ssh2 未走到该 key)→ 不能断言远端拒绝,回到中性措辞
    const neutral = authFailureHint(pinnedCfg, {
      homeDir: '/home/u',
      agentOutcome: { offeredCount: 1, signedCount: 0, signFailureCount: 0 },
    });
    expect(neutral).toContain('with the configured identity set');
    expect(neutral).not.toContain('rejected every key');
    expect(isAuthFailure(neutral)).toBe(true);
  });

  it('names only the identities the attempt was actually limited to (explicit pin beats unrelated ssh_config entries)', () => {
    // marker auth=agent + explicit Cindy pin, IdentitiesOnly unset: resolveAuth pins
    // only cfg.identityFile; the other IdentityFile entries never reach the agent.
    const hint = authFailureHint(
      cfg({
        authMethod: 'agent',
        identityFile: '/home/u/.ssh/id_ed25519_github',
        sshAuthentication: {
          identitiesOnly: false,
          configuredIdentityFiles: ['/home/u/.ssh/id_rsa', '/home/u/.ssh/id_ed25519_github', '/home/u/.ssh/other'],
          identityFileDirectiveSeen: true,
          identityFileNoneSeen: false,
        },
      }),
      { homeDir: '/home/u' },
    );
    expect(hint).toContain('IdentityFile: ~/.ssh/id_ed25519_github)');
    expect(hint).not.toContain('id_rsa');
    expect(hint).not.toContain('other');
    // The resolved auth's list wins over any derivation from config.
    const explicit = authFailureHint(pinnedCfg, {
      homeDir: '/home/u',
      pinnedIdentityFiles: ['/home/u/.ssh/only_this'],
    });
    expect(explicit).toContain('IdentityFile: ~/.ssh/only_this)');
    expect(explicit).not.toContain('id_ed25519_github');
  });

  it('keeps distinct files that share a basename instead of merging them', () => {
    const hint = authFailureHint(pinnedCfg, {
      homeDir: '/home/u',
      pinnedIdentityFiles: ['/srv/a/id_rsa', '/opt/b/id_rsa', '/srv/a/id_rsa'],
    });
    expect(hint).toContain('IdentityFile: a/id_rsa, b/id_rsa)');
    expect(hint).not.toContain('/srv/');
    expect(hint).not.toContain('/opt/');
  });

  it('appends the underlying ssh2 reason once, and not when the text already says it', () => {
    const hint = authFailureHint(pinnedCfg, {
      homeDir: '/home/u',
      cause: 'All configured authentication methods failed',
    });
    expect(hint).toContain('(ssh: All configured authentication methods failed)');
    expect(hint.split('All configured authentication methods failed').length - 1).toBe(1);
    expect(isAuthFailure(hint)).toBe(true);

    const plain = authFailureHint(cfg({ authMethod: 'agent' }), { cause: '  ' });
    expect(plain).not.toContain('(ssh:');
    const fallback = authFailureHint(
      cfg({ authMethod: 'password' as HostConfig['authMethod'] }),
      { cause: 'Authentication failed.' },
    );
    expect(fallback).toContain('(ssh: Authentication failed.)');
    expect(isAuthFailure(fallback)).toBe(true);
  });

  it('key mode names the identity by basename only when it is outside the home directory', () => {
    const hint = authFailureHint(
      cfg({ authMethod: 'key', identityFile: '/srv/keys/deploy.key' }),
      { homeDir: '/home/u', cause: 'All configured authentication methods failed' },
    );
    expect(hint).toContain('The configured identity file (deploy.key) was rejected by the remote');
    expect(hint).not.toContain('/srv/keys');
    expect(isAuthFailure(hint)).toBe(true);
  });

  it('describeIdentityPath abbreviates home, keeps ~ forms, and otherwise falls back to the basename', () => {
    expect(describeIdentityPath('/home/u/.ssh/id_ed25519', '/home/u')).toBe('~/.ssh/id_ed25519');
    expect(describeIdentityPath('~/.ssh/id_ed25519', '/home/u')).toBe('~/.ssh/id_ed25519');
    expect(describeIdentityPath('/srv/keys/deploy.key', '/home/u')).toBe('deploy.key');
    expect(describeIdentityPath('/home/u2/.ssh/id_rsa', '/home/u')).toBe('id_rsa');
    expect(describeIdentityPath('   ', '/home/u')).toBe('');
  });
});

describe('authFailureDetail is the structured source of authFailureHint (#4201 i18n)', () => {
  const pinned = cfg({
    authMethod: 'agent',
    port: 2222,
    sshAuthentication: {
      identitiesOnly: true,
      configuredIdentityFiles: ['/home/u/.ssh/id_a', '/srv/keys/id_b'],
      identityFileDirectiveSeen: true,
      identityFileNoneSeen: false,
      allowedAgentFingerprints: ['SHA256:a', 'SHA256:b'],
    },
  });
  const cases: Array<[AuthFailureKind, HostConfig, Parameters<typeof authFailureDetail>[1]]> = [
    ['agent-not-loaded', pinned, { agentOutcome: { offeredCount: 0, signedCount: 0, signFailureCount: 0 } }],
    ['agent-sign-failed', pinned, { agentOutcome: { offeredCount: 1, signedCount: 0, signFailureCount: 1 } }],
    ['agent-signed-not-accepted', pinned, { agentOutcome: { offeredCount: 2, signedCount: 1, signFailureCount: 0 } }],
    ['agent-pinned', pinned, { agentOutcome: { offeredCount: null, signedCount: 0, signFailureCount: 0 } }],
    ['agent-pinned', pinned, {}],
    ['agent-unpinned', cfg({ authMethod: 'agent', port: 2222 }), {}],
    ['key-rejected', cfg({ authMethod: 'key', port: 2222, identityFile: '/home/u/.ssh/deploy' }), {}],
    ['generic', cfg({ authMethod: 'password' as HostConfig['authMethod'] }), {}],
  ];

  it.each(cases)('%s: kind, formatter parity and isAuthFailure invariant', (kind, config, options) => {
    const withCause = { ...options, homeDir: '/home/u', cause: 'All configured authentication methods failed' };
    const detail = authFailureDetail(config, withCause);
    expect(detail.kind).toBe(kind);
    expect(detail.user).toBe('deploy');
    expect(detail.hostname).toBe('10.0.0.5');
    expect(detail.cause).toBe('All configured authentication methods failed');
    // 英文正本与结构化字段同源:lastError / IPC / MCP 继续拿到原来的整句。
    expect(formatAuthFailureHint(detail)).toBe(authFailureHint(config, withCause));
    expect(isAuthFailure(formatAuthFailureHint(detail))).toBe(true);
    // 身份标签只给缩写 / basename,结构化字段里也不出现绝对路径。
    for (const label of detail.identities) {
      expect(label.startsWith('/')).toBe(false);
    }
  });

  it('carries identity labels and the CLI command as separate English fields', () => {
    expect(authFailureDetail(pinned, { homeDir: '/home/u' }).identities).toEqual(['~/.ssh/id_a', 'id_b']);
    expect(authFailureDetail(cfg({ authMethod: 'agent', port: 2222 })).command)
      .toBe('ssh-copy-id -p 2222 deploy@10.0.0.5');
    expect(authFailureDetail(cfg({ authMethod: 'key', identityFile: '/home/u/.ssh/deploy' }), { homeDir: '/home/u' }))
      .toMatchObject({ identities: ['~/.ssh/deploy'], command: 'ssh-copy-id -i <public-key-file> deploy@10.0.0.5' });
    // pinned agent 不给命令:它的处置不是 ssh-copy-id。
    expect(authFailureDetail(pinned).command).toBeUndefined();
    // 空白 cause 不进入结构化字段。
    expect(authFailureDetail(pinned, { cause: '   ' })).not.toHaveProperty('cause');
  });
});

describe('isAuthFailure still recognizes raw ssh2 auth errors', () => {
  it.each([
    'All configured authentication methods failed',
    'Authentication failed.',
    'auth failed',
    'Permission denied (publickey)',
    'No matching authentication scheme',
  ])('%s', (msg) => {
    expect(isAuthFailure(msg)).toBe(true);
  });

  it('does not misclassify plain connection errors', () => {
    expect(isAuthFailure('connect ETIMEDOUT 10.0.0.5:22')).toBe(false);
    expect(isAuthFailure('connection closed before ready')).toBe(false);
  });
});
