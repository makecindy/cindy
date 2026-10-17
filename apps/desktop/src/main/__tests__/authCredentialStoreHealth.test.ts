import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CREDENTIAL_STORE_UNREADABLE_ESCALATION_THRESHOLD,
  createCredentialStoreHealth,
} from '../authCredentialStoreHealth';

/**
 * #1687:持久凭证库故障升级状态机。
 *
 * 守护的契约:refresh token 文件仍在但连续读不出时,不能无限 transient(此前
 * 该路径失败 14+ 小时零提示),也不能立即清空登录态(会重新引入「钥匙串抖动
 * 强制登出」的历史问题)。连续 N 次失败才升级、任何一次成功读取立即复位。
 */
describe('authCredentialStoreHealth', () => {
  it('startup read failure surfaces immediately and a later successful read clears it', () => {
    const health = createCredentialStoreHealth();
    health.noteStartupFailure();
    expect(health.unavailable).toBe(true);
    expect(health.noteReadFailure()).toBe(false);
    expect(health.noteRecovered()).toBe(true);
    expect(health.unavailable).toBe(false);
    expect(health.noteReadFailure()).toBe(false);
  });

  it('阈值之前保持瞬时语义,不升级', () => {
    const health = createCredentialStoreHealth(5);
    for (let i = 0; i < 4; i++) {
      expect(health.noteReadFailure()).toBe(false);
      expect(health.unavailable).toBe(false);
    }
  });

  it('连续跨过阈值时恰好翻转一次(只广播一次)', () => {
    const health = createCredentialStoreHealth(3);
    expect(health.noteReadFailure()).toBe(false);
    expect(health.noteReadFailure()).toBe(false);
    expect(health.noteReadFailure()).toBe(true); // 第 3 次:翻转
    expect(health.unavailable).toBe(true);
    // 继续失败不再返回 true,避免每 60s 重复广播
    expect(health.noteReadFailure()).toBe(false);
    expect(health.unavailable).toBe(true);
  });

  it('失败与成功交替时永不升级(「连续」是全部语义)', () => {
    const health = createCredentialStoreHealth(3);
    for (let i = 0; i < 10; i++) {
      expect(health.noteReadFailure()).toBe(false);
      expect(health.noteReadFailure()).toBe(false);
      expect(health.noteRecovered()).toBe(false); // 未升级时恢复不返回翻转信号
      expect(health.unavailable).toBe(false);
    }
  });

  it('升级后一次成功读取立即恢复并返回翻转信号,再恢复不重复', () => {
    const health = createCredentialStoreHealth(2);
    health.noteReadFailure();
    expect(health.noteReadFailure()).toBe(true);
    expect(health.noteRecovered()).toBe(true); // 恢复:翻转,广播一次
    expect(health.unavailable).toBe(false);
    expect(health.noteRecovered()).toBe(false); // 已恢复,不重复广播
  });

  it('恢复后重新计数,再次连续失败可再次升级', () => {
    const health = createCredentialStoreHealth(2);
    health.noteReadFailure();
    health.noteReadFailure();
    health.noteRecovered();
    expect(health.noteReadFailure()).toBe(false); // 计数已清零
    expect(health.noteReadFailure()).toBe(true); // 再次连续跨过阈值
  });

  it('reset 无条件复位且不返回信号(登出整体清态用)', () => {
    const health = createCredentialStoreHealth(1);
    health.noteReadFailure();
    expect(health.unavailable).toBe(true);
    health.reset();
    expect(health.unavailable).toBe(false);
    // reset 后计数也清零
    expect(health.noteReadFailure()).toBe(true); // threshold=1,单次即翻转
  });

  it('默认阈值 × 60s 重试间隔 ≈ 5 分钟持续失败才升级', () => {
    expect(CREDENTIAL_STORE_UNREADABLE_ESCALATION_THRESHOLD).toBe(5);
  });
});

/**
 * authManager 接线守卫(authManager 依赖 Electron 无法直接 import,沿用
 * authSessionExpiredDetection.test.ts 的源码守卫模式)。
 */
describe('authManager credential-store escalation wiring', () => {
  const authSource = readFileSync(
    resolve(process.cwd(), 'src/main/authManager.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('keeps explicit login available for corrupt vaults when encryption is healthy', () => {
    const expression = authSource.match(
      /'cold-start-credential-reconcile-unavailable',\s*([\s\S]*?),\s*\);/,
    )?.[1];
    if (!expression) throw new Error('Credential reconciliation classifier was not found');
    class AuthApiError extends Error {
      constructor(public code: string) {
        super(code);
      }
    }
    const classify = new Function(
      'credentialEncryptionUnavailable',
      'error',
      'AuthApiError',
      'hasPotentiallyPersistedAuthCredentials',
      `return (${expression});`,
    );
    const unavailable = new AuthApiError('CREDENTIAL_STORE_UNAVAILABLE');
    expect(classify(false, unavailable, AuthApiError, () => true)).toBe(false);
    expect(classify(true, unavailable, AuthApiError, () => true)).toBe(true);
    expect(classify(true, unavailable, AuthApiError, () => false)).toBe(false);
    expect(classify(true, new Error('unrelated'), AuthApiError, () => true)).toBe(false);
  });

  it('distinguishes an empty profile from records, backups, tombstones and access errors without decryption', () => {
    const body = authSource.match(
      /function hasPotentiallyPersistedAuthCredentials\(\): boolean \{([\s\S]*?)\n\}/,
    )?.[1];
    if (!body) throw new Error('Persisted credential probe was not found');
    const keys = [
      'AUTH_SESSION_KEY',
      'AUTH_ACCOUNT_VAULT_KEY',
      'AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY',
      'LEGACY_RESOURCE_REFRESH_TOKEN_KEY',
      'LEGACY_ACCOUNT_REFRESH_TOKEN_KEY',
      'LEGACY_REFRESH_TOKEN_KEY',
    ];
    const check = new Function(
      'fs',
      'path',
      'SAFE_STORAGE_DIR',
      ...keys,
      body!.replace(' as NodeJS.ErrnoException', ''),
    );
    const probe = (exists: string | null, errorCode = 'ENOENT') =>
      check(
        {
          constants: { F_OK: 0 },
          accessSync: (file: string) => {
            if (file !== exists) throw Object.assign(new Error(), { code: errorCode });
          },
        },
        { join: (...parts: string[]) => parts.join('/') },
        () => '/fake',
        ...keys,
      );
    expect(probe(null)).toBe(false);
    for (const key of keys) {
      expect(probe(`/fake/${key}.enc`)).toBe(true);
      expect(probe(`/fake/${key}.enc.bak`)).toBe(true);
    }
    expect(probe(null, 'EACCES')).toBe(true);
    expect(probe(null, 'EPERM')).toBe(true);
    expect(probe(null, 'EIO')).toBe(true);
  });
});
