/**
 * hook-control/store.ts
 * ---------------------------------------------------------------------------
 * Slack Hook 配置存储(单配置形态)。
 *
 *   - 持久化为 <userData>/slack-hook.json: { enabled, urlOverride?, workspaces }
 *     —— 属配置而非业务数据, 不进 localDb, 免去 migration 链; 原子写防半截文件。
 *   - **没有密钥**: 鉴权走登录 JWT(manager 注入 token 源), 本模块不再有
 *     safeStorage 依赖。
 *   - 服务器地址的系统默认值由 deps.defaultUrl 注入(生产 = 运行期端点清单的
 *     slackHookWsUrl); urlOverride 是无 UI 的隐藏覆写位(规则 20: 未自定义的
 *     用户随版本吃到新默认值, 覆写过的保留)。
 *   - 一次性迁移: 旧多连接文件 hook-connections.json 存在且新文件不存在时,
 *     取最早创建的启用条目的 enabled + workspaces 落进新文件, 旧文件与旧
 *     secret 加密文件 best-effort 清除(该功能无存量真实用户, 迁移从简)。
 *   - 工厂注入 filePath / log, 单测内存 harness 直接驱动(规则 14)。
 */

import fs from 'node:fs';
import path from 'node:path';

import { HOOK_CHAT_WORKSPACE_ALIAS, HOOK_WORKSPACE_ALIAS_RE } from '../../shared/hookControlIpc.js';

/**
 * (multi-team)本地绑定缓存条目 —— bind.state 快照的持久化影子(含 displaced
 * 行的 team 信息)。用途: 冷启动在断线/关开关状态下也能显示「N 个绑定已保留」,
 * 且连上后与服务端快照 diff 出「本地有、服务端没有」的 displaced 行
 * (绑定在本机离线期间被另一台设备顶掉的场景)。不含任何凭证。
 */
export interface HookBindingCacheEntry {
  teamId: string;
  teamName: string | null;
  slackUserId: string;
  slackUserName: string | null;
}

/**
 * Provider-neutral confirmed binding 的无凭证本地影子，用于关闭 provider 后
 * 稳定展示(字段与 provider.bind.* 协议词汇对齐; 当前仅 Telegram 存储槽使用)。
 */
export interface ProviderBindingCacheEntry {
  bindingId: string;
  principalId: string;
  principalName: string | null;
  scopeId: string;
  scopeName: string;
}

/** 持久化的单配置(不含任何凭证)。 */
export interface SlackHookConfigState {
  /** Slack provider 开关（保留旧字段名，避免旧消费点变更）。 */
  enabled: boolean;
  /** Telegram provider 独立开关。 */
  telegramEnabled: boolean;
  /** 服务器地址覆写(高级/调试用, 无 UI 入口); null = 跟随内置默认。 */
  urlOverride: string | null;
  /** 别名 -> 本地绝对路径。 */
  workspaces: Record<string, string>;
  /** (multi-team)本地绑定缓存; 老 server / 从未多绑定时恒空数组。 */
  bindingsCache: HookBindingCacheEntry[];
  telegramBindingCache: ProviderBindingCacheEntry | null;
}

export interface SlackHookStoreDeps {
  filePath: string;
  /** 旧多连接配置文件路径(迁移源; 不存在则跳过迁移)。 */
  legacyFilePath?: string;
  /** 旧 secret 加密文件清理钩子(best-effort; 生产传 safe-storage 目录清理)。 */
  cleanupLegacySecrets?: (legacyIds: string[]) => void;
  /** 无覆写时的默认服务器地址(生产注入运行期端点清单读取;烘焙常量已退役)。 */
  defaultUrl: () => string;
  /** 当前 Cindy 账号的不可逆指纹；null 表示尚未登录。 */
  getAccountFingerprint?: () => string | null;
  log: { info(msg: string): void; warn(msg: string): void };
}

/** 校验失败以该错误抛出, IPC 层翻译成 throwIpcError('INVALID_PARAMS')。 */
export class HookConnectionValidationError extends Error {}

/**
 * dispatcher 消费的连接视图(保留多连接时代的形状 —— dispatcher / bindings
 * 不感知单连接化, 单配置由 ipc 组装层映射成固定 id 'slack' 的一条)。
 */
export interface HookConnectionConfig {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  workspaces: Record<string, string>;
  createdAt: number;
}

const MAX_WORKSPACES = 32;
const OBJECT_META_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ACCOUNT_FINGERPRINT_RE = /^[A-Za-z0-9_-]{8,64}$/;

