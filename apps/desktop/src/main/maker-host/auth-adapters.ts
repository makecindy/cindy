/**
 * apps/desktop/src/main/maker-host/auth-adapters.ts
 *
 * Desktop 端 agent 鉴权适配 —— 直接 implement maker-core 的 AuthAdapter 接口。
 *
 * 历史:之前同时维持两个形态 (老 vendor VendorAuthAdapter + maker-core AuthAdapter),
 * 用来同时喂 vendor/claude/runtime.ts (老 agentManager 链路) 和 maker-core ClaudeCodeAgent。
 * vendor 链路退役后老形态就只是再转一道手, 已折叠。
 *
 * 设计 (D9 env 拆分):
 *   - getAuthEnv() 只筛鉴权字段 (Claude → ANTHROPIC_API_KEY; Codex → CODEX_HOME)
 *   - endpoint / behavior flag (ANTHROPIC_BASE_URL 等)
 *     由 maker-host/runtime-configs.ts 通过 AgentRuntimeConfig 注入
 */

import { app, safeStorage } from 'electron';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { promises as fsp, existsSync } from 'node:fs';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  AgentLoginMode,
  AuthAdapter,
  AuthAdapterOptions,
  AuthLoginOptions,
  AuthState,
} from '@cindy/maker-core';
import { getCachedBinaryStatus, isVettedAgentBinaryPath } from '../agent-binaries/index.js';
import { createLogger } from '../logger.js';
import { prepareCodexGlobalSkillsLinks } from './codex-global-skills.js';
import { prepareCodexGlobalRulesCopy } from './codex-global-rules.js';
import { prepareCodexGlobalPluginsBridge } from './codex-global-plugins.js';
import { prepareSharedGlobalSkillLinks } from './shared-global-skills.js';
import { relinkSharedCodexAuth } from './codex-auth-link.js';
import { claudeOAuthSpawnEnv } from './claude-oauth-spawn-env.js';
import {
  CODEX_USER_DISCONNECT_REASON,
  clearInvalidatedSystemCodexAuthMarker,
  markerMatchesCurrentSystemCodexAuth,
  readInvalidatedSystemCodexAuthMarker,
  restoreInvalidationStateOnStartup,
  settleInvalidationMarkerAfterLogin,
  shouldSuppressLocalCodexAuth,
  writeInvalidatedSystemCodexAuthMarker,
} from './codex-auth-invalidation.js';
import {
  codexLoginArgs,
  requireCodexOAuthLoginState,
  resolveCodexLoginCleanupPreflight,
  resolveCodexLoginExitState,
  terminateCodexLoginProcess,
} from './codex-auth-state.js';
import { CODEX_GATEWAY_ENV_KEY, CODEX_PROVIDER_OAUTH_PLACEHOLDER_KEY } from './codex-gateway-config.js';
import { CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY } from './claude-gateway-config.js';
import {
  clearClaudeAiOAuth,
  hasClaudeAiOAuth,
  hasClaudeAiOAuthUnbound,
} from './claude-credentials-store.js';
import {
  disconnectClaudeAiOAuth,
  getClaudeAiOAuthForSpawn,
  getValidClaudeAiOAuth,
  invalidateClaudeOAuthRefresh,
  setClaudeOAuthInvalidGrantHandler,
} from './claude-oauth-refresh.js';
import { isAnthropicCompatProxyHandleReady } from './anthropic-compat-proxy-host.js';
import { claudeUpstreamEndpoint } from './runtime-configs.js';
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import { getAppCapabilities } from '../appCapabilities.js';
import {
  getActiveAppSession,
  isAppSessionBoundaryPending,
  type ActiveAppSession,
} from '../appSessionState.js';
import {
  bindNativeProviderAuth,
  claimDetectedNativeProviderAuth,
  isNativeProviderAuthBound,
  unbindNativeProviderAuth,
} from './nativeProviderAuthBinding.js';
import { getGhostSetupChangeBus } from '../cindy-brain/ghostSetupChangeBus.js';

const execFileP = promisify(execFile);
const log = createLogger('auth-adapters');

/**
 * Host-injected provider sessions only need a non-empty credential to pass Claude Code's
 * local auth preflight. The loopback proxy replaces it with the selected provider's real
 * API key / OAuth token before forwarding the request.
 * 定义已下沉到 claude-gateway-config.ts(proxy-host 路由识别占位 key 需要它,而本
 * 文件 import 了 proxy-host,反向 import 会成环);这里 re-export 保持既有消费点。
 */
export { CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY } from './claude-gateway-config.js';

/** Codex CLI 的 HOME 目录, auth.json 放在根, sessions 子目录放会话 jsonl。 */
function getCodexHome(): string {
  return path.join(app.getPath('userData'), 'codex-home');
}

/** 本机 codex CLI 默认的 auth.json 路径 (~/.codex/auth.json), 用于 reconcile 比对凭证。 */
function getSystemCodexAuthPath(): string {
  return path.join(os.homedir(), '.codex', 'auth.json');
}

// 失效标记 (auth-invalidated-system.json) 的读写与决策拆在 codex-auth-invalidation.ts
// (Electron-free, 可单测); 这里只以显式路径调用。

/**
 * 从 codex auth.json 提取账号标识。
 * 优先 tokens.account_id (codex 现行 schema),fallback 解 id_token 的
 * chatgpt_account_id workspace claim。绝不回落 JWT sub:sub 只标识用户主体,
 * 同一用户切换 ChatGPT workspace 时不会变化,不能用于 reset credit 账号绑定。
 * 解析失败返回 null —— 调用方按"无法识别"保守处理 (不动任何文件)。
 */
async function readCodexAccountId(authPath: string): Promise<string | null> {
  try {
    const raw = await fsp.readFile(authPath, 'utf-8');
    const obj = JSON.parse(raw) as { tokens?: { account_id?: unknown; id_token?: unknown } };
    if (typeof obj.tokens?.account_id === 'string' && obj.tokens.account_id.length > 0) {
      return obj.tokens.account_id;
    }
    if (typeof obj.tokens?.id_token === 'string') {
      return chatgptWorkspaceIdFromIdToken(obj.tokens.id_token);
    }
  } catch {
    /* 解析失败 → null */
  }
  return null;
}

interface ChatgptIdTokenClaims {
  chatgpt_account_id?: unknown;
  sub?: unknown;
  'https://api.openai.com/auth'?: { chatgpt_account_id?: unknown };
}

function readChatgptIdTokenClaims(idToken: string): ChatgptIdTokenClaims | null {
  try {
    const part = idToken.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8')) as ChatgptIdTokenClaims;
  } catch {
    return null;
  }
}

/** Strict workspace identity; unlike header compatibility it never falls back to JWT sub. */
function chatgptWorkspaceIdFromIdToken(idToken: string): string | null {
  const claims = readChatgptIdTokenClaims(idToken);
  const nested = claims?.['https://api.openai.com/auth']?.chatgpt_account_id;
  if (typeof nested === 'string' && nested.length > 0) return nested;
  const topLevel = claims?.chatgpt_account_id;
  return typeof topLevel === 'string' && topLevel.length > 0 ? topLevel : null;
}

/**
 * 从 id_token JWT 提取 ChatGPT 账号 id（chatgpt-account-id 头用）。
 * 优先 `https://api.openai.com/auth`.chatgpt_account_id，回落顶层 chatgpt_account_id / sub。
 * export 供 anthropic-responses-bridge-host 复用(同一 auth.json、同一 claim 布局,单点维护)。
 */
export function chatgptAccountIdFromIdToken(idToken: string): string | null {
  const workspaceId = chatgptWorkspaceIdFromIdToken(idToken);
  if (workspaceId) return workspaceId;
  const sub = readChatgptIdTokenClaims(idToken)?.sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : null;
}

/**
 * Codex 一次性轻任务（起会话标题 oneShot）直连 ChatGPT 后端所需的凭证。
 * 读 xdt-maker 自管 codex-home 的 auth.json：`tokens.access_token` 作 Bearer、`account_id`
 * 作 chatgpt-account-id 头（account_id 缺失时回落解 id_token JWT）。token 刷新由 codex
 * app-server / CLI 负责（本函数只读当下值）；文件缺失 / 非 chatgpt 模式 / 解析失败 → null
 * （调用方据此跳过 codex 这条标题来源，不抛）。
 */
export function readCodexOneShotCreds(): { accessToken: string; accountId: string } | null {
  if (!isNativeProviderAuthBound('openai')) return null;
  try {
    const codexHome = getCodexHome();
    const authPath = path.join(codexHome, 'auth.json');
    // logout 的 durable marker 是提交点。Windows 文件锁可能让旧 auth.json 暂时残留，
    // oneShot 直读也必须服从同一断开语义，不能绕过 adapter 继续使用旧账号。
    if (shouldSuppressLocalCodexAuth(codexHome, authPath)) return null;
    const raw = fs.readFileSync(authPath, 'utf-8');
    const obj = JSON.parse(raw) as {
      tokens?: { access_token?: unknown; account_id?: unknown; id_token?: unknown };
    };
    const accessToken = obj.tokens?.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
    let accountId: string | null =
      typeof obj.tokens?.account_id === 'string' && obj.tokens.account_id.length > 0
        ? obj.tokens.account_id
        : null;
    if (!accountId && typeof obj.tokens?.id_token === 'string') {
      accountId = chatgptAccountIdFromIdToken(obj.tokens.id_token);
    }
    if (!accountId) return null;
    return { accessToken, accountId };
  } catch {
    return null;
  }
}

