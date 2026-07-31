/**
 * hook-control/manager.ts
 * ---------------------------------------------------------------------------
 * Cindy IM relay 连接编排(同一产品、多 provider): Slack 走 legacy 专属帧
 * (bind.* / prefs.* / tool.*), 其余 provider 走 provider-neutral 帧
 * (provider.bind.* / provider.prefs.*), 后者的连接状态机是表驱动的
 * NeutralProviderLane —— 新增 provider 只追加一行 config, 不复制状态机。
 * 任务执行链和本机目录配置在所有 provider 间共享。
 *
 * 每个服务都由公司中心部署、地址内置、鉴权走登录 JWT(token 源注入)，但
 * 部署和故障域彼此独立；dispatcher 以 provider 命名空间复用同一 session runner。
 *
 * 依赖全部注入(store / transport 工厂 / token 源 / 设备信息 / 状态回调),
 * 测试用内存 harness 直接驱动(规则 14); Electron 绑定在 ipc.ts 组装。
 */

import { randomUUID } from 'node:crypto';

import {
  HOOK_FEATURE_GROUP_RELAY,
  HOOK_FEATURE_LIFECYCLE_ANNOUNCEMENT,
  HOOK_FEATURE_MULTI_TEAM,
  HOOK_FEATURE_PROVIDER_BIND,
  HOOK_FEATURE_PROVIDER_PREFS,
  HOOK_FEATURE_PROVIDER_TELEGRAM,
  HOOK_FEATURE_SESSION_PICKER,
  HOOK_FEATURE_SLACK_TOOLS,
  makeBindRevoke,
  makeBindStart,
  makeHello,
  makeLifecyclePreference,
  makePrefsGet,
  makePrefsSet,
  makeProviderBindCancel,
  makeProviderBindRevoke,
  makeProviderBindStart,
  makeProviderPrefsGet,
  makeProviderPrefsSet,
  makeQueryResponse,
  makeTaskAck,
  makeToolRequest,
  type BindUpdatePayload,
  type HelloInput,
  type HookMessage,
  type HookProvider,
  type ProviderBindStatusPayload,
  type QuerySessionEntry,
} from '@cindy/slack-hook-protocol';

import {
  HOOK_BIND_REASON_NOT_INSTALLED,
  HOOK_BIND_REASON_ALREADY_BOUND,
  HOOK_BIND_REASON_SUPERSEDED,
  HOOK_CHAT_WORKSPACE_ALIAS,
} from '../../shared/hookControlIpc.js';
import type {
  HookBindingView,
  HookConnectionStatus,
  HookPendingBindView,
  HookPrefsPatch,
  HookPrefsView,
  HookProvider as ClientHookProvider,
  ProviderBindingView,
  ProviderPrefsView,
  HookTeamBindingView,
  SlackHookView,
} from '../../shared/hookControlIpc.js';
import {
  DEFAULT_SLACK_LIFECYCLE_ANNOUNCEMENT,
  type ProviderBindingCacheEntry,
  type SlackHookStore,
} from './store.js';
import type { HookDispatcher } from './dispatcher.js';
import { buildQueryResponse, type AgentModelSource } from './queryResponder.js';
import { recordGroupMessage, sweepGroupWindowExpired } from './groupWindow.js';
import { parseTelegramConnectUrl } from './telegramDeepLink.js';
import type { HookTransport, HookTransportOpts, HookTransportStatus } from './transport.js';

/** dispatcher / bindings 的 connectionId 基础键；运行时追加账号与 provider。 */
export const SLACK_HOOK_CONNECTION_ID = 'slack';

/** Legacy Slack channel lane used before provider-prefixed external keys. */
function isLegacySlackExternalKey(externalKey: string): boolean {
  return /^[A-Z][A-Z0-9]*:[A-Z][A-Z0-9]*:\d+(?:\.\d+)?$/.test(externalKey);
}

/** Pre-provider-prefix Slack DM lane accepted only for source-less/Slack traffic. */
function isLegacySlackDmExternalKey(externalKey: string): boolean {
  return /^dm:(?:[A-Z][A-Z0-9]*:){1,2}g\d+$/.test(externalKey);
}

/**
 * Route only the two providers implemented by this client.  Missing source is
 * retained solely for legacy Slack servers; Telegram always has both an
 * explicit source and the provider-prefixed lane key from its wire contract.
 * A source/key disagreement fails closed instead of letting a future or
 * compromised provider inherit Slack permissions and prompt semantics.
 */
export function providerForTaskDispatch(
  payload: Pick<import('@cindy/slack-hook-protocol').TaskDispatchPayload, 'externalKey' | 'source'>,
): HookProvider | null {
  const telegramKey = payload.externalKey.startsWith('telegram:');
  const slackKey =
    payload.externalKey.startsWith('slack:') ||
    payload.externalKey.startsWith('team-slack:') ||
    // Pre-prefix Slack channel lane: <team>:<channel>:<message timestamp>.
    isLegacySlackExternalKey(payload.externalKey) ||
    isLegacySlackDmExternalKey(payload.externalKey);
  const source = payload.source?.im;
  if (source === undefined) return slackKey ? 'slack' : null;
  if (source === 'telegram') return telegramKey ? 'telegram' : null;
  if (source === 'slack') return slackKey ? 'slack' : null;
  return null;
}

/** Route archive frames only for lane-key formats owned by implemented providers. */
export function providerForExternalKey(externalKey: string): HookProvider | null {
  if (externalKey.startsWith('telegram:')) return 'telegram';
  if (
    externalKey.startsWith('slack:') ||
    externalKey.startsWith('team-slack:') ||
    isLegacySlackExternalKey(externalKey) ||
    isLegacySlackDmExternalKey(externalKey)
  ) {
    return 'slack';
  }
  return null;
}

export interface HookControlManagerDeps {
  store: SlackHookStore;
  /** Runtime capability gate; false stops the transport without changing user prefs/bindings. */
  isAvailable?: () => boolean;
  /** transport 工厂 —— 生产为 createHookTransport, 测试可注入假实现。 */
  createTransport: (opts: HookTransportOpts) => HookTransport;
  /** Telegram 平级服务端点；空字符串表示当前环境尚未部署该服务。 */
  getTelegramUrl: () => string;
  /** 登录 accessToken 源(transport 每次建连实时取; null = 未登录)。 */
  getAuthToken: () => Promise<string | null>;
  /** upgrade 401 后强制刷新一次登录凭证；成功后 transport 立即重连。 */
  refreshAuthToken: () => Promise<boolean>;
  /** hello 用的设备身份(authManager deviceId + hostname)。 */
  deviceInfo: () => { deviceId: string; deviceName: string };
  /** hello 声明的可用 agent 类型。 */
  agents: string[];
  /** 状态变化推送(IPC 层广播到所有窗口)。 */
  notifyStatus: (view: SlackHookView) => void;
  /**
   * cindy_slack provider 的构建期可用性(bound + server capability)翻转通知。
   *
   * Claude 每个 session 启动时都会重新评估 provider；Codex 会把 MCP server
   * 清单冻结在共享 app-server / bridge 中，host 用这个出口失效其缓存。只在
   * false <-> true 真变化时触发。server capability 保留最近一次成功 welcome 的
   * 快照，因此连接抖动不会反复重建；重连到不同版本 server 时会准确刷新。
   */
  onSlackToolProviderEnabledChanged?: (enabled: boolean) => void;
  /** 目录偏好快照推送(prefs.state 到达时广播; 含请求回执与 /model 卡主动推)。 */
  notifyPrefs?: (view: HookPrefsView) => void;
  notifyProviderPrefs?: (view: ProviderPrefsView) => void;
  /** prefs 读写往返超时(默认 10s; 测试注短)。 */
  prefsTimeoutMs?: number;
  /** multi-team 自动首绑延迟窗；仅测试注短，生产默认 300ms。 */
  autoBindDeferMs?: number;
  /** Slack 网关工具往返超时(默认 60s —— 搜索/长查询比 prefs 慢得多; 测试注短)。 */
  toolTimeoutMs?: number;
  /**
   * OIDC 授权等待上限(默认 3 分钟; 测试注短)。外部系统浏览器无法感知
   * 「用户直接关掉了授权页」, 只能本地超时兜底: 到点仍 pending 视为放弃,
   * toggle 自动弹回(与 server 推 expired 的自动下线同一条路径, 先到先赢)。
   */
  bindPendingTimeoutMs?: number;
  /** "等安装"上限(默认 10 分钟; 测试注短)。见 DEFAULT_INSTALL_WAIT_TIMEOUT_MS。 */
  installWaitTimeoutMs?: number;
  /** 任务派发器。不注入时 dispatch 走 stub 拒绝(纯连接层测试用)。 */
  dispatcher?: HookDispatcher;
  /** query.request(models)的数据源(与会话选择器同规则实时派生, 允许异步); 不注入回空清单。 */
  listAgentModels?: () => AgentModelSource[] | Promise<AgentModelSource[]>;
  /** session-picker-v1 的 privacy-minimised 当前账号数据源。 */
  listRecentSessions?: () => QuerySessionEntry[] | Promise<QuerySessionEntry[]>;
  /** dispatcher/store 命名空间使用的当前 Cindy 账号不可逆指纹。 */
  getAccountFingerprint?: () => string | null;
  /** Production opens this only after the current account DB is ready. */
  accountInitiallyActive?: boolean;
  /**
   * 打开系统浏览器(SIWS OIDC 授权链接)。生产注入 electron shell.openExternal,
   * 测试注入假实现 —— 避免 manager 顶层 import electron(vitest 环境无 electron)。
   * 不注入时为 no-op(纯连接层测试)。
   */
  openExternalUrl?: (url: string) => void;
  /**
   * Telegram URL 的 main 安全边界；实现必须在 shell 前严格校验，并让
   * renderer 主动触发的打开动作能等待系统 shell 的真实结果。
   */
  openTelegramUrl?: (url: string) => void | Promise<void>;
  log: { info(msg: string): void; warn(msg: string): void };
}

export interface HookControlManager {
  /** 按当前配置 + 登录态同步连接(启动 / 开关 / 配置变更 / 登录态变化后调用)。 */
  sync(): void;
  /**
   * 在线上重发 hello(重读配置, 别名清单以最新一帧为准 —— 协议明确支持)。
   * 工作目录变更时优先走这里, 避免整条连接重建造成设置页状态闪烁;
   * false = 未连接, 调用方回退 sync()(下次建连的 hello 自带新清单)。
   */
  refreshHello(): boolean;
  /** 渲染层快照。 */
  snapshot(): SlackHookView;
  /** 持久化并尽力实时同步 Slack 上下线通知偏好。 */
  setLifecycleAnnouncement(enabled: boolean): void;
  /**
   * 发起 Slack 账号绑定(SIWS OIDC): 发 bind.start(无参); server 回
   * bind.update(pending, authorizeUrl), main 打开系统浏览器。false = 连接不在线。
   * 手动重试用; "开关即绑定"的自动路径走 armAutoBind + 连上后自动发起。
   */
  bindStart(): boolean;
  /**
   * 开关即绑定: 打开 toggle 时置一次性意图, 连上后 server 推回绑定现状 ——
   * none 自动发起 OIDC(弹浏览器), confirmed 不弹(已绑定秒恢复)。判定即清。
   */
  armAutoBind(): void;
  /** 解除 Slack 账号绑定(bind.revoke); 当前无 UI 入口, 保留供未来显式解绑。 */
  bindRevoke(): boolean;
  /**
   * (multi-team)添加新 Slack workspace 绑定: 发 bind.start(空 teamId, 用户在
   * 授权页自选)。已有真在途授权(pending)时忽略(返回 true); 终止态(denied/
   * expired/failed)允许直接重试覆盖。false = 未连接或 server 不支持 multi-team。
   */
  addBinding(): boolean;
  /** (multi-team)给指定 team 重新授权(bind.start 带 teamId, pin 授权页)。 */
  rebindTeam(teamId: string): boolean;
  /**
   * (multi-team)解绑指定 team。displaced 行 = 仅清本地缓存(服务端本就没有该
   * 绑定, 离线也能删); 活跃行 = 发 bind.revoke{teamId} 并乐观移除(需在线)。
   */
  revokeTeam(teamId: string): boolean;
  /**
   * (multi-team)取消在途授权: 本地清 pendingBind, 在线时发 bind.revoke
   * {pendingOnly:true} 作废 server 侧登记(pending 授权 / 等安装)。幂等。
   */
  cancelPendingBind(): boolean;
  /**
   * 关闭开关: **解除绑定并断开** —— 在线则先发 bind.revoke(server 清绑定与
   * 一切在途登记), 本地绑定态归零, 再断开。再打开需重新走浏览器授权。
   * 离线时发不出 revoke(尽力而为), 服务端绑定保留, 重开会按 confirmed 秒恢复。
   */
  revokeAndDisconnect(): void;
  /**
   * 调用 server 侧 Slack 网关工具(tool.request -> tool.response 往返)。
   * 永不 reject —— 各类失败(未连接 / 未绑定 / server 太旧 / 超时 / server
   * 侧错误)一律 resolve 为 { ok:false, error:{code,message} }, MCP 工具层
   * 1:1 映射为结构化结果, 不需要 try/catch。
   */
  callSlackTool(
    tool: string,
    args?: Record<string, unknown>,
    teamId?: string | null,
  ): Promise<HookSlackToolResult>;
  /** Slack 工具可用性快照(cindy_slack provider 的 isEnabled / slack_status 数据源)。 */
  getSlackToolAvailability(): HookSlackToolAvailability;
  /**
   * 拉取绑定用户的全部目录偏好快照(prefs.get -> prefs.state 往返)。
   * 未连接 reject HookNotConnectedError; 超时(server 太旧, prefs 帧被丢)
   * reject HookPrefsTimeoutError。
   */
  getWorkspacePrefs(): Promise<HookPrefsView>;
  /**
   * 部分更新某目录偏好并返回写后的最新快照(语义同 getWorkspacePrefs)。
   * teamId: (multi-team)写入目标 team; 仅 server 宣告 multi-team 时进帧。
   */
  setWorkspacePrefs(
    workspace: string,
    patch: HookPrefsPatch,
    teamId?: string | null,
  ): Promise<HookPrefsView>;
  setProviderEnabled(provider: HookProvider, enabled: boolean): void;
  providerBindStart(provider: 'telegram'): boolean;
  providerBindCancel(provider: 'telegram'): boolean;
  providerBindRevoke(provider: 'telegram'): boolean;
  openTelegramAction(action: 'connect' | 'provider' | 'add-to-group'): Promise<boolean>;
  getProviderWorkspacePrefs(provider: 'telegram'): Promise<ProviderPrefsView>;
  setProviderWorkspacePrefs(
    provider: 'telegram',
    workspace: string,
    patch: HookPrefsPatch,
  ): Promise<ProviderPrefsView>;
  /** 登录/切账号后重新打开 account ingress。 */
  activateAccount(): void;
  /** 同步关闭 ingress、取消/中止旧账号任务并等它们越过最终异步边界。 */
  deactivateAccount(): Promise<void>;
  dispose(): void;
}

