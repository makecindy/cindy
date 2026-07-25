/**
 * ghostOauthAccounts.ts — 意识 OAuth 凭证的账号与令牌管理器。
 * ---------------------------------------------------------------------------
 * 在 ghostOauthFlow(授权/刷新引擎)之上,管一个 oauth 凭证槽名下的:
 * - 多账号清单(id / 展示标签 / 状态 / 默认账号),JSON 落主机保险库;
 * - refresh token 按账号落库(轮换型服务商刷新后覆盖回写);
 * - access token 只进内存缓存(不落盘,重启后按需重刷)+ 单飞去重;
 * - invalid_grant 时把账号标记 expired(设置页展示"需重新连接"),
 *   凭证注入路径拿到结构化 AUTH_EXPIRED,不再无谓重试。
 *
 * 多实例共库纪律(2026-07-21):dev / packaged 可共用同一 userData 保险库,
 * 轮换型服务商(飞书 / Atlassian / Slack)的 refresh token 一次一换——两个
 * 进程拿同一枚旧 RT 各自去刷,输家必吃 invalid_grant。因此 invalid_grant
 * **不能直接判死**:先重读保险库(必要时短暂等待赢家落库)确认 RT 是否已被
 * 其它实例轮换,轮换了就用新 RT 重试;确认库里仍是自己用过的这枚才标
 * expired,删除也走 compare-and-delete,绝不误删并发写入的新 RT。
 *
 * 保险库键名纪律:同一凭证槽的派生键统一走 `<secretKey>-<后缀>` 形态——
 * ghost.json 的 secret key 字符集是 [a-z0-9_](见 shared/ghost.ts 校验),
 * 不含连字符,派生键与任何已声明凭证键在结构上不可能撞名;连字符同时是
 * providerSecretStore 键名字符集(SAFE_KEY_PART_RE)允许的字符(点号不是)。
 * - `<key>-client-id` / `<key>-client-secret`:用户在意识设置页自填的
 *   OAuth 客户端凭证(/oauth 端点只写通道入库,本模块只读);
 * - `<key>-accounts`:账号清单 JSON(不含任何令牌字节);
 * - `<key>-rt-<accountId>`:该账号的 refresh token(accountId 为 UUID)。
 *
 * 安全纪律与 networkSlot 一致:令牌与 client 凭证明文不进沙箱、不进日志、
 * 不进账号清单;对外(设置页/管子)只暴露 {id, label, status, isDefault,
 * avatarDataUrl}(头像是主机下载转码的 data URL 小图,非机密)。
 *
 * 依赖注入(规则 14):保险库 / fetch / openExternal 全经 deps,单测用内存
 * 假体全覆盖,零 Electron。
 */

import { randomUUID } from 'node:crypto';

import {
  fetchGhostOauthAvatar,
  fetchGhostOauthIdentity,
  refreshGhostOauthToken,
  startGhostOauthFlow,
  type GhostOauthBrokerClient,
  type GhostOauthClientConfig,
  type GhostOauthFlowError,
  type GhostOauthLogger,
} from './ghostOauthFlow.js';
import { isOfficialGhostId, type GhostSecretOauthDecl } from '../../shared/ghost.js';

/** 每个 oauth 凭证槽最多可连账号数(防清单无限膨胀;超出连接被拒)。 */
export const GHOST_OAUTH_MAX_ACCOUNTS = 8;

/**
 * invalid_grant 后延迟二次重读保险库的等待时长:并发实例撞轮换时,输家的
 * 失败响应可能先于赢家的成功落库到达,立即重读会误判"未轮换"。这段等待
 * 只发生在 invalid_grant 路径上(该路径本来就以重新授权收尾),不拖累热路径。
 */
export const GHOST_OAUTH_INVALID_GRANT_RECHECK_DELAY_MS = 2000;

/* ------------------------------------------------------------------------ */
/* 契约类型                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * ghost.json oauth 声明(client 凭证除外——那是用户自填)。直接复用 shared
 * 契约类型:validateGhostManifest 归一化后的详单原样传入,不做二次映射。
 */
export type GhostOauthDecl = GhostSecretOauthDecl;

export type GhostOauthAccountStatus = 'connected' | 'expired';

/**
 * 对外(设置页 / 管子)暴露的账号形态——只有元数据,零令牌字节。
 * label 优先取人类可读展示名(identity.displayTemplate 渲染,如 Slack 的
 * "workspace · 用户名"),没有才回落稳定身份标签(labelPath 的 user_id /
 * 邮箱)——消费端(settingsHtml / 账号工具)不感知两层区别。
 */
export interface GhostOauthAccountView {
  id: string;
  label: string | null;
  status: GhostOauthAccountStatus;
  isDefault: boolean;
  createdAt: number;
  /**
   * 头像 data URL(声明了 identity.avatarPath 且下载成功才有;主机下载转码,
   * 沙箱 CSP 的 img-src data: 恰好放行)。只经 /oauth 回设置页,不进 LLM
   * 上下文(networkSlot 只走 getFreshAccessToken)。
   */
  avatarDataUrl: string | null;
}

/** 保险库最小面(providerSecretStore 在接线处适配;测试喂内存假体)。 */
export interface GhostOauthVault {
  read(ghostId: string, storageKey: string): string | null;
  /** 返回 false = 写失败(safeStorage 不可用等),调用方折叠结构化错误。 */
  store(ghostId: string, storageKey: string, value: string): boolean;
  remove(ghostId: string, storageKey: string): void;
}

