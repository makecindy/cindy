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
 * 稳定展示(字段与 provider.bind.* 协议词汇对齐; Telegram / X 存储槽使用)。
 */
export interface ProviderBindingCacheEntry {
  tenantKey?: string | null;
  bindingId: string;
  principalId: string;
  principalName: string | null;
  scopeId: string;
  scopeName: string | null;
}

/** 持久化的单配置(不含任何凭证)。 */
export interface SlackHookConfigState {
  /** Slack provider 开关（保留旧字段名，避免旧消费点变更）。 */
  enabled: boolean;
  /** Telegram provider 独立开关。 */
  telegramEnabled: boolean;
  /** X (Twitter) provider 独立开关。 */
  xEnabled: boolean;
  /** 官方飞书 / Lark provider 独立开关。 */
  feishuEnabled: boolean;
  /** Explicit companion assignment; absent preserves ordinary X tasks. */
  xCompanionBotId?: string | null;
  /** 服务器地址覆写(高级/调试用, 无 UI 入口); null = 跟随内置默认。 */
  urlOverride: string | null;
  /** 项目名称 -> 本地绝对路径; 由侧栏项目列表投影而来(projectWorkspaces.ts)。 */
  workspaces: Record<string, string>;
  /**
   * 改名前的旧名称 -> 本地绝对路径。只用于查找: 服务端的会话选择与偏好可能还按旧名称
   * 存着。不进 hello, 也不出现在选择卡里。缺省视为空。
   */
  retiredWorkspaces?: Record<string, string>;
  /** 升级前手动配置的目录是否已经登记进项目列表(一次性)。缺省视为未做。 */
  projectCatalogMigrated?: boolean;
  /** (multi-team)本地绑定缓存; 老 server / 从未多绑定时恒空数组。 */
  bindingsCache: HookBindingCacheEntry[];
  /**
   * Slack 上下线通知的显式覆写。null = 跟随产品默认值，便于后续调整默认
   * 而不把从未操作过开关的用户永久钉死在旧值。
   */
  lifecycleAnnouncementOverride: boolean | null;
  telegramBindingCache: ProviderBindingCacheEntry | null;
  xBindingCache: ProviderBindingCacheEntry | null;
  feishuBindingCache: ProviderBindingCacheEntry | null;
  feishuBindingsCache?: ProviderBindingCacheEntry[];
  /**
   * 该 provider 派发任务时使用的默认工作目录别名; null = 用内置「对话」伪目录。
   * 生效顺序恒为 **会话显式映射 > 默认工作目录 > 「对话」**(判定在 hook server)。
   *
   * X 一次交互只允许回一条公开推文, 没有承载选择面板的位置, 所以它最先需要;
   * Telegram 虽有 inline keyboard 可以当场 /workspace, 但那是**每会话各自**设的 ——
   * 用户在设置页绑好目录后进一个新群, agent 仍在无仓库模式跑, 与他的预期不符。
   *
   * **读出来恒是有效值**: 目录清单收缩时会把失效别名从存档里删掉, viewOf 再复核
   * 一次 —— 否则 hello 会带上清单外的别名, 被协议校验拒收, 连接直接断在握手上。
   */
  xDefaultWorkspace: string | null;
  /** 同上, Telegram 侧(私聊 / 群 / 话题一律适用)。 */
  telegramDefaultWorkspace: string | null;
  /** 同上, 官方飞书 / Lark 侧(私聊 / 群话题一律适用)。 */
  feishuDefaultWorkspace: string | null;
}

export const DEFAULT_SLACK_LIFECYCLE_ANNOUNCEMENT = false;

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
  companionBotId?: string | null;
  workspaces: Record<string, string>;
  /**
   * workspaces 里只供查找的旧名称(项目改名前的名称)。按目录反查名称时它们排在现用名称
   * 之后; 缺省视为没有。
   */
  retiredWorkspaceNames?: readonly string[];
  createdAt: number;
}

/**
 * 清单与旧名称表的条数上限只防坏文件撑爆内存, 不是业务上限: 清单就是全部侧栏项目;
 * 丢掉一条旧名称, 它就可能被分给别的项目(见 projectWorkspaces.ts)。正常数据到不了这个数。
 */
