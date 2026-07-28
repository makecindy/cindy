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
 */
export function buildBackendUnreachableMessage(opts: {
  isRemote: boolean;
  remoteHostId?: string;
  retryCount: number;
  elapsedMs: number;
  lastError: string;
}): string {
  const last = opts.lastError.trim().replace(/\s+/g, ' ').slice(0, 300) || '(no error detail)';
  const elapsedS = Math.round(opts.elapsedMs / 1000);
  const head =
    `Codex backend unreachable — the daemon retried ${opts.retryCount} times over ${elapsedS}s ` +
    `without success (last error: "${last}").`;
  if (!opts.isRemote) {
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
