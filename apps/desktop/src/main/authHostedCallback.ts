/**
 * 托管回调登录链路的纯逻辑(轮询节奏、结果映射、轮询循环)。
 *
 * 背景:RFC 8252 loopback 登录会把 `http://127.0.0.1:<port>` 连同授权码一起摆到
 * 系统浏览器的地址栏里,点「回到 Cindy」时系统弹框显示的来源也是这个 IP。托管
 * 回调把 redirect_uri 换成 auth-server 自有域名下的固定地址:服务端接住 provider
 * 回调、按 clientState 短期暂存授权码,客户端**主动轮询取回**,浏览器全程停在
 * 自有域名上,授权码不再进入地址栏与浏览历史。
 *
 * 为什么是「客户端轮询」而不是「回调页 fetch 投递回本地端口」:WebKit 至今不把
 * loopback 视为 potentially trustworthy origin(WebKit #171934),https 页面 fetch
 * `http://127.0.0.1` 会被当作 mixed content 拦掉。Safari 是 macOS 默认浏览器,投递
 * 方案对这批用户必然退化回显示 IP;把方向翻转成本地主动拉取即可绕开该限制,顺带
 * 免掉 CORS 与本地端口占用。
 *
 * 本文件只放纯逻辑以便单测,Electron / 网络依赖留在 authManager(与
 * `authLoopbackCallback.ts` 已确立的分层一致)。
 */
import crypto from 'node:crypto';

import type { DesktopAuthorizationPoll } from '@cindy/auth-client';

import type { AuthLoopbackResult } from './authLoopbackCallback';

/**
 * 本次尝试的两个值:走浏览器的 `client_state` 与只留在进程内的取回凭据 `pollSecret`。
 *
 * 为什么要拆成两个:`client_state` 会作为 authorize 的 query 参数进入系统浏览器的
 * 地址栏与导航历史。若直接拿它当轮询取回凭据,任何能读到浏览历史的扩展或同机进程
 * 都可以抢先调用那个未鉴权的 poll 接口、把一次性结果消费掉——授权码本身有 PKCE
 * 兜底换不到 token,但真正的客户端会拿到 `expired`,登录被打断。
 *
 * 关系固定为 `client_state = base64url(sha256(pollSecret))`,服务端按同一算法从
 * pollSecret 还原寄存 key,因此浏览器侧只看得到哈希、看不到原像。
 */
export interface DesktopPollCredentials {
  /** 交给 authorize、会经过浏览器的值。 */
  clientState: string;
  /** 只在 main 进程内存里流转的取回凭据。 */
  pollSecret: string;
}

/** 由 pollSecret 推导 client_state（与服务端实现必须逐字节一致）。 */
export function deriveClientStateFromPollSecret(pollSecret: string): string {
  return crypto.createHash('sha256').update(pollSecret, 'utf8').digest('base64url');
}

/** 为一次托管回调登录尝试生成凭据对。 */
export function createDesktopPollCredentials(): DesktopPollCredentials {
  const pollSecret = crypto.randomBytes(32).toString('base64url');
  return { pollSecret, clientState: deriveClientStateFromPollSecret(pollSecret) };
}

/** 授权尚未完成时的轮询间隔(用户正在浏览器里操作,这段最需要低延迟)。 */
export const HOSTED_CALLBACK_POLL_FAST_INTERVAL_MS = 1_000;
/** 退避后的轮询间隔。 */
export const HOSTED_CALLBACK_POLL_SLOW_INTERVAL_MS = 2_000;
/** 超过这个时长仍未完成,说明用户多半还在慢慢操作,降频省请求。 */
export const HOSTED_CALLBACK_POLL_BACKOFF_AFTER_MS = 30_000;
/**
 * 轮询连续失败到这个次数就放弃,不必干等到总超时。
 *
 * 取 8(≈8 秒)是两头权衡:轮询期间用户多半还在浏览器里输密码,这时的网络抖动
 * (切 WiFi、休眠唤醒)与登录成败无关,过早放弃纯属误杀;但服务端真挂了也不该让
 * 用户干等满 5 分钟才看到反馈——尤其超时会收敛成"不展示错误"的 USER_CANCELLED。
 * 中途成功一次即清零,断续网络不会靠累计次数被误判。
 */