/** Slack 网关工具的结构化错误(server 码透传 + 本地码, 见 callSlackTool)。 */
export interface HookSlackToolError {
  /**
   * 错误码。本地产生的四种: HOOK_NOT_CONNECTED(未连接)/ NOT_BOUND(未绑定,
   * 本地短路)/ SERVER_TOO_OLD(welcome.features 无 slack-tools)/ TIMEOUT;
   * 其余为 server 侧透传(NO_USER_TOKEN / TOKEN_EXPIRED / RATE_LIMITED 等)。
   */
  code: string;
  message: string;
}

/** callSlackTool 的结构化结果(永不 throw)。 */
export type HookSlackToolResult =
  { ok: true; result: unknown } | { ok: false; error: HookSlackToolError };

/** Slack 工具可用性快照。 */
export interface HookSlackToolAvailability {
  connected: boolean;
  /** 绑定已 confirmed(multi-team 下 = 至少一条未 displaced 的绑定)。 */
  bound: boolean;
  /** server 已宣告 slack-tools 能力(welcome.features)。 */
  serverSupportsTools: boolean;
  binding: HookBindingView | null;
  /** server 已宣告 multi-team 能力(true 时非 status 工具必须带 teamId)。 */
  multiTeam: boolean;
  /** (multi-team)可用绑定清单(不含 displaced 行), 供 slack_status / 工具描述消费。 */
  bindings: Array<{ teamId: string; teamName: string | null }>;
}

/**
 * 连接不在线时的 prefs 读写失败(IPC 层映射 HOOK_NOT_CONNECTED)。
 *
 * provider 记录失败发生在哪条 transport / 服务上: Slack 与 Telegram 各自独立
 * 部署, 复用同一个错误类时必须带上来源, 否则 Telegram 偏好查询失败会被
 * 误诊成 Slack 断线(见 issue #279)。null = 未指定 provider 的通用 Hook 失败。
 */
export class HookNotConnectedError extends Error {
  readonly provider: HookProvider | null;
  constructor(provider: HookProvider | null = null) {
    super(
      provider === 'telegram'
        ? 'telegram provider connection is not connected'
        : provider === 'slack'
          ? 'slack hook connection is not connected'
          : 'hook connection is not connected',
    );
    this.name = 'HookNotConnectedError';
    this.provider = provider;
  }
}

/**
 * not-connected 失败的 IPC 面向文案(provider-specific)。Telegram 走独立服务,
 * 失败必须明确指向 Telegram provider 而不是 Slack Hook; Slack 保留原 Slack 语义;
 * provider 未指定(null = 通用 Hook 失败, 见 HookNotConnectedError)返回中性文案,
 * 避免任何默认参数或未来新增调用点又把非 Slack 失败误报成 Slack(issue #279)。
 * 抽成纯函数以便在 IPC 组装层复用并单测(不牵扯 electron)。
 */
export function hookNotConnectedIpcMessage(provider: HookProvider | null): string {
  return provider === 'telegram'
    ? 'Telegram provider is not connected'
    : provider === 'slack'
      ? 'slack hook is not connected'
      : 'hook is not connected';
}

/** prefs 往返超时 —— server 大概率是不认识 prefs.* 帧的旧版本(丢帧不应答)。 */
export class HookPrefsTimeoutError extends Error {
  constructor() {
    super('hook server did not answer prefs request (server too old or stalled)');
    this.name = 'HookPrefsTimeoutError';
  }
}

/** prefs 往返默认超时(对齐 server 侧 queryBroker 的 10s)。 */
const DEFAULT_PREFS_TIMEOUT_MS = 10_000;

/** Slack 网关工具往返默认超时(全量搜索等长查询远慢于 prefs, 取宽上限)。 */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/**
 * OIDC 授权等待默认上限: 已登录 Slack 的浏览器一键授权只要几秒, 3 分钟给足
 * 「浏览器里现登录 Slack」的余量; 超时即视为用户关掉/放弃了授权页。
 * (server 侧 state 令牌 TTL 10 分钟是安全上限, 与这里的 UX 上限是两回事。)
 */
const DEFAULT_BIND_PENDING_TIMEOUT_MS = 180_000;

/**
 * "等安装"默认上限: 授权检出 workspace 未装 App 后保持连接等 server 的
 * confirmed 推送(用户在浏览器走安装流程, 装完 server 自动补完绑定)。
 * 到点没等到即视为放弃, toggle 弹回。需小于 server 侧登记 TTL(15 分钟)。
 */
const DEFAULT_INSTALL_WAIT_TIMEOUT_MS = 600_000;

/** Provider attempts are server-defined as ten-minute leases; clamp hostile/skewed timestamps. */
const DEFAULT_PROVIDER_BIND_TIMEOUT_MS = 600_000;

/**
 * (multi-team)自动首绑的延迟窗口: 空 bind.state 后等这么久没有任何
 * bind.update(pending 回放)到达才发起首绑。server 的 hello 同步帧背靠背
 * 下发, 同一 TCP flush 内到达远快于本窗口; 取值只需盖住网络抖动。
 */
const AUTO_BIND_DEFER_MS = 300;

/** transport 状态 -> 渲染层状态。 */
function toViewStatus(s: HookTransportStatus | null, enabled: boolean): HookConnectionStatus {
  if (!enabled) return 'disabled';
  switch (s) {
    case 'connected':
      return 'connected';
    case 'standby':
      return 'standby';
    case 'error':
      return 'error';
    case 'stopped':
    case 'connecting':
    case null:
    default:
      return 'connecting';
  }
}

/** Latest local provider binding mutation used to reject superseded wire replies. */
type ProviderBindRequest =
  | { kind: 'start'; requestId: string }
  | { kind: 'cancel'; requestId: string; attemptId: string }
  | { kind: 'revoke'; requestId: string; bindingId: string };

/**
 * Provider-neutral 连接线的 provider 值域(Slack 走 legacy 专属帧, 不进本表)。
 *
 * 从**客户端支持集**(IPC 契约的 ClientHookProvider)派生, 而不是协议全集:
 * 协议按 append-only 先行加了 'x'(配套能力 provider:x), 但客户端的 X 渠道
 * 还没实现(见 makecindy/cindy#691), 运行期也没有对应 lane。若沿用协议全集,
 * 一个客户端从不支持的 provider 会漏进 renderer 可见类型。等 X 的 lane config
 * 与设置页一并落地时, 放宽 ClientHookProvider 即可自动带上本表。
 */
type NeutralHookProvider = Exclude<ClientHookProvider, 'slack'>;

/** renderer 请求打开 provider 相关链接的动作(openTelegramAction 的值域)。 */
type ProviderOpenAction = 'connect' | 'provider' | 'add-to-group';

/**
 * Provider-neutral 连接线的静态描述 —— 一个 provider 一行, 接线期
 * (createHookControlManager 构造时)定死, 运行期只读。除 provider 标识外全部
 * 是行为注入: 端点、能力集、绑定缓存读写与 provider 专属的 URL 校验/生成都
 * 收在 config 里, 状态机主体(lane 函数组)保持 provider 无关 —— 新增 provider
 * (如 X)只需要追加一行 config, 不再复制状态机。
 */
interface NeutralProviderConfig {
  provider: NeutralHookProvider;
  /** 日志用显示名(如 'Telegram'); 不进 IPC 视图。 */
  label: string;
  /** 服务端点(空串 = 当前环境尚未部署该服务)。 */
  getUrl: () => string;
  /** 端点未配置时的 lastError 文案。 */
  notConfiguredError: string;
  /** welcome.features 必须全部包含才视为该 provider 可用(能力协商)。 */
  requiredFeatures: readonly string[];
  /** hello.features 声明(只声明该服务实际使用的能力, 保持兼容面最小)。 */
  helloFeatures: readonly string[];
  /** provider 独立开关(store 持久位)的读写。 */
  isEnabled: () => boolean;
  setEnabled: (enabled: boolean) => void;
  /** 从本地缓存恢复 confirmed 绑定视图(无缓存返回 null), 供冷启动/账号重激活。 */
  restoreCachedBinding: () => ProviderBindingView | null;
  /** confirmed 绑定缓存写入(null = 清缓存); 状态判定在通用 persistLaneBinding。 */
  writeBindingCache: (entry: ProviderBindingCacheEntry | null) => void;
  /**
   * pending 帧的 connectUrl 校验与归一(provider 专属安全边界, 如 Telegram 的
   * t.me deep-link allowlist)。返回归一后的 payload; 非法时 throw(状态机置
   * failed + invalid-connect-url, 被拒的链接不进任何 renderer 可见快照)。
   */
  normalizePendingPayload: (payload: ProviderBindStatusPayload) => ProviderBindStatusPayload;
  /** renderer 动作 → 待打开的 provider URL(null = 该动作当前不可用)。 */
  actionUrl: (action: ProviderOpenAction, binding: ProviderBindingView) => string | null;
  /** main 安全边界内打开 provider URL(未注入 = 不支持自动打开, 仅剩复制链接)。 */
  openUrl?: (url: string) => void | Promise<void>;
}

/**
 * Provider-neutral 连接线的运行时状态。字段语义与历史 telegram* 散装变量一一
 * 对应, 生命周期全部跟随本线 transport(Slack legacy 线不共享)。
 */
