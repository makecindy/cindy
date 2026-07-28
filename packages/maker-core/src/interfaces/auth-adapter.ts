/**
 * AuthAdapter — 鉴权抽象（host 注入到 Maker）。
 *
 * 字段语义对齐现有 apps/desktop/src/main/vendor/types.ts:75-89 (v1.0 frozen)，
 * 唯一差异：getProcessEnv() → getAuthEnv()，明确"只管鉴权 env"，
 * 接入端点 + 业务 flag 拆到 AgentRuntimeConfig。详见 §6.5 拆分依据。
 */

import type { AuthState } from '../types/common.js';

export type AgentCredentialMode = 'gateway-key' | 'oauth-bearer' | 'provider-oauth';
export type AgentLoginMode = 'browser' | 'device-code';

export interface AuthLoginOptions {
  mode?: AgentLoginMode;
  onProgress?: (msg: string) => void;
}

export interface AuthAdapterOptions {
  /**
   * 本次 agent 子进程期望使用的凭证形态。
   *
   * undefined 表示调用方没有显式来源,adapter 维持既有 fallback 策略。
   * provider-oauth 是历史命名:表示目标供应商凭证(API key 或 OAuth)
   * 由 host/proxy 注入,子进程自身凭证只作占位。
   */
  credentialMode?: AgentCredentialMode;
}

export interface AuthAdapter {
  /** 检查当前鉴权状态，不触发登录 */
  getState(options?: AuthAdapterOptions): Promise<AuthState>;

  /** 触发登录流程（OAuth 跳浏览器 / API key 弹窗 / 报错） */
  triggerLogin(opts?: AuthLoginOptions): Promise<AuthState>;

  /** 退出登录，清理本地凭证 */
  logout(): Promise<void>;

  /**
   * 只返回鉴权相关的 env，例如 ANTHROPIC_API_KEY / CODEX_HOME。
   * 禁止塞接入端点（ANTHROPIC_BASE_URL）或业务 flag —— 那些归 AgentRuntimeConfig。
   */
  getAuthEnv(options?: AuthAdapterOptions): Promise<Record<string, string>>;

  /**
   * 为 host 侧直连 LLM 调用（如 oneShot 起标题 / skillReview）提供凭证 + endpoint（可选）。
   *
   * 与 getAuthEnv() 正交:getAuthEnv() 是给 **spawn 出的 agent 子进程** 用的 env;
   * 本方法是给 **maker-core 进程内** 的轻量直连请求用的。两者在某些鉴权模式下凭证不同 ——
   * 典型:Claude 'oauth' 模式下 getAuthEnv() 注入用户订阅 token(子进程按 model 分流),
   * 但 oneShot 是无 system-prompt 的轻任务,不能走订阅(会被 claude.ai OAuth 策略拒),
   * 应固定走 gateway key + gateway endpoint。实现侧返回 `{ apiKey, baseURL }`。
   *
   * 返回 null = 没有可用的直连凭证(调用方应跳过 / 优雅降级)。
   * 不实现 = 调用方回退到 getAuthEnv().ANTHROPIC_API_KEY + runtimeConfig.endpoint(旧行为)。
   */
  getOneShotAuth?(): Promise<{ apiKey: string; baseURL?: string } | null>;

  /**
   * 订阅 OAuth access token 的强制刷新(可选;仅 Claude 订阅模式的 host 实现)。
   *
   * 背景: cc >= 2.1.198 下 CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST 令子进程不再自读
   * 系统凭证库,订阅 token 由 host 经 getAuthEnv() 注入(CLAUDE_CODE_OAUTH_TOKEN);
   * 注入的是纯 access token,cc 无法自行续期。turn 中途 token 失效(401)时 cc 经
   * SDK oauth_token_refresh control 请求向宿主要新 token —— agent runtime 把该回调
   * 接到本方法。实现侧应按需刷新并返回当前有效的 access token;刷新失败返回 null
   * (调用方把 null 透传给 SDK,cc 按无 token 报 auth 错)。
   *
   * @param staleToken 该会话实际撞 401 的那枚 token(spawn 注入 / 上次回调返回)。
   *   实现侧凭它区分「凭证库早已换代(直接返回库值,不消耗刷新轮换)」与「库值就是
   *   失效的那枚(才真正刷新)」—— 防多个长会话对同一枚旧 token 群体 401 时连环旋转。
   */
  getFreshSubscriptionToken?(staleToken?: string): Promise<string | null>;

  /**
   * 取消正在进行的登录流程（可选）。
   *
   * 仅 OAuth 子进程式登录(如 Codex)需要 —— 用户在浏览器授权流半路反悔, UI 调
   * 此方法 SIGTERM kill 子进程让 triggerLogin 提前 resolve 成 errorReason='login_cancelled'。
   * Claude API key 是同步弹窗式的, 不需要 cancel, 默认不实现即可。
   *
   * 同步方法 — 不要 return Promise, host 端 IPC handler 直接调即可。
   */
  cancelLogin?(): void;

  /**
   * agent runtime 检测到当前凭证已被服务端作废 (e.g. OAuth refresh token 已被旋转,
   * 401 reauth_required 等) 时调用一次。实现侧应等价于 logout() + 通知 UI 重登,
   * 让用户立刻能感知到状态变化, 而不是任由 agent 持续撞失败。
   *
   * 可选 — 没实现时 runtime 至少会自己 dispose 当前 agent host 防御性收尾,
   * 但 UI 端不会自动跳出 "请重新登录" 的提示。
   */
  invalidate?(reason: string): Promise<void>;
}