export const DEFAULT_MAX_CONSECUTIVE_POLL_FAILURES = 8;

/**
 * 轮询失败但错误对象没带可用 code 时的兜底。选它而不是造新码:
 * `login.errors.AUTH_REQUEST_FAILED` 已有五语文案(「登录请求失败,请重试」)。
 */
const FALLBACK_POLL_ERROR_CODE = 'AUTH_REQUEST_FAILED';

/** 按已耗时决定下一次轮询前的等待。 */
export function hostedCallbackPollDelayMs(elapsedMs: number): number {
  return elapsedMs >= HOSTED_CALLBACK_POLL_BACKOFF_AFTER_MS
    ? HOSTED_CALLBACK_POLL_SLOW_INTERVAL_MS
    : HOSTED_CALLBACK_POLL_FAST_INTERVAL_MS;
}

/**
 * poll 响应 → 登录尝试结果;`null` = 尚未有结论,继续轮询。
 *
 * `expired` 复用 `INVALID_AUTH_CODE`(「授权已过期,请重新登录」)而不是新造错误码:
 * 语义一致且现网五语文案齐全。provider 侧错误原样透传,与 loopback 路径口径相同。
 */
export function mapDesktopAuthorizationPoll(
  poll: DesktopAuthorizationPoll,
): AuthLoopbackResult | null {
  switch (poll.status) {
    case 'pending':
      return null;
    case 'ok':
      return { code: poll.code };
    case 'error':
      return { error: poll.error };
    case 'expired':
      return { error: 'INVALID_AUTH_CODE' };
  }
}

/**
 * 从轮询异常里取一个对用户有意义的错误码。auth-client 抛的 AuthApiError 自带
 * `NETWORK_ERROR` / `REQUEST_TIMEOUT` / 服务端错误码,这些在 `login.errors.*` 里
 * 都已有文案,直接沿用即可,不必在这层重新分类。用鸭子类型而非 instanceof:
 * 跨包实例判定不可靠,而这里只需要那个字符串。
 */
export function pollErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code : FALLBACK_POLL_ERROR_CODE;
}

export interface HostedCallbackPollingDeps {
  /** 单次轮询。失败请抛错(AuthApiError 最佳),不要吞成 pending。 */
  poll: () => Promise<DesktopAuthorizationPoll>;
  /** 可取消的等待;signal abort 后应尽快 resolve(无需 reject)。 */
  sleep: (ms: number) => Promise<void>;
  /** 注入时钟便于测试;生产传 Date.now。 */
  now: () => number;
  /** 用户取消 / 上层中止。 */
  signal: AbortSignal;
  /** 整体时长上限,与 loopback 路径共用同一个预算。 */
  timeoutMs: number;
  /** 连续失败容忍次数,默认 DEFAULT_MAX_CONSECUTIVE_POLL_FAILURES。 */
  maxConsecutiveFailures?: number;
}

/**
 * 轮询直到拿到结论、被取消或超时。
 *
 * 取消与超时都收敛成 `USER_CANCELLED`:这与 loopback 路径的超时处理一致
 * (authManager 的 BROWSER_AUTH_TIMEOUT_MS 分支),且该码在 renderer 被特意映射成
 * "不展示错误"——用户把浏览器晾在一边不算失败。
 */
export async function runHostedCallbackPolling(
  deps: HostedCallbackPollingDeps,
): Promise<AuthLoopbackResult> {
  const maxFailures =
    deps.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_POLL_FAILURES;
  const startedAt = deps.now();
  let consecutiveFailures = 0;

  for (;;) {
    if (deps.signal.aborted) return { error: 'USER_CANCELLED' };
    if (deps.now() - startedAt >= deps.timeoutMs) {
      return { error: 'USER_CANCELLED' };
    }

    try {
      const outcome = await deps.poll();
      consecutiveFailures = 0;
      const settled = mapDesktopAuthorizationPoll(outcome);
      if (settled) return settled;
    } catch (error) {
      // 取消会让在途请求以 AbortError 收场,那不是"轮询失败",不计入失败预算。
      if (deps.signal.aborted) return { error: 'USER_CANCELLED' };
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxFailures) {
        return { error: pollErrorCode(error) };
      }
    }

    await deps.sleep(hostedCallbackPollDelayMs(deps.now() - startedAt));
  }
}
