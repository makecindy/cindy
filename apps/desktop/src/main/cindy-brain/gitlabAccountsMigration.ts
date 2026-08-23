/**
 * gitlabAccountsMigration.ts — 老 GitLab 集成账号 → Cindy GitLab 意识(id: cindy-gitlab;一次性搬账)。
 * ---------------------------------------------------------------------------
 * lizi_gitlab MCP 退役(2026-07-14)前置:老「第三方平台」里连接过的 GitLab
 * 账号(单账号形态:safe-storage 下 gitlab_token.enc + gitlab_connection.json),
 * PAT + 实例地址直接迁入意识的多连接声明(gitlab_conn)并设为默认连接——
 * 用户无感,不用重新粘贴。
 *
 * 与 user 凭证形态(github_pat)的差异:多连接是「地址 + token 成对多条」,
 * 目的地不是单个 secretKey 而是 GhostConnectionManager 名下该 decl 的连接
 * 清单;幂等判定 = 该 decl 名下已有任何连接(用户手动加过 / 已迁过)即整体
 * 跳过。注:管理器公有面区分不了「清单键在但零连接」与「从未有清单」,这里
 * 按「零连接 = 可迁」处理,不为迁移绕过管理器直读派生键(耦合键名纪律)。
 *
 * 边界:意识出网(cindy.fetch)仅支持 https 且白名单是不带端口的裸域——老
 * 集成允许 http 自建实例与带端口地址,这两类不迁(迁了也打不通),日志留痕,
 * 老存储保留;host 还要过 ghostConnections 的合法性校验(具体域名、非 IP)。
 *
 * 幂等与安全(与 githubAccountsMigration 同纪律):
 * - 意识侧该 decl 已有连接 → 跳过,绝不覆盖;
 * - 老存储原样保留(不删不改)——退役删的是代码,用户数据留作回滚余地;
 * - PAT 只在两个 safeStorage 存储之间搬运,不进日志、不进返回值;
 * - 写失败(token/清单任一步)由管理器保证回滚,本轮放弃,下次启动重试。
 *
 * 依赖注入(规则 14):老存储读取 / 连接管理器全经 deps,单测内存假体零 Electron。
 */

import { normalizeGhostConnectionHost } from './ghostConnections.js';
import type { LegacyMigrationRead } from './legacyMigrationRead.js';

/** cindy-gitlab 意识与其多连接声明 key(与 ghost.json network.connections 一致,搬账目的地)。 */
export const CINDY_GITLAB_GHOST_ID = 'cindy-gitlab';
export const CINDY_GITLAB_CONNECTION_KEY = 'gitlab_conn';

/**
 * 老集成的 safe-storage 文件名(镜像自已退役的 mcp-integrations/gitlab.ts 的
 * SAFE_STORAGE_TOKEN_KEY / CONNECTION_FILE;摘壳后常量归此,迁移零 import 老代码)。
 */
export const LEGACY_GITLAB_TOKEN_FILE = 'gitlab_token.enc';
export const LEGACY_GITLAB_CONNECTION_FILE = 'gitlab_connection.json';

/**
 * 迁移只发生在空清单上,upsert 是唯一一条新增;上限取 ghost.json 声明的
 * maxConnections(8)保持一致,任何 ≥1 的值行为等价。
 */
const UPSERT_MAX = 8;

/**
 * 连接管理器最小面(GhostConnectionManager 结构子集;测试喂内存假体)。
 * list 只用于幂等判定(有任何连接即跳过),视图字段只消费 id。
 */
export interface GitlabAccountsMigrationManager {
  list(ghostId: string, declKey: string): Array<{ id: string }>;
  /** 失败(safeStorage 写失败 / 超上限)时 ok:false,token 回滚由管理器保证。 */
  upsert(
    ghostId: string,
    declKey: string,
    params: { host: string; token: string; label?: string; max: number },
  ): { ok: true; connection: { id: string }; updated: boolean } | { ok: false; error: string };
  setDefault(ghostId: string, declKey: string, connectionId: string): boolean;
}

export interface GitlabAccountsMigrationDeps {
  /** 读老 PAT 明文，并区分确实缺失与可重试读取失败。 */
  readLegacyToken(): LegacyMigrationRead<string>;
  /**
   * 老 token 文件是否在场(existsSync,不解密)。只服务幂等跳过分支的留痕
   * 日志——跳过时保持"连老 token 都不解密"的纪律,又不让重试链被静默截断。
   */
  legacyTokenExists(): boolean;
  /** 读老连接信息，并区分确实缺失与可重试读取失败。 */
  readLegacyConnection(): LegacyMigrationRead<{
    baseUrl?: string | null;
    username?: string | null;
  }>;
  manager: GitlabAccountsMigrationManager;
  log?: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void };
}

export interface GitlabAccountsMigrationResult {
  migrated: number;
  retryPending: boolean;
}