interface NeutralProviderLane {
  config: NeutralProviderConfig;
  transport: HookTransport | null;
  status: HookTransportStatus | null;
  lastError: string | null;
  /** Provider-neutral state; confirmed cache survives provider disable/restart. */
  binding: ProviderBindingView | null;
  /** Toggle-on waits for welcome + authoritative state before starting a new attempt. */
  autoBindIntent: boolean;
  /** Only a locally initiated attempt may automatically open the provider once. */
  openRequestId: string | null;
  /** Only the newest local mutation may consume a provider.bind.update reply. */
  bindRequest: ProviderBindRequest | null;
  /** The first state frame after each welcome may replace a persisted offline cache. */
  awaitingStateSnapshot: boolean;
  bindWatchdog: NodeJS.Timeout | null;
  /** 本线独立的能力协商与发布生命周期(最近一次成功 welcome 的 features 快照)。 */
  serverFeatures: string[];
  serverWelcomeReceived: boolean;
  /** 在途的 provider prefs 往返(requestId -> 挂起 promise; replyTo 配对)。 */
  pendingPrefs: Map<
    string,
    {
      bindingId: string;
      resolve: (v: ProviderPrefsView) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >;
}

export function createHookControlManager(deps: HookControlManagerDeps): HookControlManager {
  const {
    store,
    isAvailable = () => true,
    createTransport,
    getTelegramUrl,
    getAuthToken,
    refreshAuthToken,
    deviceInfo,
    agents,
    notifyStatus,
    onSlackToolProviderEnabledChanged,
    notifyPrefs,
    prefsTimeoutMs,
    autoBindDeferMs = AUTO_BIND_DEFER_MS,
    toolTimeoutMs,
    bindPendingTimeoutMs,
    installWaitTimeoutMs,
    dispatcher,
    listAgentModels,
    listRecentSessions,
    getAccountFingerprint,
    accountInitiallyActive,
    openExternalUrl,
    openTelegramUrl,
    log,
  } = deps;
  const id = SLACK_HOOK_CONNECTION_ID;

  /** Slack 与各 provider-neutral 线是平级部署，不能共享 transport 或连接状态。 */
  let transport: HookTransport | null = null;
  let status: HookTransportStatus | null = null;
  let lastError: string | null = null;
  /**
   * server 推送的最新绑定状态(bind.update); 未推送过为 null。
   * 仅老 server(单绑定)路径维护 —— multi-team 模式下对外的 legacy binding
   * 视图由 bindings/pendingBind 在 toView 里映射, 本变量不参与。
   */
  let binding: HookBindingView | null = null;
  /**
   * (multi-team)绑定列表(活跃 + displaced 行)。权威来源是 bind.state 快照与
   * confirmed/revoked(带 teamId)事件; 冷启动从 store.bindingsCache 预热,
   * 让「已关闭 · N 个绑定已保留」与重开秒恢复在断线状态下也成立。
   */
  let multiBindings: HookTeamBindingView[] = store
    .get()
    .bindingsCache.map((e) => ({ ...e, displaced: false }));
  /** (multi-team)在途授权状态(添加/重绑 workspace 的 pending 与其终止态)。 */
  let pendingBind: HookPendingBindView | null = null;

  // ── provider-neutral 连接线注册表(目前仅 Telegram; 新 provider 在此追加) ────

  const telegramConfig: NeutralProviderConfig = {
    provider: 'telegram',
    label: 'Telegram',
    getUrl: getTelegramUrl,
    notConfiguredError: 'Telegram service endpoint is not configured',
    requiredFeatures: [
      HOOK_FEATURE_PROVIDER_BIND,
      HOOK_FEATURE_PROVIDER_PREFS,
      HOOK_FEATURE_SESSION_PICKER,
      HOOK_FEATURE_PROVIDER_TELEGRAM,
    ],
    helloFeatures: [
      HOOK_FEATURE_PROVIDER_BIND,
      HOOK_FEATURE_PROVIDER_PREFS,
      HOOK_FEATURE_SESSION_PICKER,
      HOOK_FEATURE_GROUP_RELAY,
    ],
    isEnabled: () => store.get().telegramEnabled,
    setEnabled: (enabled) => {
      store.setProviderEnabled('telegram', enabled);
    },
    restoreCachedBinding: () => {
      const cached = store.get().telegramBindingCache;
      if (cached === null) return null;
      return {
        provider: 'telegram',
        state: 'confirmed',
        attemptId: null,
        bindingId: cached.bindingId,
        principalId: cached.principalId,
        principalName: cached.principalName,
        scopeId: cached.scopeId,
        scopeName: cached.scopeName,
        connectUrl: null,
        expiresAt: null,
        reason: null,
        remediationUrl: `https://t.me/${cached.scopeName}`,
        actions: ['revoke', 'open_provider', 'add_to_group'],
      };
    },
    writeBindingCache: (entry) => {
      store.setTelegramBindingCache(entry);
    },
    normalizePendingPayload: (payload) => {
      const connectLink = parseTelegramConnectUrl(payload.connectUrl ?? '');
      if (
        payload.scopeName !== null &&
        connectLink.botUsername.toLowerCase() !== payload.scopeName.toLowerCase()
      ) {
        throw new Error('Telegram binding bot does not match the negotiated scope');
      }
      return {
        ...payload,
        scopeName: payload.scopeName ?? connectLink.botUsername,
        connectUrl: connectLink.url,
      };
    },
    actionUrl: (action, bindingView) => {
      if (action === 'connect' && bindingView.actions.includes('open_connect_url')) {
        return bindingView.connectUrl;
      }
      if (bindingView.scopeName) {
        if (action === 'add-to-group' && bindingView.actions.includes('add_to_group')) {
          return `https://t.me/${bindingView.scopeName}?startgroup=true`;
        }
        if (action === 'provider' && bindingView.actions.includes('open_provider')) {
          return `https://t.me/${bindingView.scopeName}`;
        }
      }
      return null;
    },
    openUrl: openTelegramUrl,
  };

  function createNeutralLane(config: NeutralProviderConfig): NeutralProviderLane {
    return {
      config,
      transport: null,
      status: null,
      lastError: null,
      binding: config.restoreCachedBinding(),
      autoBindIntent: false,
      openRequestId: null,
      bindRequest: null,
      awaitingStateSnapshot: false,
      bindWatchdog: null,
      serverFeatures: [],
      serverWelcomeReceived: false,
      pendingPrefs: new Map(),
    };
  }

  const telegramLane = createNeutralLane(telegramConfig);
  /** 全部 provider-neutral 线; 遍历顺序即启动 / hello 重发顺序。 */
  const lanes: readonly NeutralProviderLane[] = [telegramLane];
  // key 收窄到 NeutralHookProvider: 'slack' 走 legacy 线, 在编译期就挡在本表外
  const laneByProvider = new Map<NeutralHookProvider, NeutralProviderLane>(
    lanes.map((lane) => [lane.config.provider, lane]),
  );
  /**
   * 协议全集的 provider → 客户端实际跑着的那条 lane。两类值在这里都归为 null,
   * 调用方按「没有这条线」处理:
   *   - 'slack': 走 legacy 专属帧, 本就不进本表;
   *   - 协议按 append-only 先行加入、客户端尚未实现的 provider(当前是 'x',
   *     见 makecindy/cindy#691) —— 没有 lane config, 也没有设置页入口。
   * 直接用 laneByProvider.get() 会因 key 已收窄而在这类入口处编译不过, 那正是
   * 本函数要收的边界: 收窄发生一次, 而不是在每个调用点各写一遍断言。
   */
  function neutralLaneFor(provider: HookProvider): NeutralProviderLane | null {
    return lanes.find((lane) => lane.config.provider === provider) ?? null;
  }
  /**
   * (multi-team)自动首绑的延迟触发器: 空 bind.state + autoBindIntent 时不能
   * 立即发 bind.start —— server 的 hello 同步可能紧跟一帧 pending 回放(旧
   * 授权仍在途), 先到的回放会走「pending + 意图 → 重新发起」的既有路径签新
   * 链接; 只有短窗内没有任何 bind.update 到达才由本计时器发起首绑。
   */
  let autoBindDefer: NodeJS.Timeout | null = null;
  /**
   * 用户点「连接 Slack」发起 OIDC 后的一次性置位: 下一帧 bind.update(pending,
   * authorizeUrl)到达时打开系统浏览器一次即清 —— 重连时的 pending 状态回放
   * 不会重复弹浏览器(否则每次重连都弹一个 Slack 授权页)。
   */
  let openAuthorizeOnNextPending = false;
  /**
   * 一次性意图: 用户刚打开 toggle(armAutoBind), 连上后 server 按 hello 推回
   * 绑定现状 —— 若为 none(未绑定)则自动发起 OIDC 绑定(弹浏览器), 若已 confirmed
   * 则啥都不做(秒恢复不重弹)。在收到 bind.update 时判定, 避开 onConnected 时
   * 绑定态还没从 server 回来的竞态; 判定后即清, 不会每次重连都弹。
   */
  let autoBindIntent = false;
  /**
   * 授权看门狗: initiateBind 后计时, 到点仍停在 pending(用户关掉了浏览器 /
   * 放着没动)则本地判过期并自动关 toggle。bind.update 到达任何非 pending
   * 状态、或连接停止时清除。
   */
  let bindWatchdog: NodeJS.Timeout | null = null;
  /**
   * 安装看门狗: 授权检出 workspace 未装 App(failed + not-installed)后保持
   * 连接等 server 装完自动补完绑定的 confirmed 推送; 到点没等到则弹回 toggle。
   */
  let installWatchdog: NodeJS.Timeout | null = null;
  /** 在途的 prefs 往返(requestId -> 挂起 promise; prefs.state.replyTo 配对)。 */
  const pendingPrefs = new Map<
    string,
    { resolve: (v: HookPrefsView) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  /** 在途的 Slack 工具往返(requestId -> resolve; tool.response.replyTo 配对)。 */
  const pendingTools = new Map<
    string,
    { resolve: (v: HookSlackToolResult) => void; timer: NodeJS.Timeout }
  >();
  /**
   * 最近一次成功 welcome 宣告的 server 能力集。瞬时断线不清空，避免 Codex MCP
   * 清单随网络抖动反复重建；重连后的新 welcome 会整组覆盖并触发 gate 复算。
   */
  let serverFeatures: string[] = [];
  /** Distinguish a negotiated old Slack server with features=[] from no welcome yet. */
  let serverWelcomeReceived = false;
  /** cindy_slack provider 的构建期 gate 当前值；初始未绑定 = false。 */
  let slackToolProviderEnabled = false;
  let disposed = false;
  /** Account ingress is synchronously closed before the old account DB is released. */
  let accountActive = accountInitiallyActive ?? true;
  let accountGeneration = 0;
  /** Account-bound async reads (notably recent sessions) must drain before DB teardown. */
  const pendingAccountOps = new Set<Promise<void>>();
  /** Coalesce auth-listener and teardown requests onto the same DB-safe drain. */
  let accountDeactivation: Promise<void> | null = null;

  function trackAccountOp(operation: Promise<void>): void {
    const settled = operation.catch((err: unknown) => {
      log.warn(
        `account-bound hook operation failed (${err instanceof Error ? err.name : 'unknown'})`,
      );
    });
    pendingAccountOps.add(settled);
    void settled.finally(() => pendingAccountOps.delete(settled));
  }

  /** server 是否宣告 multi-team 能力(最近一次成功 welcome 快照)。 */
  function serverMultiTeam(): boolean {
    return serverFeatures.includes(HOOK_FEATURE_MULTI_TEAM);
  }

  /** 本线 server 是否已宣告全部必需能力(最近一次成功 welcome 快照)。 */
  function laneCapabilityReady(lane: NeutralProviderLane): boolean {
    return lane.config.requiredFeatures.every((f) => lane.serverFeatures.includes(f));
  }

  function lifecycleAnnouncementEnabled(): boolean {
    return store.get().lifecycleAnnouncementOverride ?? DEFAULT_SLACK_LIFECYCLE_ANNOUNCEMENT;
  }

  function dispatchId(provider: HookProvider): string {
    const account = getAccountFingerprint?.() ?? 'no-account';
    return `${id}:${account}:${provider}`;
  }

  function activateCurrentAccount(): void {
    if (accountActive || disposed) return;
    accountActive = true;
    // 群窗口 TTL 兜底清扫: 流量路径的清扫只在有群消息/派发时触发, 这里保证
    // 群不再活跃(或通道停用)后过期行也在每次账号激活时清掉。纳入
    // pendingAccountOps: 登出/切号等待清扫落库完成再销毁 DB client。
    trackAccountOp(sweepGroupWindowExpired());
    dispatcher?.activateAccount();
    multiBindings = store.get().bindingsCache.map((entry) => ({ ...entry, displaced: false }));
    for (const lane of lanes) lane.binding = lane.config.restoreCachedBinding();
    startEnabledProviders();
    notifyStatus(toView());
  }

  /** multi-team 视图是否生效: server 宣告能力, 或本地缓存里有多绑定行(冷启动/
   *  断线期间 serverFeatures 尚空, 但上一次会话已是多绑定世界)。 */
  function multiTeamKnown(): boolean {
    return serverMultiTeam() || multiBindings.length > 0;
  }

  /** (multi-team)当前可用(未 displaced)的绑定行。 */
  function activeBindings(): HookTeamBindingView[] {
    return multiBindings.filter((b) => !b.displaced);
  }

  /** 只在 provider 构建期 gate 真翻转时通知 host 失效 Codex MCP 缓存。 */
  function notifySlackToolProviderEnabledIfChanged(): void {
    // multi-team: 至少一条可用绑定 + 总开关打开(关开关不再 revoke, 绑定保留
    // 在本地/服务端, 必须用 enabled 把工具面关掉); 老 server: 关开关会把
    // binding 置 none, confirmed 判据自足, enabled 条件恒真不改变行为。
    const bound = multiTeamKnown()
      ? activeBindings().length > 0 && store.get().enabled
      : binding?.state === 'confirmed';
    const next = bound && serverFeatures.includes(HOOK_FEATURE_SLACK_TOOLS);
    if (next === slackToolProviderEnabled) return;
    slackToolProviderEnabled = next;
    onSlackToolProviderEnabledChanged?.(next);
  }

  /** 断线/重建时在途 prefs 请求快速失败(不让 IPC invoke 挂满超时)。 */
  function drainPendingPrefs(): void {
    for (const [, pending] of pendingPrefs) {
      clearTimeout(pending.timer);
      pending.reject(new HookNotConnectedError('slack'));
    }
    pendingPrefs.clear();
  }

  /** 单线断线只 fail 本线的 provider prefs 请求, 不波及 Slack 或其它线。 */
  function drainLanePendingPrefs(lane: NeutralProviderLane): void {
    for (const [, pending] of lane.pendingPrefs) {
      clearTimeout(pending.timer);
      pending.reject(new HookNotConnectedError(lane.config.provider));
    }
    lane.pendingPrefs.clear();
  }

  /** 断线/重建时在途工具请求快速失败(resolve 结构化错误, 语义与 prefs 对齐)。 */
  function drainPendingTools(): void {
    for (const [, pending] of pendingTools) {
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        error: { code: 'HOOK_NOT_CONNECTED', message: 'Slack 连接已断开, 请稍后重试' },
      });
    }
    pendingTools.clear();
  }

  /** 发起一次 prefs 往返(get/set 共用): 连接就绪 -> 发帧 -> 等 replyTo 配对。 */
  function sendPrefsRequest(build: (requestId: string) => HookMessage): Promise<HookPrefsView> {
    const t = transport;
    if (t === null || status !== 'connected') {
      return Promise.reject(new HookNotConnectedError('slack'));
    }
    const requestId = randomUUID();
    const frame = build(requestId);
    return new Promise<HookPrefsView>((resolve, reject) => {
      if (!t.send(frame)) {
        reject(new HookNotConnectedError('slack'));
        return;
      }
      const timer = setTimeout(() => {
        pendingPrefs.delete(requestId);
        reject(new HookPrefsTimeoutError());
      }, prefsTimeoutMs ?? DEFAULT_PREFS_TIMEOUT_MS);
      timer.unref?.();
      pendingPrefs.set(requestId, { resolve, reject, timer });
    });
  }

  function sendLanePrefsRequest(
    lane: NeutralProviderLane,
    build: (requestId: string, bindingId: string) => HookMessage,
  ): Promise<ProviderPrefsView> {
    const t = lane.transport;
    const bindingId = lane.binding?.state === 'confirmed' ? lane.binding.bindingId : null;
    if (
      t === null ||
      lane.status !== 'connected' ||
      !laneCapabilityReady(lane) ||
      !lane.config.isEnabled() ||
      bindingId === null
    ) {
      return Promise.reject(new HookNotConnectedError(lane.config.provider));
    }
    const requestId = randomUUID();
    return new Promise<ProviderPrefsView>((resolve, reject) => {
      if (!t.send(build(requestId, bindingId))) {
        reject(new HookNotConnectedError(lane.config.provider));
        return;
      }
      const timer = setTimeout(() => {
        lane.pendingPrefs.delete(requestId);
        reject(new HookPrefsTimeoutError());
      }, prefsTimeoutMs ?? DEFAULT_PREFS_TIMEOUT_MS);
      timer.unref?.();
      lane.pendingPrefs.set(requestId, { bindingId, resolve, reject, timer });
    });
  }

  /**
   * multi-team 模式下映射给老消费点的 legacy 单绑定视图: 在途授权优先
   * (pending/denied/expired/failed 原样透传), 否则首个可用绑定映射成
   * confirmed, 都没有则 none —— 让只认 binding 字段的读取方拿到语义上
   * 最接近的单值快照。
   */
  function legacyBindingView(): HookBindingView | null {
    if (pendingBind !== null) {
      return {
        state: pendingBind.state,
        slackUserId: null,
        slackUserName: null,
        message: pendingBind.message,
        authorizeUrl: pendingBind.authorizeUrl,
        reason: pendingBind.reason,
        installUrl: pendingBind.installUrl,
        teamName: null,
      };
    }
    const first = activeBindings()[0];
    if (first !== undefined) {
      return {
        state: 'confirmed',
        slackUserId: first.slackUserId,
        slackUserName: first.slackUserName,
        message: null,
        authorizeUrl: null,
        reason: null,
        installUrl: null,
        teamName: first.teamName,
      };
    }
    return {
      state: 'none',
      slackUserId: null,
      slackUserName: null,
      message: null,
      authorizeUrl: null,
      reason: null,
      installUrl: null,
      teamName: null,
    };
  }