const MAX_WORKSPACES = 4096;
const MAX_RETIRED_WORKSPACES = 4096;
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
  setProviderEnabled(
    provider: 'slack' | 'telegram' | 'x' | 'feishu',
    enabled: boolean,
  ): SlackHookConfigState;
  anyProviderEnabled(): boolean;
  setWorkspaces(workspaces: Record<string, string>): SlackHookConfigState;
  /**
   * 按侧栏项目列表落一份新的清单: 名称变了的项目, 各 provider 的默认项目跟着改名,
   * 旧名称记进 retired。清单外的默认项目照旧清掉。
   */
  applyProjectWorkspaces(plan: {
    workspaces: Record<string, string>;
    retired: Record<string, string>;
    renames: ReadonlyArray<{ from: string; to: string }>;
  }): SlackHookConfigState;
  markProjectCatalogMigrated(): SlackHookConfigState;
  /** (multi-team)覆写本地绑定缓存(bind.state / 绑定行变化后由 manager 调用)。 */
  setBindingsCache(entries: HookBindingCacheEntry[]): SlackHookConfigState;
  setLifecycleAnnouncementOverride(enabled: boolean | null): SlackHookConfigState;
  setFeishuBindingsCache(entries: ProviderBindingCacheEntry[]): SlackHookConfigState;
  /** provider-neutral(Telegram / X / 飞书)confirmed 绑定的本地影子写入。 */
  setProviderBindingCache(
    provider: 'telegram' | 'x' | 'feishu',
    entry: ProviderBindingCacheEntry | null,
  ): SlackHookConfigState;
  /**
   * 设置某个 provider 的默认工作目录别名(null / 「对话」= 用内置伪目录)。
   * 别名必须已存在于 workspaces(或恰是「对话」保留名), 否则抛校验错 ——
   * 写进去的非法值会在下次握手时被协议拒收, 那时已经离用户操作很远了。
   */
  setProviderDefaultWorkspace(
    provider: 'telegram' | 'x' | 'feishu',
    alias: string | null,
  ): SlackHookConfigState;
  setXCompanionBotId(botId: string | null): SlackHookConfigState;
}

