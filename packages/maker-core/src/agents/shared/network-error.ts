/**
 * 网络类错误识别 — 判断 agent/daemon 报错 message 是否是"网络不可达 / 上游
 * 暂时不可用"这类与用户操作无关、重试可能自愈的错误。
 *
 * 消费方:
 *  - codex translator(translateErrorNotification):willRetry=true 的网络类错误
 *    在同 turn 内持续出现时透出一条非终止提示,让用户知道 daemon 卡在自动重试
 *    (否则 turn 只是无限转圈,用户无感知也无从干预)。
 *  - renderer ErrorBanner 有一份**语义一致**的同名判定
 *    (apps/desktop/src/renderer/utils/networkError.ts,不跨 bundle 共享代码,
 *    与 401 pattern 的两端一致性同款惯例),用于把原始英文报错换成友好文案。
 *    修改 pattern 时两处同步。
 *
 * pattern 说明:Codex stream retry 状态 `Reconnecting... N/M`、HTTP 网关侧
 * 502/503/504(数字带词边界,避免误伤长数字)、
 * 网关标准短语、Node 网络 errno(ECONNREFUSED 等)、undici/fetch 失败短语、
 * AggregateError(Node 并发连接尝试全失败的聚合错误,几乎只出现在网络场景)、
 * Anthropic SDK 的 APIConnectionTimeoutError / APIConnectionError 原文
 * ("Request timed out" / "API Error: The operation timed out" / "Connection error",
 * SDK 重试耗尽后透传成终止型 turn error)。Pi / OpenAI Responses 还会写出不带
 * `API Error:` 前缀的 `The operation timed out.`，以及
 * `OpenAI Responses stream ended before a terminal response event`。
 */
/** 仅在 Pi `auto_retry_end` 失败后使用：把「点一下重试」留给用户，Host 不再续跑。首次 aborted 不得打这个 reason。 */
export const PI_GATEWAY_DROP_REASON = 'pi-gateway-drop';

export interface ReconnectAttempt {
  attempt: number;
  maxAttempts: number;
}

/**
 * Codex 会把 streaming response 的有限重连进度放进 error notification.message:
 * `Reconnecting... 2/5`（部分入口会在后面追加括号内的底层 stream error）。
 * 返回结构化次数供 translator 持续更新非终止状态；普通业务文案不匹配。
 */
export function parseReconnectAttemptMessage(message: string): ReconnectAttempt | null {
  const match = /\bReconnecting(?:\.{3}|…)\s*(\d+)\s*\/\s*(\d+)\b/i.exec(message);
  if (!match) return null;
  const attempt = Number(match[1]);
  const maxAttempts = Number(match[2]);
  if (
    !Number.isSafeInteger(attempt) ||
    !Number.isSafeInteger(maxAttempts) ||
    attempt < 1 ||
    maxAttempts < attempt
  ) {
    return null;
  }
  return { attempt, maxAttempts };
}

export function isNetworkishErrorMessage(message: string): boolean {
  return (
    parseReconnectAttemptMessage(message) !== null ||
    /\b50[234]\b|Bad Gateway|Service Unavailable|Gateway Time-?out|upstream unreachable|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EPIPE|EAI_AGAIN|fetch failed|network error|socket hang up|AggregateError|Request timed out|^API Error:\s*The operation timed out|^The operation timed out|stream ended before a terminal|Connection error/i.test(
      message,
    )
  );
}
