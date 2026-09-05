/**
 * apps/desktop/src/main/maker-ipc/usage.ts
 *
 * maker:usage:* IPC 的 Electron adapter。
 * handler body 在 usageHandlers.ts；host-level usage 依赖在这里注入，避免测试 import
 * handler 时拉起 Electron / runtime config 副作用。
 */

import { scryptSync } from 'node:crypto';
import path from 'node:path';

import type { Maker } from '@cindy/maker-core';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { getCachedBinaryStatus } from '../agent-binaries/index.js';
import {
  readClaudeAccountUsageSnapshot,
  triggerClaudeAccountUsageRefresh,
} from '../usage/claudeAccountUsage.js';
import {
  ClaudeSubscriptionUsageRateLimitedError,
  ClaudeSubscriptionUsageUnauthorizedError,
  fetchClaudeSubscriptionUsageSnapshot,
} from '../usage/claudeSubscriptionUsage.js';
import { createClaudeSubscriptionUsageReader } from '../usage/claudeSubscriptionUsageRefresh.js';
import {
  XaiSubscriptionUsageRateLimitedError,
  XaiSubscriptionUsageUnauthorizedError,
  fetchXaiSubscriptionUsageSnapshot,
} from '../usage/xaiSubscriptionUsage.js';
import { createXaiSubscriptionUsageReader } from '../usage/xaiSubscriptionUsageRefresh.js';
import { createCodexAccountUsageSnapshotReader } from '../usage/codexAccountUsageRefresh.js';
import { getGatewayModelPricing } from '../usage/modelPricing.js';
import { getReferenceModelPricing } from '../usage/referenceModelPricing.js';
import {
  CodexWebUsageUnauthorizedError,
  fetchCodexWebUsageSnapshot,
} from '../usage/codexWebUsage.js';
import { emptyUsageHistoryPayload, readUsageHistory } from '../usage/usageHistory.js';
import {
  clearClaudeSubscriptionUsageSnapshot,
  clearCodexAccountUsageSnapshot,
  clearXaiSubscriptionUsageSnapshot,
  readAgentTodayUsage,
  readClaudeSubscriptionUsageSnapshot,
  readCodexAccountUsageSnapshot,
  readXaiSubscriptionUsageSnapshot,
  recordClaudeSubscriptionUsageSnapshot,
  recordCodexAccountUsageSnapshot,
  recordXaiSubscriptionUsageSnapshot,
} from '../usageBroadcaster.js';
import { desktopCodexAuthAdapter } from '../maker-host/auth-adapters.js';
import { readClaudeAiOAuth } from '../maker-host/claude-credentials-store.js';
import { getGrokAccessToken, hasGrokOAuthLogin } from '../maker-host/grok-oauth-login.js';
import { outboundFetch } from '../maker-host/outbound-fetch.js';
import { setClaudeRateLimitHeadersListener } from '../maker-host/claude-rate-limit-headers-observer.js';
import { createCodexRateLimitResetService } from '../usage/codexRateLimitReset.js';

import { createElectronIpcHandlerRegistry } from './electronIpcRegistry.js';
import { registerMakerUsageHandlers } from './usageHandlers.js';

const log = createLogger('maker-ipc:usage');

/**
 * best-effort 提取应用分发的 claude 二进制版本 (oauth/usage 的 User-Agent 用) ——
 * prod 安装路径形如 userData/<installSubdir>/<version>/<binary>, 父目录名即版本;
 * dev LFS bundle 路径提不出来时返回 null, fetch 层用 pin 常量兜底。
 */
function readClaudeCodeVersionBestEffort(): string | null {
  try {
    const status = getCachedBinaryStatus('claude-code');
    if (!status.binaryPath) return null;
    const versionDir = path.basename(path.dirname(status.binaryPath));
    return /^\d+\.\d+/.test(versionDir) ? versionDir : null;
  } catch {
    return null;
  }
}

/** scrypt 应用盐 —— 指纹只用于同机快照归属比对, 盐固定即可(不跨机、不防离线爆破)。 */
const CLAUDE_TOKEN_FINGERPRINT_SALT = 'xdt-claude-subscription-usage-fp-v1';

// token → 指纹的单值缓存: scrypt 是有意的高成本哈希(CodeQL js/insufficient-password-hash
// 对 token 素材要求 computationally expensive), 缓存后仅换号时重算一次, 常规刷新零开销。
let _lastFingerprintToken: string | null = null;
let _lastFingerprint: string | null = null;

