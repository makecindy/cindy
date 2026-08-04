/**
 * retry-escalation — codex daemon 后端重试循环的终局升级。
 *
 * 背景 (issue #677): 远端机器摸不到 Codex 后端 (chatgpt.com 直连超时 / 403 /
 * websocket unreachable) 时, daemon 会以 ~1s 间隔无限发 willRetry=true 的
 * error notification — 协议注释明确 willRetry=true 时 server 会自动重试,
 * 客户端不应中断 turn。但 daemon 对**持续性**不可达没有退避上限, turn 在
 * UI 上永远转圈 (renderer 只有终态 error / Done 才复位 generating)。
 *
 * 这里的策略: 同 turn 的 willRetry 错误达到阈值 (次数或持续时长) 就合成一
 * 条**终态**错误收口, 消息里带原始末次错误 + 可操作的排查方向 (代理/VPN/
 * 403/超时 + SSH 代理隧道入口)。auth 缺失 (401) 不在此列 — 它有自己
 * 「同步登录态」的等待式 UX, 由调用方排除。
 *
 * claude-code 侧有等价的 upstream_response_idle_timeout watchdog
 * (claude-code/index.ts), codex 此前没有任何对应物。
 */

/** 同 turn 重试次数达到该值即升级 (daemon 重试约 1 次/秒, ≈30s)。 */
export const RETRY_ESCALATION_MAX_COUNT = 30;
/** 同 turn 首次 willRetry 至今超过该时长即升级 — 兜底重试频率异常的情形。 */
export const RETRY_ESCALATION_MAX_ELAPSED_MS = 120_000;

export interface RetryEscalationDecision {
  escalate: boolean;
  retryCount: number;
  elapsedMs: number;
}

/**
 * 本机出站路径事实(host 注入,来源是 desktop 的 outbound-proxy-resolver 快照)。
 *
 * 存在的理由:「后端不可达」时最有用的一句话是「你现在到底走没走代理」,而这件事
 * Cindy 自己知道、用户看不到 —— 日志在磁盘上,错误消息里只有一串通用猜测。
 *
 * `kind='unknown'` 是刻意与 `direct` 分开的:那表示代理判定没问出来、按直连兜底,
 * 不是确认了无代理。把猜测当事实报给用户会把排查带向反方向。
 *
 * 类型在此本地定义(不 import desktop 侧类型):maker-core 零 Electron 依赖。
 */
export interface OutboundPathFact {
  source: 'env' | 'system';
  /**
   * 四态的实际行为只有「走代理」与「直连」两种,但**原因**完全不同,而原因才是
   * 诊断要说的话:direct = 确认没配;unsupported = 配了但形态用不了(TLS-to-proxy
   * / SOCKS4);unknown = 判定没问出来、按直连兜底。
   */
  kind: 'proxy' | 'direct' | 'unsupported' | 'unknown';
  /** 已脱敏的代理地址(scheme://host:port);kind='proxy' 时有值。 */
  proxy?: string;
  /** kind='unknown' 时的原因标识(resolve_timeout / resolve_failed / …)。 */
  reason?: string;
  upstream: string;
  /**
   * 判定时间戳。不进用户消息(对排查没有直接价值),但会进升级日志 —— 系统代理
   * 判定带 TTL 缓存,读日志的人需要知道这条事实是刚测的还是缓存里的。
   */
  at?: number;
}

/**
 * 把出站路径事实渲染成一行可操作的诊断。恒返回非空串 —— 三种 kind 各有话可说。
 * 导出仅供单测。
 *
 * `direct` 必须按 source 分叉,两者是**语义相反**的结论:
 *  - source='env':有代理 env 才会走 env 分支,所以这里的 direct 意味着**配了代理
 *    却对这个上游不生效**(NO_PROXY 豁免了它,或没有覆盖该 scheme 的变量)。说成
 *    「没设代理」会盖掉真正的原因,把用户推向反方向。
 *  - source='system':只能断言「没有代理 env」(走到这一层的前提),**不能**断言
 *    系统侧没有代理配置 —— `session.resolveProxy` 是逐 URL 解析,系统完全可以配了
 *    代理、只是 PAC / bypass 规则豁免了这个上游,那时它对该 URL 就返回 DIRECT。
 *    所以这一支只陈述「系统解析器为这个上游给了直连」,并提示 bypass 的可能。
 */