  /** 本线的 IPC 视图切片(形状与历史 SlackHookView.telegram 字段完全一致)。 */
  function laneView(lane: NeutralProviderLane): SlackHookView['telegram'] {
    const enabled = lane.config.isEnabled();
    const url = lane.config.getUrl().trim();
    return {
      enabled,
      url,
      status: enabled && url.length === 0 ? 'error' : toViewStatus(lane.status, enabled),
      lastError:
        enabled && url.length === 0
          ? lane.config.notConfiguredError
          : enabled
            ? lane.lastError
            : null,
      available: laneCapabilityReady(lane),
      capabilityPending: enabled && url.length > 0 && !lane.serverWelcomeReceived,
      binding:
        lane.binding === null ? null : { ...lane.binding, actions: [...lane.binding.actions] },
    };
  }

  function toView(): SlackHookView {
    const config = store.get();
    return {
      enabled: config.enabled,
      lifecycleAnnouncement:
        config.lifecycleAnnouncementOverride ?? DEFAULT_SLACK_LIFECYCLE_ANNOUNCEMENT,
      url: store.effectiveUrl(),
      workspaces: { ...config.workspaces },
      status: toViewStatus(status, config.enabled),
      lastError: config.enabled ? lastError : null,
      binding: multiTeamKnown() ? legacyBindingView() : binding,
      bindings: multiBindings.map((b) => ({ ...b })),
      pendingBind: pendingBind !== null ? { ...pendingBind } : null,
      serverMultiTeam: serverMultiTeam(),
      telegram: laneView(telegramLane),
    };
  }