// 「当前凭证」内存缓存 —— 给 headers listener 用(它在 proxy 响应热路径的
// fire-and-forget 回调里, 不允许任何同步 keychain 读 / scrypt 计算)。由
// readClaudeCredentialsInfo(reader 的后台流程 / IPC 读, 本来就要读凭证库)顺手
// 刷新; listener 只做内存字符串比较。token 原文用于把 headers 快照绑定到发出
// 请求的账号: 换号 / 登出瞬间的 in-flight 尾巴响应(请求 token ≠ 当前凭证)直接
// 丢弃, 不会被错误打上最新账号的指纹落库。
let _currentClaudeToken: string | null = null;
let _currentClaudeFingerprint: string | null = null;
// 是否已读过凭证库 —— 区分「冷启动缓存未就位」(允许落无指纹快照)与「明确登出」
// (token 缓存为 null 是事实, 登出后的 in-flight 尾巴响应必须丢弃)。
let _claudeCredentialsKnown = false;

/**
 * OAuth token → 快照归属指纹(scrypt 截 16 hex, 不含 token 原文)——
 * 端点刷新 record 时由 reader 附到快照上, read 换号时据此判定持久化快照过期
 * (同机换账号防串号)。只在 reader 的后台刷新流程调用, 不在任何请求热路径上。
 */
function fingerprintClaudeToken(token: string): string {
  if (token === _lastFingerprintToken && _lastFingerprint) return _lastFingerprint;
  const fingerprint = scryptSync(token, CLAUDE_TOKEN_FINGERPRINT_SALT, 32)
    .toString('hex')
    .slice(0, 16);
  _lastFingerprintToken = token;
  _lastFingerprint = fingerprint;
  return fingerprint;
}

/** 读订阅凭证 + 顺手刷新「当前凭证」内存缓存(headers listener 消费)。 */
function readClaudeCredentialsInfo(): {
  accessToken: string;
  subscriptionType: string | null;
} | null {
  const oauth = readClaudeAiOAuth();
  _claudeCredentialsKnown = true;
  if (!oauth) {
    _currentClaudeToken = null;
    _currentClaudeFingerprint = null;
    return null;
  }
  _currentClaudeToken = oauth.accessToken;
  _currentClaudeFingerprint = fingerprintClaudeToken(oauth.accessToken);
  return {
    accessToken: oauth.accessToken,
    subscriptionType: oauth.subscriptionType ?? null,
  };
}

const claudeSubscriptionUsageReader = createClaudeSubscriptionUsageReader({
  readCredentials: readClaudeCredentialsInfo,
  fetchSnapshot: (credentials) =>
    fetchClaudeSubscriptionUsageSnapshot({
      accessToken: credentials.accessToken,
      subscriptionType: credentials.subscriptionType,
      claudeCodeVersion: readClaudeCodeVersionBestEffort(),
    }),
  recordSnapshot: recordClaudeSubscriptionUsageSnapshot,
  clearSnapshot: clearClaudeSubscriptionUsageSnapshot,
  readCachedSnapshot: readClaudeSubscriptionUsageSnapshot,
  fingerprintToken: fingerprintClaudeToken,
  now: () => Date.now(),
  isUnauthorizedError: (err) => err instanceof ClaudeSubscriptionUsageUnauthorizedError,
  isRateLimitedError: (err) => err instanceof ClaudeSubscriptionUsageRateLimitedError,
  onRefreshError: (err) => {
    log.warn(
      'claude subscription usage refresh failed:',
      err instanceof Error ? err.message : String(err),
    );
  },
});

/**
 * Claude turn done 后的订阅余量刷新钩子 (register.ts 消费) —— fire-and-forget,
 * 节流 / 429 退避在 reader 内部。未连订阅时 no-op。
 */
export function triggerClaudeSubscriptionUsageRefresh(): void {
  claudeSubscriptionUsageReader.triggerRefresh();
}

/**
 * Claude 订阅凭证变化(OAuth 登录 / 登出 / 换号)后的余量同步钩子(bootstrap 的
 * CLAUDE_OAUTH_LOGIN / LOGOUT handler 消费)。复用 read() 的完整语义:
 *   - 登出 → 凭证消失, 清快照并广播 null(chip 立即回占位态);
 *   - 换号 → 指纹校验清掉旧账号快照 + 触发新账号端点刷新;
 *   - 登录 → 刷新指纹缓存 + 触发端点刷新。
 * renderer 不需要感知 auth 事件, 全靠既有 usage:claude-subscription-changed push。
 */