export interface GhostOauthAccountManagerDeps {
  vault: GhostOauthVault;
  fetchImpl: typeof fetch;
  /** 拉起系统浏览器(仅 connect 用;生产注入 shell.openExternal)。 */
  openExternal(url: string): void | Promise<void>;
  /** XDT server token broker 调用器(tokenBroker 声明的意识用;接线处注入并做第一方门控)。 */
  broker?: GhostOauthBrokerClient;
  /**
   * brokerBounce 声明的公网弹跳地址解析器:入参是声明的站内路径(如
   * '/slack-mcp/bounce'),返回完整 https 地址(broker 基地址在接线处持有,
   * 清单不落域名字面量);broker 基地址未配置时返回 null,connect 按
   * INVALID_CONFIG 结构化拒绝(refresh 不需要 redirect_uri,不受影响)。
   */
  resolveBrokerPublicUrl?: (path: string) => string | null;
  brandName?: string;
  logger?: GhostOauthLogger;
  /** 钉死端口被外部进程占用时的自动回收器(生产注入 portReclaim.reclaimLoopbackPort)。 */
  reclaimPort?: (port: number) => Promise<boolean>;
  /**
   * 授权成功钩子(2026-07-14):新连与同身份重连两个成功出口都触发,调用方
   * 拿它广播"授权成功"的主机代言 tips(label = 账号展示标签,声明 identity
   * 且拉取成功才有)。抛错不许影响连接结果,实现侧自兜。
  */
  onAccountConnected?: (info: { ghostId: string; secretKey: string; label: string | null }) => void;
  /**
   * Refresh-path status transition hook. It deliberately carries no token,
   * label, account id, or provider response and fires only after a real
   * connected/expired manifest change commits.
   */
  onAccountStatusChanged?: (info: {
    ghostId: string;
    secretKey: string;
    status: GhostOauthAccountStatus;
  }) => void;
  /**
   * Fresh lifecycle guard for long-running browser authorization. Production
   * verifies that the plugin and the exact OAuth declaration still exist
   * before any callback result is persisted.
   */
  isConnectTargetCurrent?: (
    ghostId: string,
    secretKey: string,
    decl: GhostOauthDecl,
  ) => boolean;
  /** 延时器(仅 invalid_grant 轮换探测用;测试注入即时假体,生产缺省 setTimeout)。 */
  sleep?: (ms: number) => Promise<void>;
}

export type GhostOauthConnectResult =
  | { ok: true; account: GhostOauthAccountView }
  | {
      ok: false;
      error: 'NO_CLIENT_CONFIG' | 'ACCOUNT_LIMIT' | 'VAULT_WRITE_FAILED' | GhostOauthFlowError;
      detail?: string;
    };

export type GhostOauthAccessTokenResult =
  | { ok: true; accessToken: string; accountId: string }
  | {
      ok: false;
      /**
       * NO_CLIENT_CONFIG = clientId 未填;NO_ACCOUNT = 无可用账号(未连接
       * 或指定账号不存在);AUTH_EXPIRED = refresh token 失效需重新授权;
       * REFRESH_FAILED / NETWORK = 瞬时失败可重试。
       */
      error: 'NO_CLIENT_CONFIG' | 'NO_ACCOUNT' | 'AUTH_EXPIRED' | 'REFRESH_FAILED' | 'NETWORK';
      detail?: string;
    };

/* ------------------------------------------------------------------------ */
/* 内部持久化形态                                                            */
/* ------------------------------------------------------------------------ */

interface AccountRow {
  id: string;
  /** 稳定身份标签(identity.labelPath 的值;同身份重连合并的判定键)。 */
  label: string | null;
  /** 人类可读展示名(identity.displayTemplate 渲染;纯展示,不参与合并判定)。 */
  displayLabel: string | null;
  status: GhostOauthAccountStatus;
  createdAt: number;
}

interface AccountsManifest {
  defaultAccountId: string | null;
  accounts: AccountRow[];
}

const EMPTY_MANIFEST: AccountsManifest = { defaultAccountId: null, accounts: [] };

function accountsKey(secretKey: string): string {
  return `${secretKey}-accounts`;
}
function refreshTokenKey(secretKey: string, accountId: string): string {
  return `${secretKey}-rt-${accountId}`;
}
/** 头像 data URL 的保险库键(派生键纪律见文件头;非机密但与账号同生命周期)。 */
function avatarKey(secretKey: string, accountId: string): string {
  return `${secretKey}-avatar-${accountId}`;
}
function clientIdKey(secretKey: string): string {
  return `${secretKey}-client-id`;
}
function clientSecretKey(secretKey: string): string {
  return `${secretKey}-client-secret`;
}

