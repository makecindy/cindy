/**
 * atlassianAccountsMigration 单测:老 Jira/Confluence 集成(单账号 safe-storage)
 * → xd-atlassian 意识保险库的一次性搬账(规则 14,内存假体零 Electron)。
 */
import { describe, expect, it } from 'vitest';

import {
  XD_ATLASSIAN_GHOST_ID,
  XD_ATLASSIAN_SECRET_KEY,
  migrateAtlassianAccounts,
  migrateAtlassianAccountsWithResult,
  type AtlassianAccountsMigrationDeps,
} from '../atlassianAccountsMigration.js';
import type { GhostOauthVault } from '../ghostOauthAccounts.js';

const available = <T>(value: T) => ({ status: 'available' as const, value });
const missing = { status: 'missing' as const };
const retryableFailure = { status: 'retryable-failure' as const };

function memoryVault(seed?: Record<string, string>): GhostOauthVault & { data: Map<string, string> } {
  const data = new Map<string, string>(
    Object.entries(seed ?? {}).map(([k, v]) => [`${XD_ATLASSIAN_GHOST_ID} ${k}`, v]),
  );
  return {
    data,
    read: (ghostId, key) => data.get(`${ghostId} ${key}`) ?? null,
    store: (ghostId, key, value) => {
      data.set(`${ghostId} ${key}`, value);
      return true;
    },
    remove: (ghostId, key) => {
      data.delete(`${ghostId} ${key}`);
    },
  };
}

function makeDeps(overrides?: Partial<AtlassianAccountsMigrationDeps>): AtlassianAccountsMigrationDeps {
  return {
    readLegacyRefreshToken: () => available('rt-legacy'),
    readLegacyConnection: () => available({ email: 'dev@example.com' }),
    vault: memoryVault(),
    ...overrides,
  };
}

function readManifest(vault: GhostOauthVault): {
  defaultAccountId: string | null;
  accounts: Array<{ id: string; label: string | null; status: string; createdAt: number }>;
} | null {
  const raw = vault.read(XD_ATLASSIAN_GHOST_ID, `${XD_ATLASSIAN_SECRET_KEY}-accounts`);
  return raw ? (JSON.parse(raw) as ReturnType<typeof readManifest>) : null;
}

describe('migrateAtlassianAccounts', () => {
  it('有老 rt:迁一个账号,label = 老连接 email,rt 落 vault,老存储不动', () => {
    const vault = memoryVault();
    expect(migrateAtlassianAccounts(makeDeps({ vault }))).toBe(1);
    const manifest = readManifest(vault);
    expect(manifest).not.toBeNull();
    expect(manifest?.accounts).toHaveLength(1);
    const account = manifest!.accounts[0];
    expect(account.label).toBe('dev@example.com');
    expect(account.status).toBe('connected');
    expect(manifest!.defaultAccountId).toBe(account.id);
    expect(vault.read(XD_ATLASSIAN_GHOST_ID, `${XD_ATLASSIAN_SECRET_KEY}-rt-${account.id}`)).toBe('rt-legacy');
  });

  it('意识侧已有账号清单 → 整体跳过(幂等,二次启动不重复迁)', () => {
    const vault = memoryVault({
      [`${XD_ATLASSIAN_SECRET_KEY}-accounts`]: JSON.stringify({
        defaultAccountId: 'existing',
        accounts: [{ id: 'existing', label: 'x@y.com', status: 'connected', createdAt: 1 }],
      }),
    });
    expect(migrateAtlassianAccounts(makeDeps({ vault }))).toBe(0);
    expect(readManifest(vault)?.accounts[0]?.id).toBe('existing');
  });

  it('无老存储 / rt 解密失败 → no-op', () => {
    const vault = memoryVault();
    expect(migrateAtlassianAccounts(makeDeps({ vault, readLegacyRefreshToken: () => missing }))).toBe(0);
    expect(readManifest(vault)).toBeNull();
  });

  it('连接信息缺失或无 email → label 为 null,照迁', () => {
    const vault = memoryVault();
    expect(migrateAtlassianAccounts(makeDeps({ vault, readLegacyConnection: () => missing }))).toBe(1);
    expect(readManifest(vault)?.accounts[0]?.label).toBeNull();
  });

  it('旧 token 或连接读取暂时失败 → 不写目标并保留重试', () => {
    expect(
      migrateAtlassianAccountsWithResult(
        makeDeps({ readLegacyRefreshToken: () => retryableFailure }),
      ),
    ).toEqual({ migrated: 0, retryPending: true });
    expect(
      migrateAtlassianAccountsWithResult(
        makeDeps({ readLegacyConnection: () => retryableFailure }),
      ),
    ).toEqual({ migrated: 0, retryPending: true });
  });

  it('清单写失败 → 回收已搬 rt,保持"没迁过"状态', () => {
    const vault = memoryVault();
    const failingVault: GhostOauthVault = {
      read: vault.read,
      store: (ghostId, key, value) => {
        if (key === `${XD_ATLASSIAN_SECRET_KEY}-accounts`) return false;
        return vault.store(ghostId, key, value);
      },
      remove: vault.remove,
    };
    expect(migrateAtlassianAccounts(makeDeps({ vault: failingVault }))).toBe(0);
    expect(migrateAtlassianAccountsWithResult(makeDeps({ vault: failingVault }))).toEqual({
      migrated: 0,
      retryPending: true,
    });
    // rt 已回收,vault 里不残留任何键。
    expect(vault.data.size).toBe(0);
  });
});