export function syncClaudeSubscriptionUsageForAuthChange(): void {
  void claudeSubscriptionUsageReader.syncForCredentialChange().catch(() => {
    /* reader 内部已把错误交给 onRefreshError, 这里只兜底 promise 拒绝。 */
  });
}

async function readXaiCredentialsInfo(): Promise<{ accessToken: string } | null> {
  if (!hasGrokOAuthLogin()) return null;
  try {
    const accessToken = await getGrokAccessToken();
    return accessToken ? { accessToken } : null;
  } catch {
    return null;
  }
}

const xaiSubscriptionUsageReader = createXaiSubscriptionUsageReader({
  readCredentials: readXaiCredentialsInfo,
  fetchSnapshot: (credentials) =>
    fetchXaiSubscriptionUsageSnapshot({
      accessToken: credentials.accessToken,
      fetchFn: outboundFetch,
    }),
  recordSnapshot: recordXaiSubscriptionUsageSnapshot,
  clearSnapshot: clearXaiSubscriptionUsageSnapshot,
  readCachedSnapshot: readXaiSubscriptionUsageSnapshot,
  now: () => Date.now(),
  isUnauthorizedError: (err) => err instanceof XaiSubscriptionUsageUnauthorizedError,
  isRateLimitedError: (err) => err instanceof XaiSubscriptionUsageRateLimitedError,
  onRefreshError: (err) => {
    log.warn(
      'xAI subscription usage refresh failed:',
      err instanceof Error ? err.message : String(err),
    );
  },
});

/** SuperGrok 周用量:turn-done 钩子,节流 / 退避 / 未登录 no-op 都在 reader 内。 */
export function triggerXaiSubscriptionUsageRefresh(): void {
  xaiSubscriptionUsageReader.triggerRefresh();
}

/**
 * device-link dispatch 专用的 xAI 订阅余量读取出口。ipcMain 面的
 * USAGE_XAI_SUBSCRIPTION 挂了 assertTrustedSender(合成 event 必然不可信,那道闸
 * 不为远程放宽)—— 与 device-link:telegram:* 同先例,被控端 dispatch 过三道 gate
 * (被控开关 + 撤销黑名单 + allowlist)后直读本函数,不进 ipcMain。cached-first,
 * 与本机 renderer 读到的快照同形。
 */
export function readXaiSubscriptionUsageSnapshotForDeviceLink(): Promise<unknown | null> {
  return xaiSubscriptionUsageReader.read();
}

/** SuperGrok 登录 / 登出 / 换号后强制同步(先清再拉)。调用方应 await 后再广播连接态。 */
export function syncXaiSubscriptionUsageForAuthChange(): Promise<void> {
  return xaiSubscriptionUsageReader.syncForCredentialChange().catch(() => {
    /* reader 内部已把错误交给 onRefreshError */
  });
}

const readCodexAccountUsageSnapshotWithWebRefresh = createCodexAccountUsageSnapshotReader({
  readAccessToken: () => desktopCodexAuthAdapter.getAccessToken(),
  readAccountId: () => desktopCodexAuthAdapter.getAccountId(),
  fetchWebUsageSnapshot: fetchCodexWebUsageSnapshot,
  recordSnapshot: recordCodexAccountUsageSnapshot,
  clearSnapshot: clearCodexAccountUsageSnapshot,
  readCachedSnapshot: readCodexAccountUsageSnapshot,
  now: () => Date.now(),
  isUnauthorizedError: (err) => err instanceof CodexWebUsageUnauthorizedError,
  onRefreshError: (err) => {
    log.warn('codex web usage refresh failed:', err instanceof Error ? err.message : String(err));
  },
});

/**
 * 触发 ChatGPT 订阅额度(wham/usage)后台刷新 —— 复用带 web-refresh 的 reader:拉到新快照即
 * recordSnapshot → 广播 usage:codex-account-changed(reader 内部 10s 节流 + in-flight 去重)。
 * 供 claude-code 框架下 `chatgpt/` bridge 轮结束后调用,让底部 chip 的 ChatGPT 额度实时更新
 * (bridge 轮不产生 codex account_usage 事件,需主动触发)。fire-and-forget。
 */
