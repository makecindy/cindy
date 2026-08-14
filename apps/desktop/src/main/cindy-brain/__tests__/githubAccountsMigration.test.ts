/**
 * githubAccountsMigration 单测:老 GitHub 集成(单账号 PAT safe-storage)
 * → cindy-github 意识保险库的一次性搬账(规则 14,内存假体零 Electron)。
 */
import { describe, expect, it } from 'vitest';

import {
  CINDY_GITHUB_GHOST_ID,
  CINDY_GITHUB_SECRET_KEY,
  LEGACY_GITHUB_TOKEN_FILE,
  LEGACY_GITHUB_CONNECTION_FILE,
  migrateGithubAccounts,
  migrateGithubAccountsWithResult,
  type GithubAccountsMigrationDeps,
  type GithubAccountsMigrationVault,
} from '../githubAccountsMigration.js';

const available = <T>(value: T) => ({ status: 'available' as const, value });
const missing = { status: 'missing' as const };
const retryableFailure = { status: 'retryable-failure' as const };

function memoryVault(seed?: Record<string, string>): GithubAccountsMigrationVault & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>(
    Object.entries(seed ?? {}).map(([k, v]) => [`${CINDY_GITHUB_GHOST_ID} ${k}`, v]),
  );
  return {
    data,
    read: (ghostId, key) => data.get(`${ghostId} ${key}`) ?? null,
    store: (ghostId, key, value) => {
      data.set(`${ghostId} ${key}`, value);
      return true;
    },
  };
}

/** 模拟老 safe-storage 存储:记录读取次数,断言迁移对老存储只读不写。 */
function makeDeps(overrides?: Partial<GithubAccountsMigrationDeps>): GithubAccountsMigrationDeps {
  return {
    readLegacyToken: () => available('ghp_legacy_token'),
    readLegacyConnection: () => available({ host: 'github.com' }),
    vault: memoryVault(),
    ...overrides,
  };
}

describe('migrateGithubAccounts', () => {
  it('成功迁移:返回 1,PAT 落到 cindy-github/github_pat,老存储只读不动', () => {
    const vault = memoryVault();
    // 老存储侧只有两个只读函数(deps 形态本身保证不了删除通道),这里额外
    // 断言 legacy 常量仍指向老文件名——防止后人误把迁移改成"搬完就删"。
    expect(LEGACY_GITHUB_TOKEN_FILE).toBe('github_token.enc');
    expect(LEGACY_GITHUB_CONNECTION_FILE).toBe('github_connection.json');

    expect(migrateGithubAccounts(makeDeps({ vault }))).toBe(1);
    expect(vault.read(CINDY_GITHUB_GHOST_ID, CINDY_GITHUB_SECRET_KEY)).toBe('ghp_legacy_token');
    // 只写这一个键,不夹带清单等多余键(user 凭证槽是 secretKey → 值一条)。
    expect(vault.data.size).toBe(1);
  });

  it('意识侧已有值 → 整体跳过(幂等,绝不覆盖用户手动填的 PAT)', () => {
    const vault = memoryVault({ [CINDY_GITHUB_SECRET_KEY]: 'ghp_manual_value' });
    let legacyReads = 0;
    expect(
      migrateGithubAccounts(
        makeDeps({
          vault,
          readLegacyToken: () => {
            legacyReads += 1;
            return available('ghp_legacy_token');
          },
        }),
      ),
    ).toBe(0);
    expect(vault.read(CINDY_GITHUB_GHOST_ID, CINDY_GITHUB_SECRET_KEY)).toBe('ghp_manual_value');
    // 已有值时直接短路,连老 token 都不解密。
    expect(legacyReads).toBe(0);
  });

  it('无老 token(未连接过 / 解密失败)→ no-op', () => {
    const vault = memoryVault();
    expect(migrateGithubAccounts(makeDeps({ vault, readLegacyToken: () => missing }))).toBe(0);
    expect(vault.data.size).toBe(0);
  });

  it('connection.json 缺失(半身位残留)→ 保守不迁,不写库', () => {
    const vault = memoryVault();
    expect(migrateGithubAccounts(makeDeps({ vault, readLegacyConnection: () => missing }))).toBe(0);
    expect(vault.data.size).toBe(0);
  });

  it('老连接是 GHE(非 github.com)→ 跳过且不写库(意识只支持 github.com)', () => {
    const vault = memoryVault();
    expect(
      migrateGithubAccounts(
        makeDeps({ vault, readLegacyConnection: () => available({ host: 'ghe.corp.example' }) }),
      ),
    ).toBe(0);
    expect(vault.data.size).toBe(0);
  });

  it('host 大小写 / 首尾空白归一化后是 github.com → 正常迁', () => {
    const vault = memoryVault();
    expect(
      migrateGithubAccounts(
        makeDeps({ vault, readLegacyConnection: () => available({ host: '  GitHub.COM ' }) }),
      ),
    ).toBe(1);
    expect(vault.read(CINDY_GITHUB_GHOST_ID, CINDY_GITHUB_SECRET_KEY)).toBe('ghp_legacy_token');
  });

  it('旧 token 或连接读取暂时失败 → 不写目标并保留重试', () => {
    expect(
      migrateGithubAccountsWithResult(makeDeps({ readLegacyToken: () => retryableFailure })),
    ).toEqual({ migrated: 0, retryPending: true });
    expect(
      migrateGithubAccountsWithResult(makeDeps({ readLegacyConnection: () => retryableFailure })),
    ).toEqual({ migrated: 0, retryPending: true });
  });

  it('vault.store 写失败(safeStorage 不可用)→ 返回 0,下次启动可重试', () => {
    const vault = memoryVault();
    const failingVault: GithubAccountsMigrationVault = {
      read: vault.read,
      store: () => false,
    };
    expect(migrateGithubAccounts(makeDeps({ vault: failingVault }))).toBe(0);
    expect(migrateGithubAccountsWithResult(makeDeps({ vault: failingVault }))).toEqual({
      migrated: 0,
      retryPending: true,
    });
    // 没有任何值落库,保持"没迁过"状态。
    expect(vault.data.size).toBe(0);
  });
});