function isSafeWorkspaceAlias(alias: string): boolean {
  return (
    HOOK_WORKSPACE_ALIAS_RE.test(alias) &&
    alias !== HOOK_CHAT_WORKSPACE_ALIAS &&
    !OBJECT_META_KEYS.has(alias)
  );
}

function parseAccountFingerprint(raw: unknown): string | null {
  return typeof raw === 'string' && ACCOUNT_FINGERPRINT_RE.test(raw) && !OBJECT_META_KEYS.has(raw)
    ? raw
    : null;
}

/** 校验工作目录清单(别名格式 / 路径绝对), 返回规整副本。 */
export function validateWorkspaces(input: Record<string, string>): Record<string, string> {
  const entries = Object.entries(input ?? {});
  if (entries.length > MAX_WORKSPACES) {
    throw new HookConnectionValidationError(`at most ${MAX_WORKSPACES} workspaces`);
  }
  const workspaces: Record<string, string> = {};
  for (const [alias, dir] of entries) {
    if (!HOOK_WORKSPACE_ALIAS_RE.test(alias)) {
      throw new HookConnectionValidationError(
        `workspace alias "${alias}" must match ${HOOK_WORKSPACE_ALIAS_RE.source}`,
      );
    }
    if (OBJECT_META_KEYS.has(alias)) {
      throw new HookConnectionValidationError(`workspace alias "${alias}" is reserved`);
    }
    // 保留别名: 内置「对话」伪目录占用, 真实目录不许撞名(撞了会被枚举/派发
    // 侧的保留名优先规则遮蔽, 用户还以为绑到了自己的目录)
    if (alias === HOOK_CHAT_WORKSPACE_ALIAS) {
      throw new HookConnectionValidationError(
        `workspace alias "${alias}" is reserved for the built-in chat workspace`,
      );
    }
    const trimmed = typeof dir === 'string' ? dir.trim() : '';
    if (!trimmed || !path.isAbsolute(trimmed)) {
      throw new HookConnectionValidationError(`workspace "${alias}" path must be an absolute path`);
    }
    workspaces[alias] = trimmed;
  }
  return workspaces;
}

/** Slack Hook 配置仓库(写操作同步落盘, 返回写后最新状态)。 */
export interface SlackHookStore {
  get(): SlackHookConfigState;
  /** 实际生效的服务器地址(覆写优先, 否则内置默认)。 */
  effectiveUrl(): string;
  setEnabled(enabled: boolean): SlackHookConfigState;
  setProviderEnabled(provider: 'slack' | 'telegram', enabled: boolean): SlackHookConfigState;
  anyProviderEnabled(): boolean;
  setWorkspaces(workspaces: Record<string, string>): SlackHookConfigState;
  /** (multi-team)覆写本地绑定缓存(bind.state / 绑定行变化后由 manager 调用)。 */
  setBindingsCache(entries: HookBindingCacheEntry[]): SlackHookConfigState;
  setTelegramBindingCache(entry: ProviderBindingCacheEntry | null): SlackHookConfigState;
}

