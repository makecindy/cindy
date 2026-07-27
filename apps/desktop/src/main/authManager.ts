/**
 * authManager.ts
 * ---------------------------------------------------------------------------
 * All authentication logic lives here in the main process:
 *
 * - auth-server login flow (verification codes, PKCE browser redirects, account selection)
 * - Token storage (safeStorage for refresh token, in-memory for access token)
 * - Automatic access token refresh scheduling
 * - Logout (API + state cleanup)
 * - Auth state notification to renderer via IPC
 *
 * The renderer never touches tokens directly — it calls IPC endpoints
 * exposed by this module and receives state updates via 'auth:state-change'.
 */

import { BrowserWindow, net, safeStorage, app, shell } from 'electron';
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { machineIdSync } from 'node-machine-id';
import {
  AuthApiError,
  CindyAuthClient,
  reduceAuthFlow,
  ssoOrgDiscoveryToMethods,
  type AuthFlowState,
  type AuthMembership,
  type AuthRegion,
  type AuthTokenPair,
  type AccountDeletionAvailability,
  type AccountDeletionStatus,
  type LoginMethod,
  type LoginOutcome,
  type ProviderConfig,
  type SocialProvider,
} from '@cindy/auth-client';
import { closeDb as closeLocalDb } from './localDb';
import { readReloginFlag, clearReloginFlag } from './updateService';
import * as canaryFlagStore from './canaryFlagStore';
import { decodeAccessTokenOrgSlug } from './authTokenClaims';
import { getProviderSecretStore } from './secrets/providerSecretStore.js';
import {
  runRefreshWithReplacementRetry,
  resolveSessionExpiredReason,
  type RefreshFailureAction,
  type RefreshFailureInfo,
  type RefreshFetchResult,
  type SessionExpiredReason,
} from './authRefreshFailure';
import { awaitWithStartupTimeout } from './authStartupGate';
import { syncCanaryFlagAfterAuth } from './canaryFlagSync';
import {
  createAuthBrowserAuthorizationSlot,
  createAuthLoopbackDevBridgeSlot,
  parseAuthLoopbackCallback,
  raceAuthBrowserCancellation,
  renderAuthLoopbackPage,
  type AuthLoopbackDevBridge,
} from './authLoopbackCallback';
import {
  createDesktopPollCredentials,
  runHostedCallbackPolling,
} from './authHostedCallback';
// dev-only 登录 scenario harness(implementation-plan Step 0 WHAT4):静态 import
// (main 禁运行时动态 import),生产构建由 vite alias 把整模块替换为空 stub
// (vite.main.config.ts),运行时另有 app.isPackaged guard 双保险。
import { resolveLoginScenarioFetch } from '@cindy/auth-client/fixtures';

import { createLogger } from './logger';
import { buildFocusDeepLink } from './deepLink';
import { getResolvedMainLocale, t } from './i18n';
import { getClientEndpoint } from './clientEndpointsService.js';
import {
  parseDesktopLoginAction,
  type DesktopAccountDeletionChallenge,
  type DesktopLoginAction,
  type DesktopLoginActionResult,
} from '../shared/authIpc';
import {
  beginAppSessionBoundary,
  commitActiveAppSession,
  getActiveAppSession,
  type AppSessionMode,
} from './appSessionState.js';
import {
  claimLegacyOwnerNamespace,
  recordLegacyGhostMigrationResult,
} from './ownerNamespaceMigration.js';

const log = createLogger('authManager');