/** 容错解析账号清单(坏形态当空,不让一条脏数据卡死整个凭证槽)。 */
function parseManifest(raw: string | null): AccountsManifest {
  if (!raw) return EMPTY_MANIFEST;
  try {
    const parsed = JSON.parse(raw) as Partial<AccountsManifest>;
    if (!Array.isArray(parsed.accounts)) return EMPTY_MANIFEST;
    const accounts: AccountRow[] = [];
    for (const row of parsed.accounts) {
      if (typeof row !== 'object' || row === null) continue;
      const r = row as Partial<AccountRow>;
      if (typeof r.id !== 'string' || r.id.length === 0) continue;
      accounts.push({
        id: r.id,
        label: typeof r.label === 'string' && r.label.length > 0 ? r.label : null,
        displayLabel: typeof r.displayLabel === 'string' && r.displayLabel.length > 0 ? r.displayLabel : null,
        status: r.status === 'expired' ? 'expired' : 'connected',
        createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : 0,
      });
    }
    const defaultAccountId =
      typeof parsed.defaultAccountId === 'string' && accounts.some((a) => a.id === parsed.defaultAccountId)
        ? parsed.defaultAccountId
        : accounts.length > 0
          ? accounts[0].id
          : null;
    return { defaultAccountId, accounts };
  } catch {
    return EMPTY_MANIFEST;
  }
}

function toView(
  row: AccountRow,
  defaultAccountId: string | null,
  avatarDataUrl: string | null,
): GhostOauthAccountView {
  return {
    id: row.id,
    label: row.displayLabel ?? row.label,
    status: row.status,
    isDefault: row.id === defaultAccountId,
    createdAt: row.createdAt,
    avatarDataUrl,
  };
}

interface CachedAccessToken {
  accessToken: string;
  /** null = 服务商没给 expires_in,视为会话内长期有效,401 时经 invalidate 作废。 */
  expiresAt: number | null;
}

/* ------------------------------------------------------------------------ */
/* 管理器                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * 一个进程级单例管所有意识的所有 oauth 凭证槽(缓存键含 ghostId + secretKey +
 * accountId,互不串)。接线处(cindy-brain/index.ts)构造一次注入各消费方。
 */
export class GhostOauthAccountManager {
  private readonly deps: GhostOauthAccountManagerDeps;
  /** access token 内存缓存:`${ghostId} ${secretKey} ${accountId}`。 */
  private readonly tokenCache = new Map<string, CachedAccessToken>();
  /** 刷新单飞:同键并发只跑一单,其余等结果。 */
  private readonly refreshInflight = new Map<string, Promise<GhostOauthAccessTokenResult>>();

  constructor(deps: GhostOauthAccountManagerDeps) {
    this.deps = deps;
  }

  /* ---------------------------- client 凭证 ----------------------------- */

  /** client 凭证是否可用(用户自填或清单内置任一即可;设置页状态展示,不回明文)。 */
  clientConfigured(ghostId: string, secretKey: string, decl?: GhostOauthDecl): boolean {
    // broker 模式:secret 在服务端,声明了内置 clientId 即视为可连(用户零配置)。
    if (decl?.tokenBroker) return typeof decl.clientId === 'string' && decl.clientId.length > 0;
    if (this.clientCustomized(ghostId, secretKey)) return true;
    return typeof decl?.clientId === 'string' && decl.clientId.length > 0;
  }

  /** 用户是否自填过 client 凭证(区分"内置应用身份"与"已自定义"的 UI 态)。 */
  clientCustomized(ghostId: string, secretKey: string): boolean {
    const clientId = this.deps.vault.read(ghostId, clientIdKey(secretKey));
    return typeof clientId === 'string' && clientId.length > 0;
  }

  /**
   * 写入用户自填的 OAuth 客户端凭证(/oauth 端点只写通道;clientSecret
   * 可省略——纯 PKCE 公共客户端)。改 client 后既有 access token 缓存作废
   * (旧 client 换的令牌不该再续命)。
   */
  setClientConfig(ghostId: string, secretKey: string, clientId: string, clientSecret?: string): boolean {
    if (!this.deps.vault.store(ghostId, clientIdKey(secretKey), clientId)) return false;
    if (clientSecret !== undefined && clientSecret.length > 0) {
      if (!this.deps.vault.store(ghostId, clientSecretKey(secretKey), clientSecret)) return false;
    } else {
      this.deps.vault.remove(ghostId, clientSecretKey(secretKey));
    }
    for (const key of this.tokenCache.keys()) {
      if (key.startsWith(`${ghostId} ${secretKey} `)) this.tokenCache.delete(key);
    }
    return true;
  }

  /** 清除 client 凭证(幂等;已连账号保留但刷新会 NO_CLIENT_CONFIG,重填即恢复)。 */
  clearClientConfig(ghostId: string, secretKey: string): void {
    this.deps.vault.remove(ghostId, clientIdKey(secretKey));
    this.deps.vault.remove(ghostId, clientSecretKey(secretKey));
    for (const key of this.tokenCache.keys()) {
      if (key.startsWith(`${ghostId} ${secretKey} `)) this.tokenCache.delete(key);
    }
  }

