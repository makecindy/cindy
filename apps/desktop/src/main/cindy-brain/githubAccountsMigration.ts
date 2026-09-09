/**
 * githubAccountsMigration.ts — 老 GitHub 集成账号 → Cindy GitHub 意识(id: cindy-github;一次性搬账)。
 * ---------------------------------------------------------------------------
 * lizi_github MCP 退役(2026-07-14)前置:老「第三方平台」里连接过的 GitHub
 * 账号(单账号形态:safe-storage 下 github_token.enc + github_connection.json),
 * PAT 直接迁入意识保险库的 user 凭证槽(github_pat)——用户无感,不用重新粘贴。
 *
 * 与 oauth 形态(google / atlassian)的差异:user 凭证没有账号清单,保险库里
 * 就是 secretKey → 值一条;幂等判定 = 意识侧该键已有值(用户手动填过 / 已迁过)
 * 即整体跳过。
 *
 * 边界:cindy-github 意识只支持 github.com(网络白名单静态钉死)。老集成允许
 * GHE 自建实例——连接的是 GHE 时不迁(token 迁过去也只会 401),日志留痕,
 * 老存储保留。
 *
 * 幂等与安全(与 googleAccountsMigration 同纪律):
 * - 意识侧已有值 → 跳过,绝不覆盖;
 * - 老存储原样保留(不删不改)——退役删的是代码,用户数据留作回滚余地;
 * - PAT 只在两个 safeStorage 存储之间搬运,不进日志、不进返回值。
 *
 * 依赖注入(规则 14):老存储读取 / 意识保险库全经 deps,单测内存假体零 Electron。
 */

import type { LegacyMigrationRead } from './legacyMigrationRead.js';

/** cindy-github 意识与其 user 凭证槽(与 ghost.json 声明一致,搬账目的地)。 */
export const CINDY_GITHUB_GHOST_ID = 'cindy-github';
export const CINDY_GITHUB_SECRET_KEY = 'github_pat';

/**
 * 老集成的 safe-storage 文件名(镜像自已退役的 mcp-integrations/github.ts 的
 * SAFE_STORAGE_TOKEN_KEY / CONNECTION_FILE;摘壳后常量归此,迁移零 import 老代码)。
 */
export const LEGACY_GITHUB_TOKEN_FILE = 'github_token.enc';
export const LEGACY_GITHUB_CONNECTION_FILE = 'github_connection.json';

export interface GithubAccountsMigrationVault {
  /** 读意识保险库该键的值(不存在回 null;只用于幂等判定,值不外流)。 */
  read(ghostId: string, secretKey: string): string | null;
  /** 返回 false = safeStorage 写失败(本轮放弃,下次启动重试)。 */
  store(ghostId: string, secretKey: string, value: string): boolean;
}

export interface GithubAccountsMigrationDeps {
  /** 读老 PAT 明文，并区分确实缺失与可重试读取失败。 */
  readLegacyToken(): LegacyMigrationRead<string>;
  /** 读老连接信息，并区分确实缺失与可重试读取失败。 */
  readLegacyConnection(): LegacyMigrationRead<{ host?: string | null }>;
  vault: GithubAccountsMigrationVault;
  log?: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void };
}

export interface GithubAccountsMigrationResult {
  migrated: number;
  retryPending: boolean;
}

/**
 * 执行一次搬账。返回迁移的账号数(老集成是单账号形态,只会是 0 或 1)。
 * 在内置意识对账完成后、确认 cindy-github 已装入时调用(见 index.ts 启动序列)。
 */
export function migrateGithubAccountsWithResult(
  deps: GithubAccountsMigrationDeps,
): GithubAccountsMigrationResult {
  const { readLegacyToken, readLegacyConnection, vault, log } = deps;

  // 意识侧已有值(用户手动填过 / 上次已迁)→ 不碰,防覆盖。
  if (vault.read(CINDY_GITHUB_GHOST_ID, CINDY_GITHUB_SECRET_KEY) !== null) {
    return { migrated: 0, retryPending: false };
  }

  const token = readLegacyToken();
  if (token.status === 'retryable-failure') return { migrated: 0, retryPending: true };
  if (token.status === 'missing') return { migrated: 0, retryPending: false };

  // 老集成 addAccount 必写 connection.json;读不到 = 半身位残留,保守不迁。
  const connection = readLegacyConnection();
  if (connection.status === 'retryable-failure') return { migrated: 0, retryPending: true };
  const host =
    connection.status === 'available' && typeof connection.value.host === 'string'
      ? connection.value.host.trim().toLowerCase()
      : '';
  if (host !== 'github.com') {
    log?.info('cindy-github 搬账跳过:老连接不是 github.com(意识只支持 github.com)', {
      hasConnection: connection.status === 'available',
    });
    return { migrated: 0, retryPending: false };
  }

  if (!vault.store(CINDY_GITHUB_GHOST_ID, CINDY_GITHUB_SECRET_KEY, token.value)) {
    log?.warn('cindy-github 搬账:PAT 写入失败,放弃本轮(下次启动重试)');
    return { migrated: 0, retryPending: true };
  }
  log?.info('cindy-github 搬账完成:老 GitHub 集成账号已迁入意识');
  return { migrated: 1, retryPending: false };
}

/** Compatibility wrapper for callers that only need the migrated count. */
export function migrateGithubAccounts(deps: GithubAccountsMigrationDeps): number {
  return migrateGithubAccountsWithResult(deps).migrated;
}