async function claimLegacyNamespaceForVerifiedUser(userId: string): Promise<void> {
  try {
    const result = await claimLegacyOwnerNamespace({
      mode: 'cloud',
      dataOwnerId: userId,
      user: { id: userId },
    });
    recordLegacyGhostMigrationResult(userId, result);
  } catch (error) {
    recordLegacyGhostMigrationResult(userId, { status: 'partial', moved: 0, conflicts: 0 });
    log.warn('legacy owner namespace claim failed; continuing with scoped storage', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ── Config ──────────────────────────────────────────────────────────────────

const AUTH_REGION: AuthRegion =
  import.meta.env.VITE_CINDY_AUTH_REGION === 'global' ? 'global' : 'cn';
// 端点惰性读取(勿固化成模块级常量):远程清单在 app.ready 内解析,
// 顶层求值会把值钉死在烘焙值上。clientEndpointsService 的烘焙值已含 dev fallback。
// auth 清单字段不分 region——国内/海外两条 CDN 各发各的清单,无脑取即可。
function authServerUrl(): string {
  return getClientEndpoint('authApiBaseUrl');
}
const REFRESH_TOKEN_KEY = 'cindy_auth_refresh_token';
const ACCOUNT_DELETION_RECEIPT_KEY = 'cindy_auth_account_deletion_receipt';
const LEGACY_ACCOUNT_REFRESH_TOKEN_KEY = 'cindy_auth_account_refresh_token';
const LEGACY_REFRESH_TOKEN_KEY = 'refresh_token';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_EFFORT = 'medium';

// ── Types ───────────────────────────────────────────────────────────────────

// 2026-07 产品侧 me 路由退役:身份完全以 auth-server membership 为准,不再
// 请求主 server `/api/user/me`。原产品增强字段的去向:
//  - isCanary → 登录后从 oauth-broker `/api/user/feature-flags` 单独读取,
//    落 main 进程本地标记并通过 AuthState 独立投影给 renderer,不混入 User;
//  - feishuOpenId → 退役,飞书登录已整体下线,身份锚(identityAnchor)只写 email;
//  - role(产品级 admin)→ 退役,唯一消费是侧栏头像角标(纯装饰),一并移除。
export interface User {
  id: string;
  name: string;
  avatar: string | null;
  email: string | null;
  defaultModel: string;
  defaultEffort: string;
  /** auth-server membership context. */
  membershipKind: 'personal' | 'org';
  membershipRole: 'owner' | 'admin' | 'member';
  orgId: string | null;
  orgName: string | null;
  /**
   * 组织 slug(access token 的 orgSlug claim,ctx=org 时 auth-server 注入)。
   * 组织的稳定标识(域名派生、全局唯一,如 'xd'),与 orgId(cuid)/orgName(显示名)
   * 不同,适合做企业功能分流的配置键。个人身份或旧 token 缺 claim 时为 null。
   * membership 响应不含此字段,由 snapshotAuthState 出口统一从 access token 解码注入。
   */
  orgSlug: string | null;
  /** 企业 logo(auth console 组织设置上传);个人身份或未设置为 null。 */
  orgLogoUrl: string | null;
  passportId: string;
}

/**
 * Main-process-only auth user. Keep the raw membership display name separate
 * from `User.name`, whose UI fallback may be an email address or "Cindy".
 */
interface CurrentUser extends User {
  membershipDisplayName: string;
}

export interface AuthState {
  user: User | null;
  /** Stable application session. Local is an app session, not cloud authentication. */
  mode: AppSessionMode;
  /** Owner for local databases and owner-scoped private state. */
  dataOwnerId: string | null;
  /** Local and cloud sessions may enter the main application. */
  canEnterApp: boolean;
  isAuthenticated: boolean;
  /** 当前账号是否加入 Canary 发布通道；不属于身份资料。 */
  isCanary: boolean;
  /** SkillHub 跨设备识别：本机 deviceId（machineIdSync 结果），登录前后都会有值 */
  deviceId: string;
  /** Main has an encrypted receipt that can query a pending deletion without auth. */
  hasAccountDeletionReceipt: boolean;
  /** One-shot successful-login notice for a deletion that was cancelled by signing in. */
  accountDeletionRestored: boolean;
}

export interface AuthInitializeOptions {
  /**
   * 冷启动 refresh 超过 UI 等待上限时触发。renderer 仍会先拿到未登录兜底态，
   * 但 dev restart 必须继续等待这个最终结果：迟到登录后还要观察 localDb migration。
   */
  onColdStartPending?: (completion: Promise<AuthState>) => void;
}

type RefreshResponse = AuthTokenPair;

interface AuthErrorResponse {
  error?: {
    code?: string;
    message?: string;
  };
}

type AuthRefreshResult = RefreshFetchResult<RefreshResponse | AuthErrorResponse>;

type AccountSwitchTeardown = (context: {
  previousUserId: string;
  nextUserId: string;
}) => void | Promise<void>;

/** Releases every account-scoped runtime before terminal local sign-out. */
type AuthSessionTeardown = (reason: string) => void | Promise<void>;

let accountSwitchTeardown: AccountSwitchTeardown | null = null;
let authSessionTeardown: AuthSessionTeardown | null = null;

// ── Module-level state ──────────────────────────────────────────────────────

let accessToken: string | null = null;
let currentUser: CurrentUser | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshPromise: Promise<boolean> | null = null;
let sessionInvalidationPromise: Promise<void> | null = null;
/**
 * 设备标识。默认绑定物理机(machineIdSync)。
 *
 * dev-only 覆盖:设了 `XDT_DEVICE_ID_OVERRIDE` 则用它——用于在同一台机器上跑多个
 * desktop 实例模拟「多设备」(device-link 跨设备远程控制本地联调)。deviceId 只是
 * 同账号下区分设备的标识、非鉴权凭证(鉴权走 auth-server 签发的 JWT),覆盖无安全风险。
 */
const deviceId = process.env.XDT_DEVICE_ID_OVERRIDE?.trim() || machineIdSync();

let loginFlowState: AuthFlowState | null = null;
let providerConfig: ProviderConfig | null = null;
let discoveredMethods: LoginMethod[] = [];
// Account token 仅在一次登录的 Membership 选择阶段存活；兑换 resource token
// 后立即清空，不持久化、不续期，也不参与业务请求或正常登出。
let pendingAccountToken: string | null = null;
let pendingLoginTicket: string | null = null;
let pendingBindTicket: string | null = null;
let pendingSsoVerificationTicket: string | null = null;
let loginActionPromise: Promise<DesktopLoginActionResult> | null = null;
// `accountDeletionRestored` may arrive before membership selection. Keep it
// main-only until the final resource-token login commits.
let pendingAccountDeletionRestored = false;
let accountDeletionRestoredNoticePending = false;
// Set only after auth-server has accepted deletion. The identity guard keeps a
// late confirmation from tearing down a different account selected meanwhile.
let confirmedAccountDeletionAuthIdentity: string | null = null;

function createAuthClient(): CindyAuthClient {
  // 登录 scenario harness 注入点(仅 client 构造参数,不替换 client、不 fake 方法;
  // zod schema/错误归一/REGION_MISMATCH 路径全真)。guard:!app.isPackaged +
  // XDT_LOGIN_SCENARIO(值域见 implementation-plan 附录 A,经 restart 脚本
  // devEnvPrefix 白名单透传)。
  const scenarioFetch = resolveLoginScenarioFetch({
    devModeActive: !app.isPackaged,
    scenario: process.env.XDT_LOGIN_SCENARIO,
    region: AUTH_REGION,
  });
  return new CindyAuthClient({
    baseUrl: authServerUrl(),
    region: AUTH_REGION,
    deviceId,
    clientType: 'desktop',
    locale: getResolvedMainLocale(),
    fetch: scenarioFetch ?? (async (input, init) => net.fetch(input, init as RequestInit)),
  });
}

// ── safeStorage helpers ─────────────────────────────────────────────────────

const SAFE_STORAGE_DIR = () => path.join(app.getPath('userData'), 'safe-storage');

function readSafe(key: string): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const filepath = path.join(SAFE_STORAGE_DIR(), `${key}.enc`);
    if (!fs.existsSync(filepath)) return null;
    const content = fs.readFileSync(filepath, 'utf-8');
    return safeStorage.decryptString(Buffer.from(content, 'base64'));
  } catch {
    return null;
  }
}

/**
 * 区分「凭证文件确实不存在」与「暂时读不出来」。
 *
 * `readSafe` 把三种情况都折叠成 null:加密不可用、文件不存在、读取/解密抛错。
 * 只有「加密可用且文件确实不在」才能作为「凭证被外部实例清除」的判据;其余
 * (密钥链暂时不可用、瞬时 I/O、解密失败)必须按瞬时失败处理——否则一次
 * 密钥链抖动就会把仍持有有效会话的用户强制登出。
 *
 * 注意不能用 existsSync:它对 EPERM/EACCES 等访问错误同样返回 false,会把
 * 「没权限读」误判成「已被删除」。这里用 accessSync 并只认 ENOENT(文件或
 * 父目录确定不存在)为真缺席,其它错误一律按瞬时故障。
 */
function isPersistedSecretAbsent(key: string): boolean {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    fs.accessSync(path.join(SAFE_STORAGE_DIR(), `${key}.enc`), fs.constants.F_OK);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
}

function writeSafe(key: string, value: string): boolean {  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const dir = SAFE_STORAGE_DIR();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${key}.enc`),
      safeStorage.encryptString(value).toString('base64'),
      'utf-8',
    );
    return true;
  } catch {
    return false;
  }
}

function removeSafe(key: string): void {
  try {
    fs.unlinkSync(path.join(SAFE_STORAGE_DIR(), `${key}.enc`));
  } catch {
    // ENOENT is fine
  }
}

// ── PKCE (Node.js native crypto) ────────────────────────────────────────────

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

// ── net.fetch helper ────────────────────────────────────────────────────────

/**
 * Per-request timeout for auth API calls (ms). Prevents net.fetch from hanging
 * indefinitely on black-hole / captive-portal networks. Pass `timeoutMs: 0` to
 * disable (required for token-rotating endpoints where aborting mid-flight can
 * cause permanent logout).
 */
const API_FETCH_TIMEOUT_MS = 15_000;

async function apiFetch<T>(
  apiPath: string,
  options?: {
    method?: string;
    body?: unknown;
    token?: string | null;
    timeoutMs?: number;
    baseUrl?: string;
  },
): Promise<{ ok: boolean; status: number; data: T }> {
  const url = (options?.baseUrl ?? authServerUrl()) + apiPath;
  const method = options?.method ?? 'GET';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options?.token) {
    headers['Authorization'] = 'Bearer ' + options.token;
  }
  const effectiveTimeout = options?.timeoutMs ?? API_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = effectiveTimeout > 0
    ? setTimeout(() => controller.abort(), effectiveTimeout)
    : undefined;
  try {
    const response = await net.fetch(url, {
      method,
      headers,
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: effectiveTimeout > 0 ? controller.signal : undefined,
    });
    const data = (await response.json()) as T;
    const errorCode = (data as AuthErrorResponse | null)?.error?.code;
    if (response.status === 401 && errorCode === 'ACCOUNT_UNAVAILABLE' && currentUser) {
      // Internal auth-server calls (profile/feature flags/refresh) do not pass
      // through serverApiClient, but share the same terminal auth contract.
      void invalidateSession('account-unavailable');
    }
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: null as T };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function requestAuthRefresh(refreshToken: string): Promise<AuthRefreshResult> {
  // refresh 是 token-rotating 端点,禁用 abort timeout——若服务端已轮换但
  // 客户端 abort,重试旧 token 会触发 INVALID_REFRESH_TOKEN。
  return apiFetch<RefreshResponse | AuthErrorResponse>('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken, deviceId },
    timeoutMs: 0,
  });
}

function getRefreshErrorCode(result: { data: unknown }): string | undefined {
  return (result.data as AuthErrorResponse | null)?.error?.code;
}

function mapMembershipToAuthUser(membership: AuthMembership, passportId?: string): CurrentUser {
  return {
    id: membership.id,
    name: membership.displayName || membership.email || 'Cindy',
    membershipDisplayName: membership.displayName,
    // auth-server 自助头像(PATCH /api/me/profile);null = 未设置(UI 首字母兜底)。
    // 产品资料头像回落已随 /api/user/me 退役(2026-07)。
    avatar: membership.avatarUrl ?? null,
    email: membership.email,
    defaultModel: DEFAULT_MODEL,
    defaultEffort: DEFAULT_EFFORT,
    membershipKind: membership.kind,
    membershipRole: membership.role,
    orgId: membership.orgId,
    orgName: membership.orgName,
    orgLogoUrl: membership.orgLogoUrl ?? null,
    // membership 响应不带 slug;所有出口经 snapshotAuthState 时从 access token 补齐。
    orgSlug: null,
    passportId: passportId ?? membership.passportId ?? '',
  };
}

function mergeMembershipWithExisting(
  membership: AuthMembership,
  existing: CurrentUser | null,
): CurrentUser {
  const mapped = mapMembershipToAuthUser(membership);
  if (!existing || existing.id !== mapped.id) return mapped;
  return {
    ...mapped,
    // membership 自助头像优先;未设置时保留既有展示值。
    avatar: mapped.avatar ?? existing.avatar,
    defaultModel: existing.defaultModel,
    defaultEffort: existing.defaultEffort,
    passportId: mapped.passportId || existing.passportId,
  };
}

export function setAccountSwitchTeardown(teardown: AccountSwitchTeardown | null): void {
  accountSwitchTeardown = teardown;
}

export function setAuthSessionTeardown(teardown: AuthSessionTeardown | null): void {
  authSessionTeardown = teardown;
}

// ── User-level API key sync ─────────────────────────────────────────────────
//
// 已移除。XD 网关 key / Mivo key 均为 **本地 only**(Electron safeStorage),
// 从不同步到服务器,因此登录 / 冷启动不再从服务器拉 key 写本地。新设备 / 新登录
// 需用户在本机重新填入 key。renderer 侧 useApiKey / useMivoApiKey 同为本地 only。

// ── System-browser OAuth / SSO ─────────────────────────────────────────────
//
// 两条回调链路,由端点清单的 authDesktopCallbackUrl 决定走哪条:
//  - 非空 → 托管回调(hosted):redirect_uri 指向 auth-server 自有域名下的固定
//    地址,服务端暂存授权码、客户端轮询取回。浏览器全程停在自有域名上,地址栏
//    与浏览历史里不再出现 127.0.0.1 和授权码,唤起 app 的系统弹框显示的也是域名。
//  - 空 → RFC 8252 loopback(现状):本机起随机端口 HTTP server 接回调。
//
// 清单字段同时充当灰度与回滚开关:服务端侧出问题时清空该字段即可回到 loopback,
// 客户端不必发版。两条链路共用同一套取消 / 超时预算与返回契约。

const BROWSER_AUTH_TIMEOUT_MS = 5 * 60_000;
const browserAuthorizationSlot = createAuthBrowserAuthorizationSlot();

// Dev-only loopback bridge seam(v6.13,PR3):可注入纯 helper 形态,slot 逻辑在
// authLoopbackCallback.ts(可单测),此处静态注入 app.isPackaged——packaged 构建
// register 拒绝、attach/notify 全 no-op,整条路径不可达。fixture 经 register
// 注入后只拿得到 ①进程内 error 触发入口 ②渲染完成的 HTML;state/授权码不经
// bridge 落盘(state 仅进程内内存传递)。
const authLoopbackDevBridgeSlot = createAuthLoopbackDevBridgeSlot(() => app.isPackaged);

/** 附录 A browser-callback bridge fixture 的唯一注入入口(dev-only)。 */
export function registerAuthLoopbackDevBridge(bridge: AuthLoopbackDevBridge): boolean {
  return authLoopbackDevBridgeSlot.register(bridge);
}

interface BrowserAuthorizationInput {
  kind: 'social' | 'sso';
  providerOrConnectionId: string;
  codeChallenge: string;
  state: string;
}

/** 可被 abort 提前唤醒的等待(轮询间隔用;取消后立即 resolve,不 reject)。 */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    // finish 幂等:abort 与 timeout 都可能触发它,重复 resolve 无副作用但仍显式挡掉。
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    // 注册后再查一次。当前 executor 全程同步、abort 插不进来,但这层防御让「将来有人
    // 在中间加了 await」不会静默退化成「取消要等满一个轮询间隔」。
    if (signal.aborted) finish();
  });
}

/**
 * 托管回调链路:打开系统浏览器后轮询 auth-server 取回授权码。
 *
 * 这里不起本地监听、也不渲染回调页——结果页由服务端在自有域名下托管。
 * redirect_uri 原样使用清单值(必须与服务端 allowlist 逐字符一致,不做拼接)。
 *
 * 注意本链路**不复用**调用方传进来的 `state`:那个值会进浏览器地址栏与导航历史,
 * 拿它当取回凭据就能被旁观者抢先消费(见 createDesktopPollCredentials 的说明)。
 * 这里另生成一对凭据,只把哈希后的 clientState 交给 authorize。
 */
async function openHostedBrowserAuthorization(
  input: BrowserAuthorizationInput,
  redirectUri: string,
  signal: AbortSignal,
): Promise<{ code: string } | { error: string }> {
  if (signal.aborted) return { error: 'USER_CANCELLED' };

  const { clientState, pollSecret } = createDesktopPollCredentials();
  const client = createAuthClient();
  const authUrl = client.buildAuthorizeUrl({ ...input, state: clientState, redirectUri });

  // 整次尝试共用一个截止时间:唤起浏览器与随后的轮询都从这份预算里花,和 loopback
  // 分支「先起 timer 再 openExternal」的语义对齐。
  const deadline = Date.now() + BROWSER_AUTH_TIMEOUT_MS;

  // shell.openExternal 必须与取消/超时竞速。它在某些环境下会长时间不返回(系统
  // 默认浏览器正在冷启动、handler 注册异常等),而这一步发生在轮询开始之前——
  // 若只是 await 它,取消信号和五分钟预算都够不着,cancel-browser 会一直等在同一个
  // 未 settle 的登录动作上。
  const launchDeadline = AbortSignal.timeout(BROWSER_AUTH_TIMEOUT_MS);
  const launched = await raceAuthBrowserCancellation(
    shell.openExternal(authUrl).then(
      () => ({ ok: true }) as const,
      (error: unknown) => {
        log.warn('open auth URL in system browser failed', error);
        return { ok: false } as const;
      },
    ),
    AbortSignal.any([signal, launchDeadline]),
  );
  // 取消与超时都收敛成 USER_CANCELLED(renderer 特意不展示它),与 loopback 一致。
  if (launched.cancelled) return { error: 'USER_CANCELLED' };
  if (!launched.value.ok) return { error: 'BROWSER_OPEN_FAILED' };

  return runHostedCallbackPolling({
    poll: async () => {
      try {
        return await client.pollDesktopAuthorization(pollSecret, { signal });
      } catch (error) {
        // 单次失败不等于登录失败(轮询本身有连续失败预算),但静默会让线上登录
        // 问题无从排查。取消引发的中断不是故障,不记。错误对象只含固定文案与
        // 错误码,不含 state / 授权码。
        if (!signal.aborted) log.warn('hosted auth callback poll failed', error);
        throw error;
      }
    },
    sleep: (ms) => sleepUnlessAborted(ms, signal),
    now: () => Date.now(),
    signal,
    // 扣掉唤起浏览器已经花掉的时间,整次尝试仍只有一个五分钟预算。
    timeoutMs: Math.max(0, deadline - Date.now()),
  });
}

/** 按端点清单分流到托管回调或 loopback(语义见本节顶部注释)。 */
async function openSystemBrowserAuthorization(
  input: BrowserAuthorizationInput,
  signal: AbortSignal,
): Promise<{ code: string } | { error: string }> {
  const hostedCallbackUrl = getClientEndpoint('authDesktopCallbackUrl');
  return hostedCallbackUrl
    ? openHostedBrowserAuthorization(input, hostedCallbackUrl, signal)
    : openLoopbackBrowserAuthorization(input, signal);
}

async function openLoopbackBrowserAuthorization(
  input: BrowserAuthorizationInput,
  signal: AbortSignal,
): Promise<{ code: string } | { error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    // 回调页语言跟随 app 当前 UI 语言(main 迷你 i18n 复用 renderer 五语文案,
    // {{appName}} 由 t() 注入品牌名);成功 / 失败分别渲染,失败附原始错误码。
    // 抽成局部渲染器供真实 HTTP 回调与 dev bridge 触发路径共用(同一 HTML)。
    const renderCallbackPage = (result: { code: string } | { error: string }): string => {
      const isError = 'error' in result;
      return renderAuthLoopbackPage({
        htmlLang: getResolvedMainLocale(),
        variant: isError ? 'error' : 'success',
        title: t(isError ? 'login.browserCallback.errorTitle' : 'login.browserCallback.successTitle'),
        body: t(isError ? 'login.browserCallback.errorBody' : 'login.browserCallback.successBody'),
        detail: isError ? result.error : undefined,
        action: {
          href: buildFocusDeepLink('desktop-login'),
          label: t('login.browserCallback.returnButton'),
        },
      });
    };
    const server = createServer((req, res) => {
      if (settled || !req.url) {
        res.writeHead(404).end();
        return;
      }
      const result = parseAuthLoopbackCallback(req.url, input.state);
      if (!result) {
        res.writeHead(404).end();
        return;
      }
      const html = renderCallbackPage(result);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      authLoopbackDevBridgeSlot.notifyHtml(html);
      finish(result);
    });

    const finish = (result: { code: string } | { error: string }) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      if (timeout !== null) clearTimeout(timeout);
      if (server.listening) {
        // The browser may keep the callback connection alive briefly after
        // rendering "return to Cindy". Closing belongs to cleanup; do not hold
        // authorization-code exchange or cancellation behind its callback.
        server.close();
      }
      resolve(result);
    };

    const cancel = () => finish({ error: 'USER_CANCELLED' });
    signal.addEventListener('abort', cancel, { once: true });

    server.once('error', (error) => {
      log.warn('auth loopback listener failed', error);
      finish({ error: 'CALLBACK_LISTENER_FAILED' });
    });
    if (signal.aborted) {
      cancel();
      return;
    }
    server.listen(0, '127.0.0.1', () => {
      if (settled) {
        server.close();
        return;
      }
      const address = server.address() as AddressInfo;
      const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
      const authUrl = createAuthClient().buildAuthorizeUrl({ ...input, redirectUri });
      // dev bridge 挂接(packaged no-op):fixture 触发与真实回调走同一渲染/finish。
      authLoopbackDevBridgeSlot.attach(finish, renderCallbackPage);
      timeout = setTimeout(() => finish({ error: 'USER_CANCELLED' }), BROWSER_AUTH_TIMEOUT_MS);
      void shell.openExternal(authUrl).catch((error) => {
        log.warn('open auth URL in system browser failed', error);
        finish({ error: 'BROWSER_OPEN_FAILED' });
      });
    });
  });
}

// ── Refresh scheduling ──────────────────────────────────────────────────────

function scheduleRefresh(token: string): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64').toString('utf-8'),
    );
    const delay = (payload.exp - 300) * 1000 - Date.now();
    if (delay <= 0) {
      refresh();
    } else {
      refreshTimer = setTimeout(() => refresh(), delay);
    }
  } catch {
    // Invalid JWT format — skip scheduling
  }
}

/**
 * 运行时 refresh 瞬时失败后的补救重排。
 *
 * 正常路径的 refreshTimer 在触发时即消耗;若这次 refresh 因网络抖动 / 429 / 5xx 失败,
 * 不重排的话就再没有下一次尝试,access token 会在几分钟后静默过期(下一次自愈要等
 * 系统 resume 或冷启动)。access token 有 5 分钟的提前刷新余量,60s 间隔在过期前还有
 * 数次机会;确定性凭据失效不走这里(直接 clearAuth + 弹重登)。
 */
const RUNTIME_REFRESH_RETRY_MS = 60_000;
const REFRESH_TOKEN_REPLACEMENT_RETRY_LIMIT = 2;
const COLD_START_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS = [100, 250] as const;
const RUNTIME_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS = [250, 1000] as const;
const REPLACEMENT_INTEGRATION_RELOAD_RETRY_DELAYS_MS = [250, 1000, 3000] as const;

// 运行时 replacement refresh 成功后,会先持久化新 refresh token 再做 /me 身份核对。
// 如果 /me 或账号切换 teardown 瞬时失败,下一轮 refresh 读到的 token 已不再表现为
// replacementRetries > 0;用这个进程内标记强制下一轮继续 /me,避免 accessToken 切到 B
// 但 currentUser/renderer 仍停在 A。
let persistedRefreshTokenNeedsIdentityCheck = false;
// 当前进程最后一次接受/写入的 refresh token。运行时 refresh 开始前如果磁盘 token
// 已经被另一个共享 userData 实例换掉,即使本轮没有走 replacement-retry,也必须 /me
// 核对身份,避免 currentUser 仍是 A 但 accessToken 已切到 B。
let lastAcceptedRefreshToken: string | null = null;
let replacementIntegrationReloadTimers: ReturnType<typeof setTimeout>[] = [];

/**
 * 冷启动 auth 流程最多阻塞 splash 的时长。refresh 是 token-rotating 端点,禁止
 * per-request abort(见 requestAuthRefresh),黑洞 / captive-portal 网络下请求会
 * 无限挂起——没有这道闸,initialize() 永不 resolve,splash 永不淡出。超时后先以
 * 未登录返回解锁 UI,流程继续后台跑:迟到成功会正常广播登录态,renderer 的
 * GuestRoute 自动把用户从登录页带回主界面。20s 覆盖正常慢网(transient retry
 * 1s+2s 退避 × 3 次请求 + /me 的 15s 上限之内的绝大多数组合)。
 */
const COLD_START_AUTH_GATE_TIMEOUT_MS = 20_000;

/**
 * auth 状态代际计数:login / clearAuth(logout、会话过期、账号切换)
 * 每次改写全局登录态时 +1。冷启动流程在开跑时快照代际,超时转后台后的每个状态
 * 写入点都先核对代际——用户在流程挂起期间手动登录 / 登出过,则迟到结果整体丢弃,
 * 绝不覆盖更新的登录态或删除新写入的 refresh token。
 */
let authStateEpoch = 0;

/**
 * 登录态落地后异步同步灰度标记，不阻塞 renderer 进入主界面。
 *
 * expectedAuthEpoch + expectedUserId 防止慢响应在登出或换账号之后覆盖新身份；
 * 请求失败/响应非法则保留旧值，遵守 feature-flags 服务端契约。
 */
function scheduleCanaryFlagSync(input: {
  token: string;
  expectedAuthEpoch: number;
  expectedUserId: string;
}): void {
  void syncCanaryFlagAfterAuth(input, {
    fetchFeatureFlags: (token) =>
      apiFetch('/api/user/feature-flags', {
        token,
        baseUrl: getClientEndpoint('oauthBrokerApiBaseUrl'),
      }),
    readCurrentAuthIdentity: () => ({
      authEpoch: authStateEpoch,
      userId: currentUser?.id ?? null,
    }),
    persistFlag: canaryFlagStore.sync,
  })
    .then((outcome) => {
      if (outcome.kind === 'synced') {
        log.info('canary feature flag synced: isCanary=%s', outcome.isCanary);
        // feature-flags 在登录态落地后异步返回；立即推送新快照，让 renderer
        // 的 Canary 装饰不必等到下一次 refresh / 重启才更新。
        notifyRenderer();
        return;
      }
      if (outcome.reason === 'stale-auth') {
        log.debug('discarded stale canary feature-flags response');
        return;
      }
      log.warn(
        'canary feature flag sync preserved local value: reason=%s status=%s',
        outcome.reason,
        outcome.status ?? '<none>',
      );
    })
    .catch((err) => {
      // persistFlag currently absorbs filesystem errors, but keep this boundary
      // non-fatal if that implementation changes later.
      log.error('canary feature flag sync threw unexpectedly', err);
    });
}

/**
 * 冷启动流程的进程内去重:主窗超时转后台之后,副窗 / 右侧栏窗口 mount 再调
 * initialize() 时复用同一个 in-flight promise(各自套各自的超时),避免两条流程
 * 并发轮换同一枚 refresh token 互相打成 INVALID_REFRESH_TOKEN。
 */
let coldStartAuthInFlight: Promise<AuthState> | null = null;

function scheduleRefreshRetryAfterTransientFailure(): void {
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => void refresh(), RUNTIME_REFRESH_RETRY_MS);
}

function clearReplacementIntegrationReloadTimers(): void {
  for (const timer of replacementIntegrationReloadTimers) {
    clearTimeout(timer);
  }
  replacementIntegrationReloadTimers = [];
}

async function runAuthRefreshWithReplacementRetry(
  initialRefreshToken: string,
  opts: {
    phase: 'cold-start' | 'runtime';
    withTransientRetry: boolean;
    rateLimitDelayMs?: number;
    onFailure?: (info: RefreshFailureInfo) => void;
  },
): Promise<{
  result: AuthRefreshResult;
  attempts: number;
  requestedToken: string;
  replacementRetries: number;
  replacementRetryExhausted: boolean;
  failureAction?: RefreshFailureAction;
}> {
  const run = await runRefreshWithReplacementRetry(initialRefreshToken, {
    doRefresh: requestAuthRefresh,
    readLatestStoredToken: () => readSafe(REFRESH_TOKEN_KEY),
    transientRetry: opts.withTransientRetry
      ? {
          rateLimitDelayMs: opts.rateLimitDelayMs,
          onFailure: opts.onFailure,
        }
      : undefined,
    maxReplacementRetries: REFRESH_TOKEN_REPLACEMENT_RETRY_LIMIT,
    replacementRecheck: {
      delaysMs:
        opts.phase === 'cold-start'
          ? COLD_START_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS
          : RUNTIME_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS,
      onBeforeRecheck: ({ status, code, delayMs }) =>
        log.warn(
          `${opts.phase} refresh: stale refresh token failed status=${status} code=${code ?? '<none>'}, no replacement token on disk yet — re-reading after ${delayMs}ms before clearing auth`,
        ),
    },
    onReplacementRetry: ({ status, code }) =>
      log.warn(
        `${opts.phase} refresh: replacement-retry supersedes definitive failure status=${status} code=${code ?? '<none>'} — retrying with token written by another app instance`,
      ),
  });

  if (run.replacementRetryExhausted) {
    log.warn(
      `${opts.phase} refresh: stale refresh token kept being replaced after ${run.replacementRetries} replacement retries; keeping latest token on disk`,
    );
  }

  return run;
}

// ── Renderer notification ───────────────────────────────────────────────────

/**
 * 广播到所有未销毁的 BrowserWindow。
 *
 * 不能用 `BrowserWindow.getAllWindows()[0]` —— voice-input overlay
 * (`voice-input/global.ts:prewarmGlobalVoiceInputOverlay`) 启动期就 prewarm
 * 出一个 hidden + skipTaskbar + focusable:false 的 BrowserWindow,[0] 经常
 * 是它。这条踩坑在 `bootstrap-electron.ts:557-559` 已经为 `focusMainWindow`
 * 显式记录过;这里曾经用 [0] 发 'auth:state-change',结果是登出后真正的
 * 主窗 renderer 永远收不到 state-change,`isAuthenticated` 留在 true,
 * ProtectedRoute 不跳 /login —— 表现就是"settings 里点退出后界面没反应"。
 *
 * 项目内 IM / spend / maker / mcp-integrations 等广播器都是 forEach 全部
 * 窗口,本函数沿用同样语义;overlay 等无 listener 的窗口会忽略该事件,无副作用。
 */
function broadcastToRenderers(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (err) {
      log.warn(`broadcast '${channel}' to window failed (non-fatal)`, err);
    }
  }
}

/**
 * 当前登录态快照(所有状态出口共用)。
 *
 * `currentUser` 即服务端真值的合并展示态(auth-server membership 为主、
 * product /me 增强字段与头像回落)。2026-07 自助资料上线后,名字/头像
 * 修改直接写 auth-server(updateServerProfile),本地覆写层已退役。
 */
function snapshotAuthState(): AuthState {
  const appSession = getActiveAppSession();
  const isCloudAuthenticated =
    appSession.mode === 'cloud' && accessToken !== null && currentUser !== null;
  return {
    // orgSlug 在出口处统一从当前 access token 解码注入(token 与 currentUser
    // 总是成对更新,快照读取时两者一致)。这里显式投影公开字段,避免 main-only
    // membershipDisplayName 意外透传到 renderer。
    user: currentUser
      ? {
          id: currentUser.id,
          name: currentUser.name,
          avatar: currentUser.avatar,
          email: currentUser.email,
          defaultModel: currentUser.defaultModel,
          defaultEffort: currentUser.defaultEffort,
          membershipKind: currentUser.membershipKind,
          membershipRole: currentUser.membershipRole,
          orgId: currentUser.orgId,
          orgName: currentUser.orgName,
          orgSlug: decodeAccessTokenOrgSlug(accessToken),
          orgLogoUrl: currentUser.orgLogoUrl,
          passportId: currentUser.passportId,
        }
      : null,
    mode: appSession.mode,
    dataOwnerId: appSession.dataOwnerId,
    canEnterApp: appSession.mode !== 'signed-out',
    isAuthenticated: isCloudAuthenticated,
    isCanary: currentUser !== null && canaryFlagStore.read(),
    deviceId,
    hasAccountDeletionReceipt: readSafe(ACCOUNT_DELETION_RECEIPT_KEY) !== null,
    accountDeletionRestored: accountDeletionRestoredNoticePending,
  };
}

/** Logged-out projection used by stale/timeout paths that must not expose newer auth state. */
function snapshotLoggedOutAuthState(): AuthState {
  return {
    user: null,
    mode: 'signed-out',
    dataOwnerId: null,
    canEnterApp: false,
    isAuthenticated: false,
    isCanary: false,
    deviceId,
    hasAccountDeletionReceipt: readSafe(ACCOUNT_DELETION_RECEIPT_KEY) !== null,
    accountDeletionRestored: false,
  };
}

function notifyRenderer(): void {
  broadcastToRenderers('auth:state-change', snapshotAuthState());
}

function notifyRendererAuthBoundaryPending(): void {
  broadcastToRenderers('auth:state-change', snapshotLoggedOutAuthState());
}

/**
 * Preserve the dedicated forced-logout UX while leaving copy localization to
 * the renderer. Never expose auth-server messages or internal reason codes —
 * `reason` is a client-side classification enum (SessionExpiredReason), not a
 * server string, so the renderer can pick a localized "signed out elsewhere /
 * expired / account unavailable" copy without leaking internals.
 */
function notifySessionExpired(reason: SessionExpiredReason = 'unknown'): void {
  broadcastToRenderers('auth:session-expired', { message: '', reason });
}

// ── In-process auth state subscription ─────────────────────────────────────
//
// In addition to renderer broadcast (auth:state-change), main-process modules
// can subscribe to auth state transitions here. Used by main/im to
// disconnect the IM channel on logout and re-init / re-sync whitelist on
// login. Listeners are called synchronously after `currentUser` is updated;
// they MUST NOT throw.

type AuthListener = (state: AuthState) => void;
const authStateListeners = new Set<AuthListener>();

export function onAuthStateChange(listener: AuthListener): () => void {
  authStateListeners.add(listener);
  return () => authStateListeners.delete(listener);
}

function notifyAuthListeners(): void {
  const state = snapshotAuthState();
  for (const l of authStateListeners) {
    try {
      l(state);
    } catch (err) {
      log.error('auth state listener threw (non-fatal)', err);
    }
  }
}

// ── Auth state management ───────────────────────────────────────────────────

async function clearPerAccountIntegrations(): Promise<void> {
  // 登录账号级集成清单当前为空(2026-07-17 起):
  // - 飞书 token 链随 refresh-feishu 退役——xd-feishu 意识改走 OAuth broker,
  //   凭证是机器级意识保险库,登出不清(与 Atlassian / Slack / Google 同语义);
  // - Jira/Confluence 清理已随 lizi_jira 退役(2026-07-14);
  // - Slack 官方 MCP 清理已随 slack-official 退役(2026-07-15)。
  // 骨架保留:未来出现真正跟登录账号绑定的集成时在此登记,refresh() 的
  // 账号切换 teardown 守卫链依赖本函数的调用位。
}

function clearPerAccountIntegrationsInBackground(): void {
  void clearPerAccountIntegrations().catch((err) => {
    log.error('clear per-account integrations failed', err);
  });
}

/** Clear renderer-safe login progress and all main-only login tickets. */
function resetLoginFlowState(): void {
  loginFlowState = null;
  providerConfig = null;
  discoveredMethods = [];
  pendingAccountToken = null;
  pendingLoginTicket = null;
  pendingBindTicket = null;
  pendingSsoVerificationTicket = null;
  pendingAccountDeletionRestored = false;
}

async function reloadPerAccountIntegrationsFromDisk(_accessToken: string | null): Promise<void> {
  void _accessToken;
  // 登录账号级集成清单当前为空(见 clearPerAccountIntegrations 顶注)。
  // 骨架与重试调度保留:替换式刷新的账号切换路径依赖本函数的调用位与
  // 'after-integration-reload' 守卫点。
}

function scheduleReplacementIntegrationReloadRetries(userId: string): void {
  clearReplacementIntegrationReloadTimers();
  const timers: ReturnType<typeof setTimeout>[] = [];
  for (const delayMs of REPLACEMENT_INTEGRATION_RELOAD_RETRY_DELAYS_MS) {
    const timer = setTimeout(() => {
      replacementIntegrationReloadTimers = replacementIntegrationReloadTimers.filter(
        (candidate) => candidate !== timer,
      );
      void (async () => {
        if (currentUser?.id !== userId || !accessToken) return;
        await reloadPerAccountIntegrationsFromDisk(accessToken);
      })().catch((err) => {
        log.error(
          `delayed integration reload after replacement account switch failed delayMs=${delayMs}`,
          err,
        );
      });
    }, delayMs);
    timers.push(timer);
  }
  replacementIntegrationReloadTimers = timers;
}

function clearAuth(
  opts: {
    notify?: boolean;
    nextMode?: Extract<AppSessionMode, 'signed-out' | 'local'>;
    /**
     * 为 true 时不删除磁盘上的 refresh token 文件。仅用于「凭证已确认缺席」的
     * 过期路径(credential-lost):此刻磁盘上没有属于本进程的 token 可清,而共享
     * userData 的另一个实例可能刚好在登出→重登间隙写入了新 token——无条件
     * removeSafe 会把别人的新 token 删掉,把对方也踢成半死。
     */
    preservePersistedRefreshToken?: boolean;
    /**
     * Clear auth fields immediately, but defer publishing the signed-out
     * owner until the enclosing teardown completes. Owner-bound consumers are
     * blocked while the boundary is pending so they cannot enter a temporary
     * namespace during teardown.
     */
    deferSessionCommit?: boolean;
  } = {},
): void {
  const notify = opts.notify ?? true;
  authStateEpoch += 1; // 迟到的冷启动流程从此作废(见 authStateEpoch 注释)
  accessToken = null;
  pendingAccountToken = null;
  currentUser = null;
  accountDeletionRestoredNoticePending = false;
  confirmedAccountDeletionAuthIdentity = null;
  resetLoginFlowState();
  persistedRefreshTokenNeedsIdentityCheck = false;
  lastAcceptedRefreshToken = null;
  clearReplacementIntegrationReloadTimers();
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (!opts.preservePersistedRefreshToken) {
    removeSafe(REFRESH_TOKEN_KEY);
    removeSafe(LEGACY_ACCOUNT_REFRESH_TOKEN_KEY);
    removeSafe(LEGACY_REFRESH_TOKEN_KEY);
  }
  // 未登录时固定使用 stable；同步中的旧请求会被 authStateEpoch 守卫丢弃。
  canaryFlagStore.clear();
  // provider key(XD / Mivo)是绑定账号的本机密钥,**不在登出时清** —— 同账号重新登录 /
  // 会话过期重登需保留,避免每次都重填(本地 only 后服务器已无副本可拉回)。换账号导致的
  // 串号边界改由 login / 冷启动时 providerSecretStore.reconcileOwner 处理:owner 变了才清。
  // clearAuth 必须保持同步(大量调用方依赖立即 notify),但 promise rejection 仍要吞掉并记日志。
  clearPerAccountIntegrationsInBackground();
  if (!opts.deferSessionCommit) {
    commitActiveAppSession(opts.nextMode ?? 'signed-out');
  }
  if (notify) {
    notifyRenderer();
    notifyAuthListeners();
  }
}

/**
 * Expire a live cloud session after a definitive refresh failure.
 *
 * Auth expiry is an owner boundary just like logout: clear the auth state
 * before awaiting teardown so no new owner-bound work can start, then stop
 * every account-scoped runtime and publish the final signed-out state.
 */
async function expireRuntimeAuth(
  previousUserId: string,
  reason: SessionExpiredReason = 'unknown',
  opts: { preservePersistedRefreshToken?: boolean } = {},
): Promise<void> {
  const releaseBoundary = beginAppSessionBoundary();
  notifyRendererAuthBoundaryPending();
  clearAuth({
    notify: false,
    preservePersistedRefreshToken: opts.preservePersistedRefreshToken,
    deferSessionCommit: true,
  });
  try {
    if (accountSwitchTeardown) {
      await accountSwitchTeardown({ previousUserId, nextUserId: 'signed-out' });
    } else {
      log.warn('runtime auth expiry teardown hook is not registered; falling back to localDb close');
    }
  } catch (err) {
    // A teardown failure must not restore an expired credential. Continue with
    // the local DB close and signed-out notifications, while keeping evidence
    // for diagnosing the stale owner runtime.
    log.error('runtime auth expiry owner teardown failed', err);
  }
  try {
    closeLocalDb();
  } catch (err) {
    log.error('closeLocalDb on runtime auth expiry failed', err);
  } finally {
    commitActiveAppSession('signed-out');
    releaseBoundary();
    notifyRenderer();
    notifyAuthListeners();
    notifySessionExpired(reason);
  }
}

/**
 * Terminal auth rejection (deleted/disabled account or definitively invalid
 * credentials) must cross the same full account boundary as an explicit
 * logout. The single-flight guard prevents parallel API/refresh failures from
 * racing teardown and local credential deletion.
 */
export function invalidateSession(reason: string): Promise<void> {
  if (sessionInvalidationPromise) return sessionInvalidationPromise;

  // Schedule teardown one microtask later so the single-flight promise can be
  // published and credentials can be cleared synchronously first. API calls
  // that detect the rejection may themselves run inside a scheduler/service
  // being torn down; they must be able to unwind without a stop-await cycle.
  const releaseBoundary = beginAppSessionBoundary();
  const run = Promise.resolve().then(async () => {
    try {
      if (authSessionTeardown) {
        await authSessionTeardown(reason);
      } else {
        log.warn(
          `auth session teardown hook is not registered for ${reason}; falling back to localDb close`,
        );
      }
    } catch (error) {
      log.error(`auth session teardown on ${reason} failed (non-fatal)`, error);
    }
    try {
      closeLocalDb();
    } catch (error) {
      log.error(`closeLocalDb on ${reason} failed (non-fatal)`, error);
    } finally {
      commitActiveAppSession('signed-out');
      releaseBoundary();
    }
  });
  sessionInvalidationPromise = run;
  // Keep the current renderer surface in place until its session-expired
  // dialog is acknowledged. Main-process consumers still need the immediate
  // logged-out transition so no account-scoped work can restart meanwhile.
  clearAuth({ notify: false, deferSessionCommit: true });
  notifyAuthListeners();
  // invalidateSession 的 reason 是调用方语境串而非服务端失效码,这里只把
  // 「账号不可用」显式归类,其余统一走通用过期文案。
  notifySessionExpired(reason === 'account-unavailable' ? 'account-unavailable' : 'unknown');

  const clearIfCurrent = (): void => {
    if (sessionInvalidationPromise === run) sessionInvalidationPromise = null;
  };
  void run.then(clearIfCurrent, clearIfCurrent);
  return run;
}

/** Ensure a terminal auth teardown has finished before a new local owner commits. */
export async function waitForSessionInvalidation(): Promise<void> {
  if (sessionInvalidationPromise) await sessionInvalidationPromise;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getAccessToken(): string | null {
  return accessToken;
}

/** SkillHub v0.2.1: 返回当前登录用户 id（cuid），未登录时返回 null */
export function getCurrentUserId(): string | null {
  return currentUser?.id ?? null;
}

/**
 * Public issue attribution may only use the raw auth membership display name.
 * UI fallbacks (`email` / "Cindy") are intentionally excluded for privacy.
 */
export function getCurrentMembershipDisplayName(): string | undefined {
  const displayName = currentUser?.membershipDisplayName.trim();
  return displayName || undefined;
}

/** SkillHub 跨设备识别：本机 deviceId（machineIdSync 结果），登录前后都可用 */
export function getDeviceId(): string {
  return deviceId;
}

export function getAuthState(): AuthState {
  return snapshotAuthState();
}

export function getCurrentDataOwnerId(): string | null {
  return getActiveAppSession().dataOwnerId;
}

export function isLocalMode(): boolean {
  return getActiveAppSession().mode === 'local';
}

/** Enter the account-free local session after the host has torn down old runtime state. */
export function enterLocalMode(): AuthState {
  browserAuthorizationSlot.cancelActive();
  // Local mode has a different data owner. Drop process-local generic OAuth
  // tokens before switching the committed owner so cloud credentials cannot
  // be reused by the account-free session.
  getProviderSecretStore().invalidateCaches();
  clearAuth({ notify: false, nextMode: 'local' });
  notifyRenderer();
  notifyAuthListeners();
  return snapshotAuthState();
}

/** Leave local mode without deleting its owner-scoped data. */
export function exitLocalMode(): AuthState {
  if (getActiveAppSession().mode !== 'local') return snapshotAuthState();
  clearAuth({ notify: false, nextMode: 'signed-out' });
  notifyRenderer();
  notifyAuthListeners();
  return snapshotAuthState();
}

function requireAccountDeletionAccessToken(): string {
  if (!accessToken || !currentUser) {
    throw new AuthApiError('UNAUTHENTICATED', 401, 'Account deletion requires an active login');
  }
  return accessToken;
}

function currentAccountDeletionAuthIdentity(): string | null {
  if (!accessToken || !currentUser) return null;
  return currentUser.passportId || currentUser.id;
}

function commitAccountDeletionConfirmation(
  expectedIdentity: string,
  status: AccountDeletionStatus,
): AccountDeletionStatus {
  if (currentAccountDeletionAuthIdentity() !== expectedIdentity) {
    throw new AuthApiError(
      'AUTH_FLOW_SUPERSEDED',
      409,
      'Account deletion was superseded by a newer auth action',
    );
  }
  confirmedAccountDeletionAuthIdentity = expectedIdentity;
  return status;
}

/** Run an authenticated auth-client request through the terminal auth boundary. */
async function runProtectedAuthRequest<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (
      error instanceof AuthApiError &&
      error.statusCode === 401 &&
      error.code === 'ACCOUNT_UNAVAILABLE'
    ) {
      void invalidateSession('account-unavailable');
    }
    throw error;
  }
}

/** Server-controlled visibility and verification channel for personal-account deletion. */
export function getAccountDeletionAvailability(): Promise<AccountDeletionAvailability> {
  const token = requireAccountDeletionAccessToken();
  return runProtectedAuthRequest(() =>
    createAuthClient().getAccountDeletionAvailability(token),
  );
}

/**
 * Request an OTP and persist its receipt before returning display-safe challenge
 * data. The receipt never crosses into renderer and survives the initiating
 * desktop's immediate local logout after confirmation.
 */
export async function requestAccountDeletionChallenge(): Promise<DesktopAccountDeletionChallenge> {
  confirmedAccountDeletionAuthIdentity = null;
  const token = requireAccountDeletionAccessToken();
  const challenge = await runProtectedAuthRequest(() =>
    createAuthClient().requestAccountDeletionChallenge(token),
  );
  if (!writeSafe(ACCOUNT_DELETION_RECEIPT_KEY, challenge.receiptToken)) {
    throw new AuthApiError(
      'ACCOUNT_DELETION_RECEIPT_STORE_FAILED',
      0,
      'Could not securely store the account deletion receipt',
    );
  }
  return {
    challengeId: challenge.challengeId,
    channel: challenge.channel,
    maskedTarget: challenge.maskedTarget,
    expiresAt: challenge.expiresAt,
  };
}

/**
 * Confirm deletion with the main-only receipt. If the response is ambiguous,
 * query that receipt to distinguish an accepted request from a retryable error.
 */
export async function confirmAccountDeletion(input: {
  challengeId: string;
  code: string;
}): Promise<AccountDeletionStatus> {
  const token = requireAccountDeletionAccessToken();
  const expectedIdentity = currentAccountDeletionAuthIdentity();
  if (!expectedIdentity) {
    throw new AuthApiError('UNAUTHENTICATED', 401, 'Account deletion requires an active login');
  }
  confirmedAccountDeletionAuthIdentity = null;
  const receiptToken = readSafe(ACCOUNT_DELETION_RECEIPT_KEY);
  if (!receiptToken) {
    throw new AuthApiError(
      'ACCOUNT_DELETION_RECEIPT_MISSING',
      400,
      'Request a new account deletion challenge',
    );
  }
  const client = createAuthClient();
  let status: AccountDeletionStatus;
  try {
    status = await runProtectedAuthRequest(() =>
      client.confirmAccountDeletion(token, {
        ...input,
        receiptToken,
        acknowledged: true,
      }),
    );
  } catch (error) {
    const ambiguous =
      error instanceof AuthApiError &&
      ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE'].includes(error.code);
    if (!ambiguous) throw error;
    const recovered = await client.getAccountDeletionStatus(receiptToken).catch(() => null);
    if (!recovered || recovered.status === 'cancelled') throw error;
    status = recovered;
  }
  return commitAccountDeletionConfirmation(expectedIdentity, status);
}

/** Query the persisted receipt without requiring an authenticated session. */
export async function getAccountDeletionStatus(): Promise<AccountDeletionStatus | null> {
  const receiptToken = readSafe(ACCOUNT_DELETION_RECEIPT_KEY);
  if (!receiptToken) return null;
  return createAuthClient().getAccountDeletionStatus(receiptToken);
}

export function clearAccountDeletionReceipt(): void {
  removeSafe(ACCOUNT_DELETION_RECEIPT_KEY);
}

/** Consume the successful-login recovery notice exactly once per main process. */
export function consumeAccountDeletionRestoredNotice(): boolean {
  if (!accountDeletionRestoredNoticePending) return false;
  accountDeletionRestoredNoticePending = false;
  return true;
}

/**
 * Clear only local auth after the server accepted deletion. Ordinary logout is
 * deliberately skipped because the refresh family is already revoked and the
 * receipt must remain available on the login screen.
 */
export function isConfirmedAccountDeletionSessionCurrent(): boolean {
  return (
    confirmedAccountDeletionAuthIdentity !== null &&
    currentAccountDeletionAuthIdentity() === confirmedAccountDeletionAuthIdentity
  );
}

export function clearLocalSessionAfterAccountDeletion(): boolean {
  if (!isConfirmedAccountDeletionSessionCurrent()) return false;
  try {
    closeLocalDb();
  } catch (error) {
    log.error('closeLocalDb after account deletion failed', error);
  }
  clearAuth();
  return true;
}

/**
 * 当前展示资料(profileEdit 弹窗预填用)。未登录返回 null。
 */
export function getServerProfile(): { name: string; avatar: string | null } | null {
  if (!currentUser) return null;
  return { name: currentUser.name, avatar: currentUser.avatar };
}

/** PATCH /api/me/profile 的入参(至少提供一个字段;avatarUrl null = 清除头像)。 */
export interface ServerProfilePatch {
  displayName?: string;
  avatarUrl?: string | null;
}

interface PatchProfileResponse {
  membership?: AuthMembership;
  error?: { code?: string; message?: string };
}

export type UpdateServerProfileResult =
  | { ok: true; profile: { name: string; avatar: string | null } }
  | { ok: false; status: number; code?: string };

/**
 * 自助修改昵称/头像:PATCH auth-server /api/me/profile(2026-07 上线,替代
 * 旧的本地覆写方案)。成功后用响应 membership 就地更新 currentUser 并广播
 * 登录态;头像清除(avatarUrl:null)后 UI 回落首字母兜底(产品资料头像
 * 回落已随 /api/user/me 退役)。
 * 网络/服务端失败返回 ok:false(status 0 = 网络层失败),不抛异常——
 * IPC 错误语义由调用方 profileEdit 统一映射。
 */
export async function updateServerProfile(
  patch: ServerProfilePatch,
): Promise<UpdateServerProfileResult> {
  if (!accessToken || !currentUser) {
    return { ok: false, status: 0, code: 'NOT_AUTHENTICATED' };
  }
  const epochAtStart = authStateEpoch;
  const result = await apiFetch<PatchProfileResponse>('/api/me/profile', {
    method: 'PATCH',
    body: patch,
    token: accessToken,
  });
  if (!result.ok) {
    const code = result.data?.error?.code;
    if (result.status === 401 && code === 'ACCOUNT_UNAVAILABLE') {
      void invalidateSession('account-unavailable');
    }
    return { ok: false, status: result.status, ...(code !== undefined ? { code } : {}) };
  }
  const membership = result.data?.membership;
  // 请求期间登出/换号则不回写全局态(服务端已改成功,下次登录自然拉到新值)。
  if (
    membership &&
    authStateEpoch === epochAtStart &&
    currentUser !== null &&
    currentUser.id === membership.id
  ) {
    currentUser = {
      ...currentUser,
      name: membership.displayName || currentUser.name,
      membershipDisplayName: membership.displayName,
      avatar: membership.avatarUrl ?? null,
    };
    notifyRenderer();
    notifyAuthListeners();
    return { ok: true, profile: { name: currentUser.name, avatar: currentUser.avatar } };
  }
  return {
    ok: true,
    profile: {
      name: membership?.displayName ?? '',
      avatar: membership?.avatarUrl ?? null,
    },
  };
}

export async function initialize(options: AuthInitializeOptions = {}): Promise<AuthState> {
  // Local mode is a committed account-free session. It must win before any
  // persisted cloud refresh token is inspected or any auth network call runs.
  if (getActiveAppSession().mode === 'local') {
    return snapshotAuthState();
  }
  // 进程内已登录快路径:auth 状态是 main 进程全局的,主窗登录后其它 renderer
  // (会话多开副窗 / 右侧栏子窗口)mount 时各自都会调一次 auth:initialize ——
  // 没有这条快路径,每个新窗口都会重跑一整轮网络 refresh(token 轮换 + /me),
  // 期间该窗口 isAuthenticated=false,慢网/瞬时失败会闪现登录页;且冗余的
  // refresh 轮换还有并发失效风险。已登录时直接回缓存态,零网络、无闪屏。
  // 冷启动时 accessToken/currentUser 必为空,不影响下方完整初始化流程
  // (relogin marker 消费、持久化 refresh_token 校验)。
  if (accessToken && currentUser) {
    commitActiveAppSession('cloud', currentUser.id);
    return snapshotAuthState();
  }

  // release-relogin-on-update: if the auto-updater dropped a relogin marker
  // for *this* version, wipe persisted auth and force the user back to the
  // OAuth flow. The flag is one-shot: once consumed, subsequent launches
  // see no marker and no refresh_token, so the user stays logged out
  // naturally until they sign in (rather than getting kicked every launch).
  const reloginFlag = readReloginFlag();
  if (reloginFlag && reloginFlag.version === app.getVersion()) {
    log.info(
      'relogin marker hit for v%s — clearing persisted auth',
      reloginFlag.version,
    );
    lastAcceptedRefreshToken = null;
    removeSafe(REFRESH_TOKEN_KEY);
    pendingAccountToken = null;
    removeSafe(LEGACY_ACCOUNT_REFRESH_TOKEN_KEY);
    removeSafe(LEGACY_REFRESH_TOKEN_KEY);
    clearReloginFlag();
    commitActiveAppSession('signed-out');
    return snapshotLoggedOutAuthState();
  }

  // Old Feishu-auth refresh tokens are intentionally not portable to auth-server.
  removeSafe(LEGACY_REFRESH_TOKEN_KEY);
  // 早期测试版曾持久化 account refresh token；该会话现已收窄为登录期内存态。
  removeSafe(LEGACY_ACCOUNT_REFRESH_TOKEN_KEY);
  const storedToken = readSafe(REFRESH_TOKEN_KEY);
  if (!storedToken) {
    commitActiveAppSession('signed-out');
    return snapshotLoggedOutAuthState();
  }

  // 进程内去重:主窗流程还挂着(黑洞网络)时,副窗 / 右侧栏窗口 mount 触发的
  // initialize() 复用同一个 in-flight promise,避免并发轮换同一枚 refresh token。
  if (coldStartAuthInFlight === null) {
    coldStartAuthInFlight = runColdStartRefreshFlow(storedToken).finally(() => {
      coldStartAuthInFlight = null;
    });
  }
  // 黑洞 / captive-portal 网络护栏:限时等待,超时先以未登录返回解锁 splash,
  // 流程继续后台跑;迟到成功由流程内部广播登录态(renderer 自动跳回主界面)。
  const coldStartCompletion = coldStartAuthInFlight;
  return awaitWithStartupTimeout(coldStartCompletion, {
    timeoutMs: COLD_START_AUTH_GATE_TIMEOUT_MS,
    onTimeout: () => {
      options.onColdStartPending?.(coldStartCompletion);
      log.warn(
        `cold-start auth still pending after ${COLD_START_AUTH_GATE_TIMEOUT_MS}ms — unblocking startup as logged out, flow continues in background`,
      );
      return snapshotLoggedOutAuthState();
    },
    onLateResult: (state) =>
      log.info(
        `cold-start auth settled after startup gate timeout — isAuthenticated=${state.isAuthenticated}`,
      ),
    onLateError: (err) =>
      log.error('cold-start auth flow threw after startup gate timeout', err),
  });
}

/**
 * 冷启动 refresh 流程本体(从 initialize() 提取)。超时护栏可能把它转入后台继续
 * 执行——彼时用户已能操作登录页,因此每个全局状态写入点之前都必须核对
 * authStateEpoch:用户手动登录 / 登出过就整体丢弃迟到结果,绝不覆盖更新的登录态、
 * 不删除新登录写入的 refresh token(见 authStateEpoch 常量注释)。
 */
async function runColdStartRefreshFlow(storedToken: string): Promise<AuthState> {
  const epochAtStart = authStateEpoch;
  let releaseBoundary: (() => void) | null = null;
  const epochChanged = (point: string): boolean => {
    if (authStateEpoch === epochAtStart) return false;
    log.warn(
      `cold-start refresh flow superseded by manual auth change (${point}) — discarding late result`,
    );
    return true;
  };

  try {
    // 瞬时失败(断网 / 5xx)短暂退避后重试,而不是一次失败就以未登录进登录页——
    // 否则冷启动撞上一次网络抖动,用户看到的就是「重启莫名被登出、重开一次又好了」。
    // 注意:
    //  - refresh 是 token-rotating 端点,不设 per-request timeout(timeoutMs:0)——
    //    若服务端已轮换但客户端 abort,重试以旧 token 触发 INVALID_REFRESH_TOKEN 永久登出。
    //  - 429 不重试(rateLimitDelayMs:0):服务端窗口 60s,短退避必然还在同一窗口内失败,
    //    长退避(60s)则会把 splash 阻塞分钟级——两种都不合适;直接放弃本次保留 token,
    //    下次启动或运行时 refresh(非阻塞)自愈。
    const {
      result: refreshResult,
      attempts,
      failureAction,
    } = await runAuthRefreshWithReplacementRetry(storedToken, {
      phase: 'cold-start',
      withTransientRetry: true,
      rateLimitDelayMs: 0,
      onFailure: ({ attempt, status, code, definitive, willRetry }) =>
        log.warn(
          `cold-start refresh attempt ${attempt} failed status=${status} code=${code ?? '<none>'} definitive=${definitive} transientWillRetry=${willRetry}`,
        ),
    });
    // 迟到守卫①:refresh 期间用户手动登录 / 登出过 → 丢弃结果。成功也丢
    // (旧 token family 已被新登录取代);失败更不能把新登录的 token 删掉。
    if (epochChanged('after-refresh')) {
      return snapshotAuthState();
    }
    if (!refreshResult.ok) {
      // 只在「确定性凭据失效」时清除 token。429 限流 / 5xx / 断网等瞬时失败保留 token,
      // 让下次启动(或后续 refresh)能恢复登录,避免冷启动撞限流 / 网络抖动即被永久登出。
      // 与运行时 refresh() 的清除条件保持一致(共用 authRefreshFailure)。
      const action: RefreshFailureAction = failureAction ?? { kind: 'transient-failure' };
      if (action.kind === 'definitive-failure') {
        log.warn(
          'cold-start refresh: definitive credential failure — clearing persisted refresh token',
        );
        lastAcceptedRefreshToken = null;
        removeSafe(REFRESH_TOKEN_KEY);
      } else if (action.kind === 'replacement-retry') {
        log.warn(
          `cold-start refresh failed for a stale token after ${attempts} attempt(s) — keeping latest refresh token, starting logged out`,
        );
      } else {
        log.warn(
          `cold-start refresh still failing after ${attempts} attempt(s) — keeping refresh token, starting logged out`,
        );
      }
      commitActiveAppSession('signed-out');
      return snapshotLoggedOutAuthState();
    }

    const refreshData = refreshResult.data as RefreshResponse;
    if (accountSwitchTeardown) {
      // Cold-start refresh may outlive initialize()'s startup timeout. Keep
      // the owner boundary held for the entire late commit sequence so stale
      // IPC cannot reopen the previous owner's database while teardown,
      // namespace claiming, and session publication are still in flight.
      releaseBoundary = beginAppSessionBoundary();
      await accountSwitchTeardown({
        previousUserId: getActiveAppSession().dataOwnerId ?? 'signed-out',
        nextUserId: refreshData.membership.id,
      });
      if (epochChanged('after-cold-start-teardown')) {
        releaseBoundary();
        releaseBoundary = null;
        return snapshotAuthState();
      }
    }
    await claimLegacyNamespaceForVerifiedUser(refreshData.membership.id);
    if (epochChanged('after-owner-namespace-claim')) {
      releaseBoundary?.();
      releaseBoundary = null;
      return snapshotAuthState();
    }
    writeSafe(REFRESH_TOKEN_KEY, refreshData.refreshToken);
    lastAcceptedRefreshToken = refreshData.refreshToken;

    accessToken = refreshData.accessToken;
    // 2026-07 起身份完全以 auth membership 为准(产品 /api/user/me 已退役)。
    currentUser = mapMembershipToAuthUser(refreshData.membership);
    commitActiveAppSession('cloud', currentUser.id);
    persistedRefreshTokenNeedsIdentityCheck = false;
    clearReplacementIntegrationReloadTimers();
    scheduleCanaryFlagSync({
      token: refreshData.accessToken,
      expectedAuthEpoch: epochAtStart,
      expectedUserId: currentUser.id,
    });
    scheduleRefresh(refreshData.accessToken);
    // XD / Mivo key 均为本地 only,不再在冷启动从服务器同步到本地。
    // 账号边界对账:换账号则清掉上一个账号留在本机的 provider key,同账号保留(不必重填)。
    getProviderSecretStore().reconcileOwner(refreshData.membership.id);
    // 自动登录(冷启动)也广播到 renderer,和 login() / refresh() / clearAuth() 一致。
    // AuthContext 是从 service.initialize() 的 IPC return value 拿初始 state 的,这条
    // 广播对它是"幂等的重复事件";但 renderer 侧晚到的订阅者(如 tapdb 上报)只能从
    // 广播拿到冷启动状态——不广播就永远收不到 auto-login 事件。
    notifyRenderer();
    notifyAuthListeners();
    releaseBoundary?.();
    releaseBoundary = null;
    return snapshotAuthState();
  } catch (err) {
    // 网络类失败都在 apiFetch 内部消化(返回 status 0),能走到这里的是 refresh 成功
    // **之后**的本地状态同步代码(writeSafe / provider owner reconcile 等)抛异常——
    // 此时新 refresh token 已轮换并落盘,删除它只会把有效凭据丢掉。保留 token、记录
    // 错误,本次以未登录返回,留待下次启动自愈。
    log.error('cold-start auth initialize threw after refresh — keeping persisted refresh token', err);
    // 迟到守卫③:异常清理同样不能覆盖用户手动登录后的状态。
    if (!epochChanged('catch')) {
      accessToken = null;
      currentUser = null;
      if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
    }
    releaseBoundary?.();
    releaseBoundary = null;
    if (!epochChanged('catch-return')) commitActiveAppSession('signed-out');
    return epochChanged('catch-return-state')
      ? snapshotAuthState()
      : snapshotLoggedOutAuthState();
  }
}

async function loadLoginProviders(): Promise<AuthFlowState> {
  discoveredMethods = [];
  pendingAccountToken = null;
  pendingLoginTicket = null;
  pendingBindTicket = null;
  pendingSsoVerificationTicket = null;
  pendingAccountDeletionRestored = false;
  providerConfig = await createAuthClient().getProviders();
  loginFlowState = reduceAuthFlow(loginFlowState, {
    type: 'providers-loaded',
    providers: providerConfig,
  });
  return loginFlowState;
}

export async function getLoginState(): Promise<DesktopLoginActionResult> {
  try {
    if (loginFlowState) return { success: true, state: loginFlowState };
    return { success: true, state: await loadLoginProviders() };
  } catch (error) {
    const code = error instanceof AuthApiError ? error.code : 'AUTH_SERVICE_UNAVAILABLE';
    log.warn(`load login providers failed code=${code}`);
    loginFlowState = { step: 'error', code, recoverTo: 'identifier' };
    return { success: false, code, state: loginFlowState };
  }
}

async function completeLogin(
  outcome: Extract<LoginOutcome, { status: 'ok' }>,
): Promise<AuthFlowState> {
  const loginEpoch = ++authStateEpoch;
  const deletionWasRestored =
    outcome.accountDeletionRestored === true || pendingAccountDeletionRestored;
  const nextUser = mapMembershipToAuthUser(outcome.membership);
  const previousSession = getActiveAppSession();
  let releaseBoundary: (() => void) | null = null;
  if (previousSession.dataOwnerId !== nextUser.id) {
    releaseBoundary = beginAppSessionBoundary();
    try {
      if (accountSwitchTeardown) {
        await accountSwitchTeardown({
          previousUserId: previousSession.dataOwnerId ?? previousSession.mode,
          nextUserId: nextUser.id,
        });
      } else {
        closeLocalDb();
      }
    } catch (err) {
      releaseBoundary();
      releaseBoundary = null;
      throw err;
    }
  }
  // legacy 飞书集成清理已随主机 token 链退役(2026-07-17):这里不再有登录前
  // 的异步清理窗口,epoch 守卫保留给未来在提交前重新引入 await 的改动兜底。
  if (authStateEpoch !== loginEpoch) {
    releaseBoundary?.();
    throw new AuthApiError(
      'AUTH_FLOW_SUPERSEDED',
      409,
      'Login was superseded by a newer auth action',
    );
  }

  try {
    await claimLegacyNamespaceForVerifiedUser(nextUser.id);
  } catch (error) {
    // The boundary must not remain pending if legacy namespace claiming fails.
    releaseBoundary?.();
    releaseBoundary = null;
    throw error;
  }
  if (authStateEpoch !== loginEpoch) {
    releaseBoundary?.();
    throw new AuthApiError(
      'AUTH_FLOW_SUPERSEDED',
      409,
      'Login was superseded by a newer auth action',
    );
  }

  try {
    pendingAccountToken = null;
    pendingAccountDeletionRestored = false;
    accessToken = outcome.accessToken;
    persistedRefreshTokenNeedsIdentityCheck = false;
    clearReplacementIntegrationReloadTimers();
    writeSafe(REFRESH_TOKEN_KEY, outcome.refreshToken);
    removeSafe(LEGACY_REFRESH_TOKEN_KEY);
    lastAcceptedRefreshToken = outcome.refreshToken;
    removeSafe(ACCOUNT_DELETION_RECEIPT_KEY);
    accountDeletionRestoredNoticePending = deletionWasRestored;
    clearReloginFlag();
    currentUser = nextUser;
    commitActiveAppSession('cloud', currentUser.id);
  } finally {
    releaseBoundary?.();
  }
  scheduleCanaryFlagSync({
    token: outcome.accessToken,
    expectedAuthEpoch: loginEpoch,
    expectedUserId: currentUser.id,
  });
  scheduleRefresh(outcome.accessToken);
  getProviderSecretStore().reconcileOwner(outcome.membership.id);
  pendingLoginTicket = null;
  pendingBindTicket = null;
  pendingSsoVerificationTicket = null;
  loginFlowState = reduceAuthFlow(loginFlowState, { type: 'outcome', outcome });
  notifyRenderer();
  notifyAuthListeners();
  return loginFlowState;
}

async function acceptLoginOutcome(outcome: LoginOutcome): Promise<AuthFlowState> {
  if (outcome.status === 'ok' || outcome.status === 'select_account') {
    // Membership selection already establishes which passport owns the new
    // login. A receipt from the previous login must not survive this boundary.
    removeSafe(ACCOUNT_DELETION_RECEIPT_KEY);
  }
  if (
    (outcome.status === 'ok' || outcome.status === 'select_account') &&
    outcome.accountDeletionRestored === true
  ) {
    pendingAccountDeletionRestored = true;
  }
  pendingAccountToken = outcome.status === 'select_account' ? (outcome.accountToken ?? null) : null;

  if (outcome.status === 'ok') return completeLogin(outcome);
  if (outcome.status === 'select_account') {
    pendingLoginTicket = outcome.loginTicket;
    pendingBindTicket = null;
    pendingSsoVerificationTicket = null;
  } else if (outcome.status === 'binding_required') {
    pendingBindTicket = outcome.bindTicket;
    pendingLoginTicket = null;
    pendingSsoVerificationTicket = null;
  } else {
    pendingSsoVerificationTicket = outcome.verificationTicket;
    pendingLoginTicket = null;
    pendingBindTicket = null;
  }
  loginFlowState = reduceAuthFlow(loginFlowState, { type: 'outcome', outcome });
  return loginFlowState;
}

async function runLoginAction(action: DesktopLoginAction): Promise<DesktopLoginActionResult> {
  const client = createAuthClient();
  const stateBeforeAction = loginFlowState?.step === 'error' ? null : loginFlowState;
  try {
    // Cancellation is intercepted by dispatchLoginAction so it can settle the
    // already-running browser action instead of starting a second action.
    if (action.type === 'cancel-browser') {
      throw new AuthApiError('INVALID_AUTH_ACTION', 400, 'Unexpected browser cancellation');
    }
    if (action.type === 'reset') {
      return { success: true, state: await loadLoginProviders() };
    }
    if (!providerConfig) await loadLoginProviders();

    if (action.type === 'discover') {
      const email = action.email.trim().toLowerCase();
      discoveredMethods = await client.discover(email);
      loginFlowState = reduceAuthFlow(loginFlowState, {
        type: 'discovery-loaded',
        email,
        methods: discoveredMethods,
      });
      return { success: true, state: loginFlowState };
    }

    // 企业 SSO 入口（按组织 ID/slug/已验证域名）：结果映射进 method-choice，
    // 使 start-browser 的 connectionId 白名单校验与连接选择 UI 直接复用。
    if (action.type === 'discover-sso-org') {
      const discovery = await client.discoverSsoOrg(action.org.trim().toLowerCase());
      discoveredMethods = ssoOrgDiscoveryToMethods(discovery);
      loginFlowState = reduceAuthFlow(loginFlowState, {
        type: 'discovery-loaded',
        email: '',
        methods: discoveredMethods,
      });
      return { success: true, state: loginFlowState };
    }

    if (action.type === 'request-code') {
      if (action.kind === 'phone' && !providerConfig?.phone) {
        throw new AuthApiError('PHONE_LOGIN_DISABLED', 400, 'Phone login is disabled');
      }
      await client.requestCode(action.kind, action.identifier);
      loginFlowState = reduceAuthFlow(loginFlowState, {
        type: 'code-requested',
        kind: action.kind,
        identifier: action.identifier,
      });
      return { success: true, state: loginFlowState };
    }

    if (action.type === 'verify-code') {
      return {
        success: true,
        state: await acceptLoginOutcome(
          await client.verifyCode(action.kind, action.identifier, action.code),
        ),
      };
    }

    if (action.type === 'start-browser') {
      if (action.kind === 'social') {
        const provider = action.providerOrConnectionId as SocialProvider;
        if (!providerConfig?.social.includes(provider)) {
          throw new AuthApiError('SOCIAL_PROVIDER_DISABLED', 400, 'Provider is disabled');
        }
      } else if (
        !discoveredMethods.some(
          (method) =>
            method.type === 'sso' && method.connectionId === action.providerOrConnectionId,
        )
      ) {
        throw new AuthApiError('CONNECTION_NOT_FOUND', 404, 'SSO connection is unavailable');
      }
      const { codeVerifier, codeChallenge } = generatePKCE();
      // 这个 state 只服务 loopback 链路:纯 CSRF 校验值,回调回来比对一次即弃。
      // randomUUID 的 122 bit 随机量对该用途足够,也不动存量 client_state 的格式。
      //
      // 托管回调链路**不用它** —— openHostedBrowserAuthorization 会另生成一对
      // (pollSecret, clientState = base64url(sha256(pollSecret))),把哈希交给
      // authorize、原像留作取回凭据。原因是这里的值会进浏览器地址栏与导航历史,
      // 拿它取回就能被旁观者抢先消费(见 createDesktopPollCredentials 的说明)。
      // 两条链路的值都只存在于本进程内存中,不落盘、不进日志。
      const state = crypto.randomUUID();
      loginFlowState = reduceAuthFlow(loginFlowState, {
        type: 'browser-started',
        label: action.label,
      });
      const cancellation = new AbortController();
      const deactivateCancellation = browserAuthorizationSlot.activate(() => cancellation.abort());
      try {
        const callback = await openSystemBrowserAuthorization(
          {
            kind: action.kind,
            providerOrConnectionId: action.providerOrConnectionId,
            codeChallenge,
            state,
          },
          cancellation.signal,
        );
        if ('error' in callback) {
          throw new AuthApiError(callback.error, 0, 'Browser authorization did not complete');
        }
        const exchange = await raceAuthBrowserCancellation(
          client.exchangeAuthorizationCode(callback.code, codeVerifier),
          cancellation.signal,
        );
        if (exchange.cancelled) {
          throw new AuthApiError('USER_CANCELLED', 0, 'Browser authorization was cancelled');
        }
        return {
          success: true,
          state: await acceptLoginOutcome(exchange.value),
        };
      } finally {
        deactivateCancellation();
      }
    }

    if (action.type === 'select-account') {
      const accountToken = pendingAccountToken;
      if (accountToken) {
        const pair = await client.exchangeAccountMembership(accountToken, action.accountId);
        pendingAccountToken = null;
        return {
          success: true,
          state: await completeLogin({ status: 'ok', ...pair }),
        };
      }
      // 纯社交/SSO 等没有 account 会话的历史路径仍用一次性 loginTicket。
      if (!pendingLoginTicket) {
        throw new AuthApiError('INVALID_LOGIN_TICKET', 401, 'Missing login ticket');
      }
      return {
        success: true,
        state: await acceptLoginOutcome(
          await client.selectAccount(pendingLoginTicket, action.accountId),
        ),
      };
    }

    if (action.type === 'request-sso-verification-code') {
      if (!pendingSsoVerificationTicket || loginFlowState?.step !== 'sso-verification') {
        throw new AuthApiError(
          'INVALID_SSO_VERIFICATION_TICKET',
          401,
          'Missing SSO verification ticket',
        );
      }
      await client.requestSsoVerificationCode(pendingSsoVerificationTicket);
      loginFlowState = reduceAuthFlow(loginFlowState, {
        type: 'sso-verification-code-requested',
        channel: loginFlowState.channel,
        targetMasked: loginFlowState.targetMasked,
      });
      return { success: true, state: loginFlowState };
    }

    if (action.type === 'verify-sso-verification') {
      if (!pendingSsoVerificationTicket || loginFlowState?.step !== 'sso-verification') {
        throw new AuthApiError(
          'INVALID_SSO_VERIFICATION_TICKET',
          401,
          'Missing SSO verification ticket',
        );
      }
      return {
        success: true,
        state: await acceptLoginOutcome(
          await client.verifySsoVerification(pendingSsoVerificationTicket, action.code),
        ),
      };
    }

    if (action.type === 'request-binding-code') {
      if (!pendingBindTicket || loginFlowState?.step !== 'binding') {
        throw new AuthApiError('INVALID_BIND_TICKET', 401, 'Missing binding ticket');
      }
      await client.requestBindingCode(pendingBindTicket, loginFlowState.bindType, action.contact);
      loginFlowState = reduceAuthFlow(loginFlowState, {
        type: 'binding-code-requested',
        bindType: loginFlowState.bindType,
        contact: action.contact,
      });
      return { success: true, state: loginFlowState };
    }

    if (!pendingBindTicket || loginFlowState?.step !== 'binding') {
      throw new AuthApiError('INVALID_BIND_TICKET', 401, 'Missing binding ticket');
    }
    return {
      success: true,
      state: await acceptLoginOutcome(
        await client.verifyBinding(
          pendingBindTicket,
          loginFlowState.bindType,
          action.contact,
          action.code,
        ),
      ),
    };
  } catch (error) {
    const code = error instanceof AuthApiError ? error.code : 'AUTH_REQUEST_FAILED';
    const status = error instanceof AuthApiError ? error.statusCode : 0;
    log.warn(`login action failed action=${action.type} status=${status} code=${code}`);
    const flowCannotRetry = [
      'INVALID_LOGIN_TICKET',
      'INVALID_BIND_TICKET',
      'INVALID_SSO_VERIFICATION_TICKET',
      'INVALID_AUTH_CODE',
      'INVALID_TOKEN',
      'TOKEN_EXPIRED',
    ].includes(code);
    if (flowCannotRetry) {
      pendingAccountToken = null;
      pendingLoginTicket = null;
      pendingBindTicket = null;
      pendingSsoVerificationTicket = null;
    }
    // Keep the last usable screen so validation/network failures can be retried
    // without discarding the entered identifier or requesting another code.
    loginFlowState = flowCannotRetry
      ? { step: 'error', code, recoverTo: 'identifier' }
      : (stateBeforeAction ?? { step: 'error', code, recoverTo: 'identifier' });
    return { success: false, code, state: loginFlowState };
  }
}

export async function dispatchLoginAction(action: unknown): Promise<DesktopLoginActionResult> {
  // Terminal logout clears credentials synchronously, then tears down the old
  // account boundary in the background so the rejecting request can unwind.
  // Do not let a fast re-login open a new account DB that the old teardown
  // would subsequently close.
  if (sessionInvalidationPromise) await sessionInvalidationPromise;
  const parsedAction = parseDesktopLoginAction(action);
  if (!parsedAction) {
    return { success: false, code: 'INVALID_AUTH_ACTION', state: loginFlowState };
  }
  if (parsedAction.type === 'cancel-browser') {
    const pendingAction = loginActionPromise;
    const cancelled = browserAuthorizationSlot.cancelActive();
    if (!cancelled && !pendingAction) {
      return { success: false, code: 'NO_BROWSER_AUTH_IN_PROGRESS', state: loginFlowState };
    }
    const settled = pendingAction ? await pendingAction : null;
    const state = settled?.state ?? loginFlowState ?? (await loadLoginProviders());
    return { success: true, state };
  }
  if (loginActionPromise) {
    return { success: false, code: 'LOGIN_BUSY', state: loginFlowState };
  }
  loginActionPromise = runLoginAction(parsedAction);
  try {
    return await loginActionPromise;
  } finally {
    loginActionPromise = null;
  }
}

export async function refresh(): Promise<boolean> {
  if (getActiveAppSession().mode === 'local') {
    log.debug('runtime refresh skipped in local mode');
    return false;
  }
  if (refreshPromise !== null) return refreshPromise;

  refreshPromise = (async () => {
    const refreshEpoch = authStateEpoch;
    const refreshWasSuperseded = (point: string): boolean => {
      if (authStateEpoch === refreshEpoch) return false;
      log.warn(
        `runtime refresh superseded by logout or a newer login (${point}) — discarding late result`,
      );
      return true;
    };
    const storedToken = readSafe(REFRESH_TOKEN_KEY);
    if (!storedToken) {
      // 磁盘 refresh token 消失但本进程仍持有活会话:本进程内 logout 会同步清内存态
      // 并取消 refresh timer,冷启动 / 已登出时 currentUser 为 null —— 所以这个组合
      // 只会来自共享 userData 的外部实例登出 / 清凭证(同机互踢的一种)。按确定性
      // 失效走会话过期出口让用户明确感知;此前只打 debug 静默跳过,进程会进入
      // 「自以为登录、实际已死」的半死状态(模型源消失、device-link 无限 401)。
      if (currentUser !== null) {
        if (refreshWasSuperseded('missing-persisted-token')) return false;
        if (!isPersistedSecretAbsent(REFRESH_TOKEN_KEY)) {
          // 文件还在但读/解密失败(或加密暂不可用):瞬时故障,不能按凭证丢失
          // 强踢用户;保留会话,等下个 refresh 周期或 device-link 自救重试。
          log.warn(
            'runtime refresh: refresh token unreadable but file still present (or encryption unavailable) — treating as transient',
          );
          // 正常 refresh timer 已经触发过,这里不重排的话,一次密钥链/IO 抖动
          // 会让有效会话在 access token 到期前没有任何后续 refresh(半死)。
          scheduleRefreshRetryAfterTransientFailure();
          return false;
        }
        const previousUserId = currentUser.id;
        log.warn(
          'runtime refresh: persisted refresh token missing while session is live — expiring session (credential removed externally)',
        );
        await expireRuntimeAuth(previousUserId, 'credential-lost', {
          preservePersistedRefreshToken: true,
        });
        return false;
      }
      log.debug('runtime refresh skipped: no persisted refresh token');
      return false;
    }
    const diskTokenChangedBeforeRefresh =
      currentUser !== null &&
      lastAcceptedRefreshToken !== null &&
      storedToken !== lastAcceptedRefreshToken;
    if (diskTokenChangedBeforeRefresh) {
      log.warn(
        'runtime refresh detected refresh token changed on disk before request; will verify identity before accepting result',
      );
    }

    try {
      const { result, failureAction, replacementRetries } =
        await runAuthRefreshWithReplacementRetry(storedToken, {
          phase: 'runtime',
          withTransientRetry: false,
        });
      if (refreshWasSuperseded('after-refresh')) return false;
      if (!result.ok) {
        const action: RefreshFailureAction = failureAction ?? { kind: 'transient-failure' };
        const code = getRefreshErrorCode(result);
        if (action.kind === 'definitive-failure') {
          log.warn(
            `runtime refresh: definitive credential failure code=${code} — clearing auth, notifying session expired`,
          );
          const previousUserId = currentUser?.id ?? getActiveAppSession().dataOwnerId ?? 'signed-out';
          await expireRuntimeAuth(previousUserId, resolveSessionExpiredReason(code));
        } else if (action.kind === 'replacement-retry') {
          log.warn(
            `runtime refresh failed for a stale token after replacement retries status=${result.status} code=${code ?? '<none>'} — retrying in ${RUNTIME_REFRESH_RETRY_MS / 1000}s`,
          );
          scheduleRefreshRetryAfterTransientFailure();
        } else {
          log.warn(
            `runtime refresh failed transiently status=${result.status} code=${code ?? '<none>'} — retrying in ${RUNTIME_REFRESH_RETRY_MS / 1000}s`,
          );
          scheduleRefreshRetryAfterTransientFailure();
        }
        return false;
      }

      const data = result.data as RefreshResponse;
      const needsIdentityCheck =
        replacementRetries > 0 ||
        persistedRefreshTokenNeedsIdentityCheck ||
        diskTokenChangedBeforeRefresh;
      if (needsIdentityCheck) {
        // The replacement token may have been written by another shared-userData
        // instance. Verify / reconcile the account before accepting its access token,
        // otherwise renderer state could still show account A while API calls use B.
        persistedRefreshTokenNeedsIdentityCheck = true;
        writeSafe(REFRESH_TOKEN_KEY, data.refreshToken);
        lastAcceptedRefreshToken = data.refreshToken;

        const previousUserId = currentUser?.id ?? null;
        const nextUser = mergeMembershipWithExisting(data.membership, currentUser);
        const accountSwitched = previousUserId !== null && previousUserId !== nextUser.id;
        let releaseBoundary: (() => void) | null = null;
        if (accountSwitched) {
          log.warn(
            `runtime replacement refresh switched authenticated user from ${previousUserId} to ${nextUser.id}; reconciling auth state`,
          );
          notifyRendererAuthBoundaryPending();
          releaseBoundary = beginAppSessionBoundary();
          try {
            if (accountSwitchTeardown) {
              await accountSwitchTeardown({ previousUserId, nextUserId: nextUser.id });
            } else {
              log.warn(
                'runtime replacement account switch teardown hook is not registered; falling back to localDb close only',
              );
            }
            closeLocalDb();
          } catch (err) {
            releaseBoundary();
            releaseBoundary = null;
            log.error('runtime replacement account switch teardown failed', err);
            notifyRenderer();
            scheduleRefreshRetryAfterTransientFailure();
            return false;
          }
          if (refreshWasSuperseded('after-account-switch-teardown')) {
            releaseBoundary();
            return false;
          }
        }

        if (accountSwitched) {
          try {
            await claimLegacyNamespaceForVerifiedUser(nextUser.id);
          } catch (err) {
            // Namespace claiming is still inside the owner boundary. Always
            // release it before retrying so a failed claim cannot permanently
            // block all owner-bound IPC work.
            releaseBoundary?.();
            releaseBoundary = null;
            throw err;
          }
          if (refreshWasSuperseded('after-owner-namespace-claim')) {
            releaseBoundary?.();
            releaseBoundary = null;
            return false;
          }
        }

        accessToken = data.accessToken;
        currentUser = nextUser;
        try {
          commitActiveAppSession('cloud', currentUser.id);
        } finally {
          releaseBoundary?.();
        }
        persistedRefreshTokenNeedsIdentityCheck = false;
        getProviderSecretStore().reconcileOwner(currentUser.id);
        if (accountSwitched) {
          try {
            await clearPerAccountIntegrations();
            await reloadPerAccountIntegrationsFromDisk(accessToken);
          } catch (err) {
            log.error('reload per-account integrations after replacement account switch failed', err);
          }
          if (refreshWasSuperseded('after-integration-reload')) return false;
          scheduleReplacementIntegrationReloadRetries(currentUser.id);
        }
        scheduleCanaryFlagSync({
          token: data.accessToken,
          expectedAuthEpoch: refreshEpoch,
          expectedUserId: currentUser.id,
        });
        scheduleRefresh(data.accessToken);
        notifyRenderer();
        if (previousUserId !== currentUser.id) {
          notifyAuthListeners();
        }
        return true;
      }

      accessToken = data.accessToken;
      currentUser = mergeMembershipWithExisting(data.membership, currentUser);
      commitActiveAppSession('cloud', currentUser.id);
      persistedRefreshTokenNeedsIdentityCheck = false;
      writeSafe(REFRESH_TOKEN_KEY, data.refreshToken);
      lastAcceptedRefreshToken = data.refreshToken;
      scheduleRefresh(data.accessToken);
      notifyRenderer();
      return true;
    } catch (err) {
      if (refreshWasSuperseded('catch')) return false;
      // apiFetch 消化了网络错误(status 0 走上面 !ok 分支),这里是本地状态同步异常;
      // 与瞬时失败同等对待:记录并重排,避免刷新链就此断掉。
      log.error('runtime refresh threw — retrying later', err);
      scheduleRefreshRetryAfterTransientFailure();
      return false;
    }
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

export async function logout(): Promise<void> {
  const currentAccessToken = accessToken;
  // 注意:真实登出入口(bootstrap auth:logout handler)在调用本函数**之前**已
  // dispose DbClient 并释放 device-link 持有权(releaseDeviceLinkOwnershipBeforeLogout);
  // 需要在 DB 关闭前收尾写入的逻辑应挂在那条链路上,而不是本函数内(此时已太晚)。
  // chat-data-localization: drop the per-user db connection so the next
  // login (potentially a different user) opens a fresh file via ensureReady.
  try {
    closeLocalDb();
  } catch (err) {
    log.error('closeLocalDb on logout failed', err);
  }
  // Ordinary logout abandons an unconfirmed challenge. Confirmed deletion uses
  // clearLocalSessionAfterAccountDeletion() and intentionally preserves receipt.
  clearAccountDeletionReceipt();
  clearAuth();

  if (currentAccessToken) {
    apiFetch('/api/auth/logout', {
      method: 'POST',
      body: { deviceId },
      token: currentAccessToken,
    }).catch(() => {});
  }
}

/**
 * Called on system resume (powerMonitor 'resume' event).
 * If the app JWT is expired or expiring within 5 minutes, trigger a refresh.
 */
export function handleResume(): void {
  if (accessToken === null) return;
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64').toString('utf-8'),
    );
    if (payload.exp * 1000 - Date.now() <= 5 * 60 * 1000) {
      refresh();
    }
  } catch {
    // Invalid JWT format — skip
  }
}

export function dispose(): void {
  browserAuthorizationSlot.cancelActive();
  if (refreshTimer !== null) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  clearReplacementIntegrationReloadTimers();
}