  /**
   * client 凭证解析链:用户自填 > 清单内置(cindy-google 等开箱即用意识
   * 把凭证写在包里)。**成对语义**:自填了 clientId 就用自填的整对
   * (secret 缺省 = 纯 PKCE),绝不拿自填 id 混内置 secret——错配的
   * id/secret 只会换来 invalid_client。清除自填即回落内置(配置设计原则
   * 的"恢复默认 = 清除 override")。
   */
  private readClientConfig(
    ghostId: string,
    secretKey: string,
    decl: GhostOauthDecl,
    clientIdOverride?: string,
  ): GhostOauthClientConfig | null {
    // broker 模式:服务端 secret 与内置 clientId 是绑定的一对,用户自填
    // client 无意义且必错(自填 id 配服务端 secret = invalid_client),
    // 一律忽略自填。缺省用内置 clientId;connect 可传已经过清单白名单
    // 复验的备用 clientId,供同一意识按 region 选择不同 OAuth App。
    const customId = decl.tokenBroker ? null : this.deps.vault.read(ghostId, clientIdKey(secretKey));
    let clientId: string | null;
    let clientSecret: string | null | undefined;
    if (clientIdOverride !== undefined) {
      clientId = clientIdOverride;
      clientSecret = decl.clientSecret;
    } else if (customId) {
      clientId = customId;
      clientSecret = this.deps.vault.read(ghostId, clientSecretKey(secretKey));
    } else {
      clientId = decl.clientId ?? null;
      clientSecret = decl.clientSecret;
    }
    if (!clientId) return null;
    // brokerBounce → 双地址模型:公网弹跳地址由接线处解析器现拼(broker 基
    // 地址来自端点清单;当前 region 提供该服务时应为非空)。null 仅剩一种
    // 来源:宿主未接线
    // resolveBrokerPublicUrl(测试/精简宿主)——此时不带 publicRedirectUri,
    // 由 connectAccount 结构化拒绝(refresh 不需要 redirect_uri,照常可用)。
    const publicRedirectUri = decl.brokerBounce
      ? (this.deps.resolveBrokerPublicUrl?.(decl.brokerBounce.path) ?? null)
      : null;
    return {
      authorizeUrl: decl.authorizeUrl,
      tokenUrl: decl.tokenUrl,
      scopes: decl.scopes ?? [],
      ...(decl.scopeDelimiter !== undefined ? { scopeDelimiter: decl.scopeDelimiter } : {}),
      pkce: decl.pkce,
      extraAuthorizeParams: decl.extraAuthorizeParams,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      ...(decl.redirectPort !== undefined ? { redirectPort: decl.redirectPort } : {}),
      ...(decl.tokenBroker !== undefined ? { tokenBroker: decl.tokenBroker } : {}),
      ...(publicRedirectUri !== null ? { publicRedirectUri } : {}),
      ...(decl.brokerBounce !== undefined ? { callbackPath: decl.brokerBounce.callbackPath } : {}),
    };
  }

  /* ------------------------------ 账号清单 ------------------------------ */

  listAccounts(ghostId: string, secretKey: string): GhostOauthAccountView[] {
    const manifest = parseManifest(this.deps.vault.read(ghostId, accountsKey(secretKey)));
    return manifest.accounts.map((a) =>
      toView(a, manifest.defaultAccountId, this.readAvatar(ghostId, secretKey, a.id)),
    );
  }

  /** 头像 data URL 读取(形状校验兜底:库里的坏值当无头像,不喂给 <img>)。 */
  private readAvatar(ghostId: string, secretKey: string, accountId: string): string | null {
    const raw = this.deps.vault.read(ghostId, avatarKey(secretKey, accountId));
    return typeof raw === 'string' && raw.startsWith('data:image/') ? raw : null;
  }

  setDefaultAccount(ghostId: string, secretKey: string, accountId: string): boolean {
    const manifest = parseManifest(this.deps.vault.read(ghostId, accountsKey(secretKey)));
    if (!manifest.accounts.some((a) => a.id === accountId)) return false;
    return this.deps.vault.store(
      ghostId,
      accountsKey(secretKey),
      JSON.stringify({ ...manifest, defaultAccountId: accountId }),
    );
  }

  /** 断开账号:清 refresh token、清头像、清缓存、从清单摘除(幂等)。 */
  disconnectAccount(ghostId: string, secretKey: string, accountId: string): void {
    const manifest = parseManifest(this.deps.vault.read(ghostId, accountsKey(secretKey)));
    const remaining = manifest.accounts.filter((a) => a.id !== accountId);
    this.deps.vault.remove(ghostId, refreshTokenKey(secretKey, accountId));
    this.deps.vault.remove(ghostId, avatarKey(secretKey, accountId));
    this.tokenCache.delete(this.cacheKey(ghostId, secretKey, accountId));
    this.deps.vault.store(
      ghostId,
      accountsKey(secretKey),
      JSON.stringify({
        defaultAccountId:
          manifest.defaultAccountId === accountId
            ? (remaining[0]?.id ?? null)
            : manifest.defaultAccountId,
        accounts: remaining,
      } satisfies AccountsManifest),
    );
  }

  /* ------------------------------- 连接 --------------------------------- */