/** 删除 Cindy 自管且无法按账号归属的 Codex 模型 cache。 */
async function removeDesktopCodexModelsCache(codexHome: string): Promise<boolean> {
  const cachePath = path.join(codexHome, 'models_cache.json');
  try {
    await fsp.rm(cachePath, { force: true });
  } catch (err) {
    log.warn('remove stale Codex models_cache.json failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return !existsSync(cachePath);
}

/**
 * 下一次 OAuth 前清理上一个鉴权边界留下的本地状态。
 * auth.json 只在 durable disconnect marker 匹配时删除；models_cache.json 每次都删除，
 * 因为 Codex cache 不含账号 ID，不能证明一份结构有效的旧 cache 属于即将登录的账号。
 * Windows 锁仍未释放时返回 false，让登录 fail-closed；之后重试会再次清理，无需重启。
 */
export async function clearCodexAuthBoundaryStateBeforeLogin(
  codexHome: string = getCodexHome(),
): Promise<boolean> {
  const authPath = path.join(codexHome, 'auth.json');
  if (shouldSuppressLocalCodexAuth(codexHome, authPath)) {
    try {
      await fsp.rm(authPath, { force: true });
    } catch (err) {
      log.warn('remove suppressed Codex auth.json before login failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const authReady = !shouldSuppressLocalCodexAuth(codexHome, authPath);
  const cacheReady = await removeDesktopCodexModelsCache(codexHome);
  return authReady && cacheReady;
}

/**
 * Windows: 用 icacls 把文件权限收紧为"仅当前用户 Full"。
 * 失败仅 stderr 告警, 不抛 —— userData ACL + 0o600 已经是双保险, icacls 是第三道。
 */
async function tightenAclWindows(file: string): Promise<void> {
  const username = process.env.USERNAME ?? os.userInfo().username;
  try {
    await execFileP('icacls', [file, '/inheritance:r', '/grant:r', `${username}:F`]);
  } catch (err) {
    log.warn('icacls failed', { file, error: (err as Error).message });
  }
}

/**
 * codex login 子进程超时。给用户充足时间在浏览器完成 OAuth 跳转,
 * 同时防御网络异常 / CLI 卡死。
 */
const CODEX_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// ═════════════════════════════════════════════════════════════════════════════
// Claude — safeStorage 加密 LiteLLM proxy key
// ═════════════════════════════════════════════════════════════════════════════
//
// 与 renderer useApiKey hook 共享同一个 storage key ('api_key'), 无需额外 IPC。
// 编码格式与 main 进程 safe-storage-store / safe-storage-read IPC handler 一致:
//   写: safeStorage.encryptString(value).toString('base64') → 写 utf-8 文件
//   读: readFileSync utf-8 → Buffer.from(content, 'base64') → safeStorage.decryptString()

/** Read the active owner's raw local gateway key for explicit BYOK flows only. */
export function readOwnerScopedXdGatewayKey(): string | null {
  return getProviderSecretStore().get('xd');
}

/** Read the gateway key only when the current app session may use Cindy gateway services. */
export function readClaudeApiKey(): string | null {
  if (!getAppCapabilities().canUseCindyGateway) return null;
  return readOwnerScopedXdGatewayKey();
}

/**
 * cc 401 回调(getFreshSubscriptionToken)的总预算。必须显著小于 cc 侧
 * oauth_token_refresh control 请求的 30s 超时(反编译 eqf=30000),超时快速返回 null
 * 让 cc 落磁盘兜底,不把 turn 吊在锁等待 + 慢网络上。
 */
export const CLAUDE_OAUTH_CALLBACK_TIMEOUT_MS = 12_000;

/** Claude AuthAdapter —— 只回鉴权 env, endpoint / behavior flag 走 runtime-configs.ts。 */
export class DesktopClaudeAuthAdapter implements AuthAdapter {
  private pendingSharedSkillsPrep: Promise<void> | null = null;

  /** invalidate() 触发时把 auth state 推给 renderer(maker-host 装配注入,对齐 codex)。 */
  private onInvalidatedBroadcast?: (reason: string) => void;

  constructor() {
    // 订阅 refresh token 被服务端作废(锁内确认的 invalid_grant)→ 清态 + 广播重登提示,
    // 不让用户停在「显示已连接、会话连环 401」的假状态。纯内存接线,构造期零文件系统
    // 副作用(authAdaptersImportPurity 约定)。
    setClaudeOAuthInvalidGrantHandler(() => {
      void this.invalidate('claude_oauth_refresh_invalid_grant');
    });
  }

  /** maker-host 注入: invalidate() 触发后给 renderer push auth state。 */
  setOnInvalidatedBroadcast(cb: (reason: string) => void): void {
    this.onInvalidatedBroadcast = cb;
  }

  /**
   * 订阅凭证被服务端作废时的收尾:清系统凭证(cc 对 invalid_grant 同样清盘)+ 失效
   * 刷新器 + 广播 UI 重登。对齐 DesktopCodexAuthAdapter.invalidate 模式。
   */
  async invalidate(reason: string): Promise<void> {
    log.warn('claude auth invalidated', { reason });
    invalidateClaudeOAuthRefresh();
    try {
      if (hasClaudeAiOAuth()) clearClaudeAiOAuth();
      // 凭证删除是 best-effort 的(clearClaudeAiOAuth 的 unlink 失败静默吞掉)。删干净了就
      // **不**留抑制标记 —— 服务端作废不是用户意图,本机 CLI 重新登录后仍应享有设计内的自动
      // 继承;可一旦没删掉,slot 空 + 凭证还在,下一次可信读取就会把这份刚被作废的凭证认领
      // 回来、拿它重启发现,再 401、再 invalidate,在「已连接 / 失效」之间打转
      // (PR #548 review)。所以按残留与否分流。
      const residual = hasClaudeAiOAuthUnbound();
      unbindNativeProviderAuth('anthropic', residual ? { revoked: true } : undefined);
      if (residual) {
        log.warn('claude credential still present after invalidate; suppressing auto-claim', {
          reason,
        });
      }
    } catch (e) {
      log.warn('clear claude oauth on invalidate failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    if (this.onInvalidatedBroadcast) {
      try {
        this.onInvalidatedBroadcast(reason);
      } catch (e) {
        log.warn('onInvalidatedBroadcast threw', { error: (e as Error).message });
      }
    }
  }

  async ensureSharedGlobalSkills(): Promise<void> {
    if (this.pendingSharedSkillsPrep) return this.pendingSharedSkillsPrep;
    this.pendingSharedSkillsPrep = this.runEnsureSharedGlobalSkills().finally(() => {
      this.pendingSharedSkillsPrep = null;
    });
    return this.pendingSharedSkillsPrep;
  }

  private async runEnsureSharedGlobalSkills(): Promise<void> {
    try {
      const result = await prepareSharedGlobalSkillLinks();
      for (const warning of result.warnings) {
        log.warn('shared global skill warning', { warning });
      }
    } catch (error) {
      log.warn('prepare shared global skills failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getState(options?: AuthAdapterOptions): Promise<AuthState> {
    if (!safeStorage.isEncryptionAvailable()) {
      return { authenticated: false, errorReason: 'no_encryption' };
    }
    if (options?.credentialMode === 'gateway-key') {
      const apiKey = readClaudeApiKey();
      return apiKey
        ? { authenticated: true, identity: 'API Key · Cindy AI', authSource: 'api-key' }
        : { authenticated: false, errorReason: 'no_key' };
    }
    if (options?.credentialMode === 'provider-oauth') {
      if (!isAnthropicCompatProxyHandleReady()) {
        return { authenticated: false, errorReason: 'proxy_not_ready' };
      }
      return { authenticated: true, identity: 'Provider · Proxy', authSource: 'api-key' };
    }
    // 连了 Claude.ai 订阅(系统 Claude Code 凭证库有 OAuth 登录,或经本 app 浏览器授权写入)
    // → cc 走 oauth-spawn:子进程携带订阅 OAuth token,因此「Anthropic 订阅」成为本会话可
    // per-session 选中的来源(选中即直连 api.anthropic.com)。默认仍走网关(网关 key 由 proxy
    // 旁路按请求注入)。授权≠自动走订阅,要在模型列表显式选中才走。
    // per-session / 默认路由强依赖 loopback proxy,proxy 没起来直接拒授权,fail-closed ——
    // 不让「OAuth token + 直连」裸奔(规则 9)。
    if (hasClaudeAiOAuth()) {
      if (!isAnthropicCompatProxyHandleReady()) {
        return { authenticated: false, errorReason: 'proxy_not_ready' };
      }
      return { authenticated: true, identity: 'Claude.ai · OAuth', authSource: 'oauth' };
    }
    if (options?.credentialMode === 'oauth-bearer') {
      return { authenticated: false, errorReason: 'no_oauth' };
    }
    // 未连订阅 → gateway-spawn:鉴权前提 = XD 网关 key 存在(现状,字节级不变)。
    const apiKey = readClaudeApiKey();
    return apiKey
      ? { authenticated: true }
      : { authenticated: false, errorReason: 'no_key' };
  }

  async triggerLogin(): Promise<AuthState> {
    // Claude 登录入口在 renderer:gateway 模式走 useApiKey hook 填 gateway key;
    // oauth 模式走 Settings 里粘贴 `claude setup-token` 产出的 token(CLAUDE_OAUTH_TOKEN_SET IPC)。
    // main 侧无 spawn 式登录流程,保留此位为扩展位。
    throw new Error('use renderer (useApiKey / Claude OAuth token paste) to trigger Claude login');
  }

  async logout(): Promise<void> {
    // 连了订阅时,logout 清系统 Claude.ai OAuth 凭证(⚠️ 会同时登出本地 claude),
    // **不动** gateway api_key(它是 XD 托管 key,网关来源 + oneShot 都还要用)。
    if (hasClaudeAiOAuth()) {
      // disconnect = 先失效刷新器再清凭证(唯一正确入口,见 claude-oauth-refresh 文档)
      // —— 否则「已断开」状态下在途刷新回写会让凭证复活。
      disconnectClaudeAiOAuth();
      // 用户显式登出:留撤销标记。凭证删除是 best-effort(文件删除吞错),残留凭证不该在
      // 下一次读连接态时被自动认领回来(PR #548 review)。
      unbindNativeProviderAuth('anthropic', { revoked: true });
      return;
    }
    // 经统一 store 移除本机 XD 网关 key。store.remove 把"文件本不存在"视为成功
    // (幂等,等价旧逻辑忽略 ENOENT);其它真实失败保持上抛语义。
    const removed = getProviderSecretStore().remove('xd');
    if (!removed.success) {
      throw new Error(`failed to remove XD gateway key: ${removed.error ?? 'unknown'}`);
    }
    getGhostSetupChangeBus().emitAll({
      source: 'host_config',
      ref: 'model-provider',
    });
  }

  async getAuthEnv(options?: AuthAdapterOptions): Promise<Record<string, string>> {
    await this.ensureSharedGlobalSkills();
    const env: Record<string, string> = {};
    if (options?.credentialMode === 'gateway-key') {
      const apiKey = readClaudeApiKey();
      if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
    } else if (options?.credentialMode === 'provider-oauth') {
      // 真实供应商凭证只留在 host/proxy;占位 key 仅用于通过 CC CLI 本地鉴权检查。
      env.ANTHROPIC_API_KEY = CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY;
    } else if (hasClaudeAiOAuth()) {
      // 连了订阅(oauth-spawn):经 CLAUDE_CODE_OAUTH_TOKEN 显式把订阅 access token 递给
      // cc 子进程(官方桌面宿主协议)。cc 2.1.198 起 CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST
      // (env-builder 无条件注入) 的语义扩大为「凭证也由 host 全权提供」—— 设了 flag 的子进程
      // **完全不读**系统凭证库,旧的「不注入、让 cc 自读 ~/.claude」方案在新 CLI 上直接
      // "Not logged in"(2026-07-03 线上事故:0.0.139 升 cc 2.1.186→2.1.198 后订阅会话全挂)。
      // token 到期刷新随之转移到 host:getClaudeAiOAuthForSpawn **不阻塞 spawn**——立即
      // 注入现值,临期只触发后台单飞刷新(新会话首响应不吃刷新 RTT,规则 10);旧 token 若
      // 已彻底失效,turn 中的 401 由 SDK getOAuthToken 回调走 getFreshSubscriptionToken 兜底。
      // scopes / subscriptionType / rateLimitTier 一并递入 —— cc env-token 分支默认 scopes 只有
      // user:inference,不递会丢订阅身份细节(feature gate / beta header 判定用)。
      // **绝不**注入 ANTHROPIC_API_KEY —— 它与 OAuth 共存会触发 cc 的 shouldDisableAuth 反而
      // 关掉 Anthropic 鉴权(计划 R4)。provider 路由模型要用的 gateway key 不走子进程 env,
      // 由本地 proxy 旁路注入(setClaudeProxyGatewayKeyReader)。
      // (getState 已 gate:无凭证 / proxy 没起来时不授权,不会裸奔到这里 spawn。)
      const oauth = getClaudeAiOAuthForSpawn();
      if (oauth?.accessToken) {
        Object.assign(env, claudeOAuthSpawnEnv(oauth));
      }
    } else if (options?.credentialMode === 'oauth-bearer') {
      // 显式订阅模式没有 OAuth 时,getState 已 fail-closed;这里保持不注入 key。
    } else {
      const apiKey = readClaudeApiKey();
      if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
    }
    // dev 多实例隔离:设了 XDT_USER_DATA_DIR(device-link 本地联调跑多实例)时,把
    // Claude Code 的配置目录也切到 userData 下。否则多实例共用全局 ~/.claude
    // (~/.claude.json / projects 下的 transcripts)会互相干扰,无法当作两台独立设备。
    // 仅 dev(非 packaged)生效,生产忽略;auth 走 ANTHROPIC_API_KEY,重定向 config
    // dir 不影响鉴权。process.env 路线行不通(CLAUDE_CONFIG_DIR 在 boot 期被
    // stripSensitiveAnthropicEnv 清掉),故经 getAuthEnv 注入子进程 env(覆盖优先)。
    if (
      process.env.XDT_USER_DATA_DIR &&
      !app.isPackaged &&
      !process.env.CLAUDE_CONFIG_DIR
    ) {
      env.CLAUDE_CONFIG_DIR = path.join(app.getPath('userData'), 'claude-home');
    }
    return env;
  }

  /**
   * host 侧直连 LLM 调用(oneShot 起标题 / skillReview)的凭证。
   *
   * 仅连了订阅(oauth-spawn)时需要特殊处理:此时 getAuthEnv() 不带 ANTHROPIC_API_KEY(只注入订阅 token),
   * oneShot 拿不到 key。固定回 gateway key + **直连 gateway endpoint**(绕开 loopback proxy 的
   * 路由)—— 避免 oneShot 这种无 system prompt 的轻任务被路由去 api.anthropic.com 撞
   * claude.ai OAuth 策略(无 Claude Code 身份段会被拒)。
   * 未连订阅回 null → oneShot 走旧路径(getAuthEnv.ANTHROPIC_API_KEY + runtimeConfig.endpoint),零改动。
   */
  async getOneShotAuth(): Promise<{ apiKey: string; baseURL?: string } | null> {
    if (!hasClaudeAiOAuth()) return null;
    const apiKey = readClaudeApiKey();
    if (!apiKey) return null;
    return { apiKey, baseURL: claudeUpstreamEndpoint() };
  }

  /**
   * cc 子进程 turn 中途 401 时经 SDK oauth_token_refresh control 回调走到这里
   * (见 maker-core claude-code getOAuthToken 接线)。forceRefresh 语义 = 锁内比对后
   * 按需刷:凭证库已比失败 token 新 → 直接返回不刷(防多会话同时 401 连环旋转);
   * 仍旧才单飞刷新;失败返回 null(绝不把已知坏 token 递回去)。
   *
   * 超时预算 12s —— 必须显著小于 cc 侧 control 请求的 30s(反编译 eqf=30000):
   * 超时快速返回 null 让 cc 落磁盘兜底(host 刷新总会写回凭证库,在途刷新即使超过
   * 预算也会完成写回,cc 第二条恢复路 tengu_oauth_401_recovered_from_disk 能捡到),
   * 不把整个 turn 吊在一次慢网络上。
   */
  async getFreshSubscriptionToken(staleToken?: string): Promise<string | null> {
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), CLAUDE_OAUTH_CALLBACK_TIMEOUT_MS).unref?.(),
    );
    // staleToken = 该会话实际撞 401 的那枚(spawn 注入 / 上次回调返回)。库值已比它新
    // (后台预续期换代)时刷新器直接返回库值,不再消耗一次轮换 —— 防多个长会话对同
    // 一枚旧 token 群体 401 时串行连环旋转。
    const refresh = getValidClaudeAiOAuth({ forceRefresh: true, staleToken }).then(
      (oauth) => oauth?.accessToken ?? null,
    );
    return Promise.race([refresh, timeout]);
  }

  // cancelLogin 不实现 —— Claude 走 renderer useApiKey hook 的同步弹窗式登录,
  // 没有需要 abort 的子进程。BaseAgent.cancelLogin 调到这里时是 no-op (interface 可选)。
}

// ═════════════════════════════════════════════════════════════════════════════
// Codex — OAuth 子进程登录, 读 auth.json 判状态
// ═════════════════════════════════════════════════════════════════════════════

/** Codex AuthAdapter —— OAuth 子进程登录 + auth.json 读状态; getAuthEnv 仅注入 CODEX_HOME。 */
type PendingCodexLogin = {
  mode: AgentLoginMode;
  promise: Promise<AuthState>;
  progressListeners: Set<NonNullable<AuthLoginOptions['onProgress']>>;
  progressHistory: string[];
  progressHistoryChars: number;
  cancelled: boolean;
};

const MAX_COALESCED_LOGIN_PROGRESS_CHARS = 64 * 1024;

export class DesktopCodexAuthAdapter implements AuthAdapter {
  private currentLoginProc: ChildProcess | null = null;
  /** 同模式重复点击共用流程；切换登录模式时先取消旧流程再串行启动新流程。 */
  private pendingLogin: PendingCodexLogin | null = null;
  /** logout 全流程的线性化点；其间新登录排队到凭证清理和解绑全部完成之后。 */
  private logoutOperation: Promise<void> | null = null;
  private loginAborted = false;
  /** CLI 和凭证 finalize 都未收口时接受取消；成功结果返回后才关闭窗口。 */
  private loginCancellationOpen = false;
  /**
   * logout() 成功后回调 —— 由 maker-host 注入本地 Codex host 收割。
   * local app-server 内存里仍持有旧 token, 不杀的话切账号会用旧 token。
   * 远端 host 使用远端 daemon / 远端用户配置,不能被本地 logout 误关。
   *
   */
  private onLogoutSuccess?: () => void | Promise<void>;

  /**
   * OAuth 登录成功后的对称处置回调(与 onLogoutSuccess 同款接线)。
   *
   * 历史上认为不需要 —— "getHost 自带 auth gate, 授权前根本不会 spawn"。这个前提
   * 在网关 key fallback 下不成立:仅配了 XD 网关 key 的用户是 authenticated 的,
   * 隐式会话早就 spawn 出 env-key 形态的共享 host;此时完成 OAuth 登录,fallback
   * 实际钥匙已变成 oauth-bearer,但在跑的 host 不会自己重判 —— 后续隐式会话经
   * 快路径继续复用旧 env-key 进程,用户以为在用订阅实际仍走网关(codex review
   * 2026-07-03 P2)。登录成功后与 logout 同款强制重启本地 host,下次 getHost
   * 按新 fallback 重建。
   */
  private onLoginSuccess?: () => void | Promise<void>;

  /**
   * invalidate() 触发时收口 host 侧鉴权派生状态，再把 auth state 推给 renderer。
   * 由 maker-host 注入并允许 async — 适配层不直接 import IPC channel 常量,保持单向依赖。
   */
  private onInvalidatedBroadcast?: (reason: string) => void | Promise<void>;
  private oauthInvalidatedReason: string | null = null;
  private suppressSystemCodexReconcile = false;

  /**
   * 进行中的 ensureGlobalCodexAssets 调用 —— 同一时刻并发进入直接复用同一 Promise,
   * 避免重复 stat / copy。每次 codex session start 都会过一遍 getAuthEnv → ensure,
   * 没有缓存时连续启动会触发并发竞态 (功能正确但浪费 io)。结束后置 null 不做长期缓存,
   * 因为源文件 (~/.codex/AGENTS.md) 随时可能被用户改, 仍需要后续调用触发新一轮检查。
   */
  private pendingAssetsPrep: Promise<void> | null = null;

  /**
   * 进行中的 reconcileWithSystemCodex 调用 —— 多个调用点 (构造 / getState / getAuthEnv /
   * getAccessToken / getAccountId) 并发进入时复用同一次在途 reconcile, 避免它们同时去
   * 替换 auth.json 撞临时文件 / 反复 stat。reconcile 读的是实时文件状态, 合并并发调用
   * 语义上等价于跑一次。结束后置 null, 不做长期缓存 (~/.codex 随时可能被外部 codex 改)。
   */
  private pendingReconcile: Promise<void> | null = null;

  /** invalidation marker 是否已从磁盘加载过 (惰性一次, 见 ensureInvalidationMarkerLoaded)。 */
  private invalidationMarkerLoaded = false;

  /**
   * ⚠️ 本类**不允许有构造副作用**(连读盘都不行)。模块底部有 import 即执行的单例,
   * 构造期 IO 会让任何(传递性)import 到本模块的代码在真实文件系统留痕 ——
   * 2026-07-03 曾因测试把 userData mock 成 cwd,构造期预热把 codex-home 整套骨架
   * (含真实 ~/.codex/auth.json 的硬链)生成进了仓库 apps/desktop/ 下(PR #438)。
   * 原构造函数的逻辑拆成: marker 读取 → ensureInvalidationMarkerLoaded(懒加载),
   * 目录/凭证预热 → warmUp()(由 maker-host 装配时显式调用)。
   * import 纯度由 __tests__/authAdaptersImportPurity.test.ts 回归保护。
   */

  /**
   * codexHome 每次现取而非构造期冻结:userData 在 dev 下可被 XDT_USER_DATA_DIR /
   * --isolated 覆写,测试里 getPath mock 的值也可能在构造之后才就位;现取保证
   * 永远跟随当前 userData(app.getPath 是内存查表,无 IO 开销)。
   */
  private get codexHome(): string {
    return getCodexHome();
  }

  /**
   * 惰性加载「系统 codex 凭证已被服务端作废」marker(原构造函数逻辑)。
   * 所有消费 oauthInvalidatedReason / suppressSystemCodexReconcile 的入口先过这里,
   * 保证语义与旧实现一致;logout / invalidate 会写权威状态,也先过这里防止其后
   * 首次懒加载用磁盘旧值覆盖内存新值。
   */
  private ensureInvalidationMarkerLoaded(): void {
    if (this.invalidationMarkerLoaded) return;
    this.invalidationMarkerLoaded = true;
    const restored = restoreInvalidationStateOnStartup(
      this.codexHome,
      getSystemCodexAuthPath(),
      path.join(this.codexHome, 'auth.json'),
    );
    this.suppressSystemCodexReconcile = restored.suppressReconcile;
    this.oauthInvalidatedReason = restored.invalidatedReason;
  }

  /**
   * 生产启动预热 —— 等价旧构造函数里的 fire-and-forget:提前建好 codex-home 骨架、
   * 和本机 codex CLI (~/.codex/auth.json) 协调凭证(防止两份 refresh_token 互相
   * rotate 导致服务端 invalidate 对方),让首次 getState / spawn 走热路径。
   * 由 maker-host 装配 codex agent 时显式调用;失败静默,后续 getAuthEnv / getState
   * 的按需 ensure / reconcile 会兜底。
   */
  warmUp(): void {
    this.ensureInvalidationMarkerLoaded();
    // 串行:先建 codex-home 骨架、再 reconcile。并行时首启(目录尚不存在)的 reconcile
    // 会在建目录前尝试硬链,白跑一次注定 ENOENT 的 IO(目录兜底见 runReconcile 内 mkdir)。
    void this.ensureGlobalCodexAssets()
      .catch(() => undefined)
      .then(() => this.reconcileWithSystemCodex())
      .catch(() => undefined);
  }

  /**
   * 和本机 codex CLI 协调 auth.json 存储:
   *   - 本机没装 / 没登 (~/.codex/auth.json 不存在) → no-op, xdt-maker 走自己的
   *   - xdt-maker 这边和本机已经是同 inode → no-op (热路径)
   *   - 双方账号一致 (或 xdt-maker 还没登过) → 删 xdt-maker 的 auth.json,
   *     建硬链指向 ~/.codex/auth.json, refresh 写回同步生效在两端
   *   - 双方账号不同 → no-op, 各管各
   *   - 跨分区 / 权限失败 → no-op, xdt-maker 这边的 auth.json 完全不动
   *
   * 幂等: 反复调用结果一致 (已是硬链则 inode 比对短路)。
   * 设计上只在启动 / getAuthEnv / triggerLogin 成功后调, 不做运行时 watch ——
   * 用户在本机 codex 切账号后, 自愈靠下次 xdt-maker 启动重跑这里。
   *
   * dedup 包装: 并发调用复用同一次在途 reconcile (见 pendingReconcile 字段)。
   */
  private reconcileWithSystemCodex(): Promise<void> {
    if (this.pendingReconcile) return this.pendingReconcile;
    // 发起时刻固定会话快照:reconcile 是异步的,期间可能发生账号切换;绑定自愈
    // 只允许写给「发起时与完成时都是同一个已提交会话」的 owner(见 claim 内校验)。
    const sessionAtStart = getActiveAppSession();
    const run = this.runReconcileWithSystemCodex()
      .then(() => this.claimDetectedCodexOAuthBinding(sessionAtStart))
      .finally(() => {
        if (this.pendingReconcile === run) this.pendingReconcile = null;
      });
    this.pendingReconcile = run;
    return run;
  }

  /**
   * reconcile 收口后的绑定自愈:codex-home 里存在可用 OAuth token(硬链自本机 CLI 或
   * 早年隔离登录)、而 openai 尚无任何 owner 绑定时,把它绑给当前 owner。
   *
   * 修复的时序竞态:一次性 legacy 迁移(migrateLegacyNativeProviderAuthBindings)在
   * 首次登录时快照 hasCodexOAuthLoginUnbound(),但 reconcile 硬链往往还没建立 ——
   * 名额被以 openai:false 永久消费,首个 owner 从此拿不到设计内的自动继承;local 模式
   * owner 更是从不跑该迁移。结果是 getState 报 authenticated(读 auth.json)而
   * provider connected=false(查绑定),设置页「已连接」与聊天门禁「无来源」自相矛盾。
   *
   * 安全边界不变:已有归属(含别的账号)/ legacyClaimOwner 是别的账号 / durable
   * disconnect 抑制中,一律不写(见 claimDetectedNativeProviderAuth),换账号继续
   * fail-closed。写失败只记日志,不让 reconcile 链路抛穿。
   *
   * 会话边界防护(review P1):claim 在异步 reconcile 完成后执行,期间可能发生账号
   * 切换。只在「发起时与完成时是同一个已提交会话(owner + generation 均未变)、且
   * 没有会话边界切换在途」时才允许写入;否则放弃本轮 —— 新会话自己的下一次
   * reconcile 会带着自己的快照重试,自愈不丢,只是绝不把 A 时代发起的认领写到 B 名下。
   */
  private claimDetectedCodexOAuthBinding(sessionAtStart: ActiveAppSession): void {
    const session = getActiveAppSession();
    if (isAppSessionBoundaryPending()) return;
    if (
      session.generation !== sessionAtStart.generation ||
      session.dataOwnerId !== sessionAtStart.dataOwnerId
    ) {
      return;
    }
    if (this.oauthInvalidatedReason) return;
    const authPath = path.join(this.codexHome, 'auth.json');
    if (shouldSuppressLocalCodexAuth(this.codexHome, authPath)) return;
    try {
      if (claimDetectedNativeProviderAuth('openai', () => this.hasCodexOAuthLoginUnbound())) {
        log.info('codex OAuth credential auto-bound to current owner after reconcile');
      }
    } catch (err) {
      log.warn('codex OAuth binding claim failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 登录成功后专用: 先等在途的 reconcile 结束, 再保证用刚写好的 auth.json 重新跑一遍。
   * 否则 dedup 可能把这次"必须基于最新 auth.json"的 reconcile 合并到一个用登录前状态
   * 启动的在途调用上, 导致刚登录的凭证没被正确共享 (规则 9: 用代码而非侥幸保证确定性)。
   */
  private async reconcileWithSystemCodexAfterLogin(): Promise<void> {
    const inflight = this.pendingReconcile;
    if (inflight) await inflight.catch(() => undefined);
    await this.reconcileWithSystemCodex();
  }

  /** reconcile 真正的执行体 —— 只经由 reconcileWithSystemCodex(AfterLogin) 调用, 不直接对外。 */
  private async runReconcileWithSystemCodex(): Promise<void> {
    this.ensureInvalidationMarkerLoaded();
    if (this.suppressSystemCodexReconcile) {
      const marker = readInvalidatedSystemCodexAuthMarker(this.codexHome);
      if (marker && markerMatchesCurrentSystemCodexAuth(marker, getSystemCodexAuthPath())) return;
      this.suppressSystemCodexReconcile = false;
      this.oauthInvalidatedReason = null;
      clearInvalidatedSystemCodexAuthMarker(this.codexHome);
    }

    const systemAuth = getSystemCodexAuthPath();
    const myAuth = path.join(this.codexHome, 'auth.json');

    if (!existsSync(systemAuth)) return;

    // 热路径: 已经是同 inode 直接返回
    if (existsSync(myAuth)) {
      try {
        const sysStat = await fsp.stat(systemAuth);
        const myStat = await fsp.stat(myAuth);
        if (sysStat.ino === myStat.ino && sysStat.dev === myStat.dev) return;
      } catch {
        /* stat 失败走完整流程 */
      }
    }

    const sysAccount = await readCodexAccountId(systemAuth);
    if (!sysAccount) return; // 本机 auth.json 解析不出 account, 保守不动

    if (existsSync(myAuth)) {
      const myAccount = await readCodexAccountId(myAuth);
      // 解析得出且不同 → 不同账号, 各管各
      if (myAccount && myAccount !== sysAccount) {
        log.info('system codex logged in as different account, keeping isolated auth');
        return;
      }
      // myAccount === sysAccount, 或 myAccount 解析不出 (可能是损坏/旧 schema): 都按"可合并"处理
    }

    // 同账号 (或 xdt-maker 没登过): 用本机的, 通过硬链共享, refresh 写回两端同步。
    // 安全替换 (唯一 sidecar + 失败重建) 见 codex-auth-link.ts —— 避免并发撞临时文件、
    // 以及"myAuth 删了又建不回去导致用户被迫重登"的空窗。
    // 硬链前幂等确保 codexHome 目录存在: 首启时 assets 预热可能尚未建好目录, ENOENT
    // 会让 relink 走 link-unsupported 回退, splash 后首次 auth 查询短暂误报未登录。
    await fsp.mkdir(this.codexHome, { recursive: true }).catch(() => undefined);
    const { kind, error } = await relinkSharedCodexAuth(systemAuth, myAuth);
    switch (kind) {
      case 'linked':
        log.info('codex auth.json linked with ~/.codex (shared)');
        break;
      case 'link-unsupported':
        // 跨分区 / 权限 → 建不出硬链, myAuth 一字未动, xdt-maker 继续走自己的隔离 auth。
        log.warn('hardlink to ~/.codex failed, fallback to isolated auth', {
          error: error?.message,
        });
        break;
      case 'swap-failed-intact':
        // 替换失败但 myAuth 完好 (多半并发的另一次已放好) —— 无需补救。
        log.warn('reconcile swap failed, auth.json left intact', { error: error?.message });
        break;
      case 'recovered':
        // 替换中途 myAuth 一度丢失但已从 ~/.codex 重建 —— 用户无感, 仅记一笔。
        log.warn('reconcile swap failed but auth.json recovered from ~/.codex', {
          error: error?.message,
        });
        break;
      case 'lost':
        // 极端: myAuth 丢了且 systemAuth 也读不回 —— 这次只能让用户重新登录。
        log.error('reconcile swap failed and auth.json lost; user must re-login', {
          error: error?.message,
        });
        break;
    }
  }

  async ensureGlobalCodexAssets(): Promise<void> {
    if (this.pendingAssetsPrep) return this.pendingAssetsPrep;
    this.pendingAssetsPrep = this.runEnsureGlobalCodexAssets().finally(() => {
      this.pendingAssetsPrep = null;
    });
    return this.pendingAssetsPrep;
  }

  private async runEnsureGlobalCodexAssets(): Promise<void> {
    // Load-bearing order: Codex skill linking scans ~/.agents/skills, so shared
    // links must populate that directory before prepareCodexGlobalSkillsLinks runs.
    const sharedOutcome = await prepareSharedGlobalSkillLinks().then(
      (r) => ({ ok: true as const, label: 'shared-skills' as const, warnings: r.warnings }),
      (err: Error) => ({ ok: false as const, label: 'shared-skills' as const, err }),
    );

    const [skillsOutcome, rulesOutcome, pluginsOutcome] = await Promise.all([
      prepareCodexGlobalSkillsLinks(this.codexHome).then(
        (r) => ({ ok: true as const, label: 'skills' as const, warnings: r.warnings }),
        (err: Error) => ({ ok: false as const, label: 'skills' as const, err }),
      ),
      prepareCodexGlobalRulesCopy(this.codexHome).then(
        (r) => ({ ok: true as const, label: 'rules' as const, warnings: r.warnings }),
        (err: Error) => ({ ok: false as const, label: 'rules' as const, err }),
      ),
      prepareCodexGlobalPluginsBridge(this.codexHome).then(
        (r) => ({ ok: true as const, label: 'plugins' as const, warnings: r.warnings }),
        (err: Error) => ({ ok: false as const, label: 'plugins' as const, err }),
      ),
    ]);

    for (const outcome of [sharedOutcome, skillsOutcome, rulesOutcome, pluginsOutcome]) {
      if (!outcome.ok) {
        log.warn('prepare Codex global asset failed', {
          asset: outcome.label,
          error: outcome.err.message,
        });
        continue;
      }
      for (const warning of outcome.warnings) {
        log.warn('Codex global asset warning', { asset: outcome.label, warning });
      }
    }
  }

  /** maker-host 在构造完 codexAgent 后调一次, 注入 dispose 回调。 */
  setOnLogoutSuccess(cb: () => void | Promise<void>): void {
    this.onLogoutSuccess = cb;
  }

  /** maker-host 注入: OAuth 登录成功后重启本地 codex host(见 onLoginSuccess 字段注释)。 */
  setOnLoginSuccess(cb: () => void | Promise<void>): void {
    this.onLoginSuccess = cb;
  }

  /** maker-host 注入: invalidate() 触发后收口派生状态并给 renderer push auth state。 */
  setOnInvalidatedBroadcast(cb: (reason: string) => void | Promise<void>): void {
    this.onInvalidatedBroadcast = cb;
  }

  async getState(options?: AuthAdapterOptions): Promise<AuthState> {
    return this.readState({ credentialMode: options?.credentialMode });
  }

  private async readState(options?: {
    skipReconcile?: boolean;
    credentialMode?: AuthAdapterOptions['credentialMode'];
  }): Promise<AuthState> {
    this.ensureInvalidationMarkerLoaded();
    // 鉴权前提:有 Codex OAuth 登录(→ oauth-bearer spawn,可 per-session 选 ChatGPT 订阅 / XD 网关),
    // 或退而求其次有 XD 网关 key(→ env-key spawn,全量走网关)。两者都没有 = 未授权。
    // 「授权某来源 = 它可选,不等于自动走它」—— 具体走哪个供应商由 per-session 选择 + proxy 路由决定,
    // 不在这道全局 gate 上拦。下方 reconcile → 本地 auth.json → api-key fallback 即覆盖上述语义。
    if (options?.credentialMode === 'gateway-key') {
      return readClaudeApiKey()
        ? { authenticated: true, identity: 'API Key · Cindy AI', authSource: 'api-key' }
        : { authenticated: false, errorReason: 'no_key' };
    }
    if (options?.credentialMode === 'provider-oauth') {
      return { authenticated: true, identity: 'Provider OAuth · Proxy', authSource: 'api-key' };
    }
    if (this.oauthInvalidatedReason) {
      await this.clearStaleInvalidationIfSystemCodexChanged();
    }
    if (this.oauthInvalidatedReason) {
      return { authenticated: false, errorReason: this.oauthInvalidatedReason };
    }

    // 先 reconcile —— 新用户首次打开 xdt-maker 时, 如果本机已登过 codex,
    // 这一步会建硬链把本机的 auth.json 引过来, getState 直接报 authenticated,
    // 用户不用再走一次 OAuth 流程。
    if (!options?.skipReconcile) {
      await this.reconcileWithSystemCodex();
    }
    if (options?.credentialMode === 'oauth-bearer') {
      const localState = await this.readLocalCodexAuthState();
      if (localState.authenticated) {
        const accessToken = await this.getAccessToken();
        if (accessToken) return localState;
      }
      return { authenticated: false, errorReason: localState.errorReason ?? 'no_oauth' };
    }
    const localState = await this.readLocalCodexAuthState();
    // 绑定 gate(与 provider 目录 connected / getAccessToken 同口径,对齐 Anthropic 侧
    // readClaudeAiOAuth 的读取层校验):auth.json 是与系统 CLI 共享的存储,凭证在、但
    // openai 未绑定到当前 owner 时,不得以 OAuth 已连接示人 —— 否则设置页显示「已连接」
    // 而聊天门禁按无来源拦截,状态自相矛盾。上方 reconcile 收口已把「首个 owner 检测到
    // 本机 CLI 凭证」的合法自动继承补好绑定(claimDetectedCodexOAuthBinding);走到这里
    // 仍未绑定的只剩换账号等 fail-closed 场景,按无 OAuth 处理,可退网关 key。
    if (
      localState.authenticated &&
      localState.authSource === 'oauth' &&
      !isNativeProviderAuthBound('openai')
    ) {
      if (readClaudeApiKey()) {
        return { authenticated: true, identity: 'API Key · Cindy AI', authSource: 'api-key' };
      }
      return { authenticated: false, errorReason: 'oauth_not_bound' };
    }
    if (localState.authenticated) {
      // api-key 型 auth.json(可解析但无 access_token)且配了网关 key:fallback spawn
      // 实际会走 gateway key(hasCodexOAuthLogin=false),authSource 补成 'api-key'
      // 与之同源 —— 隐式会话据此归一化成 gateway-key,与显式 xd 会话同族复用,
      // 不再空转一次凭证切换(codex review P2 第 3 条)。两个 key 都没有时保持
      // authSource 缺省,归一化解析不出 → 保守重建,语义不变。
      if (!localState.authSource && readClaudeApiKey()) {
        return { ...localState, authSource: 'api-key' };
      }
      return localState;
    }
    // proxy 路线: 无 OAuth 登录但配了 api key → 仍放行 codex 进程(折扣模型经 proxy 走 gateway 可用)。
    // 单条 model 的可用性由 ModelSelector + proxy 路由把关, 不在这道全局 gate 上拦。
    if (readClaudeApiKey()) {
      return { authenticated: true, identity: 'API Key · Cindy AI', authSource: 'api-key' };
    }
    return localState;
  }

  private async clearStaleInvalidationIfSystemCodexChanged(): Promise<void> {
    if (!this.oauthInvalidatedReason) return;
    const marker = readInvalidatedSystemCodexAuthMarker(this.codexHome);
    if (!marker) return;
    if (markerMatchesCurrentSystemCodexAuth(marker, getSystemCodexAuthPath())) return;
    this.oauthInvalidatedReason = null;
    this.suppressSystemCodexReconcile = false;
    clearInvalidatedSystemCodexAuthMarker(this.codexHome);
    await this.reconcileWithSystemCodex();
  }

  private async readLocalCodexAuthState(): Promise<AuthState> {
    const authPath = path.join(this.codexHome, 'auth.json');
    if (!existsSync(authPath)) return { authenticated: false };
    // logout 的 marker 先于 unlink 落盘；崩溃 / 文件锁导致旧 auth 残留时也不能复活账号。
    // 新一次显式 OAuth 会写入不同 fingerprint，因此不会被这条规则误伤。
    if (shouldSuppressLocalCodexAuth(this.codexHome, authPath)) {
      return { authenticated: false };
    }
    try {
      const raw = await fsp.readFile(authPath, 'utf-8');
      const obj = JSON.parse(raw) as {
        account?: { email?: unknown };
        expires_at?: unknown;
        tokens?: { access_token?: unknown };
      };
      const identity = typeof obj.account?.email === 'string' ? obj.account.email : undefined;
      const expiresAt = typeof obj.expires_at === 'number' ? obj.expires_at : undefined;
      // authSource='oauth' 必须与 spawn fallback 的判定同源(hasCodexOAuthLogin =
      // auth.json 含 access_token,见下方 getAccessToken 的字段路径)。`codex login
      // --api-key` 产生的 auth.json 没有 tokens —— 若仅凭"能解析"就标 oauth,
      // maker-core 会把隐式会话归一成 oauth-bearer,而 spawn fallback 实际走
      // gateway key,共享 host 被登记错形态 → 后续显式 oauth 会话静默复用网关
      // key 进程(review P1)。tokens 缺失时不标 authSource,归一化解析不出
      // 即回退保守的"重建"语义,登录门禁(authenticated)不受影响。
      const hasOAuthToken =
        typeof obj.tokens?.access_token === 'string' && obj.tokens.access_token.length > 0;
      return hasOAuthToken
        ? { authenticated: true, identity, expiresAt, authSource: 'oauth' }
        : { authenticated: true, identity, expiresAt };
    } catch {
      // JSON.parse 失败 / IO 错 → 降级为未登录 + errorReason, 不抛
      return { authenticated: false, errorReason: 'auth_parse_failed' };
    }
  }

  triggerLogin(opts?: AuthLoginOptions): Promise<AuthState> {
    const mode = opts?.mode ?? 'browser';
    if (this.pendingLogin) {
      if (this.pendingLogin.mode === mode && !this.pendingLogin.cancelled) {
        if (opts?.onProgress && !this.pendingLogin.progressListeners.has(opts.onProgress)) {
          this.pendingLogin.progressListeners.add(opts.onProgress);
          for (const message of this.pendingLogin.progressHistory) {
            try {
              opts.onProgress(message);
            } catch {
              /* 一个 IPC listener 失败不能阻断其它窗口或登录流程。 */
            }
          }
        }
        return this.pendingLogin.promise;
      }
      const previous = this.pendingLogin.promise;
      if (!this.pendingLogin.cancelled) this.cancelLogin();
      const waits = [previous, ...(this.logoutOperation ? [this.logoutOperation] : [])];
      const barrier = Promise.all(waits.map((operation) => operation.catch(() => undefined)));
      return this.startTrackedLogin(opts, barrier);
    }
    return this.startTrackedLogin(opts, this.logoutOperation ?? undefined);
  }

  private startTrackedLogin(
    opts?: AuthLoginOptions,
    waitFor?: Promise<unknown>,
  ): Promise<AuthState> {
    const mode = opts?.mode ?? 'browser';
    const operation: PendingCodexLogin = {
      mode,
      promise: null as unknown as Promise<AuthState>,
      progressListeners: new Set(opts?.onProgress ? [opts.onProgress] : []),
      progressHistory: [],
      progressHistoryChars: 0,
      cancelled: false,
    };
    const emitProgress = (message: string): void => {
      operation.progressHistory.push(message);
      operation.progressHistoryChars += message.length;
      while (
        operation.progressHistoryChars > MAX_COALESCED_LOGIN_PROGRESS_CHARS
        && operation.progressHistory.length > 1
      ) {
        operation.progressHistoryChars -= operation.progressHistory.shift()?.length ?? 0;
      }
      for (const listener of operation.progressListeners) {
        try {
          listener(message);
        } catch {
          /* 一个 IPC listener 失败不能阻断其它窗口或登录流程。 */
        }
      }
    };
    const start = (): Promise<AuthState> => {
      if (operation.cancelled) {
        return Promise.resolve({ authenticated: false, errorReason: 'login_cancelled' });
      }
      return this.runTriggerLogin(
        { ...opts, mode, onProgress: emitProgress },
        () => operation.cancelled,
      );
    };
    const execution = waitFor
      ? waitFor.catch(() => undefined).then(start)
      : start();
    const run = execution.finally(() => {
      if (this.pendingLogin?.promise !== run) return;
      this.pendingLogin = null;
      this.loginCancellationOpen = false;
    });
    operation.promise = run;
    this.pendingLogin = operation;
    return run;
  }

  private async runTriggerLogin(
    opts?: AuthLoginOptions,
    isCancelled: () => boolean = () => false,
  ): Promise<AuthState> {
    this.ensureInvalidationMarkerLoaded();
    this.loginAborted = false;
    this.loginCancellationOpen = true;
    await this.ensureGlobalCodexAssets();

    // Binary 必须在应用启动时就绪 (bootstrap-electron 的 ready 钩子会阻塞预下载)。
    // 这里仅做一次 readiness 快查作为兜底 —— 正常情况下永远是 true。
    const cached = getCachedBinaryStatus('codex');
    if (!cached.binaryReady || !cached.binaryPath) {
      return { authenticated: false, errorReason: 'codex_binary_missing' };
    }
    if (this.loginAborted) {
      return { authenticated: false, errorReason: 'login_cancelled' };
    }
    // durable disconnect 后 Windows 可能因文件锁留下旧 auth.json。不能把这份已抑制凭证
    // 交给 codex login（CLI 可能按“已有登录”直接退出而不重写）；锁仍在时本轮 fail-closed，
    // 用户重试会再次清理。
    const cleanupFailure = await resolveCodexLoginCleanupPreflight(
      () => clearCodexAuthBoundaryStateBeforeLogin(this.codexHome),
      () => this.loginAborted,
    );
    if (cleanupFailure) return cleanupFailure;

    const binaryPath = cached.binaryPath;
    // 执行前复核路径确为受管二进制(CodeQL js/command-line-injection 防御纵深)
    if (!isVettedAgentBinaryPath('codex', binaryPath)) {
      return { authenticated: false, errorReason: 'codex_binary_missing' };
    }

    // spawn codex login。POSIX 建独立进程组，取消/超时时连同回调 server 一起收割。
    return new Promise<AuthState>((resolve) => {
      const mode: AgentLoginMode = opts?.mode ?? 'browser';
      const proc = spawn(binaryPath, codexLoginArgs(mode), {
        shell: false,
        env: { ...process.env, CODEX_HOME: this.codexHome },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      this.currentLoginProc = proc;
      let settled = false;
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;

      const stderrTail: string[] = [];
      proc.stdout?.on('data', (chunk: Buffer) => {
        // data chunk 边界不等于文本边界；保留原始空白，IPC 层会分流累积后解析。
        opts?.onProgress?.(`stdout:${String(chunk)}`);
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        const raw = String(chunk);
        stderrTail.push(raw.trim());
        if (stderrTail.length > 5) stderrTail.shift();
        opts?.onProgress?.(`stderr:${raw}`);
      });

      const complete = (state: AuthState): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (this.currentLoginProc === proc) this.currentLoginProc = null;
        resolve(state);
      };

      timeout = setTimeout(() => {
        timedOut = true;
        this.loginCancellationOpen = false;
        terminateCodexLoginProcess(proc);
      }, CODEX_LOGIN_TIMEOUT_MS);
      timeout.unref?.();

      proc.once('exit', (code) => {
        // 根进程已经退出，先摘掉 timer / process 引用再做异步凭证 finalize；否则迟到
        // cancel 可能重复终止已退出进程，或把成功结果错误翻成 cancelled。
        if (timeout) clearTimeout(timeout);
        if (this.currentLoginProc === proc) this.currentLoginProc = null;
        const cancelled = this.loginAborted || isCancelled();
        const exitState = resolveCodexLoginExitState({
          cancelled,
          timedOut,
          exitCode: code,
          stderr: stderrTail.join(' | '),
        });
        if (exitState) {
          complete(exitState);
          return;
        }
        const noOAuthFallback: AuthState | undefined = cancelled
          ? { authenticated: false, errorReason: 'login_cancelled' }
          : timedOut
            ? { authenticated: false, errorReason: 'login_timeout' }
            : undefined;
        void this.finishSuccessfulCodexLogin(
          noOAuthFallback,
          () => this.loginAborted || isCancelled(),
        ).then(complete, (err: unknown) => {
          complete({
            authenticated: false,
            errorReason: `login_finalize_error:${err instanceof Error ? err.message : String(err)}`,
          });
        });
      });

      proc.once('error', (err) => {
        this.loginCancellationOpen = false;
        complete({ authenticated: false, errorReason: `spawn_error:${err.message}` });
      });
    });
  }

  private async finishSuccessfulCodexLogin(
    noOAuthFallback?: AuthState,
    isCancelled: () => boolean = () => false,
  ): Promise<AuthState> {
    const cancelFinalization = (): Promise<AuthState> | null => {
      if (!isCancelled()) return null;
      // The CLI may already have written a valid token. A late Cancel must establish the same
      // durable disconnected boundary as logout, otherwise the next state read can resurrect it.
      return this.disconnectCodexOAuth().then(() => ({
        authenticated: false,
        errorReason: 'login_cancelled',
      }));
    };
    const cancelledBeforeFinalize = cancelFinalization();
    if (cancelledBeforeFinalize) return cancelledBeforeFinalize;

    // 收紧 auth.json 权限 (fail-soft: 失败只打日志, 不阻塞登录成功)。
    // Win 上 chmod 0o600 在 NTFS 是 no-op,走 icacls；POSIX 用标准 0o600。
    const authPath = path.join(this.codexHome, 'auth.json');
    if (existsSync(authPath)) {
      if (process.platform === 'win32') {
        await tightenAclWindows(authPath).catch((e: unknown) => {
          log.warn('icacls auth.json failed', { error: String(e) });
        });
      } else {
        await fsp.chmod(authPath, 0o600).catch((e: unknown) => {
          log.warn('chmod auth.json failed', { error: String(e) });
        });
      }
    }
    // 先直接校验刚由 CLI 写入的本地文件，再改变 invalidation / reconcile 状态。否则 CLI
    // 即使 exit 0 但没产出 access_token，也会把原来的 token_invalidated 内存态提前清掉。
    const localOAuthState = requireCodexOAuthLoginState(await this.readLocalCodexAuthState());
    const cancelledAfterLocalRead = cancelFinalization();
    if (cancelledAfterLocalRead) return cancelledAfterLocalRead;
    if (!localOAuthState.authenticated) return noOAuthFallback ?? localOAuthState;

    // 系统文件仍是被判坏 / 被用户主动断开的原凭证时继续 suppress，避免覆盖新登录。
    this.oauthInvalidatedReason = null;
    const { keepSuppressed } = settleInvalidationMarkerAfterLogin(
      this.codexHome,
      getSystemCodexAuthPath(),
    );
    this.suppressSystemCodexReconcile = keepSuppressed;
    if (keepSuppressed) {
      log.warn('system codex auth.json marker still active; keeping reconcile suppressed after login');
    } else {
      await this.reconcileWithSystemCodexAfterLogin();
    }
    const cancelledAfterReconcile = cancelFinalization();
    if (cancelledAfterReconcile) return cancelledAfterReconcile;
    // `codex login` 的成功必须由真实 access_token 证明；绝不能被 XD Gateway fallback 冒充。
    bindNativeProviderAuth('openai');
    const state = requireCodexOAuthLoginState(
      await this.readState({ skipReconcile: true, credentialMode: 'oauth-bearer' }),
    );
    const cancelledAfterStateRead = cancelFinalization();
    if (cancelledAfterStateRead) return cancelledAfterStateRead;
    if (!state.authenticated) return state;

    // 真正拿到 OAuth 后才重启本地 codex host；失败只记日志，不翻转登录结果。
    if (this.onLoginSuccess) {
      try {
        await this.onLoginSuccess();
      } catch (e) {
        log.warn('onLoginSuccess threw', { error: (e as Error).message });
      }
    }
    const cancelledAfterHostRestart = cancelFinalization();
    if (cancelledAfterHostRestart) return cancelledAfterHostRestart;
    return state;
  }

  /** Codex OAuth 子进程 abort —— 用户在浏览器授权流半路反悔时调。 */
  cancelLogin(): void {
    // 设置 abort 标志覆盖 assets prepare、CLI 和凭证 finalize 阶段。
    if (!this.pendingLogin) return;
    this.pendingLogin.cancelled = true;
    if (!this.loginCancellationOpen) return;
    this.loginAborted = true;
    if (this.currentLoginProc) terminateCodexLoginProcess(this.currentLoginProc);
  }

  logout(opts?: { preserveInvalidatedReason?: boolean }): Promise<void> {
    if (this.logoutOperation) {
      // 登录可能在第一次 logout 之后排队、等待同一个 barrier。后来的 logout 仍代表更新的
      // 用户意图，必须把这份 queued login 标成 cancelled，不能只复用旧 Promise 后让它启动。
      this.cancelLogin();
      return this.logoutOperation;
    }
    const run = this.runLogout(opts).finally(() => {
      if (this.logoutOperation === run) this.logoutOperation = null;
    });
    this.logoutOperation = run;
    return run;
  }

  private async runLogout(opts?: { preserveInvalidatedReason?: boolean }): Promise<void> {
    this.ensureInvalidationMarkerLoaded();
    // 登出与在途登录串行：先取消并等它完全收口，防迟到的 auth.json 在登出后复活账号。
    const pendingLogin = this.pendingLogin?.promise;
    if (pendingLogin) {
      this.cancelLogin();
      await pendingLogin.catch(() => undefined);
    }
    await this.disconnectCodexOAuth(opts);
  }

  /**
   * 建立 durable Codex 断开边界并清理 host/cache。
   * 调用方负责先处理 pendingLogin；登录 finalize 自身取消时不能等待自己的 Promise。
   */
  private async disconnectCodexOAuth(
    opts?: { preserveInvalidatedReason?: boolean },
  ): Promise<void> {
    let durableDisconnectCommitted = false;
    if (!opts?.preserveInvalidatedReason) {
      const systemAuthPath = getSystemCodexAuthPath();
      this.oauthInvalidatedReason = null;
      // 先持久化 durable 用户断开 sentinel，再删本地 auth；否则下一次 provider refetch
      // 会立刻从 ~/.codex 重建硬链。即使系统 auth 当前不存在也必须写：用户之后在 CLI
      // 登录仍不应绕过这里的显式断开。写失败时 fail-closed，不假报登出成功。
      const persisted = writeInvalidatedSystemCodexAuthMarker(
        this.codexHome,
        systemAuthPath,
        CODEX_USER_DISCONNECT_REASON,
        path.join(this.codexHome, 'auth.json'),
      );
      if (!persisted) {
        throw new Error('failed to persist Codex disconnect state');
      }
      durableDisconnectCommitted = true;
      this.suppressSystemCodexReconcile = true;
    }
    const authPath = path.join(this.codexHome, 'auth.json');
    try {
      await fsp.rm(authPath, { force: true });
    } catch (err) {
      // 显式 logout 已在 durable marker 处完成线性化：即使 Windows 文件锁让旧文件
      // 暂时删不掉，所有 token 读取也会被 marker 抑制。继续做 host/cache/broadcast
      // 收尾，避免仍在跑的 app-server 或 bridge 内存缓存继续持有旧凭证。
      // invalidate() 的 preserve 路径没有在本方法内证明 marker 已提交，保持原有抛错语义。
      if (!durableDisconnectCommitted) throw err;
      log.warn('remove Codex auth.json after durable disconnect failed; credential remains suppressed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // ⚠️ 不删 sessions/ —— 历史上这里会 `rm -rf sessions/` 清空所有 thread 的 rollout
    // .jsonl(那是 resume 功能还不存在的年代留下的"登出即清本地状态"清理)。后来加了
    // 「从磁盘 rollout 续聊」(CodexAgent thread/resume) 和外部会话导入,xdt-maker 的会话
    // 续聊**依赖** rollout 文件存在。继续在登出/换账号时删 sessions/ 会让所有老会话
    // thread/resume 撞 "no rollout found" 永久坏掉(state DB 里 threads 行还在 → 留下指向
    // 已删文件的孤儿),且用户无法在多个 codex 账号间切换还各自保留会话历史。logout 只负责
    // 撤销登录态(删 auth.json)即可,rollout 是用户数据,保留。
    // 不删 config.toml (MCP 配置由 Boss 5 管)
    // 收割 app-server 子进程 (它内存里仍持有旧 token; 不杀的话切账号会用旧 token 撞 401,
    // 或泄露老账号会话给新账号)。dispose 幂等: host 没起过就 no-op。失败仅 stderr 告警。
    if (this.onLogoutSuccess) {
      try {
        await this.onLogoutSuccess();
      } catch (e) {
        log.warn('onLogoutSuccess threw', { error: (e as Error).message });
      }
    }
    // models_cache.json 没有账号 ID，必须与 auth 边界一起失效。先 dispose host 再删，
    // 降低 Windows 文件锁概率；删失败仍由 disconnect marker + 内存快照清空保证 fail-closed，
    // 下次登录前会再次清理并在锁未释放时拒绝继续。
    await removeDesktopCodexModelsCache(this.codexHome);
    // 用户显式登出:除既有的 disconnect marker 外,再留一道跨 provider 统一的撤销标记。
    unbindNativeProviderAuth('openai', { revoked: true });
  }

  async getAuthEnv(options?: AuthAdapterOptions): Promise<Record<string, string>> {
    this.ensureInvalidationMarkerLoaded();
    await this.ensureGlobalCodexAssets();
    // proxy 路线: codex 始终经 loopback proxy 出口, spawn 鉴权分两路(见 prepareCodexExtraSpawnConfig):
    //   - oauth-bearer (有 OAuth 登录): provider 用 requires_openai_auth, codex 带 auth.json 的 OAuth
    //     token; XDT_CODEX_API_KEY 此时 codex 不读(provider 无 env_key 配置), 注入无害。
    //   - env-key (纯 api key、无 OAuth): provider 用 env_key=XDT_CODEX_API_KEY, codex 带 gateway key。
    // proxy 自身给折扣 / api 流量换的 gateway key 走 readClaudeApiKey(), 不经此 env。
    const env: Record<string, string> = { CODEX_HOME: this.codexHome };
    const apiKey = readClaudeApiKey();
    if (apiKey) env[CODEX_GATEWAY_ENV_KEY] = apiKey;
    if (options?.credentialMode === 'provider-oauth') {
      env[CODEX_GATEWAY_ENV_KEY] = apiKey || CODEX_PROVIDER_OAUTH_PLACEHOLDER_KEY;
      return env;
    }
    // 确保 OAuth 凭证可用(有 OAuth 的用户: proxy 透传 OAuth token 给 ChatGPT 后端需要 auth.json 最新)。
    if (options?.credentialMode === 'gateway-key') {
      return env;
    }
    if (this.oauthInvalidatedReason) {
      await this.clearStaleInvalidationIfSystemCodexChanged();
    }
    if (!this.oauthInvalidatedReason) {
      await this.reconcileWithSystemCodex();
    }
    return env;
  }

  /**
   * codex 是否有可用的 OAuth 登录(auth.json 含 access_token)。proxy 路线 spawn 时用它决定
   * provider 走 requires_openai_auth(带 OAuth token)还是 env_key(gateway key)。
   */
  async hasCodexOAuthLogin(): Promise<boolean> {
    return (await this.getAccessToken()) != null;
  }

  /**
   * 纯读版连接态 —— 不触发 reconcile,因此不建硬链、不写绑定文件、不碰 invalidation marker。
   *
   * 给 `maker:provider:list` 里「sender 不可信」的那条降级路径用:hasCodexOAuthLogin() 会经
   * getAccessToken 走一次 reconcileWithSystemCodex,那里既会把本机 CLI 凭证硬链进 codex-home,
   * 又会为首个 owner 补写 openai 绑定 —— 一个本该只读的查询,不该被子 frame / WebView 或
   * device-link 合成 event 用来触发这种特权变更(PR #548 review)。
   *
   * 判定只会比自愈版**更保守**:durable 登出标记、内存 invalidation、未绑定当前 owner 一律
   * 返回 false;差别仅在于「本来会被这次 reconcile 补上的绑定」这里看不到,于是显示未连接。
   */
  hasCodexOAuthLoginReadOnly(): boolean {
    if (this.oauthInvalidatedReason) return false;
    if (!isNativeProviderAuthBound('openai')) return false;
    const authPath = path.join(this.codexHome, 'auth.json');
    if (shouldSuppressLocalCodexAuth(this.codexHome, authPath)) return false;
    return this.hasCodexOAuthLoginUnbound();
  }

  /** Legacy upgrade probe; only used while claiming the first verified owner. */
  hasCodexOAuthLoginUnbound(): boolean {
    try {
      const raw = fs.readFileSync(path.join(this.codexHome, 'auth.json'), 'utf-8');
      const parsed = JSON.parse(raw) as { tokens?: { access_token?: unknown } };
      return typeof parsed.tokens?.access_token === 'string' && parsed.tokens.access_token.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Return the Codex OAuth access token for host-owned integrations.
   *
   * This is intentionally main-process only. Renderer code never receives the
   * token, and callers should only use it for short-lived OpenAI requests that
   * are covered by the active Codex login.
   */
  async getAccessToken(): Promise<string | null> {
    this.ensureInvalidationMarkerLoaded();
    if (this.oauthInvalidatedReason) {
      await this.clearStaleInvalidationIfSystemCodexChanged();
    }
    if (this.oauthInvalidatedReason) return null;
    // 绑定校验放在 reconcile 之后:reconcile 收口会为首个 owner 补绑定
    // (claimDetectedCodexOAuthBinding),同一次调用内即可生效;校验仍在 token
    // 读取之前,未绑定(换账号等)保持 fail-closed 返回 null。
    await this.reconcileWithSystemCodex();
    if (!isNativeProviderAuthBound('openai')) return null;
    const authPath = path.join(this.codexHome, 'auth.json');
    if (shouldSuppressLocalCodexAuth(this.codexHome, authPath)) return null;
    try {
      const raw = await fsp.readFile(authPath, 'utf-8');
      const obj = JSON.parse(raw) as { tokens?: { access_token?: unknown } };
      return typeof obj.tokens?.access_token === 'string' && obj.tokens.access_token.length > 0
        ? obj.tokens.access_token
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Return the ChatGPT workspace id from the active Codex auth, if any.
   *
   * Needed by host-owned integrations that talk to the Codex backend Responses
   * API (`chatgpt.com/backend-api/codex/responses`): that endpoint expects a
   * `ChatGPT-Account-Id` header alongside the bearer token so the request is
   * routed against the correct ChatGPT workspace. Returns null when neither
   * tokens.account_id nor a chatgpt_account_id claim is present; JWT sub is a
   * user id, not a workspace id, and must not bind reset-credit operations.
   */
  async getAccountId(): Promise<string | null> {
    this.ensureInvalidationMarkerLoaded();
    if (this.oauthInvalidatedReason) {
      await this.clearStaleInvalidationIfSystemCodexChanged();
    }
    if (this.oauthInvalidatedReason) return null;
    // 同 getAccessToken:绑定校验在 reconcile(含首个 owner 补绑定)之后、读取之前。
    await this.reconcileWithSystemCodex();
    if (!isNativeProviderAuthBound('openai')) return null;
    const authPath = path.join(this.codexHome, 'auth.json');
    if (shouldSuppressLocalCodexAuth(this.codexHome, authPath)) return null;
    return readCodexAccountId(authPath);
  }

  /**
   * 凭证被服务端作废 (refresh_token reuse / 401 reauth_required) 时被 codex agent 调用。
   * 等价于 logout() + 主动 push auth state 让 renderer 立刻显示 "请重新登录",
   * 否则错误只会反复埋进后台日志, 用户全程无感。
   */
  async invalidate(reason: string): Promise<void> {
    this.ensureInvalidationMarkerLoaded();
    log.warn('codex auth invalidated', { reason });
    // 服务端已经明确判定 OAuth 凭证失效时, 不能再从 ~/.codex 自动 reconcile 回来。
    // 否则 app-server 会拿同一份坏 token 继续 spawn/retry, 用户也看不到明确的重登录入口。
    this.oauthInvalidatedReason = reason;
    this.suppressSystemCodexReconcile = true;
    writeInvalidatedSystemCodexAuthMarker(
      this.codexHome,
      getSystemCodexAuthPath(),
      reason,
      path.join(this.codexHome, 'auth.json'),
    );
    await this.logout({ preserveInvalidatedReason: true });
    if (this.onInvalidatedBroadcast) {
      try {
        await this.onInvalidatedBroadcast(reason);
      } catch (e) {
        log.warn('onInvalidatedBroadcast threw', { error: (e as Error).message });
      }
    }
  }
}

// 单例 (与现有 host 消费者保持一致)
export const desktopClaudeAuthAdapter = new DesktopClaudeAuthAdapter();
export const desktopCodexAuthAdapter = new DesktopCodexAuthAdapter();
