/**
 * gitlabAccountsMigration 单测:老 GitLab 集成(单账号 PAT safe-storage)
 * → cindy-gitlab 意识多连接声明(gitlab_conn)的一次性搬账(规则 14,
 * 内存假体零 Electron)。
 */
import { describe, expect, it } from 'vitest';

import {
  CINDY_GITLAB_GHOST_ID,
  CINDY_GITLAB_CONNECTION_KEY,
  LEGACY_GITLAB_TOKEN_FILE,
  LEGACY_GITLAB_CONNECTION_FILE,
  migrateGitlabAccounts,
  migrateGitlabAccountsWithResult,
  type GitlabAccountsMigrationDeps,
  type GitlabAccountsMigrationManager,
} from '../gitlabAccountsMigration.js';

const available = <T>(value: T) => ({ status: 'available' as const, value });
const missing = { status: 'missing' as const };
const retryableFailure = { status: 'retryable-failure' as const };

interface FakeRow {
  id: string;
  host: string;
  token: string;
  label: string | null;
}

/** 内存假体连接管理器:按 ghostId+declKey 分桶,行为对齐 GhostConnectionManager 的最小面。 */
function memoryManager(seedRows?: FakeRow[]): GitlabAccountsMigrationManager & {
  rows: FakeRow[];
  defaultId: string | null;
  listCalls: number;
} {
  const rows: FakeRow[] = [...(seedRows ?? [])];
  const self = {
    rows,
    defaultId: rows[0]?.id ?? null,
    listCalls: 0,
    list(ghostId: string, declKey: string) {
      self.listCalls += 1;
      expect(ghostId).toBe(CINDY_GITLAB_GHOST_ID);
      expect(declKey).toBe(CINDY_GITLAB_CONNECTION_KEY);
      return rows.map((r) => ({ id: r.id }));
    },
    upsert(
      _ghostId: string,
      _declKey: string,
      params: { host: string; token: string; label?: string; max: number },
    ) {
      const row: FakeRow = {
        id: `conn-${rows.length + 1}`,
        host: params.host,
        token: params.token,
        label: params.label ?? null,
      };
      rows.push(row);
      return { ok: true as const, connection: { id: row.id }, updated: false };
    },
    setDefault(_ghostId: string, _declKey: string, connectionId: string) {
      if (!rows.some((r) => r.id === connectionId)) return false;
      self.defaultId = connectionId;
      return true;
    },
  };
  return self;
}

function makeDeps(overrides?: Partial<GitlabAccountsMigrationDeps>): GitlabAccountsMigrationDeps {
  return {
    readLegacyToken: () => available('glpat_legacy_token'),
    // 缺省与 readLegacyToken 一致地"在场";幂等留痕用例单独覆盖两种取值。
    legacyTokenExists: () => true,
    readLegacyConnection: () => available({ baseUrl: 'https://gitlab.example.com', username: 'devuser' }),
    manager: memoryManager(),
    ...overrides,
  };
}