export function createSlackHookStore(deps: SlackHookStoreDeps): SlackHookStore {
  const { filePath, legacyFilePath, cleanupLegacySecrets, log } = deps;

  interface AccountState {
    slack: {
      enabled: boolean;
      bindingsCache: HookBindingCacheEntry[];
      lifecycleAnnouncementOverride: boolean | null;
    };
    telegram: {
      enabled: boolean;
      bindingCache: ProviderBindingCacheEntry | null;
      defaultWorkspace: string | null;
    };
    x: {
      enabled: boolean;
      companionBotId?: string | null;
      bindingCache: ProviderBindingCacheEntry | null;
      defaultWorkspace: string | null;
    };
    /** 官方飞书 / Lark; 旧配置文件没有这个键, 解析为全默认(关闭、无缓存)。 */
    feishu: {
      enabled: boolean;
      bindingCache: ProviderBindingCacheEntry | null;
      bindingsCache?: ProviderBindingCacheEntry[];
      defaultWorkspace: string | null;
    };
  }

  interface StoredDocument {
    version: 2;
    urlOverride: string | null;
    workspaces: Record<string, string>;
    retiredAliases?: Record<string, string>;
    projectCatalogMigrated?: boolean;
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
        xEnabled: false,
        feishuEnabled: false,
        urlOverride: null, // 旧 url 是自部署地址, 不迁移 —— 新形态用内置中心服务器
        workspaces,
        bindingsCache: [], // 旧多连接时代没有绑定缓存概念
        lifecycleAnnouncementOverride: null,
        telegramBindingCache: null,
        xBindingCache: null,
        feishuBindingCache: null,
        xDefaultWorkspace: null,
        telegramDefaultWorkspace: null,
        feishuDefaultWorkspace: null,
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
    slack: {
      enabled: false,
      bindingsCache: [],
      lifecycleAnnouncementOverride: null,
    },
    telegram: { enabled: false, bindingCache: null, defaultWorkspace: null },
    x: { enabled: false, bindingCache: null, defaultWorkspace: null },
    feishu: { enabled: false, bindingCache: null, defaultWorkspace: null },
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

  function parseProviderBindingCache(raw: unknown): ProviderBindingCacheEntry | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    if (
      typeof row.bindingId !== 'string' ||
      !row.bindingId ||
      typeof row.principalId !== 'string' ||
      !row.principalId ||
      typeof row.scopeId !== 'string' ||
      !row.scopeId ||
      (row.scopeName !== null && (typeof row.scopeName !== 'string' || !row.scopeName))
    ) {
      return null;
    }
    return {
      ...(typeof row.tenantKey === 'string' ? { tenantKey: row.tenantKey } : {}),
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
    const x =
      row.x && typeof row.x === 'object' && !Array.isArray(row.x)
        ? (row.x as Record<string, unknown>)
        : {};
    const feishu =
      row.feishu && typeof row.feishu === 'object' && !Array.isArray(row.feishu)
        ? (row.feishu as Record<string, unknown>)
        : {};
    return {
      slack: {
        enabled: slack.enabled === true,
        bindingsCache: parseBindingsCache(slack.bindingsCache),
        lifecycleAnnouncementOverride:
          typeof slack.lifecycleAnnouncementOverride === 'boolean'
            ? slack.lifecycleAnnouncementOverride
            : null,
      },
      telegram: {
        enabled: telegram.enabled === true,
        bindingCache: parseProviderBindingCache(telegram.bindingCache),
        // 同 x: 成员关系留给 viewOf 复核(这里 workspaces 还没读进来)。
        // 旧配置文件没有这个键 —— 读成 null 即"没设过", 不需要迁移动作。
        defaultWorkspace:
          typeof telegram.defaultWorkspace === 'string' ? telegram.defaultWorkspace : null,
      },
      x: {
        enabled: x.enabled === true,
        companionBotId: typeof x.companionBotId === 'string' && x.companionBotId.length <= 200
          ? x.companionBotId : null,
        bindingCache: parseProviderBindingCache(x.bindingCache),
        // 成员关系不在这里卡: 解析时 workspaces 还没读进来。留给 viewOf 复核,
        // 那里才同时握有两者。
        defaultWorkspace: typeof x.defaultWorkspace === 'string' ? x.defaultWorkspace : null,
      },
      feishu: {
        enabled: feishu.enabled === true,
        bindingCache: parseProviderBindingCache(feishu.bindingCache),
        ...(Array.isArray(feishu.bindingsCache) ? { bindingsCache: feishu.bindingsCache.map(parseProviderBindingCache)
          .filter((row): row is ProviderBindingCacheEntry => row !== null) } : {}),
        // 同 x: 成员关系留给 viewOf 复核。
        defaultWorkspace:
          typeof feishu.defaultWorkspace === 'string' ? feishu.defaultWorkspace : null,
      },
    };
  }

  function parseWorkspaces(raw: unknown, max: number = MAX_WORKSPACES): Record<string, string> {
    const workspaces: Record<string, string> = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (Object.keys(workspaces).length === max) break;
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
          lifecycleAnnouncementOverride: state.lifecycleAnnouncementOverride,
        },
        telegram: { enabled: false, bindingCache: null, defaultWorkspace: null },
        x: { enabled: false, bindingCache: null, defaultWorkspace: null },
        feishu: { enabled: false, bindingCache: null, defaultWorkspace: null },
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
        const retiredAliases = parseWorkspaces(row.retiredAliases, MAX_RETIRED_WORKSPACES);
        return {
          version: 2,
          urlOverride,
          workspaces,
          ...(Object.keys(retiredAliases).length > 0 ? { retiredAliases } : {}),
          ...(row.projectCatalogMigrated === true ? { projectCatalogMigrated: true } : {}),
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
        xEnabled: false,
        feishuEnabled: false,
        urlOverride,
        workspaces,
        bindingsCache: parseBindingsCache(row.bindingsCache),
        lifecycleAnnouncementOverride: null,
        telegramBindingCache: null,
        xBindingCache: null,
        feishuBindingCache: null,
        xDefaultWorkspace: null,
        telegramDefaultWorkspace: null,
        feishuDefaultWorkspace: null,
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

  /**
   * X 默认工作目录的**定义域**:workspaces 清单 + 内置「对话」伪目录。
   *
   * 清单是文档级的、默认值是账号级的, 两者由不同入口写入, 所以这条不变量必须
   * 有一个共用判据 —— 否则读侧和写侧各写各的, 迟早分叉。
   */
  function isSelectableWorkspace(document: StoredDocument, alias: string): boolean {
    // 「对话」不是 workspaces 的键, 但它恒在 hello 清单里, 所以放行。
    return (
      alias === HOOK_CHAT_WORKSPACE_ALIAS ||
      Object.prototype.hasOwnProperty.call(document.workspaces, alias)
    );
  }

  /**
   * 把已不在定义域内的默认别名从**存档**里删掉, 返回是否改动过。
   *
   * 只靠 viewOf 把它投影成 null 不够: 旧别名仍留在盘上, 用户之后重新添加一个
   * 同名别名(哪怕指向的是另一个目录)就会让它无声复活, X 任务被派发到用户从未
   * 选过的目录。清单收缩是唯一会让默认值失效的操作, 所以在那里落盘删除。
   */
  function pruneStaleDefaultWorkspaces(document: StoredDocument): boolean {
    let changed = false;
    const accounts = [...Object.values(document.accounts), document.legacyAccount];
    for (const account of accounts) {
      if (account === undefined) continue;
      // 每个 provider 都要清: 漏清一个会让它的失效别名留在盘上, 用户之后
      // 重新添加同名别名(哪怕指向另一个目录)就把它无声复活。
      for (const provider of ['telegram', 'x', 'feishu'] as const) {
        const alias = account[provider].defaultWorkspace;
        if (alias === null || alias === undefined) continue;
        if (isSelectableWorkspace(document, alias)) continue;
        account[provider].defaultWorkspace = null;
        changed = true;
      }
    }
    return changed;
  }

  /** 读侧复核: 别名不在当前清单内就投影成 null(见 viewOf 上方注释)。 */
  function selectableDefaultWorkspace(
    document: StoredDocument,
    alias: string | null,
  ): string | null {
    return alias !== null && isSelectableWorkspace(document, alias) ? alias : null;
  }

  function viewOf(document: StoredDocument, fingerprint: string | null): SlackHookConfigState {
    const account = fingerprint
      ? (document.accounts[fingerprint] ?? EMPTY_ACCOUNT())
      : EMPTY_ACCOUNT();
    // 默认项目所有官方机器人共用一个。升级前各渠道分别存过的, 按 飞书 -> Telegram -> X
    // 取第一个仍然可选的; 之后任何一处修改都会把三处写成同一个值(setProviderDefaultWorkspace)。
    const defaultWorkspace =
      selectableDefaultWorkspace(document, account.feishu.defaultWorkspace) ??
      selectableDefaultWorkspace(document, account.telegram.defaultWorkspace) ??
      selectableDefaultWorkspace(document, account.x.defaultWorkspace);
    return {
      enabled: account.slack.enabled,
      telegramEnabled: account.telegram.enabled,
      xEnabled: account.x.enabled,
      feishuEnabled: account.feishu.enabled,
      xCompanionBotId: account.x.companionBotId ?? null,
      urlOverride: document.urlOverride,
      workspaces: { ...document.workspaces },
      retiredWorkspaces: { ...(document.retiredAliases ?? {}) },
      projectCatalogMigrated: document.projectCatalogMigrated === true,
      bindingsCache: account.slack.bindingsCache.map((entry) => ({ ...entry })),
      lifecycleAnnouncementOverride: account.slack.lifecycleAnnouncementOverride,
      telegramBindingCache: account.telegram.bindingCache
        ? { ...account.telegram.bindingCache }
        : null,
      xBindingCache: account.x.bindingCache ? { ...account.x.bindingCache } : null,
      feishuBindingCache: account.feishu.bindingCache
        ? { ...account.feishu.bindingCache }
        : null,
      ...(account.feishu.bindingsCache === undefined ? {} : { feishuBindingsCache: account.feishu.bindingsCache.map((row) => ({ ...row })) }),
      // 读侧兜底: 正常路径上 setWorkspaces 已把失效别名从存档里删了, 这里只兜
      // 手改配置文件、或将来新增了别的清单写入口的情况。代价不对称 —— 漏兜的
      // 后果是 hello 带上清单外别名被协议拒收, **该 provider 的连接**断在握手上
      // 且没有任何用户可见线索(Telegram / X 两条线同样适用), 所以这层留着。
      xDefaultWorkspace: defaultWorkspace,
      telegramDefaultWorkspace: defaultWorkspace,
      feishuDefaultWorkspace: defaultWorkspace,
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
      return state.enabled || state.telegramEnabled || state.xEnabled || state.feishuEnabled;
    },
    setWorkspaces(workspaces) {
      const current = currentDocument();
      current.document.workspaces = validateWorkspaces(workspaces);
      pruneStaleDefaultWorkspaces(current.document);
      writeDocument(current.document);
      return viewOf(current.document, current.fingerprint);
    },
    applyProjectWorkspaces(plan) {
      const current = currentDocument();
      const workspaces = validateWorkspaces(plan.workspaces);
      const renamed = new Map(plan.renames.map((rename) => [rename.from, rename.to] as const));
      // 默认项目跟着项目改名, 而不是被当成「清单外」清掉 —— 否则侧栏里改个名字,
      // X / Telegram / 飞书的默认项目就悄悄退回「对话」。
      for (const account of [...Object.values(current.document.accounts), current.document.legacyAccount]) {
        if (account === undefined) continue;
        for (const provider of ['telegram', 'x', 'feishu'] as const) {
          const alias = account[provider].defaultWorkspace;
          const next = alias === null || alias === undefined ? undefined : renamed.get(alias);
          if (next !== undefined && Object.hasOwn(workspaces, next)) {
            account[provider].defaultWorkspace = next;
          }
        }
      }
      current.document.workspaces = workspaces;
      const retired = parseWorkspaces(plan.retired, MAX_RETIRED_WORKSPACES);
      if (Object.keys(retired).length > 0) current.document.retiredAliases = retired;
      else delete current.document.retiredAliases;
      pruneStaleDefaultWorkspaces(current.document);
      writeDocument(current.document);
      return viewOf(current.document, current.fingerprint);
    },
    markProjectCatalogMigrated() {
      const current = currentDocument();
      if (current.document.projectCatalogMigrated !== true) {
        current.document.projectCatalogMigrated = true;
        writeDocument(current.document);
      }
      return viewOf(current.document, current.fingerprint);
    },
    setBindingsCache(entries) {
      // 缓存条目由 manager 从协议帧生成(形状可信), 这里只做浅拷贝防外部改动
      return mutateAccount((account) => {
        account.slack.bindingsCache = entries.map((e) => ({ ...e }));
      });
    },
    setLifecycleAnnouncementOverride(enabled) {
      return mutateAccount((account) => {
        account.slack.lifecycleAnnouncementOverride = enabled;
      });
    },
    setFeishuBindingsCache(entries) {
      return mutateAccount((account) => {
        account.feishu.bindingsCache = entries.map((row) => ({ ...row }));
        account.feishu.bindingCache = entries[0] ? { ...entries[0] } : null;
      });
    },
    setProviderBindingCache(provider, entry) {
      return mutateAccount((account) => {
        account[provider].bindingCache = entry ? { ...entry } : null;
        if (provider === 'feishu') delete account.feishu.bindingsCache;
      });
    },
    setProviderDefaultWorkspace(provider, alias) {
      // 「对话」伪目录不在 workspaces 里, 但它恒在 hello 清单中 —— 归一成 null
      // (二者语义相同, 存 null 让"没设过"和"选了对话"只有一种表示)。
      const normalized = alias === null || alias === HOOK_CHAT_WORKSPACE_ALIAS ? null : alias;
      if (normalized !== null) {
        const current = read();
        if (!Object.prototype.hasOwnProperty.call(current.workspaces, normalized)) {
          throw new HookConnectionValidationError(
            `workspace alias "${normalized}" is not configured`,
          );
        }
      }
      // 默认项目是共用的: 从哪个机器人的入口改, 都把三处写成同一个值。
      void provider;
      return mutateAccount((account) => {
        account.feishu.defaultWorkspace = normalized;
        account.telegram.defaultWorkspace = normalized;
        account.x.defaultWorkspace = normalized;
      });
    },
    setXCompanionBotId(botId) {
      if (botId !== null && (typeof botId !== 'string' || !botId.trim() || botId.length > 200)) {
        throw new HookConnectionValidationError('invalid companion id');
      }
      return mutateAccount((account) => {
        account.x.companionBotId = botId;
      });
    },
  };
}