  /**
   * 跑一单完整授权并落账号。同一身份重复授权 = **重连语义**:授权回来的
   * identity 标签与清单里已有账号相同时,覆盖那条的 refresh token、状态复活
   * connected,不新增占位(否则"过期重连 / 手滑重复点连接"会把同一邮箱堆成
   * 多行)。标签为 null(未声明 identity / 拉取失败)时无从判定,保持追加。
   * client 凭证未填直接拒;授权流程失败原样透传结构化错误(设置页据此提示)。
   */
  async connectAccount(
    ghostId: string,
    secretKey: string,
    decl: GhostOauthDecl,
    opts?: {
      /**
       * 本次授权申请的 scope 子集(设置页"只读连接"这类降面授权)。调用方
       * (/oauth 端点)已校验 ⊆ decl.scopes;这里防御性重验,越界即拒——
       * 意识永远不能借连接动作申请清单没声明过的授权面。
       */
      scopes?: readonly string[];
      /**
       * broker 模式本次授权使用的公开 clientId。只接受清单默认值或
       * clientIdAlternatives 明确列出的值;用于意识按宿主 region 选 App。
       */
      clientId?: string;
    },
  ): Promise<GhostOauthConnectResult> {
    if (opts?.clientId !== undefined) {
      const allowedClientIds = [decl.clientId, ...(decl.clientIdAlternatives ?? [])];
      if (!decl.tokenBroker || !allowedClientIds.includes(opts.clientId)) {
        return {
          ok: false,
          error: 'INVALID_CONFIG',
          detail: '本次授权选择的 clientId 未在清单中声明',
        };
      }
    }
    const config = this.readClientConfig(ghostId, secretKey, decl, opts?.clientId);
    if (!config) return { ok: false, error: 'NO_CLIENT_CONFIG' };
    if (decl.brokerBounce && !config.publicRedirectUri) {
      return {
        ok: false,
        error: 'INVALID_CONFIG',
        detail: '授权 broker 基地址未配置(端点清单 oauthBrokerApiBaseUrl),无法拼出弹跳回调地址',
      };
    }
    if (opts?.scopes !== undefined) {
      const declared = new Set(decl.scopes ?? []);
      if (opts.scopes.length === 0 || opts.scopes.some((sc) => !declared.has(sc))) {
        return { ok: false, error: 'INVALID_CONFIG', detail: '申请的 scope 必须是清单声明的非空子集' };
      }
      config.scopes = [...opts.scopes];
    }

    const flow = await startGhostOauthFlow({
      config,
      openExternal: this.deps.openExternal,
      fetchImpl: this.deps.fetchImpl,
      broker: this.deps.broker,
      brandName: this.deps.brandName,
      logger: this.deps.logger,
      // 端口回收器只对第一方官方意识放行(与 tokenBroker 连接闸同口径):
      // 回收 = 强杀占用进程,而"杀谁"由 redirectPort 决定——第三方 manifest
      // 可声明任意端口(如 5432),放开等于让任意意识借「连接账号」之手
      // 强杀用户本地服务(Postgres 等),故第三方一律回落"占用即报错"。
      reclaimPort: isOfficialGhostId(ghostId) ? this.deps.reclaimPort : undefined,
    });
    if (!flow.ok) return { ok: false, error: flow.error, detail: flow.detail };
    if (this.deps.isConnectTargetCurrent?.(ghostId, secretKey, decl) === false) {
      return {
        ok: false,
        error: 'INVALID_CONFIG',
        detail: '插件或授权声明已变更',
      };
    }

    // 身份标签:声明了 identity 才拉,失败降级 null(不阻断授权)。label 是
    // 同身份合并的判定键;display 是展示名(declaration 有 displayTemplate 才有);
    // avatar 是头像 data URL(declaration 有 avatarPath 且下载成功才有)。
    let label: string | null = null;
    let display: string | null = null;
    let avatar: string | null = null;
    if (decl.identity) {
      const identity = await fetchGhostOauthIdentity({
        url: decl.identity.url,
        labelPath: decl.identity.labelPath,
        ...(decl.identity.displayTemplate !== undefined
          ? { displayTemplate: decl.identity.displayTemplate }
          : {}),
        ...(decl.identity.avatarPath !== undefined ? { avatarPath: decl.identity.avatarPath } : {}),
        accessToken: flow.bundle.accessToken,
        fetchImpl: this.deps.fetchImpl,
      });
      label = identity.label;
      display = identity.display;
      // 头像下载只对第一方官方意识放行(与 tokenBroker / 端口回收同口径):
      // 头像地址是身份端点响应里的任意 https,不受 hosts 白名单约束——放开
      // 等于给第三方意识一个"主机代发 GET + 小图字节回沙箱"的 SSRF 读原语。
      // 下载本身不带任何凭证(CDN 域名不在注入白名单);失败降级无头像。
      if (identity.avatarUrl !== null && isOfficialGhostId(ghostId)) {
        avatar = await fetchGhostOauthAvatar({ url: identity.avatarUrl, fetchImpl: this.deps.fetchImpl });
      }
    }

    // Identity/avatar fetches are asynchronous as well. Recheck immediately
    // before the first vault read/write so uninstall or manifest replacement
    // during those requests cannot resurrect stale credentials.
    if (this.deps.isConnectTargetCurrent?.(ghostId, secretKey, decl) === false) {
      return {
        ok: false,
        error: 'INVALID_CONFIG',
        detail: '插件或授权声明已变更',
      };
    }

    // 清单在授权**之后**才读:授权流可长达数分钟,期间清单可能被并发写
    // (断开其它账号 / 刷新 invalidGrant 标过期),以新鲜清单为准收窄
    // 陈旧写回窗口。
    const manifest = parseManifest(this.deps.vault.read(ghostId, accountsKey(secretKey)));

    // 同身份合并:复用既有账号 id(默认位 / 意识侧记住的 account id 全部
    // 保持有效),只换令牌与状态。
    const existing = label !== null ? manifest.accounts.find((a) => a.label === label) : undefined;
    if (existing) {
      if (flow.bundle.refreshToken !== null) {
        if (!this.deps.vault.store(ghostId, refreshTokenKey(secretKey, existing.id), flow.bundle.refreshToken)) {
          return { ok: false, error: 'VAULT_WRITE_FAILED' };
        }
      }
      // 重连顺带刷新展示名:老账号(displayTemplate 上线前连的)或用户改过
      // 显示名/workspace 名的,这里追上最新值。
      let manifestDirty = false;
      if (existing.status !== 'connected') {
        existing.status = 'connected';
        manifestDirty = true;
      }
      if (display !== null && existing.displayLabel !== display) {
        existing.displayLabel = display;
        manifestDirty = true;
      }
      if (manifestDirty) {
        this.deps.vault.store(ghostId, accountsKey(secretKey), JSON.stringify(manifest));
      }
      // 重连顺带刷新头像(用户可能换过头像;写失败不影响连接结果)。
      if (avatar !== null) {
        this.deps.vault.store(ghostId, avatarKey(secretKey, existing.id), avatar);
      }
      this.tokenCache.set(this.cacheKey(ghostId, secretKey, existing.id), {
        accessToken: flow.bundle.accessToken,
        expiresAt: flow.bundle.expiresAt,
      });
      this.deps.logger?.info('ghost oauth 账号已重连(同身份合并)', { ghostId, secretKey, accountId: existing.id });
      this.notifyConnected(ghostId, secretKey, existing.displayLabel ?? existing.label);
      return {
        ok: true,
        account: toView(
          existing,
          manifest.defaultAccountId,
          avatar ?? this.readAvatar(ghostId, secretKey, existing.id),
        ),
      };
    }

    // 上限只拦"真新增":检查放在合并判定之后——满员时重连既有账号仍然要放行
    // (代价是满员 + 真新账号会白跑一趟授权才报 ACCOUNT_LIMIT,8 个上限极少命中)。
    if (manifest.accounts.length >= GHOST_OAUTH_MAX_ACCOUNTS) {
      return { ok: false, error: 'ACCOUNT_LIMIT' };
    }

    const account: AccountRow = {
      id: randomUUID(),
      label,
      displayLabel: display,
      status: 'connected',
      createdAt: Date.now(),
    };

    // refresh token 先落库再挂清单:清单是"账号存在"的事实源,顺序反了
    // 可能出现"清单有账号但无 rt"的半身位。没有 rt 的服务商(罕见)照样
    // 挂账号,access token 走内存缓存,过期后 AUTH_EXPIRED 引导重连。
    if (flow.bundle.refreshToken !== null) {
      if (!this.deps.vault.store(ghostId, refreshTokenKey(secretKey, account.id), flow.bundle.refreshToken)) {
        return { ok: false, error: 'VAULT_WRITE_FAILED' };
      }
    }
    const nextManifest: AccountsManifest = {
      defaultAccountId: manifest.defaultAccountId ?? account.id,
      accounts: [...manifest.accounts, account],
    };
    if (!this.deps.vault.store(ghostId, accountsKey(secretKey), JSON.stringify(nextManifest))) {
      this.deps.vault.remove(ghostId, refreshTokenKey(secretKey, account.id));
      return { ok: false, error: 'VAULT_WRITE_FAILED' };
    }
    // 头像最后落(清单已是事实源;写失败只是没头像,不回滚账号)。
    if (avatar !== null) {
      this.deps.vault.store(ghostId, avatarKey(secretKey, account.id), avatar);
    }

    this.tokenCache.set(this.cacheKey(ghostId, secretKey, account.id), {
      accessToken: flow.bundle.accessToken,
      expiresAt: flow.bundle.expiresAt,
    });
    this.deps.logger?.info('ghost oauth 账号已连接', { ghostId, secretKey, accountId: account.id });
    this.notifyConnected(ghostId, secretKey, account.displayLabel ?? account.label);
    return { ok: true, account: toView(account, nextManifest.defaultAccountId, avatar) };
  }