  /** (multi-team)把当前绑定列表(含 displaced 行的 team 信息)写回本地缓存。 */
  function persistBindingsCache(): void {
    try {
      store.setBindingsCache(
        multiBindings.map((b) => ({
          teamId: b.teamId,
          teamName: b.teamName,
          slackUserId: b.slackUserId,
          slackUserName: b.slackUserName,
        })),
      );
    } catch (err) {
      // 缓存是体验增强(冷启动显示/diff), 写失败不影响运行时状态
      log.warn(
        `persist bindings cache failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * bind.start 发出后的乐观置位: server 的 bind.update(pending)要一个网络
   * 往返才回来, 期间绑定态若停在 none 渲染层会闪回未绑定 UI; 这里先置
   * pending(authorizeUrl 暂空, 等 server 真值), 后续 bind.update 覆盖。
   */
  function markBindingPending(): void {
    binding = {
      state: 'pending',
      slackUserId: binding?.slackUserId ?? null,
      slackUserName: binding?.slackUserName ?? null,
      message: null,
      authorizeUrl: null,
      reason: null,
      installUrl: null,
      teamName: binding?.teamName ?? null,
    };
  }

  function clearBindWatchdog(): void {
    if (bindWatchdog !== null) {
      clearTimeout(bindWatchdog);
      bindWatchdog = null;
    }
  }

  function clearInstallWatchdog(): void {
    if (installWatchdog !== null) {
      clearTimeout(installWatchdog);
      installWatchdog = null;
    }
  }

  function clearLaneBindWatchdog(lane: NeutralProviderLane): void {
    if (lane.bindWatchdog !== null) {
      clearTimeout(lane.bindWatchdog);
      lane.bindWatchdog = null;
    }
  }

  function armLaneBindWatchdog(lane: NeutralProviderLane, expiresAt: number): void {
    clearLaneBindWatchdog(lane);
    const delay = Math.min(DEFAULT_PROVIDER_BIND_TIMEOUT_MS, Math.max(0, expiresAt - Date.now()));
    lane.bindWatchdog = setTimeout(() => {
      lane.bindWatchdog = null;
      if (lane.binding?.state !== 'pending' && lane.binding?.state !== 'awaiting_confirmation') {
        return;
      }
      lane.binding = {
        ...lane.binding,
        state: 'expired',
        connectUrl: null,
        expiresAt: null,
        reason: 'expired',
        actions: ['retry'],
      };
      notifyStatus(toView());
    }, delay);
    lane.bindWatchdog.unref?.();
  }

  /**
   * provider 取本地 lane config 而不是 payload: 调用方已用
   * `payload.provider !== lane.config.provider` 丢过走错线的帧, 两者必然相等,
   * 而 lane config 是接线期定死的可信值 —— renderer 可见快照里的渠道标识不从
   * 网线上的值取。
   */
  function providerBindingView(
    provider: NeutralHookProvider,
    payload: ProviderBindStatusPayload,
  ): ProviderBindingView {
    return {
      provider,
      state: payload.state,
      attemptId: payload.attemptId,
      bindingId: payload.bindingId,
      principalId: payload.principalId,
      principalName: payload.principalName,
      scopeId: payload.scopeId,
      scopeName: payload.scopeName,
      connectUrl: payload.connectUrl,
      expiresAt: payload.expiresAt,
      reason: payload.reason,
      remediationUrl: payload.remediationUrl,
      actions: [...payload.actions],
    };
  }

  function persistLaneBinding(lane: NeutralProviderLane, view: ProviderBindingView): void {
    try {
      if (
        view.state === 'confirmed' &&
        view.bindingId &&
        view.principalId &&
        view.scopeId &&
        view.scopeName
      ) {
        lane.config.writeBindingCache({
          bindingId: view.bindingId,
          principalId: view.principalId,
          principalName: view.principalName,
          scopeId: view.scopeId,
          scopeName: view.scopeName,
        });
      } else if (view.state === 'revoked' || view.state === 'none' || view.state === 'superseded') {
        lane.config.writeBindingCache(null);
      }
    } catch (err) {
      // The server owns binding truth; a read-only/full local disk may reduce
      // restart convenience but must not suppress the live confirmed state.
      log.warn(
        `persist ${lane.config.label} binding cache failed (${err instanceof Error ? err.name : 'unknown'})`,
      );
    }
  }

  function isProviderAttemptState(state: ProviderBindStatusPayload['state']): boolean {
    return (
      state === 'pending' ||
      state === 'awaiting_confirmation' ||
      state === 'denied' ||
      state === 'expired' ||
      state === 'failed'
    );
  }

  /**
   * Bind replies are not globally ordered with the provider's own callbacks
   * (for example a user completing the bind inside the provider app). Keep the
   * local state monotonic by accepting only the newest request reply and only
   * events that name the current attempt/binding. The first state snapshot
   * after a welcome is the sole exception: it is authoritative and may clear
   * an offline persisted cache, unless a newer local mutation already began.
   */
  function shouldApplyProviderBindStatus(
    lane: NeutralProviderLane,
    payload: ProviderBindStatusPayload,
    isStateSnapshot: boolean,
  ): boolean {
    if (payload.replyTo !== null) {
      const request = lane.bindRequest;
      if (request === null || request.requestId !== payload.replyTo) {
        log.warn(`stale ${lane.config.label} bind reply dropped`);
        return false;
      }
      // One request has one reply. Clear before validating its identity so a
      // malformed response cannot keep blocking later unsolicited truth.
      lane.bindRequest = null;
      if (request.kind === 'start') {
        return payload.state !== 'revoked' && payload.state !== 'superseded';
      }
      if (request.kind === 'cancel') {
        const ownsCurrentAttempt = lane.binding?.attemptId === request.attemptId;
        if (payload.state === 'confirmed') return ownsCurrentAttempt;
        return ownsCurrentAttempt && payload.attemptId === request.attemptId;
      }
      // A failed revoke must not replace the durable confirmed binding with an
      // attempt-shaped error. The server can retry/reconcile from its snapshot.
      if (isProviderAttemptState(payload.state)) {
        log.warn(`${lane.config.label} revoke failure kept the confirmed binding`);
        return false;
      }
      return (
        lane.binding?.bindingId === request.bindingId && payload.bindingId === request.bindingId
      );
    }

    if (isStateSnapshot && lane.awaitingStateSnapshot) {
      lane.awaitingStateSnapshot = false;
      lane.bindRequest = null;
      return true;
    }

    const current = lane.binding;
    if (current === null) {
      return (
        payload.state === 'none' ||
        payload.state === 'pending' ||
        payload.state === 'awaiting_confirmation' ||
        payload.state === 'confirmed'
      );
    }
    if (payload.state === 'none') {
      return (
        current.state === 'none' ||
        current.state === 'denied' ||
        current.state === 'expired' ||
        current.state === 'failed'
      );
    }
    if (isProviderAttemptState(payload.state)) {
      if (lane.bindRequest?.kind === 'cancel') return false;
      return payload.attemptId !== null && current.attemptId === payload.attemptId;
    }
    if (payload.state === 'confirmed') {
      if (current.state === 'confirmed') return current.bindingId === payload.bindingId;
      // A confirmation that wins a cancel race is durable server truth. A
      // start still waiting for its direct pending reply has no attempt id and
      // deliberately rejects confirmations from an older attempt.
      return current.state === 'none' || current.attemptId !== null;
    }
    if (payload.state === 'revoked' || payload.state === 'superseded') {
      return current.bindingId !== null && current.bindingId === payload.bindingId;
    }
    return false;
  }

  function initiateProviderBind(lane: NeutralProviderLane): boolean {
    if (
      lane.transport === null ||
      lane.status !== 'connected' ||
      !laneCapabilityReady(lane) ||
      !lane.config.isEnabled()
    ) {
      return false;
    }
    // Pending/awaiting flows deliberately allow an explicit retry so a stale
    // one-time link can be superseded. A durable confirmed binding must never
    // be replaced by a duplicate/stale renderer invocation.
    if (lane.binding?.state === 'confirmed') return false;
    const requestId = randomUUID();
    if (
      !lane.transport.send(makeProviderBindStart({ requestId, provider: lane.config.provider }))
    ) {
      return false;
    }
    lane.awaitingStateSnapshot = false;
    lane.bindRequest = { kind: 'start', requestId };
    lane.openRequestId = requestId;
    lane.binding = {
      provider: lane.config.provider,
      state: 'pending',
      attemptId: null,
      bindingId: null,
      principalId: null,
      principalName: null,
      scopeId: null,
      scopeName: null,
      connectUrl: null,
      expiresAt: null,
      reason: null,
      remediationUrl: null,
      actions: [],
    };
    notifyStatus(toView());
    return true;
  }

  function handleProviderBindStatus(
    lane: NeutralProviderLane,
    payload: ProviderBindStatusPayload,
    isStateSnapshot: boolean,
  ): void {
    const { label } = lane.config;
    // 两种丢帧原因分开记日志: 走错线(多 lane 下另一类问题)≠ 能力协商未完成
    if (payload.provider !== lane.config.provider) {
      log.warn(`provider bind state for ${payload.provider} dropped on ${label} lane`);
      return;
    }
    if (!laneCapabilityReady(lane)) {
      log.warn(`provider bind state dropped before ${label} capability negotiation`);
      return;
    }
    if (!shouldApplyProviderBindStatus(lane, payload, isStateSnapshot)) {
      if (payload.replyTo !== null && payload.replyTo === lane.openRequestId) {
        lane.openRequestId = null;
      }
      return;
    }
    let acceptedPayload = payload;
    if (payload.state === 'pending') {
      try {
        acceptedPayload = lane.config.normalizePendingPayload(payload);
      } catch {
        // The renderer can copy a bind link without crossing shell.openExternal,
        // so validate the server value before it enters any renderer-visible
        // snapshot. Keep the token and rejected URL out of logs.
        lane.openRequestId = null;
        lane.autoBindIntent = false;
        clearLaneBindWatchdog(lane);
        lane.binding = {
          provider: lane.config.provider,
          state: 'failed',
          attemptId: payload.attemptId,
          bindingId: null,
          principalId: null,
          principalName: null,
          scopeId: payload.scopeId,
          scopeName: payload.scopeName,
          connectUrl: null,
          expiresAt: null,
          reason: 'invalid-connect-url',
          remediationUrl: null,
          actions: ['retry'],
        };
        log.warn(`invalid ${label} binding URL dropped`);
        notifyStatus(toView());
        return;
      }
    }
    // An update accepted after welcome is newer than the still-in-flight
    // initial snapshot; do not let that older snapshot roll it back.
    if (!isStateSnapshot) lane.awaitingStateSnapshot = false;
    const previousBindingId = lane.binding?.state === 'confirmed' ? lane.binding.bindingId : null;
    const view = providerBindingView(lane.config.provider, acceptedPayload);
    lane.binding = view;
    const currentBindingId = view.state === 'confirmed' ? view.bindingId : null;
    if (previousBindingId !== null && previousBindingId !== currentBindingId) {
      // Binding identity is the prefs isolation key. Fail every old request
      // immediately instead of leaving the editor pending until a stale reply
      // or the generic timeout happens to arrive.
      drainLanePendingPrefs(lane);
    }
    persistLaneBinding(lane, view);
    if (
      (view.state === 'pending' || view.state === 'awaiting_confirmation') &&
      view.expiresAt !== null
    ) {
      armLaneBindWatchdog(lane, view.expiresAt);
    } else {
      clearLaneBindWatchdog(lane);
    }
    if (
      lane.openRequestId !== null &&
      acceptedPayload.replyTo === lane.openRequestId &&
      view.state === 'pending' &&
      view.connectUrl &&
      view.actions.includes('open_connect_url')
    ) {
      lane.openRequestId = null;
      // Auto-open is best-effort. The link remains in the view so
      // remote-control users can copy it when the local shell rejects.
      void Promise.resolve()
        .then(() => lane.config.openUrl?.(view.connectUrl!))
        .catch((err: unknown) => {
          log.warn(
            `open ${label} binding URL failed (${err instanceof Error ? err.name : 'unknown'})`,
          );
        });
    }
    if (view.state !== 'pending' && view.state !== 'none') lane.openRequestId = null;
    if (
      view.state === 'confirmed' ||
      view.state === 'revoked' ||
      view.state === 'superseded' ||
      view.state === 'none'
    ) {
      lane.bindRequest = null;
    }
    if (
      lane.autoBindIntent &&
      view.state === 'none' &&
      lane.config.isEnabled() &&
      initiateProviderBind(lane)
    ) {
      lane.autoBindIntent = false;
      return;
    }
    lane.autoBindIntent = false;
    notifyStatus(toView());
  }

  /**
   * 起安装看门狗: "等安装"期到点仍未收到 confirmed(用户没装 / 装到了别的
   * workspace / 放弃)则弹回 toggle 并断开; binding 保留 not-installed 供 UI
   * 显示原因与重试提示。
   */
  function armInstallWatchdog(): void {
    clearInstallWatchdog();
    installWatchdog = setTimeout(() => {
      installWatchdog = null;
      if (!store.get().enabled) return;
      if (multiTeamKnown()) {
        // multi-team: "等安装"挂在 pendingBind 上。已有可用绑定时只作废这次
        // 添加尝试(连接与其它绑定不受影响); 首绑(0 可用绑定)保持老语义弹回。
        if (
          pendingBind?.state !== 'failed' ||
          pendingBind.reason !== HOOK_BIND_REASON_NOT_INSTALLED
        ) {
          return;
        }
        autoBindIntent = false;
        openAuthorizeOnNextPending = false;
        if (activeBindings().length > 0) {
          if (transport !== null && status === 'connected') {
            transport.send(makeBindRevoke({ pendingOnly: true }));
          }
          pendingBind = null;
          notifyStatus(toView());
          log.info('multi-team add-binding install wait timed out, pending cleared');
        } else {
          store.setEnabled(false);
          stopSlack();
          notifyStatus(toView());
          log.info('slack hook auto-disabled: app install not completed in time (multi-team)');
        }
        return;
      }
      if (binding?.state !== 'failed' || binding.reason !== HOOK_BIND_REASON_NOT_INSTALLED) return;
      autoBindIntent = false;
      openAuthorizeOnNextPending = false;
      store.setEnabled(false);
      stopSlack();
      notifyStatus(toView());
      log.info('slack hook auto-disabled: app install not completed in time');
    }, installWaitTimeoutMs ?? DEFAULT_INSTALL_WAIT_TIMEOUT_MS);
    installWatchdog.unref?.();
  }

  /**
   * 起授权看门狗: 到点仍 pending 则视为用户放弃(关掉浏览器/没操作), 本地判
   * expired 并走与 server 推终止态相同的自动下线路径(toggle 弹回 + 断开)。
   */
  function armBindWatchdog(): void {
    clearBindWatchdog();
    bindWatchdog = setTimeout(() => {
      bindWatchdog = null;
      if (!store.get().enabled) return;
      if (multiTeamKnown()) {
        if (pendingBind?.state !== 'pending') return;
        autoBindIntent = false;
        openAuthorizeOnNextPending = false;
        if (activeBindings().length > 0) {
          // 已有可用绑定: 只作废这次"添加/重绑"授权(server 侧登记顺手作废),
          // 总开关与既有绑定不受影响
          if (transport !== null && status === 'connected') {
            transport.send(makeBindRevoke({ pendingOnly: true }));
          }
          pendingBind = null;
          notifyStatus(toView());
          log.info('multi-team add-binding authorize timed out, pending cleared');
        } else {
          // 首绑超时: 与单绑定同语义 —— 本地判 expired, toggle 弹回
          pendingBind = { ...pendingBind, state: 'expired', authorizeUrl: null };
          store.setEnabled(false);
          stopSlack();
          notifyStatus(toView());
          log.info('slack hook auto-disabled: first authorize timed out (multi-team)');
        }
        return;
      }
      if (binding?.state !== 'pending') return;
      autoBindIntent = false;
      openAuthorizeOnNextPending = false;
      binding = {
        state: 'expired',
        slackUserId: null,
        slackUserName: null,
        message: null,
        authorizeUrl: null,
        reason: null,
        installUrl: null,
        teamName: null,
      };
      store.setEnabled(false);
      stopSlack();
      notifyStatus(toView());
      log.info('slack hook auto-disabled: authorize timed out (browser closed or idle)');
    }, bindPendingTimeoutMs ?? DEFAULT_BIND_PENDING_TIMEOUT_MS);
    bindWatchdog.unref?.();
  }

  /**
   * 发起 SIWS OIDC 绑定(发空 bind.start; server 回 pending+authorizeUrl 时
   * 由 openAuthorizeOnNextPending 弹一次浏览器)。手动「连接 Slack」与"开关即
   * 绑定"的自动路径共用。返回 false = 连接不在线, 发不出。
   */
  function initiateBind(): boolean {
    if (transport === null || status !== 'connected') return false;
    if (!transport.send(makeBindStart({}))) return false;
    openAuthorizeOnNextPending = true;
    if (multiTeamKnown()) {
      // multi-team: 在途授权落 pendingBind(乐观置位, 语义同 markBindingPending)
      pendingBind = {
        state: 'pending',
        message: null,
        authorizeUrl: null,
        reason: null,
        installUrl: null,
        teamId: null,
      };
    } else {
      markBindingPending();
    }
    armBindWatchdog();
    notifyStatus(toView());
    return true;
  }

  /**
   * (multi-team)发起添加/重绑授权: bind.start 带可选 teamId(重绑时 pin
   * 授权页), 乐观置 pendingBind 并臂授权看门狗。false = 发不出(未连接)。
   */
  function initiateMultiBind(teamId: string | null): boolean {
    if (transport === null || status !== 'connected') return false;
    if (!transport.send(makeBindStart(teamId !== null ? { teamId } : {}))) return false;
    openAuthorizeOnNextPending = true;
    pendingBind = {
      state: 'pending',
      message: null,
      authorizeUrl: null,
      reason: null,
      installUrl: null,
      teamId,
    };
    armBindWatchdog();
    notifyStatus(toView());
    return true;
  }

  function clearAutoBindDefer(): void {
    if (autoBindDefer !== null) {
      clearTimeout(autoBindDefer);
      autoBindDefer = null;
    }
  }

  /** Slack legacy 线的 hello 能力声明(provider-neutral 线各自在 config.helloFeatures)。 */
  const SLACK_HELLO_FEATURES: readonly string[] = [
    HOOK_FEATURE_MULTI_TEAM,
    HOOK_FEATURE_SESSION_PICKER,
  ];

  function buildHello(
    features: readonly string[],
    includeLifecycleAnnouncement = false,
  ): HelloInput {
    // 每次连接成功都重读配置 —— 别名映射变更后重连即生效
    const device = deviceInfo();
    return {
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      // 内置「对话」伪目录恒在清单第一位(与真实目录同级; Set 去重防存量撞名)
      workspaces: [...new Set([HOOK_CHAT_WORKSPACE_ALIAS, ...Object.keys(store.get().workspaces)])],
      agents,
      // 每条连接只声明其服务会实际使用的能力，避免把 provider-neutral wire 误投
      // 到 Slack 服务，也保持老 Slack hello 的兼容面最小。
      features: [...features],
      ...(includeLifecycleAnnouncement
        ? { lifecycleAnnouncement: lifecycleAnnouncementEnabled() }
        : {}),
    };
  }

  /**
   * (multi-team)bind.update 处理: 事件帧只做行级更新与在途授权状态维护,
   * 列表权威以 bind.state 快照为准(server 在任何绑定变化后都会补推快照)。
   * 与老路径的关键差异: confirmed/revoked 按 teamId 定位行; none 只清在途
   * 授权不清列表; 终止态只在「首绑(0 可用绑定)」时才弹回 toggle。
   */
  function handleMultiBindUpdate(payload: BindUpdatePayload): void {
    const state = payload.state;
    if (state === 'confirmed') {
      // 添加/重绑成功: 行级 upsert + 在途授权收口(看门狗/意图/弹窗置位全清)
      const pendingBefore = pendingBind;
      clearBindWatchdog();
      clearInstallWatchdog();
      clearAutoBindDefer();
      autoBindIntent = false;
      openAuthorizeOnNextPending = false;
      pendingBind = null;
      const teamId = payload.teamId ?? null;
      if (teamId !== null && payload.slackUserId !== null) {
        const row: HookTeamBindingView = {
          teamId,
          teamName: payload.teamName ?? null,
          slackUserId: payload.slackUserId,
          slackUserName: payload.slackUserName,
          displaced: false,
        };
        const idx = multiBindings.findIndex((b) => b.teamId === teamId);
        // 「添加 workspace」流落在已绑定的活跃 team 上: Slack 授权页右上角的
        // workspace 下拉默认停在当前登录的 workspace, 用户没切换就点了允许 ——
        // 结果只是刷新原绑定, 列表不变。若不提示, 用户看到的是"点了添加却毫无
        // 反应"(实测踩坑)。以本地终止态 already-bound 呈现指引; 指定 team 的
        // 重绑(pendingBefore.teamId === teamId)与 displaced 行的复活不提示。
        if (
          idx >= 0 &&
          !multiBindings[idx].displaced &&
          pendingBefore !== null &&
          pendingBefore.teamId !== teamId
        ) {
          pendingBind = {
            state: 'failed',
            message: null,
            authorizeUrl: null,
            reason: HOOK_BIND_REASON_ALREADY_BOUND,
            installUrl: null,
            teamId,
          };
        }
        if (idx >= 0) multiBindings[idx] = row;
        else multiBindings.push(row);
        persistBindingsCache();
      }
      // teamId 缺失属异常(multi server 恒下发): 不猜行, 等随后的 bind.state 对齐
      notifySlackToolProviderEnabledIfChanged();
      notifyStatus(toView());
      return;
    }
    if (state === 'revoked') {
      const teamId = payload.teamId ?? null;
      if (teamId !== null) {
        const idx = multiBindings.findIndex((b) => b.teamId === teamId);
        if (idx >= 0) {
          if ((payload.reason ?? null) === HOOK_BIND_REASON_SUPERSEDED) {
            // 被另一台设备顶掉: 行保留标注 displaced, 用户可重新绑定或删除
            multiBindings[idx] = { ...multiBindings[idx], displaced: true };
          } else {
            multiBindings.splice(idx, 1);
          }
          persistBindingsCache();
        }
      } else {
        // 无 teamId 的全量解除(异常/服务端清理): 清列表, 等 bind.state 对齐
        multiBindings = [];
        persistBindingsCache();
      }
      notifySlackToolProviderEnabledIfChanged();
      notifyStatus(toView());
      return;
    }
    if (state === 'none') {
      // 只影响在途授权(server 侧已无进行中流程); 列表只信 bind.state/confirmed/revoked
      clearBindWatchdog();
      clearInstallWatchdog();
      pendingBind = null;
      if (autoBindIntent) {
        clearAutoBindDefer();
        if (initiateMultiBind(null)) {
          autoBindIntent = false;
          return;
        }
        log.info('multi-team bind.start send failed mid-frame, keeping auto-bind intent');
      }
      notifyStatus(toView());
      return;
    }
    // pending / denied / expired / failed → 在途授权状态
    const authorizeUrl = payload.authorizeUrl ?? null;
    pendingBind = {
      state,
      message: payload.message,
      authorizeUrl,
      reason: payload.reason ?? null,
      installUrl: payload.installUrl ?? null,
      // 授权流早期 server 不带 teamId(用户尚未选 workspace), 保留本地发起时
      // 记下的目标 team(重绑场景)供 UI 定位
      teamId: payload.teamId ?? pendingBind?.teamId ?? null,
    };
    // 授权/安装看门狗跟随真实状态(语义同老路径, 见各 arm 函数注释)
    if (state !== 'pending') clearBindWatchdog();
    else if (bindWatchdog === null) armBindWatchdog();
    const awaitingInstall =
      state === 'failed' && (payload.reason ?? null) === HOOK_BIND_REASON_NOT_INSTALLED;
    if (awaitingInstall && store.get().enabled) {
      if (installWatchdog === null) armInstallWatchdog();
    } else {
      clearInstallWatchdog();
    }
    // 刚开 toggle 撞上 server 回放的旧 pending: 重新发起换新链接(老路径同语义;
    // 同时取消 bind.state 分支排下的延迟首绑, 避免双发)
    if (state === 'pending' && autoBindIntent) {
      clearAutoBindDefer();
      if (initiateMultiBind(null)) {
        autoBindIntent = false;
        return;
      }
      log.info('multi-team bind.start send failed mid-frame, keeping auto-bind intent');
      notifyStatus(toView());
      return;
    }
    // 用户刚发起添加/重绑 → 首帧 pending 带授权链接时打开系统浏览器一次
    if (state === 'pending' && authorizeUrl !== null && openAuthorizeOnNextPending) {
      openAuthorizeOnNextPending = false;
      try {
        openExternalUrl?.(authorizeUrl);
      } catch (err) {
        log.warn(`openExternal(authorizeUrl) failed: ${String(err)}`);
      }
    }
    // 终止态: 首绑(0 可用绑定)保持老语义弹回 toggle; 已有绑定时只把终止态留
    // 在 pendingBind 供 UI 展示原因, 连接与既有绑定不受影响
    const terminal =
      state === 'denied' || state === 'expired' || (state === 'failed' && !awaitingInstall);
    if (terminal) {
      autoBindIntent = false;
      clearAutoBindDefer();
      if (activeBindings().length === 0 && store.get().enabled) {
        store.setEnabled(false);
        stopSlack();
        log.info(`slack hook auto-disabled on first-bind ${state} (multi-team)`);
      }
    }
    notifyStatus(toView());
  }

  /**
   * 业务帧处理(v2 帧 + 任务派发)。expectedProvider 来自物理 transport，而非
   * 不可信 payload；平台专属帧一旦走错服务立即丢弃。
   */
  function handleBusinessMessage(
    expectedProvider: HookProvider,
    msg: HookMessage,
    send: (m: HookMessage) => boolean,
  ): void {
    if (!accountActive) {
      if (msg.type === 'task.dispatch') {
        log.info(
          `task.dispatch rejected after account ingress closed: requestId=${msg.payload.requestId}`,
        );
        send(
          makeTaskAck({
            requestId: msg.payload.requestId,
            result: 'rejected',
            reason: 'disabled',
            sessionId: null,
            queuePosition: null,
          }),
        );
        return;
      }
      log.info(`hook frame dropped after account ingress closed: ${msg.type}`);
      return;
    }
    const lane = neutralLaneFor(expectedProvider);
    const neutralOnly =
      msg.type === 'provider.bind.update' ||
      msg.type === 'provider.bind.state' ||
      msg.type === 'provider.prefs.state';
    const slackOnly =
      msg.type === 'bind.state' ||
      msg.type === 'bind.update' ||
      msg.type === 'prefs.state' ||
      msg.type === 'tool.response';
    if (
      (expectedProvider === 'slack' && neutralOnly) ||
      (expectedProvider !== 'slack' && slackOnly)
    ) {
      log.warn(`${msg.type} dropped on wrong ${expectedProvider} transport`);
      return;
    }
    const transportReady =
      expectedProvider === 'slack'
        ? status === 'connected'
        : lane !== null && lane.status === 'connected' && laneCapabilityReady(lane);
    if (!transportReady) {
      // A socket before welcome, or a provider-neutral lane reaching an
      // old/partially rolled-out node, is not an authenticated business
      // channel. Fail closed before any local workspace/model/session data
      // source or dispatcher is touched, while still returning terminal
      // replies for request/ack-shaped frames so the server does not leave an
      // operation hanging.
      if (msg.type === 'query.request') {
        send(
          makeQueryResponse({
            queryId: msg.payload.queryId,
            kind: msg.payload.kind,
            ok: false,
            error: `${expectedProvider} transport handshake required`,
          }),
        );
      } else if (msg.type === 'task.dispatch') {
        send(
          makeTaskAck({
            requestId: msg.payload.requestId,
            result: 'rejected',
            reason: 'invalid',
            sessionId: null,
            queuePosition: null,
          }),
        );
      }
      log.warn(`${msg.type} dropped before ${expectedProvider} transport handshake`);
      return;
    }
    if (msg.type === 'provider.bind.update' || msg.type === 'provider.bind.state') {
      // transportReady 已保证 lane 非空(neutral 帧不会带 null lane 走到这里)
      if (lane !== null) {
        handleProviderBindStatus(lane, msg.payload, msg.type === 'provider.bind.state');
      }
      return;
    }
    if (msg.type === 'bind.state') {
      // (multi-team)绑定全量快照(权威列表): 整体替换活跃行; 本地已知(缓存/
      // 上一轮)但快照缺失的 team 保留为 displaced 行 —— 覆盖「绑定在本机
      // 离线期间被另一台设备顶掉」的冷启动场景(实时被顶走 revoked 事件)。
      const snap = msg.payload.bindings;
      const snapIds = new Set(snap.map((e) => e.teamId));
      const next: HookTeamBindingView[] = snap.map((e) => ({
        teamId: e.teamId,
        teamName: e.teamName,
        slackUserId: e.slackUserId,
        slackUserName: e.slackUserName,
        displaced: false,
      }));
      for (const row of multiBindings) {
        if (!snapIds.has(row.teamId)) next.push({ ...row, displaced: true });
      }
      multiBindings = next;
      persistBindingsCache();
      notifySlackToolProviderEnabledIfChanged();
      // 开关即绑定(首次 0 绑定): 快照为空且用户刚开 toggle → 延迟一小窗发起
      // 首绑。不立即发的原因: server 的 hello 同步可能紧跟一帧 pending 回放,
      // 先让它走「pending + 意图 → 重新发起」路径签新链接; 短窗内没有任何
      // bind.update 才由计时器发空 bind.start(见 autoBindDefer 声明注释)。
      if (autoBindIntent) {
        if (activeBindings().length > 0) {
          autoBindIntent = false; // 已有绑定, 秒恢复, 无需发起授权
        } else if (autoBindDefer === null) {
          autoBindDefer = setTimeout(() => {
            autoBindDefer = null;
            if (!autoBindIntent || !store.get().enabled) return;
            if (pendingBind !== null) return; // 回放先到, 已交给 pending 路径
            if (initiateMultiBind(null)) autoBindIntent = false;
          }, autoBindDeferMs);
          autoBindDefer.unref?.();
        }
      }
      notifyStatus(toView());
      log.info(`bind.state: ${snap.length} bindings`);
      return;
    }
    if (msg.type === 'tool.response') {
      // Slack 网关工具应答: replyTo 配对在途请求; 迟到帧(已超时清理)静默丢
      const pending = pendingTools.get(msg.payload.replyTo);
      if (pending === undefined) {
        log.warn(`tool.response for unknown requestId=${msg.payload.replyTo}, dropped (late?)`);
        return;
      }
      pendingTools.delete(msg.payload.replyTo);
      clearTimeout(pending.timer);
      if (msg.payload.ok) {
        pending.resolve({ ok: true, result: msg.payload.result });
      } else {
        // parse 层已强制 ok=false 必带非空 error, 这里只是类型收窄兜底
        const err = msg.payload.error ?? {
          code: 'INTERNAL',
          message: 'server returned no error detail',
        };
        pending.resolve({ ok: false, error: { code: err.code, message: err.message } });
      }
      return;
    }
    if (msg.type === 'prefs.state') {
      // 全量快照 latest-wins: 回执(replyTo 命中在途请求)与主动推送(/model
      // 卡写入后)都无条件广播 —— 多窗口/面板保持同步
      const view: HookPrefsView = {
        bound: msg.payload.bound,
        prefs: msg.payload.prefs.map((p) => ({ ...p })),
      };
      if (msg.payload.replyTo !== null) {
        const pending = pendingPrefs.get(msg.payload.replyTo);
        if (pending !== undefined) {
          pendingPrefs.delete(msg.payload.replyTo);
          clearTimeout(pending.timer);
          pending.resolve(view);
        }
      }
      notifyPrefs?.(view);
      return;
    }
    if (msg.type === 'provider.prefs.state') {
      // transportReady 已保证 lane 非空且能力协商完成; 这里只再校验帧的 provider
      // 归属, 两种丢帧原因分开记日志(同 handleProviderBindStatus)
      if (lane === null) {
        log.warn(`provider prefs state dropped before ${expectedProvider} transport handshake`);
        return;
      }
      if (msg.payload.provider !== lane.config.provider) {
        log.warn(
          `provider prefs state for ${msg.payload.provider} dropped on ${lane.config.label} lane`,
        );
        return;
      }
      const view: ProviderPrefsView = {
        // 同 providerBindingView: 上面已丢过走错线的帧, 渠道标识取可信的 lane config。
        provider: lane.config.provider,
        bindingId: msg.payload.bindingId,
        scopeId: msg.payload.scopeId,
        bound: msg.payload.bound,
        prefs: msg.payload.prefs.map((pref) => ({ ...pref })),
      };
      if (msg.payload.replyTo !== null) {
        const pending = lane.pendingPrefs.get(msg.payload.replyTo);
        if (pending === undefined) {
          log.warn('provider prefs state for unknown requestId, dropped (late?)');
          return;
        }
        if (msg.payload.bindingId !== pending.bindingId) {
          lane.pendingPrefs.delete(msg.payload.replyTo);
          clearTimeout(pending.timer);
          pending.reject(new HookNotConnectedError(lane.config.provider));
          log.warn('provider prefs state bindingId mismatch, dropped');
          return;
        }
        const currentBindingId =
          lane.binding?.state === 'confirmed' ? lane.binding.bindingId : null;
        if (msg.payload.bindingId !== currentBindingId) {
          lane.pendingPrefs.delete(msg.payload.replyTo);
          clearTimeout(pending.timer);
          pending.reject(new HookNotConnectedError(lane.config.provider));
          log.warn('provider prefs reply for a superseded binding, dropped');
          return;
        }
        lane.pendingPrefs.delete(msg.payload.replyTo);
        clearTimeout(pending.timer);
        pending.resolve(view);
      } else {
        const currentBindingId =
          lane.binding?.state === 'confirmed' ? lane.binding.bindingId : null;
        if (msg.payload.bindingId !== currentBindingId) {
          log.warn('stale provider prefs push for a different binding, dropped');
          return;
        }
      }
      deps.notifyProviderPrefs?.(view);
      return;
    }
    if (msg.type === 'bind.update') {
      if (serverMultiTeam()) {
        // multi-team 双方能力齐备: 事件帧按 team 行级处理, 老状态机不参与
        handleMultiBindUpdate(msg.payload);
        log.info(`bind.update(multi): ${msg.payload.state}`);
        return;
      }
      const authorizeUrl = msg.payload.authorizeUrl ?? null;
      binding = {
        state: msg.payload.state,
        slackUserId: msg.payload.slackUserId,
        slackUserName: msg.payload.slackUserName,
        message: msg.payload.message,
        authorizeUrl,
        reason: msg.payload.reason ?? null,
        installUrl: msg.payload.installUrl ?? null,
        teamName: msg.payload.teamName ?? null,
      };
      notifySlackToolProviderEnabledIfChanged();
      // 授权看门狗跟随真实状态: 离开 pending 即撤; 重连回放 pending(server 侧
      // 授权仍在途)且本地没在计时的补一只 —— 断线重连不会让"等授权"变成无限等。
      if (msg.payload.state !== 'pending') {
        clearBindWatchdog();
      } else if (bindWatchdog === null) {
        armBindWatchdog();
      }
      // "等安装"态(授权已过、workspace 未装 App): 不下线, 保持连接等 server
      // 装完自动补完绑定推回 confirmed(免二次授权); 安装看门狗兜底超时弹回。
      // 其它任何状态到达即撤(confirmed = 装完补完; 其余 = 流程终止/重开)。
      const awaitingInstall =
        msg.payload.state === 'failed' &&
        (msg.payload.reason ?? null) === HOOK_BIND_REASON_NOT_INSTALLED;
      if (awaitingInstall && store.get().enabled) {
        if (installWatchdog === null) armInstallWatchdog();
      } else {
        clearInstallWatchdog();
      }
      // 用户刚点「连接 Slack」→ 首帧 pending 带授权链接时打开系统浏览器一次
      // (置位一次性; 重连时的 pending 回放不弹, 见 openAuthorizeOnNextPending 注释)。
      // 远程控制场景 openExternal 落在被控机, 设置页另给「复制链接」兜底(规则 26)。
      if (msg.payload.state === 'pending' && authorizeUrl !== null && openAuthorizeOnNextPending) {
        openAuthorizeOnNextPending = false;
        try {
          openExternalUrl?.(authorizeUrl);
        } catch (err) {
          log.warn(`openExternal(authorizeUrl) failed: ${String(err)}`);
        }
      }
      // 开关即绑定: 用户刚打开 toggle(armAutoBind), 连上后 server 按 hello 推回
      // 绑定现状 —— none 或 pending 都自动(重新)发起 OIDC 绑定(弹浏览器一次),
      // confirmed 则不弹(已绑定设备重开秒恢复)。pending 也要重发起的原因:
      // 本地看门狗超时(3 分钟)早于 server 侧 pending TTL(10 分钟), toggle 弹回
      // 后重开会撞上 server 回放的旧 pending —— 若不重发起, 浏览器不弹、bind.start
      // 不重发, 用户会卡在「授权中」;initiateBind 让 server 作废旧尝试签新链接。
      // 一次性: 判定后即清, 后续回放不再触发。
      if (autoBindIntent) {
        if (msg.payload.state === 'none' || msg.payload.state === 'pending') {
          if (initiateBind()) {
            autoBindIntent = false;
            // initiateBind 会把 binding 乐观置 pending 并 notifyStatus, 这里直接返回
            // 避免下方用刚被覆盖前的旧状态再 notify 一次(状态闪回)
            return;
          }
          // 发不出 bind.start = 连接恰在本帧处理中掉线: 保留意图等重连回放
          // bind.update 时重试, 且不落入下方 autoDisable(none 会把用户刚打开
          // 的开关静默弹回, 表现为"点了开关没弹浏览器又自己关了")
          log.info(
            'bind.start send failed mid-frame, keeping auto-bind intent for reconnect replay',
          );
          notifyStatus(toView());
          return;
        }
        autoBindIntent = false;
      }
      // 自动下线的终止态(开关语义 = 连接 + 绑定齐备才允许保持打开):
      //   revoked  被其它设备顶掉(实时推送, 保留原因供设置页展示被踢);
      //   denied/expired/failed  用户取消授权 / 授权超时 / 流程失败 —— toggle 弹回;
      //   none     server 侧已无绑定, 且本轮不是用户刚开开关(autoBindIntent
      //            分支已在上方消费并 return) —— 典型是绑定在本机离线期间丢失
      //            (被顶时不在线收不到 revoked、服务端解绑/迁移), 启动后 hello
      //            回放拿到 none。不弹回会留下「开关开着 · 已连接 · 未绑定」的
      //            僵尸态(看着可用实际派发不通), 弹回后重开即走新一轮授权。
      // 例外: failed + not-installed 是"等安装"中间态(上方已臂安装看门狗),
      // 保持在线等 confirmed, 不在这里下线。
      const autoDisable =
        msg.payload.state === 'revoked' ||
        msg.payload.state === 'denied' ||
        msg.payload.state === 'expired' ||
        msg.payload.state === 'none' ||
        (msg.payload.state === 'failed' && !awaitingInstall);
      if (autoDisable && store.get().enabled) {
        autoBindIntent = false;
        store.setEnabled(false);
        stopSlack();
        log.info(`slack hook auto-disabled on bind.update=${msg.payload.state}`);
      }
      notifyStatus(toView());
      log.info(`bind.update: ${msg.payload.state}`);
      return;
    }
    if (msg.type === 'query.request') {
      // 接收日志: /bind /model /effort 的实时问答帧。排查「server 到底有没有
      // 转发到本机」时这是唯一的客户端侧证据(低频帧, INFO 无性能顾虑)。
      log.info(`query.request received: kind=${msg.payload.kind} queryId=${msg.payload.queryId}`);
      // buildQueryResponse 现为异步(models 数据源要实时读 listProviders);
      // 内部已捕获数据源错误(回 ok:false), 这里不会 reject。
      const admittedGeneration = accountGeneration;
      trackAccountOp(
        buildQueryResponse(
          {
            listWorkspaces: () => [
              ...new Set([HOOK_CHAT_WORKSPACE_ALIAS, ...Object.keys(store.get().workspaces)]),
            ],
            listAgentModels: () => listAgentModels?.() ?? [],
            listSessions: () =>
              (lane !== null ? lane.serverFeatures : serverFeatures).includes(
                HOOK_FEATURE_SESSION_PICKER,
              )
                ? (listRecentSessions?.() ?? [])
                : Promise.reject(new Error('session-picker-v1 was not negotiated')),
          },
          msg.payload,
        ).then((response) => {
          if (!accountActive || admittedGeneration !== accountGeneration) return;
          send(makeQueryResponse(response));
        }),
      );
      return;
    }
    if (msg.type === 'task.cancel') {
      log.info(`task.cancel received: requestId=${msg.payload.requestId}`);
      if (dispatcher) {
        dispatcher.cancel(dispatchId(expectedProvider), msg.payload.requestId);
      } else {
        log.warn('task.cancel ignored (no dispatcher)');
      }
      return;
    }
    if (msg.type === 'session.archive') {
      // Provider lane /new 换代 -> 归档旧代会话(幂等, 无绑定即 no-op)
      if (dispatcher) {
        const provider = providerForExternalKey(msg.payload.externalKey);
        if (provider !== expectedProvider || (lane !== null && !laneCapabilityReady(lane))) {
          log.warn(
            `session.archive ignored for unsupported or mismatched provider: ${provider ?? 'unknown'}`,
          );
          return;
        }
        dispatcher.handleSessionArchive(dispatchId(provider), msg.payload.externalKey);
      } else {
        log.warn('session.archive ignored (no dispatcher)');
      }
      return;
    }
    if (msg.type === 'interaction.decision') {
      // 交互卡按钮回流(低频帧, INFO 留证据)
      log.info(
        `interaction.decision received: interactionId=${msg.payload.interactionId} button=${msg.payload.buttonId}`,
      );
      if (dispatcher) {
        dispatcher.handleInteractionDecision(dispatchId(expectedProvider), msg.payload);
      } else {
        log.warn('interaction.decision ignored (no dispatcher)');
      }
      return;
    }
    if (msg.type === 'task.dispatch') {
      const provider = providerForTaskDispatch(msg.payload);
      // 接收日志: 复用已有会话的派发在 dispatcher 里是静默路径(只有新建才留
      // worktree 痕迹), 没有这条就无法区分「没收到」和「静默复用」。lane
      // key 含 IM 用户/聊天标识，不写日志。
      log.info(
        `task.dispatch received: requestId=${msg.payload.requestId} provider=${provider ?? 'unknown'} sessionId=${msg.payload.sessionId ?? '(new/bound)'}`,
      );
      if (provider !== expectedProvider || (lane !== null && !laneCapabilityReady(lane))) {
        log.warn(
          `task.dispatch rejected for unsupported or mismatched provider: requestId=${msg.payload.requestId}`,
        );
        send(
          makeTaskAck({
            requestId: msg.payload.requestId,
            result: 'rejected',
            reason: 'invalid',
            sessionId: null,
            queuePosition: null,
          }),
        );
        return;
      }
      if (dispatcher) {
        dispatcher.handleDispatch(dispatchId(provider), msg.payload, send);
        return;
      }
      log.info(`dispatch received (requestId=${msg.payload.requestId}) — no dispatcher, rejecting`);
      send(
        makeTaskAck({
          requestId: msg.payload.requestId,
          result: 'rejected',
          reason: 'disabled',
          sessionId: null,
          queuePosition: null,
        }),
      );
      return;
    }
    if (msg.type === 'group.message') {
      // 群消息实时中继入本地窗口(group-relay-v1)。只接受来自对应 provider
      // transport 的帧(错误路由的连接不得写窗口); fire-and-forget:
      // 失败只记日志, 窗口是上下文增强, 不影响任务链路。内容不写日志。
      if (msg.payload.provider !== expectedProvider) {
        log.warn(
          `group.message ignored: provider=${msg.payload.provider} on ${expectedProvider} transport`,
        );
        return;
      }
      // 账号边界: 写入纳入 pendingAccountOps, 登出/切号等待落库完成后再
      // 销毁 DB client, 不留 use-after-dispose。
      trackAccountOp(
        recordGroupMessage(msg.payload).catch((err) =>
          log.warn(`group window record failed: ${String(err)}`),
        ),
      );
      return;
    }
    // task.ack / turn.end 不该由 server 发给 desktop; 未知业务帧只记日志
    log.warn(`unexpected message type=${msg.type}, ignored`);
  }

  function stopSlack(): void {
    // Slack 看门狗只随 Slack 连接停止，不能打断 Telegram 绑定流程。
    clearBindWatchdog();
    clearInstallWatchdog();
    clearAutoBindDefer();
    if (transport === null) return;
    const t = transport;
    transport = null;
    status = null;
    lastError = null;
    dispatcher?.onDisconnected(dispatchId('slack'));
    drainPendingPrefs();
    drainPendingTools();
    t.dispose();
  }

  function stopLane(lane: NeutralProviderLane): void {
    clearLaneBindWatchdog(lane);
    lane.openRequestId = null;
    lane.bindRequest = null;
    lane.awaitingStateSnapshot = false;
    const t = lane.transport;
    lane.transport = null;
    lane.status = null;
    lane.lastError = null;
    dispatcher?.onDisconnected(dispatchId(lane.config.provider));
    // Capability state belongs to this transport lifecycle. Keeping a previous
    // welcome after disable/sync makes the stopped provider look available and
    // can let a later enable act on stale rollout information.
    lane.serverFeatures = [];
    lane.serverWelcomeReceived = false;
    drainLanePendingPrefs(lane);
    t?.dispose();
  }

  function stopAll(): void {
    stopSlack();
    for (const lane of lanes) stopLane(lane);
  }

  function startSlack(): void {
    if (
      !accountActive ||
      disposed ||
      !isAvailable() ||
      !store.get().enabled ||
      transport !== null
    ) {
      return;
    }
    // serverFeatures intentionally survives reconnects for stable tool exposure,
    // but capability-gated frames must wait for this transport's own welcome.
    serverWelcomeReceived = false;
    // created 先声明后赋值: transport 工厂同步触发首个 onStatus(connecting),
    // 此时按"未注册"丢弃(status 随后统一置 connecting, 不丢信息)
    let created: HookTransport | null = null;
    created = createTransport({
      url: store.effectiveUrl(),
      getAuthToken,
      refreshAuthToken,
      buildHello: () => buildHello(SLACK_HELLO_FEATURES, true),
      onMessage: (msg, send) => handleBusinessMessage('slack', msg, send),
      onWelcome: (payload) => {
        if (created === null || transport !== created) return;
        // server 能力集以最新一次握手为准(重连可能落到另一版本实例)
        serverFeatures = [...payload.features];
        serverWelcomeReceived = true;
        // hello 发出后、welcome 返回前用户仍可能切换设置。能力协商完成时
        // 补发当前有效值，避免 server 留在 hello 携带的旧快照。
        if (serverFeatures.includes(HOOK_FEATURE_LIFECYCLE_ANNOUNCEMENT)) {
          created.send(
            makeLifecyclePreference({
              enabled: lifecycleAnnouncementEnabled(),
            }),
          );
        }
        // 落回老 server(无 multi-team): 多绑定列表与缓存作废 —— 老 server 是
        // 单绑定权威(它会经 bind.update 推现状), 残留的多绑定行会让 toView
        // 误走 multi 映射、渲染层误开列表 UI。pendingBind 无条件清: 滚动发布
        // multi→old 横跳时 0 绑定设备的在途态也不该滞留(老 server 随后会推现状)
        if (!serverMultiTeam()) {
          pendingBind = null;
          if (multiBindings.length > 0) {
            multiBindings = [];
            persistBindingsCache();
          }
        }
        notifySlackToolProviderEnabledIfChanged();
        notifyStatus(toView());
      },
      onStatus: (s, err) => {
        // 构造期 / dispose / 重建后的尾随回调不再处理
        if (created === null || transport !== created) return;
        status = s;
        lastError = err;
        // 掉线(含退避重连中): 在途往返快速失败, 不让调用方挂满超时
        if (s !== 'connected') {
          serverWelcomeReceived = false;
          dispatcher?.onDisconnected(dispatchId('slack'));
          drainPendingPrefs();
          drainPendingTools();
        }
        // 握手完成 → dispatcher 刷新发送函数并补发离线积压的 turn.end
        if (s === 'connected') {
          const t = created;
          // features 一并交出去: dispatcher 的 turn.reopen 回流按 server 本次
          // 握手宣告的能力开关(滚动发布时重连可能落到不支持的旧实例)。
          dispatcher?.onConnected(dispatchId('slack'), (m) => t.send(m), serverFeatures);
          // 阶段 4 起绑定走 SIWS OIDC, 由用户点「连接 Slack」显式发起(需开浏览器),
          // 不再随连接就绪自动绑 —— 抢占式绑定若自动补绑会让两台设备互相顶。
        }
        notifyStatus(toView());
      },
      log,
    });
    transport = created;
    status = 'connecting';
  }

  function startLane(lane: NeutralProviderLane): void {
    if (
      !accountActive ||
      disposed ||
      !isAvailable() ||
      !lane.config.isEnabled() ||
      lane.transport !== null
    ) {
      return;
    }
    const { provider, label } = lane.config;
    const url = lane.config.getUrl().trim();
    if (url.length === 0) {
      lane.serverFeatures = [];
      lane.serverWelcomeReceived = true;
      lane.status = 'error';
      lane.lastError = lane.config.notConfiguredError;
      notifyStatus(toView());
      return;
    }
    lane.serverWelcomeReceived = false;
    let created: HookTransport | null = null;
    created = createTransport({
      url,
      getAuthToken,
      refreshAuthToken,
      buildHello: () => buildHello(lane.config.helloFeatures),
      onMessage: (msg, send) => handleBusinessMessage(provider, msg, send),
      onWelcome: (payload) => {
        if (created === null || lane.transport !== created) return;
        lane.serverFeatures = [...payload.features];
        lane.serverWelcomeReceived = true;
        const supported = laneCapabilityReady(lane);
        lane.awaitingStateSnapshot = supported;
        if (!supported) {
          // A rolling deployment may briefly route this enabled client to an
          // older node. Preserve the user's explicit preference and keep the
          // transport alive so a later reconnect can negotiate capabilities
          // again. The auto-bind intent is also preserved: a toggle-on that
          // landed on an old node should complete after rollout without a
          // second user action. Only clear wire attempts tied to this node.
          lane.openRequestId = null;
          lane.bindRequest = null;
          clearLaneBindWatchdog(lane);
          drainLanePendingPrefs(lane);
          dispatcher?.onDisconnected(dispatchId(provider));
          log.warn(
            `${label} provider unavailable because ${label} service capability negotiation failed`,
          );
        } else if (lane.status === 'connected') {
          // refreshHello() can upgrade an already-open socket after a rolling
          // deploy without another status transition.
          const t = created;
          dispatcher?.onConnected(dispatchId(provider), (m) => t.send(m), lane.serverFeatures);
        }
        notifyStatus(toView());
      },
      onStatus: (s, err) => {
        if (created === null || lane.transport !== created) return;
        lane.status = s;
        lane.lastError = err;
        if (s !== 'connected' || !laneCapabilityReady(lane)) {
          dispatcher?.onDisconnected(dispatchId(provider));
          drainLanePendingPrefs(lane);
        }
        if (s === 'connected' && laneCapabilityReady(lane)) {
          const t = created;
          dispatcher?.onConnected(dispatchId(provider), (m) => t.send(m), lane.serverFeatures);
        }
        notifyStatus(toView());
      },
      log,
    });
    lane.transport = created;
    lane.status = 'connecting';
    lane.lastError = null;
  }

  function startEnabledProviders(): void {
    if (!accountActive || disposed) return;
    if (store.get().enabled) startSlack();
    for (const lane of lanes) {
      if (lane.config.isEnabled()) startLane(lane);
    }
  }

  return {
    sync() {
      // 两条连接各自重建；一个 provider 的端点/故障不影响另一个。
      stopAll();
      startEnabledProviders();
      // multi-team 的 gate 含 enabled 因子(关开关不再清绑定), setEnabled 后的
      // sync 是它唯一的重算点; 老路径下本调用是幂等 no-op
      notifySlackToolProviderEnabledIfChanged();
      notifyStatus(toView());
    },
    snapshot: () => toView(),
    setLifecycleAnnouncement(enabled) {
      store.setLifecycleAnnouncementOverride(enabled);
      if (
        transport !== null &&
        status === 'connected' &&
        serverWelcomeReceived &&
        serverFeatures.includes(HOOK_FEATURE_LIFECYCLE_ANNOUNCEMENT)
      ) {
        const sent = transport.send(makeLifecyclePreference({ enabled }));
        if (!sent) {
          // 连接状态与 socket readyState 可能在 close 回调前短暂错位。偏好已经
          // 持久化；主动重建连接，让下一次 hello 立即携带最新值，避免等待旧
          // transport 的退避/回调后 server 继续沿用旧偏好。
          log.warn('lifecycle preference send failed; reconnecting to resync persisted value');
          stopSlack();
          startSlack();
        }
      }
      notifyStatus(toView());
    },
    refreshHello() {
      let attempted = false;
      let sent = true;
      if (transport !== null && status === 'connected') {
        attempted = true;
        sent = transport.send(makeHello(buildHello(SLACK_HELLO_FEATURES, true))) && sent;
      }
      for (const lane of lanes) {
        if (lane.transport !== null && lane.status === 'connected') {
          attempted = true;
          sent = lane.transport.send(makeHello(buildHello(lane.config.helloFeatures))) && sent;
        }
      }
      return attempted && sent;
    },
    bindStart() {
      return initiateBind();
    },
    armAutoBind() {
      // 开关即绑定: 置一次性意图, 连上后收到 bind.update(none/pending) 或
      // (multi-team)空 bind.state 自动发起绑定
      autoBindIntent = true;
      // 重开开关 = 新一轮流程: 清掉上一轮残留的终止态绑定快照(failed/expired
      // 等), 否则 renderer 会拿陈旧的 not-installed 误弹"安装确认框"、用户对
      // 过时弹窗点取消还会误杀刚建立的新绑定。server 连上后按 hello 推回真实
      // 现状; confirmed 保留(离线关开关的边缘场景, 重开即显已绑定)。
      if (binding !== null && binding.state !== 'confirmed') binding = null;
      // multi-team 的在途授权快照同理清掉(真在途的话 server 会回放 pending)
      pendingBind = null;
    },
    bindRevoke() {
      if (transport === null || status !== 'connected') return false;
      return transport.send(makeBindRevoke());
    },
    addBinding() {
      // 需 server multi-team 能力(老 server 对多绑定语义一无所知)
      if (!serverMultiTeam()) return false;
      // 真在途授权(pending)时忽略(幂等, 不打断进行中的流程); 终止态
      // (denied/expired/failed)允许直接重试覆盖
      if (pendingBind?.state === 'pending') return true;
      return initiateMultiBind(null);
    },
    rebindTeam(teamId) {
      if (!serverMultiTeam()) return false;
      return initiateMultiBind(teamId);
    },
    revokeTeam(teamId) {
      const idx = multiBindings.findIndex((b) => b.teamId === teamId);
      if (idx < 0) return true; // 行已不在(重复点击/竞态), 幂等成功
      if (multiBindings[idx].displaced) {
        // displaced 行: 服务端本就没有该绑定, 删除 = 仅清本地缓存(离线可用)
        multiBindings.splice(idx, 1);
        persistBindingsCache();
        notifyStatus(toView());
        return true;
      }
      if (!serverMultiTeam() || transport === null || status !== 'connected') return false;
      if (!transport.send(makeBindRevoke({ teamId }))) return false;
      // 乐观移除: server 处理后还会补推 bind.state 快照对齐
      multiBindings.splice(idx, 1);
      persistBindingsCache();
      notifySlackToolProviderEnabledIfChanged();
      notifyStatus(toView());
      return true;
    },
    cancelPendingBind() {
      // 本地收口无条件执行(离线也能取消显示); server 侧登记在线时顺手作废
      clearBindWatchdog();
      clearInstallWatchdog();
      clearAutoBindDefer();
      autoBindIntent = false;
      openAuthorizeOnNextPending = false;
      const hadPending = pendingBind !== null;
      pendingBind = null;
      if (serverMultiTeam() && transport !== null && status === 'connected' && hadPending) {
        transport.send(makeBindRevoke({ pendingOnly: true }));
      }
      notifyStatus(toView());
      return true;
    },
    callSlackTool(tool, args, teamId) {
      const fail = (code: string, message: string): Promise<HookSlackToolResult> =>
        Promise.resolve({ ok: false, error: { code, message } });
      const t = transport;
      if (t === null || status !== 'connected') {
        return fail('HOOK_NOT_CONNECTED', 'Slack 连接不在线, 请检查 设置 → Slack 开关与网络');
      }
      const bound = multiTeamKnown() ? activeBindings().length > 0 : binding?.state === 'confirmed';
      if (!bound) {
        return fail('NOT_BOUND', '本设备未绑定 Slack, 请先到 设置 → Slack 完成绑定');
      }
      // 老 server 不认识 tool.request(丢帧不应答): 按能力宣告短路, 不打空炮
      if (!serverFeatures.includes(HOOK_FEATURE_SLACK_TOOLS)) {
        return fail('SERVER_TOO_OLD', 'Slack 服务端版本过旧, 不支持 Slack 工具, 请联系管理员升级');
      }
      const requestId = randomUUID();
      // teamId 仅在 server 宣告 multi-team 后进帧(老 server 语境下无意义)
      const withTeam = teamId != null && serverMultiTeam() ? { teamId } : {};
      return new Promise<HookSlackToolResult>((resolve) => {
        if (
          !t.send(
            makeToolRequest({
              requestId,
              tool,
              ...(args !== undefined ? { args } : {}),
              ...withTeam,
            }),
          )
        ) {
          resolve({
            ok: false,
            error: { code: 'HOOK_NOT_CONNECTED', message: 'Slack 连接不在线, 请稍后重试' },
          });
          return;
        }
        const timer = setTimeout(() => {
          pendingTools.delete(requestId);
          resolve({
            ok: false,
            error: { code: 'TIMEOUT', message: 'Slack 工具请求超时(服务端无应答), 请稍后重试' },
          });
        }, toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
        timer.unref?.();
        pendingTools.set(requestId, { resolve, timer });
      });
    },
    getSlackToolAvailability() {
      const multi = multiTeamKnown();
      return {
        connected: status === 'connected',
        // multi-team 关开关不清绑定, bound 必须叠 enabled 因子 —— 否则 Slack
        // 已关的设备上 cindy_slack 工具面仍会挂进新会话(老路径关开关会把
        // binding 归零, confirmed 判据自足)
        bound: multi
          ? store.get().enabled && activeBindings().length > 0
          : binding?.state === 'confirmed',
        serverSupportsTools: serverFeatures.includes(HOOK_FEATURE_SLACK_TOOLS),
        binding: multi ? legacyBindingView() : binding,
        multiTeam: serverMultiTeam(),
        bindings: activeBindings().map((b) => ({ teamId: b.teamId, teamName: b.teamName })),
      };
    },
    getWorkspacePrefs() {
      return sendPrefsRequest((requestId) => makePrefsGet({ requestId }));
    },
    setWorkspacePrefs(workspace, patch, teamId) {
      return sendPrefsRequest((requestId) =>
        makePrefsSet({
          requestId,
          workspace,
          // undefined 字段不进帧(部分更新语义); null 显式清空
          ...(patch.model !== undefined ? { model: patch.model } : {}),
          ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
          ...(patch.agentKind !== undefined ? { agentKind: patch.agentKind } : {}),
          ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
          // (multi-team)偏好归属 team: 仅 server 宣告能力时进帧(老 server 不查
          // 本字段, 但语义上单绑定无归属概念, 不发保持帧面与老版本逐字节一致)
          ...(teamId != null && serverMultiTeam() ? { teamId } : {}),
        }),
      );
    },
    setProviderEnabled(provider, enabled) {
      if (provider === 'slack') {
        store.setEnabled(enabled);
        if (!enabled) {
          // multi-team keeps durable bindings while the toggle is off, so the
          // build-time cindy_slack gate must be recomputed after the enabled
          // bit flips rather than relying on revokeAndDisconnect().
          notifySlackToolProviderEnabledIfChanged();
          stopSlack();
        } else if (transport === null) startSlack();
        else if (status === 'connected' && serverWelcomeReceived) {
          // 幂等重复开启已连接的 Slack 时不会收到新的状态回放，直接消费
          // armAutoBind 意图；首次开启走上面的 startSlack + 服务端回放路径。
          if (serverMultiTeam()) {
            if (activeBindings().length > 0) autoBindIntent = false;
            else if (initiateMultiBind(null)) autoBindIntent = false;
          } else if (binding?.state === 'confirmed') {
            autoBindIntent = false;
          } else if (initiateBind()) {
            autoBindIntent = false;
          }
        }
        notifyStatus(toView());
        return;
      }
      const lane = neutralLaneFor(provider);
      if (lane === null) return;
      lane.config.setEnabled(enabled);
      if (!enabled) {
        lane.autoBindIntent = false;
        lane.openRequestId = null;
        lane.bindRequest = null;
        clearLaneBindWatchdog(lane);
        const attemptId = lane.binding?.attemptId;
        if (
          attemptId &&
          lane.transport !== null &&
          lane.status === 'connected' &&
          laneCapabilityReady(lane)
        ) {
          lane.transport.send(
            makeProviderBindCancel({
              requestId: randomUUID(),
              provider: lane.config.provider,
              attemptId,
            }),
          );
        }
        stopLane(lane);
        notifyStatus(toView());
        return;
      }
      // Cached state is presentation-only until the server's authoritative
      // snapshot arrives. Always arm explicit enable; a confirmed snapshot
      // clears the intent, while none/revoked starts a fresh one-time bind.
      lane.autoBindIntent = true;
      if (lane.transport === null) {
        startLane(lane);
      } else if (lane.status === 'connected' && laneCapabilityReady(lane)) {
        if (lane.binding?.state === 'confirmed') lane.autoBindIntent = false;
        else if (initiateProviderBind(lane)) lane.autoBindIntent = false;
      }
      notifyStatus(toView());
    },
    providerBindStart(provider) {
      const lane = laneByProvider.get(provider);
      if (lane === undefined) return false;
      lane.autoBindIntent = false;
      return initiateProviderBind(lane);
    },
    providerBindCancel(provider) {
      const lane = laneByProvider.get(provider);
      if (lane === undefined) return false;
      const current = lane.binding;
      const attemptId = current?.attemptId;
      if (
        current === null ||
        !attemptId ||
        !current.actions.includes('cancel') ||
        lane.transport === null ||
        lane.status !== 'connected' ||
        !laneCapabilityReady(lane)
      ) {
        return false;
      }
      const requestId = randomUUID();
      const sent = lane.transport.send(
        makeProviderBindCancel({ requestId, provider: lane.config.provider, attemptId }),
      );
      if (sent) {
        lane.bindRequest = { kind: 'cancel', requestId, attemptId };
        clearLaneBindWatchdog(lane);
        lane.openRequestId = null;
        lane.binding = {
          ...current,
          state: 'failed',
          connectUrl: null,
          expiresAt: null,
          reason: 'cancelled',
          actions: ['retry'],
        };
        notifyStatus(toView());
      }
      return sent;
    },
    providerBindRevoke(provider) {
      const lane = laneByProvider.get(provider);
      if (lane === undefined) return false;
      const bindingId = lane.binding?.state === 'confirmed' ? lane.binding.bindingId : null;
      if (
        !bindingId ||
        !lane.binding?.actions.includes('revoke') ||
        lane.transport === null ||
        lane.status !== 'connected' ||
        !laneCapabilityReady(lane)
      ) {
        return false;
      }
      const requestId = randomUUID();
      const sent = lane.transport.send(
        makeProviderBindRevoke({ requestId, provider: lane.config.provider, bindingId }),
      );
      if (sent) lane.bindRequest = { kind: 'revoke', requestId, bindingId };
      return sent;
    },
    async openTelegramAction(action) {
      const lane = telegramLane;
      if (!lane.config.openUrl || lane.binding === null) return false;
      const url = lane.config.actionUrl(action, lane.binding);
      if (!url) return false;
      await lane.config.openUrl(url);
      return true;
    },
    getProviderWorkspacePrefs(provider) {
      const lane = laneByProvider.get(provider);
      if (lane === undefined) return Promise.reject(new HookNotConnectedError(provider));
      return sendLanePrefsRequest(lane, (requestId, bindingId) =>
        makeProviderPrefsGet({
          requestId,
          provider,
          bindingId,
          scopeId: null,
        }),
      );
    },
    setProviderWorkspacePrefs(provider, workspace, patch) {
      const lane = laneByProvider.get(provider);
      if (lane === undefined) return Promise.reject(new HookNotConnectedError(provider));
      return sendLanePrefsRequest(lane, (requestId, bindingId) =>
        makeProviderPrefsSet({
          requestId,
          provider,
          bindingId,
          scopeId: null,
          workspace,
          ...(patch.model !== undefined ? { model: patch.model } : {}),
          ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
          ...(patch.agentKind !== undefined ? { agentKind: patch.agentKind } : {}),
          ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
        }),
      );
    },
    activateAccount() {
      if (accountDeactivation !== null) {
        const generation = accountGeneration;
        void accountDeactivation.then(() => {
          if (generation === accountGeneration) activateCurrentAccount();
        });
        return;
      }
      activateCurrentAccount();
    },
    async deactivateAccount() {
      // Invalidate deferred activation and all account-bound async work even
      // when another caller is already waiting on the same physical drain.
      accountActive = false;
      accountGeneration += 1;
      for (const lane of lanes) {
        lane.openRequestId = null;
        lane.bindRequest = null;
        lane.autoBindIntent = false;
      }
      if (accountDeactivation !== null) {
        await accountDeactivation;
        return;
      }
      stopAll();
      const drain = (async (): Promise<void> => {
        const dispatcherDrain = dispatcher?.deactivateAccount();
        await Promise.allSettled([
          ...(dispatcherDrain ? [dispatcherDrain] : []),
          ...pendingAccountOps,
        ]);
        binding = null;
        multiBindings = [];
        pendingBind = null;
        serverFeatures = [];
        serverWelcomeReceived = false;
        for (const lane of lanes) {
          lane.binding = null;
          lane.serverFeatures = [];
          lane.serverWelcomeReceived = false;
        }
        notifySlackToolProviderEnabledIfChanged();
        notifyStatus(toView());
      })();
      accountDeactivation = drain.finally(() => {
        accountDeactivation = null;
      });
      await accountDeactivation;
    },
    revokeAndDisconnect() {
      if (serverMultiTeam()) {
        // (multi-team)关 toggle = 只断开, **不再发全量 bind.revoke** —— 绑定
        // 保留在服务端与本地缓存, 重开开关秒恢复(解绑改走显式 revokeTeam)。
        // 在途的添加/重绑授权顺手作废(pendingOnly, 不触碰已确认绑定)。
        if (transport !== null && status === 'connected' && pendingBind !== null) {
          transport.send(makeBindRevoke({ pendingOnly: true }));
        }
        autoBindIntent = false;
        openAuthorizeOnNextPending = false;
        pendingBind = null;
        stopSlack();
        // setProviderEnabled(false) flips the durable bit and recomputes the
        // gate immediately after this pre-disable disconnect step.
        notifySlackToolProviderEnabledIfChanged();
        return;
      }
      // 关 toggle = 解除绑定并断开: 在线则先发 bind.revoke(server 清绑定 +
      // pendingLink + 等安装登记, 取消"安装确认框"也走这里), 本地绑定态直接
      // 归零(stop 后收不到 server 回的 none 帧, 不能靠推送), 清在途意图与
      // 弹窗置位。送达是尽力而为(离线不发; 发出后立即断开, 极端竞态可能丢
      // 帧): 丢帧后果有界 —— server 侧绑定/等安装登记保留(登记最长 15 分钟),
      // 期间装 App 只会把绑定落到用户自己已验过的身份上, 重开开关按 confirmed
      // 恢复, 不产生安全风险, 也不会有半解绑状态。
      if (transport !== null && status === 'connected') {
        transport.send(makeBindRevoke());
      }
      autoBindIntent = false;
      openAuthorizeOnNextPending = false;
      pendingBind = null;
      binding = {
        state: 'none',
        slackUserId: null,
        slackUserName: null,
        message: null,
        authorizeUrl: null,
        reason: null,
        installUrl: null,
        teamName: null,
      };
      notifySlackToolProviderEnabledIfChanged();
      stopSlack();
    },
    dispose() {
      disposed = true;
      stopAll();
      // dispatcher 由本 manager 独占持有(ipc.ts 在同一处创建两者), 所以它的
      // 进程级信号订阅也随本次 dispose 一起退掉, 否则重建 manager 会叠加一个
      // 对着废弃 dispatcher 状态跑的续跑监听。
      dispatcher?.dispose();
    },
  };
}
