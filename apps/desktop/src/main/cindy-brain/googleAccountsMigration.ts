/**
 * googleAccountsMigration.ts — 老 Google 集成账号 → Filo Google 意识(一次性搬账)。
 * ---------------------------------------------------------------------------
 * lizi_google MCP 退役(2026-07-13)前置:老「第三方平台」里授权过的账号,
 * 凡是用 filoCurrent 内置 client 换的(refresh token 与 client 绑定,意识内置
 * 的正是同一个 client,令牌通用),直接迁进意识 OAuth 保险库——用户无感,
 * 不用重新授权。filoLegacy 档案的账号不迁(Lizi 定案"原本的就算了"):
 * 老 client 不随意识走,那批账号由用户在意识里重新点一次「连接账号」。
 *
 * 幂等与安全:
 * - 意识侧已有账号清单(用户已连接过 / 已迁移过)→ 整体跳过,绝不合并覆盖;
 * - 老存储原样保留(不删不改)——退役删的是代码,用户数据留作回滚余地;
 * - refresh token 只在两个 safeStorage 存储之间搬运,不进日志、不进返回值。
 *
 * 依赖注入(规则 14):老存储读取 / 意识保险库全经 deps,单测内存假体零 Electron。
 */

import type { GhostOauthVault } from './ghostOauthAccounts.js';
import type { LegacyMigrationRead } from './legacyMigrationRead.js';

/** filo-google 意识与其 oauth 凭证槽(与 ghost.json 声明一致,搬账目的地)。 */
export const FILO_GOOGLE_GHOST_ID = 'filo-google';
export const FILO_GOOGLE_SECRET_KEY = 'google_account';

/** 老集成账号清单行(mcp-integrations/google.ts 的 manifest 形态,退役后此处是唯一读者)。 */
export interface LegacyGoogleAccountRow {
  id: string;
  email: string | null;
  credentialProfileId: string;
  updatedAt: number;
}

export interface GoogleAccountsMigrationDeps {
  /** 读老账号清单，并区分确实缺失与可重试读取失败。 */
  readLegacyManifest(): LegacyMigrationRead<{ accounts: LegacyGoogleAccountRow[] }>;
  /** 读老账号的 refresh token 明文，并区分确实缺失与可重试读取失败。 */
  readLegacyRefreshToken(accountId: string): LegacyMigrationRead<string>;
  /** 意识 OAuth 保险库(与 GhostOauthAccountManager 同一本账)。 */
  vault: GhostOauthVault;
  log?: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void };
}

export interface GoogleAccountsMigrationResult {
  migrated: number;
  retryPending: boolean;
}

/** 老账号 id 形状(镜像老集成的 SAFE_ACCOUNT_ID_RE;同时满足保险库键名字符集)。 */
const SAFE_ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** 当前内置档案 id(googleCredentials.ts 的 FILO_GOOGLE_CURRENT_PROFILE_ID;退役后常量归此)。 */
export const FILO_CURRENT_PROFILE_ID = 'filoCurrent';

/**
 * 执行一次搬账。返回迁移的账号数(0 = 无可迁 / 已迁过 / 意识侧已有账号)。
 * 在内置意识对账完成后调用(见 index.ts 启动序列);同步 IO 量级为个位数
 * 小文件,不值得异步化。
 */
export function migrateFiloGoogleAccountsWithResult(
  deps: GoogleAccountsMigrationDeps,
): GoogleAccountsMigrationResult {
  const { readLegacyManifest, readLegacyRefreshToken, vault, log } = deps;

  const accountsKey = `${FILO_GOOGLE_SECRET_KEY}-accounts`;
  // 意识侧已有账号(用户手动连过 / 上次已迁)→ 不碰,防重复合并。
  if (vault.read(FILO_GOOGLE_GHOST_ID, accountsKey) !== null) {
    return { migrated: 0, retryPending: false };
  }

  const legacy = readLegacyManifest();
  if (legacy.status === 'retryable-failure') {
    return { migrated: 0, retryPending: true };
  }
  if (legacy.status === 'missing' || legacy.value.accounts.length === 0) {
    return { migrated: 0, retryPending: false };
  }

  const rows: Array<{ id: string; label: string | null; status: 'connected'; createdAt: number }> = [];
  for (const account of legacy.value.accounts) {
    // 只迁 filoCurrent:意识内置同一 client,refresh token 直接通用;
    // legacy 档案的令牌换了 client 刷不动,迁了也是死账号,不如引导重连。
    if (account.credentialProfileId !== FILO_CURRENT_PROFILE_ID) continue;
    if (typeof account.id !== 'string' || !SAFE_ACCOUNT_ID_RE.test(account.id)) continue;
    const refreshToken = readLegacyRefreshToken(account.id);
    if (refreshToken.status === 'retryable-failure') {
      for (const row of rows) {
        vault.remove(FILO_GOOGLE_GHOST_ID, `${FILO_GOOGLE_SECRET_KEY}-rt-${row.id}`);
      }
      return { migrated: 0, retryPending: true };
    }
    if (refreshToken.status === 'missing') continue;
    if (!vault.store(FILO_GOOGLE_GHOST_ID, `${FILO_GOOGLE_SECRET_KEY}-rt-${account.id}`, refreshToken.value)) {
      for (const row of rows) {
        vault.remove(FILO_GOOGLE_GHOST_ID, `${FILO_GOOGLE_SECRET_KEY}-rt-${row.id}`);
      }
      log?.warn('filo-google 搬账:refresh token 写入失败,整体回退并等待重试', {
        accountId: account.id,
      });
      return { migrated: 0, retryPending: true };
    }
    rows.push({
      id: account.id,
      label: typeof account.email === 'string' && account.email.length > 0 ? account.email : null,
      status: 'connected',
      createdAt: typeof account.updatedAt === 'number' && Number.isFinite(account.updatedAt) ? account.updatedAt : 0,
    });
  }
  if (rows.length === 0) return { migrated: 0, retryPending: false };

  const manifest = { defaultAccountId: rows[0].id, accounts: rows };
  if (!vault.store(FILO_GOOGLE_GHOST_ID, accountsKey, JSON.stringify(manifest))) {
    // 清单写失败:回收已搬的 rt,保持"没迁过"的干净状态,下次启动重试。
    for (const row of rows) vault.remove(FILO_GOOGLE_GHOST_ID, `${FILO_GOOGLE_SECRET_KEY}-rt-${row.id}`);
    log?.warn('filo-google 搬账:账号清单写入失败,整体回退');
    return { migrated: 0, retryPending: true };
  }
  log?.info('filo-google 搬账完成:老 Google 集成账号已迁入意识', { migrated: rows.length });
  return { migrated: rows.length, retryPending: false };
}

/** Compatibility wrapper for callers that only need the migrated count. */
export function migrateFiloGoogleAccounts(deps: GoogleAccountsMigrationDeps): number {
  return migrateFiloGoogleAccountsWithResult(deps).migrated;
}