  /** 授权成功通知(自兜异常:提示挂了不影响连接结果)。 */
  private notifyConnected(ghostId: string, secretKey: string, label: string | null): void {
    try {
      this.deps.onAccountConnected?.({ ghostId, secretKey, label });
    } catch (err) {
      this.deps.logger?.warn?.('ghost oauth onAccountConnected 通知失败(不影响连接结果)', {
        ghostId,
        secretKey,
        err: String(err),
      });
    }
  }

  /* ----------------------------- 令牌获取 -------------------------------- */

  /**
   * 出网注入路径的唯一入口:拿指定(或默认)账号的新鲜 access token。
   * 缓存未过期直接回;否则单飞刷新。invalid_grant 标账号 expired 并回
   * AUTH_EXPIRED(networkSlot 折叠给意识的错误里不含任何令牌字节)。
   */
  async getFreshAccessToken(
    ghostId: string,
    secretKey: string,
    decl: GhostOauthDecl,
    accountId?: string,
  ): Promise<GhostOauthAccessTokenResult> {
    const manifest = parseManifest(this.deps.vault.read(ghostId, accountsKey(secretKey)));
    const resolvedId = accountId ?? manifest.defaultAccountId;
    if (!resolvedId) return { ok: false, error: 'NO_ACCOUNT' };
    const row = manifest.accounts.find((a) => a.id === resolvedId);
    if (!row) return { ok: false, error: 'NO_ACCOUNT' };

    const key = this.cacheKey(ghostId, secretKey, resolvedId);
    const cached = this.tokenCache.get(key);
    if (cached && (cached.expiresAt === null || cached.expiresAt > Date.now())) {
      return { ok: true, accessToken: cached.accessToken, accountId: resolvedId };
    }

    const inflight = this.refreshInflight.get(key);
    if (inflight) return inflight;

    const task = this.refreshAccount(ghostId, secretKey, decl, resolvedId, key).finally(() => {
      this.refreshInflight.delete(key);
    });
    this.refreshInflight.set(key, task);
    return task;
  }