export function triggerCodexAccountUsageRefresh(): void {
  void readCodexAccountUsageSnapshotWithWebRefresh().catch(() => {
    /* best-effort: 失败保留上一次快照, 不影响 turn 收尾 */
  });
}

export function registerMakerUsageIpc(maker: Maker): void {
  log.info('registering maker:usage:* IPC handlers');

  const codexRateLimitResetService = createCodexRateLimitResetService({
    readRateLimits: () => maker.readAgentAccountRateLimits('codex'),
    consumeResetCredit: (params) => maker.consumeAgentAccountRateLimitResetCredit('codex', params),
    readAccountIdentity: async () => {
      const state = await maker.getAgentAuthState('codex');
      const accountId =
        state.authSource === 'oauth' ? await desktopCodexAuthAdapter.getAccountId() : null;
      const identity =
        state.authSource === 'oauth' && state.identity?.includes('@') ? state.identity : null;
      return { email: identity, accountId };
    },
    recordRateLimitSnapshot: recordCodexAccountUsageSnapshot,
  });

  registerMakerUsageHandlers(createElectronIpcHandlerRegistry(), {
    readAgentTodayUsage,
    readCodexAccountUsageSnapshot: readCodexAccountUsageSnapshotWithWebRefresh,
    // Bind recovery confirmation to the exact owner, marker and OAuth credential observed before
    // this account-level RPC. A stale response still returns its usage payload but cannot consume a
    // newer recovery state.
    readCodexRateLimits: () =>
      desktopCodexAuthAdapter.verifyRecoveryWithAccountRpc(() => codexRateLimitResetService.read()),
    consumeCodexRateLimitReset: codexRateLimitResetService.consume,
    readClaudeSubscriptionUsageSnapshot: () => claudeSubscriptionUsageReader.read(),
    readXaiSubscriptionUsageSnapshot: () => xaiSubscriptionUsageReader.read(),
    assertTrustedSender: (event) => {
      assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
    },
    readClaudeAccountUsageSnapshot,
    triggerClaudeAccountUsageRefresh,
    readModelPricing: getGatewayModelPricing,
    readReferenceModelPricing: getReferenceModelPricing,
    readUsageHistory,
    emptyUsageHistory: emptyUsageHistoryPayload,
  });

  // proxy 旁路读到订阅直连响应的 unified rate limit headers → 落库 + 广播。
  // ⚠️ 这条回调由 observer 在响应开始时同步发起, 处于 proxy 热路径 —— 首个 await
  // 之前的主路径不得有任何同步 IO / scrypt(规则 10), 只做内存读与字符串比较。
  // 例外:请求 bearer 与缓存 token 不一致时,可能是 Claude Code 刚刷新 OAuth access token
  // 而缓存尚未更新;这个 rare mismatch 分支允许同步刷新一次凭证缓存,避免把新 token 的
  // headers 快照持续误丢到下一次 IPC read / throttle 过期。
  // 快照绑定到发出请求的 token: 请求 bearer 与「当前凭证」缓存不符(换号 / 登出
  // 瞬间的 in-flight 尾巴, 或登出后缓存已清)→ 丢弃, 不落库不广播; 缓存尚未就位
  // (冷启动首响应早于任何 read)时保守落一笔无指纹快照, 由随后端点刷新补齐归属。
  setClaudeRateLimitHeadersListener((snapshot, requestBearerToken) => {
    let currentToken = _currentClaudeToken;
    if (currentToken) {
      if (requestBearerToken !== currentToken) {
        currentToken = readClaudeCredentialsInfo()?.accessToken ?? null;
        if (requestBearerToken !== currentToken) return false; // 归属不符 (换号尾巴), 丢弃
      }
      const fingerprint = _currentClaudeFingerprint;
      void recordClaudeSubscriptionUsageSnapshot(
        fingerprint ? { ...snapshot, accountFingerprint: fingerprint } : snapshot,
      );
      return true;
    }
    // token 缓存为 null 且已读过凭证库 = 明确登出 —— 登出后的 in-flight 尾巴响应
    // 丢弃(auth 钩子已清快照, 落库会残留旧账号数据)。只有冷启动(从未读过凭证,
    // 首响应早于任何 read)才保守落一笔无指纹快照, 由随后端点刷新补齐归属。
    if (_claudeCredentialsKnown) return false;
    void recordClaudeSubscriptionUsageSnapshot(snapshot);
    return true;
  });

  log.info('maker usage IPC handlers registered');
}