export function createSlackHookStore(deps: SlackHookStoreDeps): SlackHookStore {
  const { filePath, legacyFilePath, cleanupLegacySecrets, log } = deps;

  interface AccountState {
    slack: { enabled: boolean; bindingsCache: HookBindingCacheEntry[] };
    telegram: { enabled: boolean; bindingCache: ProviderBindingCacheEntry | null };
  }

  interface StoredDocument {
    version: 2;
    urlOverride: string | null;
    workspaces: Record<string, string>;
    accounts: Record<string, AccountState>;
    /** v1 配置在首次拿到账号指纹前暂存于此，防登出期写配置丢迁移源。 */
    legacyAccount?: AccountState;
  }

  /** Account IDs are dynamic object keys, so never inherit Object prototype keys. */
  const EMPTY_ACCOUNTS = (): Record<string, AccountState> =>
    Object.create(null) as Record<string, AccountState>;

  function writeDocument(state: StoredDocument): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  }

  /** 旧多连接文件 -> 单配置(最早创建的启用条目优先, 没有启用的取最早一条)。 */
  function migrateLegacy(): SlackHookConfigState | null {
    if (!legacyFilePath || !fs.existsSync(legacyFilePath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(legacyFilePath, 'utf-8')) as unknown;
      if (!Array.isArray(raw)) return null;
      const rows = raw
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
      const source = rows.find((r) => r.enabled === true) ?? rows[0] ?? null;
      const workspaces = parseWorkspaces(source?.workspaces);
      const migrated: SlackHookConfigState = {
        enabled: source?.enabled === true,
        telegramEnabled: false,
        urlOverride: null, // 旧 url 是自部署地址, 不迁移 —— 新形态用内置中心服务器
        workspaces,
        bindingsCache: [], // 旧多连接时代没有绑定缓存概念
        telegramBindingCache: null,
      };
      // 清理旧文件与旧 secret(best-effort, 失败只记日志)
      const legacyIds = rows.map((r) => (typeof r.id === 'string' ? r.id : '')).filter(Boolean);
      try {
        fs.unlinkSync(legacyFilePath);
      } catch {
        /* 清不掉不影响迁移结果 */
      }
      try {
        cleanupLegacySecrets?.(legacyIds);
      } catch {
        /* best-effort */
      }
      log.info(`migrated legacy hook-connections (${rows.length} rows) to slack-hook.json`);
      return migrated;
    } catch (err) {
      log.warn(
        `legacy hook-connections migration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  const EMPTY_ACCOUNT = (): AccountState => ({
    slack: { enabled: false, bindingsCache: [] },
    telegram: { enabled: false, bindingCache: null },
  });

  /** 绑定缓存条目形状校验(坏条目静默丢弃 —— 缓存是可再生数据, 不值得报错)。 */
  function parseBindingsCache(raw: unknown): HookBindingCacheEntry[] {
    if (!Array.isArray(raw)) return [];
    const entries: HookBindingCacheEntry[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      if (typeof row.teamId !== 'string' || row.teamId.length === 0) continue;
      if (typeof row.slackUserId !== 'string' || row.slackUserId.length === 0) continue;
      entries.push({
        teamId: row.teamId,
        teamName: typeof row.teamName === 'string' ? row.teamName : null,
        slackUserId: row.slackUserId,
        slackUserName: typeof row.slackUserName === 'string' ? row.slackUserName : null,
      });
    }
    return entries;
  }

  function parseTelegramBindingCache(raw: unknown): ProviderBindingCacheEntry | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    if (
      typeof row.bindingId !== 'string' ||
      !row.bindingId ||
      typeof row.principalId !== 'string' ||
      !row.principalId ||
      typeof row.scopeId !== 'string' ||
      !row.scopeId ||
      typeof row.scopeName !== 'string' ||
      !row.scopeName
    ) {
      return null;
    }
    return {
      bindingId: row.bindingId,
      principalId: row.principalId,
      principalName: typeof row.principalName === 'string' ? row.principalName : null,
      scopeId: row.scopeId,
      scopeName: row.scopeName,
    };
  }

  function parseAccount(raw: unknown): AccountState {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_ACCOUNT();
    const row = raw as Record<string, unknown>;
    const slack =
      row.slack && typeof row.slack === 'object' && !Array.isArray(row.slack)
        ? (row.slack as Record<string, unknown>)
        : {};
    const telegram =
      row.telegram && typeof row.telegram === 'object' && !Array.isArray(row.telegram)
        ? (row.telegram as Record<string, unknown>)
        : {};
    return {
      slack: {
        enabled: slack.enabled === true,
        bindingsCache: parseBindingsCache(slack.bindingsCache),
      },
      telegram: {
        enabled: telegram.enabled === true,
        bindingCache: parseTelegramBindingCache(telegram.bindingCache),
      },
    };
  }

  function parseWorkspaces(raw: unknown): Record<string, string> {
    const workspaces: Record<string, string> = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (Object.keys(workspaces).length === MAX_WORKSPACES) break;
        if (!isSafeWorkspaceAlias(k) || typeof v !== 'string') continue;
        const trimmed = v.trim();
        if (trimmed && path.isAbsolute(trimmed)) workspaces[k] = trimmed;
      }
    }
    return workspaces;
  }

  function fromLegacyState(state: SlackHookConfigState): StoredDocument {
    return {
      version: 2,
      urlOverride: state.urlOverride,
      workspaces: { ...state.workspaces },
      accounts: EMPTY_ACCOUNTS(),
      legacyAccount: {
        slack: {
          enabled: state.enabled,
          bindingsCache: state.bindingsCache.map((e) => ({ ...e })),
        },
        telegram: { enabled: false, bindingCache: null },
      },
    };
  }

  function readDocument(): StoredDocument {
    try {
      if (!fs.existsSync(filePath)) {
        const migrated = migrateLegacy();
        if (migrated) {
          const document = fromLegacyState(migrated);
          writeDocument(document);
          return document;
        }
        return { version: 2, urlOverride: null, workspaces: {}, accounts: EMPTY_ACCOUNTS() };
      }
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { version: 2, urlOverride: null, workspaces: {}, accounts: EMPTY_ACCOUNTS() };
      }
      const row = raw as Record<string, unknown>;
      const urlOverride =
        typeof row.urlOverride === 'string' && /^wss?:\/\/.+/.test(row.urlOverride)
          ? row.urlOverride
          : null;
      const workspaces = parseWorkspaces(row.workspaces);
      if (row.version === 2) {
        const accounts = EMPTY_ACCOUNTS();
        if (row.accounts && typeof row.accounts === 'object' && !Array.isArray(row.accounts)) {
          for (const [fingerprint, account] of Object.entries(
            row.accounts as Record<string, unknown>,
          )) {
            if (parseAccountFingerprint(fingerprint) !== null)
              accounts[fingerprint] = parseAccount(account);
          }
        }
        return {
          version: 2,
          urlOverride,
          workspaces,
          accounts,
          ...(row.legacyAccount !== undefined
            ? { legacyAccount: parseAccount(row.legacyAccount) }
            : {}),
        };
      }
      // v1 slack-hook.json: provider 状态在首次登录时只归入那个 Cindy 账号。
      return fromLegacyState({
        enabled: row.enabled === true,
        telegramEnabled: false,
        urlOverride,
        workspaces,
        bindingsCache: parseBindingsCache(row.bindingsCache),
        telegramBindingCache: null,
      });
    } catch (err) {
      log.warn(
        `read slack-hook config failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { version: 2, urlOverride: null, workspaces: {}, accounts: EMPTY_ACCOUNTS() };
    }
  }

  /** Claim v1 state only after a concrete authenticated-account fingerprint exists. */
  function currentDocument(): {
    document: StoredDocument;
    fingerprint: string | null;
    changed: boolean;
  } {
    const document = readDocument();
    const fingerprint = parseAccountFingerprint(deps.getAccountFingerprint?.() ?? null);
    let changed = false;
    if (fingerprint && document.legacyAccount) {
      document.accounts[fingerprint] ??= document.legacyAccount;
      delete document.legacyAccount;
      changed = true;
    }
    return { document, fingerprint, changed };
  }

  function viewOf(document: StoredDocument, fingerprint: string | null): SlackHookConfigState {
    const account = fingerprint
      ? (document.accounts[fingerprint] ?? EMPTY_ACCOUNT())
      : EMPTY_ACCOUNT();
    return {
      enabled: account.slack.enabled,
      telegramEnabled: account.telegram.enabled,
      urlOverride: document.urlOverride,
      workspaces: { ...document.workspaces },
      bindingsCache: account.slack.bindingsCache.map((entry) => ({ ...entry })),
      telegramBindingCache: account.telegram.bindingCache
        ? { ...account.telegram.bindingCache }
        : null,
    };
  }

  function read(): SlackHookConfigState {
    const current = currentDocument();
    if (current.changed) writeDocument(current.document);
    return viewOf(current.document, current.fingerprint);
  }

  function mutateAccount(mutator: (account: AccountState) => void): SlackHookConfigState {
    const current = currentDocument();
    if (!current.fingerprint) return viewOf(current.document, null);
    const account = (current.document.accounts[current.fingerprint] ??= EMPTY_ACCOUNT());
    mutator(account);
    writeDocument(current.document);
    return viewOf(current.document, current.fingerprint);
  }

  return {
    get: () => read(),
    effectiveUrl() {
      return read().urlOverride ?? deps.defaultUrl();
    },
    setEnabled(enabled) {
      return mutateAccount((account) => {
        account.slack.enabled = enabled;
      });
    },
    setProviderEnabled(provider, enabled) {
      return mutateAccount((account) => {
        account[provider].enabled = enabled;
      });
    },
    anyProviderEnabled() {
      const state = read();
      return state.enabled || state.telegramEnabled;
    },
    setWorkspaces(workspaces) {
      const current = currentDocument();
      current.document.workspaces = validateWorkspaces(workspaces);
      writeDocument(current.document);
      return viewOf(current.document, current.fingerprint);
    },
    setBindingsCache(entries) {
      // 缓存条目由 manager 从协议帧生成(形状可信), 这里只做浅拷贝防外部改动
      return mutateAccount((account) => {
        account.slack.bindingsCache = entries.map((e) => ({ ...e }));
      });
    },
    setTelegramBindingCache(entry) {
      return mutateAccount((account) => {
        account.telegram.bindingCache = entry ? { ...entry } : null;
      });
    },
  };
}