  /**
   * 401 作废通道(networkSlot 上游 401 时调用):丢缓存,下一单强制刷新。
   * 与 exchange 引擎的"作废重换整链重试一次"同一套路。
   */
  invalidateAccessToken(ghostId: string, secretKey: string, accountId: string): void {
    this.tokenCache.delete(this.cacheKey(ghostId, secretKey, accountId));
  }

  private async refreshAccount(
    ghostId: string,
    secretKey: string,
    decl: GhostOauthDecl,
    accountId: string,
    cacheKey: string,
  ): Promise<GhostOauthAccessTokenResult> {
    const config = this.readClientConfig(ghostId, secretKey, decl);
    if (!config) return { ok: false, error: 'NO_CLIENT_CONFIG' };
    let refreshToken = this.deps.vault.read(ghostId, refreshTokenKey(secretKey, accountId));
    if (!refreshToken) {
      // 无 rt 且缓存已失效:只能重新授权。
      this.markExpired(ghostId, secretKey, accountId);
      return { ok: false, error: 'AUTH_EXPIRED' };
    }

    // 最多两轮:第一轮 invalid_grant 先怀疑"RT 已被其它共库实例轮换"(文件头
    // 多实例共库纪律),探测到新 RT 就换它重试一轮;第二轮仍 invalid_grant
    // 才判真失效。
    for (let attempt = 0; ; attempt += 1) {
      const result = await refreshGhostOauthToken({
        config,
        refreshToken,
        fetchImpl: this.deps.fetchImpl,
        broker: this.deps.broker,
        logger: this.deps.logger,
      });
      if (result.ok) {
        // 轮换型服务商:新 rt 覆盖落库(丢了下一次刷新必 invalid_grant)。
        // 写失败无法当场补救(新 RT 只在内存),但必须大声留痕:重启后旧 RT
        // 已被服务商作废,下一次刷新注定 invalid_grant → 重新授权。
        if (result.bundle.refreshToken !== null && result.bundle.refreshToken !== refreshToken) {
          if (
            !this.deps.vault.store(ghostId, refreshTokenKey(secretKey, accountId), result.bundle.refreshToken)
          ) {
            this.deps.logger?.warn(
              'ghost oauth 轮换后的新 refresh token 落库失败——新令牌仅存内存,重启后需要重新授权',
              { ghostId, secretKey, accountId },
            );
          }
        }
        this.tokenCache.set(cacheKey, {
          accessToken: result.bundle.accessToken,
          expiresAt: result.bundle.expiresAt,
        });
        // 曾标 expired 的账号刷新成功即复活(用户在别处重授权后 rt 又有效的边角)。
        this.markConnected(ghostId, secretKey, accountId);
        // 展示名/头像回填(fire-and-forget,不拖累令牌热路径):displayTemplate /
        // avatarPath 上线前连的老账号缺这些,借下一次令牌刷新顺路补上,无需重连。
        void this.backfillIdentityExtras(ghostId, secretKey, decl, accountId, result.bundle.accessToken);
        return { ok: true, accessToken: result.bundle.accessToken, accountId };
      }

      if (result.error === 'NETWORK') {
        return { ok: false, error: 'NETWORK', detail: result.detail };
      }
      if (!result.invalidGrant) {
        return { ok: false, error: 'REFRESH_FAILED', detail: result.detail };
      }

      if (attempt === 0) {
        const rotated = await this.readRotatedRefreshToken(ghostId, secretKey, accountId, refreshToken);
        if (rotated !== null) {
          this.deps.logger?.info(
            'ghost oauth invalid_grant 后检测到 refresh token 已被其它实例轮换,用新令牌重试',
            { ghostId, secretKey, accountId },
          );
          refreshToken = rotated;
          continue;
        }
      }

      // 真失效:标 expired 引导重新授权。删除走 compare-and-delete——只删
      // 仍等于自己最后用过的这枚;若期间有并发实例写入了更新的 RT,留给它。
      this.markExpired(ghostId, secretKey, accountId);
      const current = this.deps.vault.read(ghostId, refreshTokenKey(secretKey, accountId));
      if (current === refreshToken) {
        this.deps.vault.remove(ghostId, refreshTokenKey(secretKey, accountId));
      }
      this.tokenCache.delete(cacheKey);
      return { ok: false, error: 'AUTH_EXPIRED', detail: result.detail };
    }
  }

  /**
   * invalid_grant 后的轮换探测:立即重读保险库;仍是自己用过的那枚时短暂等待
   * (并发赢家的成功响应可能还在落库路上)再读一次。返回已轮换的新 RT,或
   * null(确认未轮换,invalid_grant 是真失效)。
   */
  private async readRotatedRefreshToken(
    ghostId: string,
    secretKey: string,
    accountId: string,
    usedRefreshToken: string,
  ): Promise<string | null> {
    const key = refreshTokenKey(secretKey, accountId);
    const immediate = this.deps.vault.read(ghostId, key);
    if (immediate !== null && immediate !== usedRefreshToken) return immediate;
    const sleep =
      this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    await sleep(GHOST_OAUTH_INVALID_GRANT_RECHECK_DELAY_MS);
    const delayed = this.deps.vault.read(ghostId, key);
    if (delayed !== null && delayed !== usedRefreshToken) return delayed;
    return null;
  }

