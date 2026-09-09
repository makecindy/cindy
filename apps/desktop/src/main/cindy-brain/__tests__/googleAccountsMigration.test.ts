/**
 * googleAccountsMigration 单测:老 Google 集成 → Filo Google 意识搬账
 * (只迁 filoCurrent、幂等、清单写败回退;规则 14 内存假体零 Electron)。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  FILO_CURRENT_PROFILE_ID,
  FILO_GOOGLE_GHOST_ID,
  FILO_GOOGLE_SECRET_KEY,
  migrateFiloGoogleAccounts,
  migrateFiloGoogleAccountsWithResult,
  type GoogleAccountsMigrationDeps,
  type LegacyGoogleAccountRow,
} from '../googleAccountsMigration.js';

function memoryVault(seed?: Record<string, string>) {
  const data = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    data,
    read: (g: string, k: string) => data.get(`${g} ${k}`) ?? null,
    store: (g: string, k: string, v: string) => {
      data.set(`${g} ${k}`, v);
      return true;
    },
    remove: (g: string, k: string) => {
      data.delete(`${g} ${k}`);
    },
  };
}

const CURRENT = (id: string, email: string | null): LegacyGoogleAccountRow => ({
  id,
  email,
  credentialProfileId: FILO_CURRENT_PROFILE_ID,
  updatedAt: 100,
});
const available = <T>(value: T) => ({ status: 'available' as const, value });
const missing = { status: 'missing' as const };
const retryableFailure = { status: 'retryable-failure' as const };

function deps(over: Partial<GoogleAccountsMigrationDeps>): GoogleAccountsMigrationDeps {
  return {
    readLegacyManifest: () => available({ accounts: [CURRENT('acc-1', 'a@b.com')] }),
    readLegacyRefreshToken: () => available('rt-legacy'),
    vault: memoryVault(),
    ...over,
  };
}

const RT_KEY = (id: string) => `${FILO_GOOGLE_SECRET_KEY}-rt-${id}`;
const ACCOUNTS_KEY = `${FILO_GOOGLE_SECRET_KEY}-accounts`;

describe('migrateFiloGoogleAccounts', () => {
  it('happy:filoCurrent 账号迁入,rt 落库 + 清单成形 + 默认账号', () => {
    const vault = memoryVault();
    const n = migrateFiloGoogleAccounts(deps({ vault }));
    expect(n).toBe(1);
    expect(vault.read(FILO_GOOGLE_GHOST_ID, RT_KEY('acc-1'))).toBe('rt-legacy');
    const manifest = JSON.parse(vault.read(FILO_GOOGLE_GHOST_ID, ACCOUNTS_KEY) ?? '{}');
    expect(manifest.defaultAccountId).toBe('acc-1');
    expect(manifest.accounts[0]).toMatchObject({ id: 'acc-1', label: 'a@b.com', status: 'connected' });
  });

  it('legacy 档案账号不迁(原本的就算了)', () => {
    const vault = memoryVault();
    const n = migrateFiloGoogleAccounts(
      deps({
        vault,
        readLegacyManifest: () => available({
          accounts: [{ id: 'old-1', email: 'x@y.com', credentialProfileId: 'filoLegacy', updatedAt: 1 }],
        }),
      }),
    );
    expect(n).toBe(0);
    expect(vault.read(FILO_GOOGLE_GHOST_ID, ACCOUNTS_KEY)).toBeNull();
  });

  it('幂等:意识侧已有账号清单 → 整体跳过,不读老存储', () => {
    const vault = memoryVault({ [`${FILO_GOOGLE_GHOST_ID} ${ACCOUNTS_KEY}`]: '{"defaultAccountId":"x","accounts":[]}' });
    const readLegacyManifest = vi.fn(() => available({ accounts: [CURRENT('acc-1', 'a@b.com')] }));
    const n = migrateFiloGoogleAccounts(deps({ vault, readLegacyManifest }));
    expect(n).toBe(0);
    expect(readLegacyManifest).not.toHaveBeenCalled();
  });

  it('老存储缺失 / 无 filoCurrent 账号 → 0,不建清单', () => {
    expect(migrateFiloGoogleAccounts(deps({ readLegacyManifest: () => missing }))).toBe(0);
    expect(
      migrateFiloGoogleAccounts(deps({ readLegacyManifest: () => available({ accounts: [] }) })),
    ).toBe(0);
  });

  it('refresh token 读不到的账号跳过,只迁能迁的', () => {
    const vault = memoryVault();
    const n = migrateFiloGoogleAccounts(
      deps({
        vault,
        readLegacyManifest: () => available({ accounts: [CURRENT('acc-1', 'a@b.com'), CURRENT('acc-2', 'c@d.com')] }),
        readLegacyRefreshToken: (id) => (id === 'acc-1' ? available('rt-1') : missing),
      }),
    );
    expect(n).toBe(1);
    const manifest = JSON.parse(vault.read(FILO_GOOGLE_GHOST_ID, ACCOUNTS_KEY) ?? '{}');
    expect(manifest.accounts.map((a: { id: string }) => a.id)).toEqual(['acc-1']);
  });

  it('任一旧 token 暂时读失败 → 回滚本轮已写 token 并保留整轮重试', () => {
    const vault = memoryVault();
    const result = migrateFiloGoogleAccountsWithResult(
      deps({
        vault,
        readLegacyManifest: () => available({
          accounts: [CURRENT('acc-1', 'a@b.com'), CURRENT('acc-2', 'c@d.com')],
        }),
        readLegacyRefreshToken: (id) => (id === 'acc-1' ? available('rt-1') : retryableFailure),
      }),
    );
    expect(result).toEqual({ migrated: 0, retryPending: true });
    expect(vault.data.size).toBe(0);
  });

  it('旧账号清单暂时读失败 → 不写目标并保留重试', () => {
    const vault = memoryVault();
    expect(
      migrateFiloGoogleAccountsWithResult(
        deps({ vault, readLegacyManifest: () => retryableFailure }),
      ),
    ).toEqual({ migrated: 0, retryPending: true });
    expect(vault.data.size).toBe(0);
  });

  it('清单写失败 → 回收已搬 rt,保持"没迁过"状态', () => {
    const vault = memoryVault();
    // 清单键写入失败(rt 键正常):模拟 safeStorage 半可用。
    const store = vi.fn((g: string, k: string, v: string) => {
      if (k === ACCOUNTS_KEY) return false;
      vault.data.set(`${g} ${k}`, v);
      return true;
    });
    const failing = { ...vault, store };
    const n = migrateFiloGoogleAccounts(deps({ vault: failing }));
    expect(n).toBe(0);
    // 已搬的 rt 被回收,下次启动可干净重试。
    expect(vault.read(FILO_GOOGLE_GHOST_ID, RT_KEY('acc-1'))).toBeNull();
    expect(migrateFiloGoogleAccountsWithResult(deps({ vault: failing }))).toEqual({
      migrated: 0,
      retryPending: true,
    });
  });
});