export function describeOutboundPath(fact: OutboundPathFact): string {
  if (fact.kind === 'proxy') {
    const from = fact.source === 'env' ? 'proxy env vars' : 'system proxy settings';
    return (
      `Cindy's outbound path for ${fact.upstream}: via ${fact.proxy ?? '(unknown address)'} ` +
      `(from ${from}). If that proxy is down or cannot reach the upstream, this is where it fails.`
    );
  }
  if (fact.kind === 'unsupported') {
    // 配了代理,但形态转发层用不了(TLS-to-proxy 的 https / SOCKS4),所以实际直连。
    // 报成「没有代理」会让用户以为配置正常,真正的动作是把出口换成 HTTP 或 SOCKS5。
    // 两种来源的修改位置不同 —— env 改变量值,system 改系统/PAC 里的那一条。
    if (fact.source === 'env') {
      return (
        `Cindy's outbound path for ${fact.upstream}: direct connection — a proxy env var is set, ` +
        `but its value is not a form Cindy can use (an https:// TLS-to-proxy or socks4:// URL), ` +
        `so it was rejected and the request went out directly. Use an http:// or socks5:// proxy URL.`
      );
    }
    return (
      `Cindy's outbound path for ${fact.upstream}: direct connection — the system proxy ` +
      `settings do list a proxy for this upstream, but in a form Cindy cannot use (an HTTPS/` +
      `TLS-to-proxy entry, or SOCKS4), so the request went out directly. Switch that entry to ` +
      `an HTTP or SOCKS5 proxy to route Cindy through it.`
    );
  }
  if (fact.kind === 'direct') {
    if (fact.source === 'env') {
      return (
        `Cindy's outbound path for ${fact.upstream}: direct connection — proxy env vars are set, ` +
        `but none of them applies to this upstream (NO_PROXY exempts it, or no variable covers ` +
        `its scheme), so the configured proxy is being bypassed. On a network that needs a proxy ` +
        `to reach the upstream, that bypass alone explains the failure.`
      );
    }
    return (
      `Cindy's outbound path for ${fact.upstream}: direct connection — no proxy env var is set, ` +
      `and the system proxy resolver returned a direct route for this upstream (a system proxy ` +
      `may still be configured but bypassing this host). On a network that needs a proxy or VPN ` +
      `to reach the upstream, this explains the failure.`
    );
  }
  return (
    `Cindy could not determine the outbound path for ${fact.upstream} ` +
    `(${fact.reason ?? 'unknown reason'}) and fell back to a direct connection. ` +
    `That fallback is a guess, not a confirmed "no proxy" — on a network that needs a proxy it fails.`
  );
}

export class TurnRetryTracker {
  private turnId: string | null = null;
  private count = 0;
  private firstAt = 0;

  /** 新 turn / turn 终结时复位。 */
  reset(): void {
    this.turnId = null;
    this.count = 0;
    this.firstAt = 0;
  }

  /** 记录一次 willRetry=true 错误; turnId 变化视为新序列重新计数。 */
  track(turnId: string, now: number): RetryEscalationDecision {
    if (this.turnId !== turnId) {
      this.turnId = turnId;
      this.count = 0;
      this.firstAt = now;
    }
    this.count += 1;
    const elapsedMs = now - this.firstAt;
    return {
      escalate:
        this.count >= RETRY_ESCALATION_MAX_COUNT ||
        elapsedMs >= RETRY_ESCALATION_MAX_ELAPSED_MS,
      retryCount: this.count,
      elapsedMs,
    };
  }
}

/**
 * 升级时合成给用户的终态错误消息。保留末次原始错误 (截断) 作为诊断锚点;
 * 按 local/remote 给出不同的排查指向 (remote 才有 SSH 代理隧道入口)。
 *
 * `outboundPath` 只在**本地**场景附加: 远端 daemon 在远端机器上自己出网, 本机的
 * 出站代理判定与它无关 —— 把本机快照报给远端故障会指错方向 (agentProxy 未开时
 * 远端根本不经本机)。远端仍走原有的 SSH 代理隧道引导。
 */
export function buildBackendUnreachableMessage(opts: {
  isRemote: boolean;
  remoteHostId?: string;
  retryCount: number;
  elapsedMs: number;
  lastError: string;
  outboundPath?: OutboundPathFact | null;
}): string {
  const last = opts.lastError.trim().replace(/\s+/g, ' ').slice(0, 300) || '(no error detail)';
  const elapsedS = Math.round(opts.elapsedMs / 1000);
  const head =
    `Codex backend unreachable — the daemon retried ${opts.retryCount} times over ${elapsedS}s ` +
    `without success (last error: "${last}").`;
  if (!opts.isRemote) {
    // 有实测出站事实就用它替掉通用猜测清单 —— 后者把四种原因并列, 等于没有指向。
    if (opts.outboundPath) {
      return (
        `${head}\nThe Codex backend (chatgpt.com) is not responding.\n` +
        `${describeOutboundPath(opts.outboundPath)}`
      );
    }
    return (
      `${head}\nThe Codex backend (chatgpt.com) is not responding. Likely causes: network outage, ` +
      `proxy/VPN required, request blocked (403), or timeout. Check your connection and retry.`
    );
  }
  const host = opts.remoteHostId ? ` "${opts.remoteHostId}"` : '';
  return (
    `${head}\nThe remote host${host} cannot reach the Codex backend (chatgpt.com) directly. ` +
    `Likely causes: proxy/VPN required on the remote, outbound blocked (403), timeout, or websocket unreachable.\n` +
    `Hint: in Settings → SSH remote hosts, edit this host and enable "Route agent traffic via local proxy" ` +
    `to tunnel agent traffic back to a proxy on this machine, or fix the remote network, then retry.`
  );
}