  /**
   * 老账号展示名/头像一次性回填:声明了 displayTemplate(且该行还没有
   * displayLabel)或 avatarPath(且库里还没有头像)时,用新鲜 access token
   * 拉一次身份端点补上。best-effort——任何失败静默放弃(下次刷新再试),
   * 绝不影响令牌获取结果。
   */
  private async backfillIdentityExtras(
    ghostId: string,
    secretKey: string,
    decl: GhostOauthDecl,
    accountId: string,
    accessToken: string,
  ): Promise<void> {
    try {
      if (decl.identity === undefined) return;
      const template = decl.identity.displayTemplate;
      const before = parseManifest(this.deps.vault.read(ghostId, accountsKey(secretKey)));
      const row = before.accounts.find((a) => a.id === accountId);
      if (!row) return;
      const needDisplay = template !== undefined && row.displayLabel === null;
      // 头像回填同样只对第一方官方意识放行(connectAccount 处的 SSRF 口径)。
      const needAvatar =
        decl.identity.avatarPath !== undefined &&
        isOfficialGhostId(ghostId) &&
        this.readAvatar(ghostId, secretKey, accountId) === null;
      if (!needDisplay && !needAvatar) return;
      const identity = await fetchGhostOauthIdentity({
        url: decl.identity.url,
        labelPath: decl.identity.labelPath,
        ...(template !== undefined ? { displayTemplate: template } : {}),
        ...(decl.identity.avatarPath !== undefined ? { avatarPath: decl.identity.avatarPath } : {}),
        accessToken,
        fetchImpl: this.deps.fetchImpl,
      });
      if (needDisplay && identity.display !== null) {
        // 拉取期间清单可能被并发写(断开/设默认/新连接):用 patchAccount 做
        // 定向字段写入——只改目标行的 displayLabel/label,不覆盖清单其它状态。
        this.patchAccount(ghostId, secretKey, accountId, (fresh) => {
          if (fresh.displayLabel !== null) return false;
          fresh.displayLabel = identity.display;
          if (fresh.label === null && identity.label !== null) fresh.label = identity.label;
          return true;
        });
        this.deps.logger?.info('ghost oauth 账号展示名已回填', { ghostId, secretKey, accountId });
      }
      if (needAvatar && identity.avatarUrl !== null) {
        const avatar = await fetchGhostOauthAvatar({ url: identity.avatarUrl, fetchImpl: this.deps.fetchImpl });
        // 存前重验账号仍在清单(拉取期间可能被断开;断开后不再写孤儿头像键)。
        if (avatar !== null) {
          const fresh = parseManifest(this.deps.vault.read(ghostId, accountsKey(secretKey)));
          if (fresh.accounts.some((a) => a.id === accountId)) {
            this.deps.vault.store(ghostId, avatarKey(secretKey, accountId), avatar);
            this.deps.logger?.info('ghost oauth 账号头像已回填', { ghostId, secretKey, accountId });
          }
        }
      }
    } catch (err) {
      this.deps.logger?.warn('ghost oauth 展示名/头像回填失败(不影响令牌获取)', {
        ghostId,
        secretKey,
        accountId,
        err: String(err),
      });
    }
  }

  /**
   * 原子定向账号字段修补:重读清单 → 定位目标行 → 执行 mutator → 存回。
   * mutator 返回 true 表示有改动需落盘,false/undefined = 无需写回。
   * 读→改→写之间无 yield(同步),单线程 JS 保证无并发插入。
   */
  private patchAccount(
    ghostId: string,
    secretKey: string,
    accountId: string,
    mutator: (row: AccountRow) => boolean | undefined,
  ): boolean {
    const manifest = parseManifest(this.deps.vault.read(ghostId, accountsKey(secretKey)));
    const row = manifest.accounts.find((a) => a.id === accountId);
    if (!row || !mutator(row)) return false;
    return this.deps.vault.store(
      ghostId,
      accountsKey(secretKey),
      JSON.stringify(manifest),
    );
  }

  private markExpired(ghostId: string, secretKey: string, accountId: string): void {
    const changed = this.patchAccount(ghostId, secretKey, accountId, (row) => {
      if (row.status === 'expired') return false;
      row.status = 'expired';
      return true;
    });
    if (changed) this.notifyStatusChanged(ghostId, secretKey, 'expired');
  }

  private markConnected(ghostId: string, secretKey: string, accountId: string): void {
    const changed = this.patchAccount(ghostId, secretKey, accountId, (row) => {
      if (row.status === 'connected') return false;
      row.status = 'connected';
      return true;
    });
    if (changed) this.notifyStatusChanged(ghostId, secretKey, 'connected');
  }

  private notifyStatusChanged(
    ghostId: string,
    secretKey: string,
    status: GhostOauthAccountStatus,
  ): void {
    try {
      this.deps.onAccountStatusChanged?.({ ghostId, secretKey, status });
    } catch (err) {
      this.deps.logger?.warn?.(
        'ghost oauth onAccountStatusChanged 通知失败(不影响状态写入)',
        {
          ghostId,
          secretKey,
          status,
          err: String(err),
        },
      );
    }
  }

  private cacheKey(ghostId: string, secretKey: string, accountId: string): string {
    return `${ghostId} ${secretKey} ${accountId}`;
  }
}