describe('migrateGitlabAccounts', () => {
  it('成功迁移:返回 1,连接落到 gitlab_conn 名下(label = 老 username)并设为默认', () => {
    const manager = memoryManager();
    // 老存储侧只有两个只读函数(deps 形态本身保证不了删除通道),这里额外
    // 断言 legacy 常量仍指向老文件名——防止后人误把迁移改成"搬完就删"。
    expect(LEGACY_GITLAB_TOKEN_FILE).toBe('gitlab_token.enc');
    expect(LEGACY_GITLAB_CONNECTION_FILE).toBe('gitlab_connection.json');

    expect(migrateGitlabAccounts(makeDeps({ manager }))).toBe(1);
    expect(manager.rows).toHaveLength(1);
    expect(manager.rows[0]).toMatchObject({
      host: 'gitlab.example.com',
      token: 'glpat_legacy_token',
      label: 'devuser',
    });
    expect(manager.defaultId).toBe(manager.rows[0].id);
  });

  it('该 decl 已有连接 → 整体跳过(幂等,绝不覆盖用户手动加的连接)', () => {
    const manager = memoryManager([
      { id: 'conn-manual', host: 'gitlab.example.com', token: 'glpat_manual', label: null },
    ]);
    let legacyReads = 0;
    expect(
      migrateGitlabAccounts(
        makeDeps({
          manager,
          readLegacyToken: () => {
            legacyReads += 1;
            return available('glpat_legacy_token');
          },
        }),
      ),
    ).toBe(0);
    expect(manager.rows).toHaveLength(1);
    expect(manager.rows[0].token).toBe('glpat_manual');
    // 已有连接时直接短路,连老 token 都不解密。
    expect(legacyReads).toBe(0);
  });

  it('幂等跳过留痕:老 token 文件在场时打 info(只探存在性不解密),不在场时静默', () => {
    // 场景:首启 upsert 失败后用户手动加了别的实例——重试链在此截断,日志
    // 是排查"迁移为什么没跑"的唯一线索(对抗性 review P1-2)。
    const manager = memoryManager();
    manager.rows.push({ id: 'conn-manual', host: 'git.manual.com', token: 'glpat_manual', label: null });
    const infos: string[] = [];
    const log = { info: (m: string) => infos.push(m), warn: () => {} };
    expect(migrateGitlabAccounts(makeDeps({ manager, legacyTokenExists: () => true, log }))).toBe(0);
    expect(infos.some((m) => m.includes('已有连接清单'))).toBe(true);
    const silent: string[] = [];
    expect(
      migrateGitlabAccounts(
        makeDeps({ manager, legacyTokenExists: () => false, log: { info: (m: string) => silent.push(m), warn: () => {} } }),
      ),
    ).toBe(0);
    expect(silent).toHaveLength(0);
  });

  it('无老 token(未连接过 / 解密失败)→ no-op', () => {
    const manager = memoryManager();
    expect(migrateGitlabAccounts(makeDeps({ manager, readLegacyToken: () => missing }))).toBe(0);
    expect(manager.rows).toHaveLength(0);
  });

  it('connection.json 缺失(半身位残留)→ 保守不迁,不写库', () => {
    const manager = memoryManager();
    expect(migrateGitlabAccounts(makeDeps({ manager, readLegacyConnection: () => missing }))).toBe(0);
    expect(manager.rows).toHaveLength(0);
  });

  it('老连接是 http 自建实例 → 跳过且不写库(意识出网仅 https)', () => {
    const manager = memoryManager();
    expect(
      migrateGitlabAccounts(
        makeDeps({
          manager,
          readLegacyConnection: () => available({ baseUrl: 'http://gitlab.internal.example', username: 'devuser' }),
        }),
      ),
    ).toBe(0);
    expect(manager.rows).toHaveLength(0);
  });

  it('老连接带端口 → 跳过且不写库(连接白名单只认裸域)', () => {
    const manager = memoryManager();
    expect(
      migrateGitlabAccounts(
        makeDeps({
          manager,
          readLegacyConnection: () => available({ baseUrl: 'https://git.example.com:8443', username: 'devuser' }),
        }),
      ),
    ).toBe(0);
    expect(manager.rows).toHaveLength(0);
  });

  it('baseUrl 大小写 / 尾斜杠归一化:HTTPS://Git.X.com/ → git.x.com', () => {
    const manager = memoryManager();
    expect(
      migrateGitlabAccounts(
        makeDeps({
          manager,
          readLegacyConnection: () => available({ baseUrl: 'HTTPS://Git.X.com/', username: 'devuser' }),
        }),
      ),
    ).toBe(1);
    expect(manager.rows).toHaveLength(1);
    expect(manager.rows[0].host).toBe('git.x.com');
  });

  it('老 username 缺失 → 仍迁移,label 为 null', () => {
    const manager = memoryManager();
    expect(
      migrateGitlabAccounts(
        makeDeps({
          manager,
          readLegacyConnection: () => available({ baseUrl: 'https://gitlab.example.com', username: null }),
        }),
      ),
    ).toBe(1);
    expect(manager.rows[0].label).toBeNull();
  });

  it('旧 token 或连接读取暂时失败 → 不写目标并保留重试', () => {
    expect(
      migrateGitlabAccountsWithResult(makeDeps({ readLegacyToken: () => retryableFailure })),
    ).toEqual({ migrated: 0, retryPending: true });
    expect(
      migrateGitlabAccountsWithResult(makeDeps({ readLegacyConnection: () => retryableFailure })),
    ).toEqual({ migrated: 0, retryPending: true });
  });

  it('manager.upsert 写失败(safeStorage 不可用)→ 返回 0,下次启动可重试', () => {
    const manager = memoryManager();
    const failingManager: GitlabAccountsMigrationManager = {
      list: manager.list,
      upsert: () => ({ ok: false as const, error: 'VAULT_WRITE_FAILED' }),
      setDefault: manager.setDefault,
    };
    expect(migrateGitlabAccounts(makeDeps({ manager: failingManager }))).toBe(0);
    expect(migrateGitlabAccountsWithResult(makeDeps({ manager: failingManager }))).toEqual({
      migrated: 0,
      retryPending: true,
    });
    // 假体的 rows 只经真 upsert 写入,失败路径不落任何行,保持"没迁过"状态。
    expect(manager.rows).toHaveLength(0);
  });
});
