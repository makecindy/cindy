/**
 * atlassianAccountsMigration.ts — 老 Jira/Confluence 集成账号 → XD Atlassian 意识(一次性搬账)。
 * ---------------------------------------------------------------------------
 * lizi_jira / lizi_confluence MCP 退役(2026-07-14)前置:老「第三方平台」里
 * 授权过的 Atlassian 账号(单账号形态:safe-storage 下 jira_refresh_token.enc +
 * jira_connection.json),refresh token 是同一个 Atlassian 应用(server 端
 * broker 持 secret)换的,意识的 tokenBroker 模式走同一 broker 端点刷新,
 * 令牌直接通用——用户无感,不用重新授权。
 *
 * 幂等与安全(与 googleAccountsMigration 同纪律):
 * - 意识侧已有账号清单(用户已连接过 / 已迁移过)→ 整体跳过,绝不合并覆盖;
 * - 老存储原样保留(不删不改)——退役删的是代码,用户数据留作回滚余地;
 * - refresh token 只在两个 safeStorage 存储之间搬运,不进日志、不进返回值。
 *
 * 依赖注入(规则 14):老存储读取 / 意识保险库全经 deps,单测内存假体零 Electron。
 */

import { randomUUID } from 'node:crypto';

import type { GhostOauthVault } from './ghostOauthAccounts.js';
import type { LegacyMigrationRead } from './legacyMigrationRead.js';

/** xd-atlassian 意识与其 oauth 凭证槽(与 ghost.json 声明一致,搬账目的地)。 */
export const XD_ATLASSIAN_GHOST_ID = 'xd-atlassian';
export const XD_ATLASSIAN_SECRET_KEY = 'atlassian_account';

/**
 * 老集成的 safe-storage 文件名(镜像自已退役的 mcp-integrations/jira.ts 的
 * SAFE_STORAGE_RT_KEY / CONNECTION_FILE;摘壳后常量归此,迁移零 import 老代码)。
 */
export const LEGACY_JIRA_RT_FILE = 'jira_refresh_token.enc';
export const LEGACY_JIRA_CONNECTION_FILE = 'jira_connection.json';

export interface AtlassianAccountsMigrationDeps {
  /** 读老 refresh token 明文，并区分确实缺失与可重试读取失败。 */
  readLegacyRefreshToken(): LegacyMigrationRead<string>;
  /** 读老连接信息，并区分确实缺失与可重试读取失败。 */
  readLegacyConnection(): LegacyMigrationRead<{ email?: string | null }>;
  /** 意识 OAuth 保险库(与 GhostOauthAccountManager 同一本账)。 */
  vault: GhostOauthVault;
  log?: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void };
}

export interface AtlassianAccountsMigrationResult {
  migrated: number;
  retryPending: boolean;
}

/**
 * 执行一次搬账。返回迁移的账号数(老集成是单账号形态,只会是 0 或 1)。
 * 在内置意识对账完成后、确认 xd-atlassian 已装入时调用(见 index.ts 启动序列)。
 */
export function migrateAtlassianAccountsWithResult(
  deps: AtlassianAccountsMigrationDeps,
): AtlassianAccountsMigrationResult {
  const { readLegacyRefreshToken, readLegacyConnection, vault, log } = deps;

  const accountsKey = `${XD_ATLASSIAN_SECRET_KEY}-accounts`;
  // 意识侧已有账号(用户手动连过 / 上次已迁)→ 不碰,防重复合并。
  if (vault.read(XD_ATLASSIAN_GHOST_ID, accountsKey) !== null) {
    return { migrated: 0, retryPending: false };
  }

  const refreshToken = readLegacyRefreshToken();
  if (refreshToken.status === 'retryable-failure') return { migrated: 0, retryPending: true };
  if (refreshToken.status === 'missing') return { migrated: 0, retryPending: false };

  const connection = readLegacyConnection();
  if (connection.status === 'retryable-failure') return { migrated: 0, retryPending: true };
  const email =
    connection.status === 'available'
    && typeof connection.value.email === 'string'
    && connection.value.email.length > 0
      ? connection.value.email
      : null;

  const accountId = randomUUID();
  // rt 先落库再挂清单(与 GhostOauthAccountManager.connectAccount 同顺序,防半身位)。
  if (!vault.store(XD_ATLASSIAN_GHOST_ID, `${XD_ATLASSIAN_SECRET_KEY}-rt-${accountId}`, refreshToken.value)) {
    log?.warn('xd-atlassian 搬账:refresh token 写入失败,放弃本轮(下次启动重试)');
    return { migrated: 0, retryPending: true };
  }
  const manifest = {
    defaultAccountId: accountId,
    accounts: [{ id: accountId, label: email, status: 'connected' as const, createdAt: Date.now() }],
  };
  if (!vault.store(XD_ATLASSIAN_GHOST_ID, accountsKey, JSON.stringify(manifest))) {
    // 清单写失败:回收已搬的 rt,保持"没迁过"的干净状态,下次启动重试。
    vault.remove(XD_ATLASSIAN_GHOST_ID, `${XD_ATLASSIAN_SECRET_KEY}-rt-${accountId}`);
    log?.warn('xd-atlassian 搬账:账号清单写入失败,整体回退');
    return { migrated: 0, retryPending: true };
  }
  log?.info('xd-atlassian 搬账完成:老 Jira/Confluence 集成账号已迁入意识', { hasEmail: email !== null });
  return { migrated: 1, retryPending: false };
}

/** Compatibility wrapper for callers that only need the migrated count. */
export function migrateAtlassianAccounts(deps: AtlassianAccountsMigrationDeps): number {
  return migrateAtlassianAccountsWithResult(deps).migrated;
}