/**
 * 老 baseUrl(形如 `https://git.example.com`)→ 连接清单要求的小写裸域。
 * 不可迁形态返回 null:非 https(意识出网仅 https)、带端口(白名单不吃
 * 端口)、host 过不了 ghostConnections 合法性校验(IP / 单段域名等)。
 */
function legacyBaseUrlToHost(
  baseUrl: string,
  log?: GitlabAccountsMigrationDeps['log'],
): string | null {
  const trimmed = baseUrl.trim();
  // 老集成允许 http 自建实例;意识 cindy.fetch 仅 https,迁了也打不通。
  if (!/^https:\/\//i.test(trimmed)) {
    log?.info('cindy-gitlab 搬账跳过:老连接不是 https 实例(意识出网仅 https)');
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    log?.info('cindy-gitlab 搬账跳过:老连接 baseUrl 无法解析');
    return null;
  }
  // 白名单按裸域精确匹配,不吃端口——带端口的自建实例迁了也命中不了。
  if (url.port !== '') {
    log?.info('cindy-gitlab 搬账跳过:老连接带端口(连接白名单只认裸域)');
    return null;
  }
  // URL.hostname 已小写化并剥掉协议 / 尾斜杠;再过连接地址同一套合法性校验。
  const host = normalizeGhostConnectionHost(url.hostname);
  if (host === null) {
    log?.info('cindy-gitlab 搬账跳过:老连接 host 过不了连接地址合法性校验');
    return null;
  }
  return host;
}

/**
 * 执行一次搬账。返回迁移的连接数(老集成是单账号形态,只会是 0 或 1)。
 * 在内置意识对账完成后、确认 cindy-gitlab 已装入时调用(见 index.ts 启动序列)。
 */
export function migrateGitlabAccountsWithResult(
  deps: GitlabAccountsMigrationDeps,
): GitlabAccountsMigrationResult {
  const { readLegacyToken, readLegacyConnection, manager, log } = deps;

  // 该 decl 名下已有连接(用户手动加过 / 上次已迁)→ 不碰,防覆盖。
  // 留痕:若老 token 文件还在(含"首启 upsert 失败后用户手动加了别的实例"
  // 的截断场景),这里是重试链的唯一出口——只探存在性不解密,纪律不破。
  if (manager.list(CINDY_GITLAB_GHOST_ID, CINDY_GITLAB_CONNECTION_KEY).length > 0) {
    if (deps.legacyTokenExists()) {
      log?.info('cindy-gitlab 搬账跳过:意识侧已有连接清单(老 token 文件仍在,按防覆盖纪律不迁)');
    }
    return { migrated: 0, retryPending: false };
  }

  const token = readLegacyToken();
  if (token.status === 'retryable-failure') return { migrated: 0, retryPending: true };
  if (token.status === 'missing') return { migrated: 0, retryPending: false };

  // 老集成 addAccount 必写 connection.json;读不到 = 半身位残留,保守不迁。
  const connection = readLegacyConnection();
  if (connection.status === 'retryable-failure') return { migrated: 0, retryPending: true };
  const baseUrl =
    connection.status === 'available' && typeof connection.value.baseUrl === 'string'
      ? connection.value.baseUrl
      : '';
  if (!baseUrl) {
    log?.info('cindy-gitlab 搬账跳过:老连接信息缺失(半身位残留,保守不迁)', {
      hasConnection: connection.status === 'available',
    });
    return { migrated: 0, retryPending: false };
  }
  const host = legacyBaseUrlToHost(baseUrl, log);
  if (host === null) return { migrated: 0, retryPending: false };

  const username =
    connection.status === 'available'
    && typeof connection.value.username === 'string'
    && connection.value.username.length > 0
      ? connection.value.username
      : null;
  const result = manager.upsert(CINDY_GITLAB_GHOST_ID, CINDY_GITLAB_CONNECTION_KEY, {
    host,
    token: token.value,
    ...(username !== null ? { label: username } : {}),
    max: UPSERT_MAX,
  });
  if (!result.ok) {
    log?.warn('cindy-gitlab 搬账:连接写入失败,放弃本轮(下次启动重试)', {
      error: result.error,
    });
    return { migrated: 0, retryPending: true };
  }
  // 空清单上的新增本就自动成为默认连接;显式设一次是防御性收口(setDefault
  // 幂等),失败也不回退迁移结果(连接已可用,默认位下次启动无从修——但
  // 单连接场景默认位必然就是它,记日志即可)。
  if (!manager.setDefault(CINDY_GITLAB_GHOST_ID, CINDY_GITLAB_CONNECTION_KEY, result.connection.id)) {
    log?.warn('cindy-gitlab 搬账:设默认连接失败(单连接场景不影响使用)');
  }
  log?.info('cindy-gitlab 搬账完成:老 GitLab 集成账号已迁入意识', { host });
  return { migrated: 1, retryPending: false };
}

/** Compatibility wrapper for callers that only need the migrated count. */
export function migrateGitlabAccounts(deps: GitlabAccountsMigrationDeps): number {
  return migrateGitlabAccountsWithResult(deps).migrated;
}
