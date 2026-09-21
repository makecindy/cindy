/**
 * 网络类错误识别(renderer 侧)— 判断错误 message 是否是"网络不可达 / 上游暂时
 * 不可用"这类与用户操作无关、重试可能自愈的错误。ErrorBanner 用它把原始英文
 * 报错(如 "unexpected status 502 Bad Gateway: upstream unreachable: AggregateError,
 * url: http://127.0.0.1:PORT/responses")换成友好文案,原始错误折叠可查。
 *
 * pattern 与 maker-core 的判定**语义一致**
 * (packages/maker-core/src/agents/shared/network-error.ts,那份决定 codex
 * retry-loop 何时透出提示;不跨 bundle 共享代码,与 401 pattern 的两端一致性
 * 同款惯例)。修改时两处同步。
 *
 * `Reconnecting... N/M` 是 Codex streaming response 的有限重连状态；解析后的
 * attempt/maxAttempts 会显示在 recoverable banner。`Request timed out` /
 * `API Error: The operation timed out` / `Connection error` 是 Anthropic SDK 的
 * APIConnectionTimeoutError / APIConnectionError 原文(SDK 重试耗尽后透传成
 * 终止型 turn error),同属重试可自愈的网络类(2026-07-13 超时横幅裸英文实锤)。
 * Cindy Responses bridge / compat-proxy 中途断流写成 `upstream stream error: …`
 * （undici 的 `terminated`、socket reset 等），Claude Code 再包 `API Error:`；
 * 只认这句短语，不裸匹配 `terminated`，避免误伤 `app_session_terminated`。
 */
export interface ReconnectAttempt {
  attempt: number;
  maxAttempts: number;
}

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
    /\b50[234]\b|Bad Gateway|Service Unavailable|Gateway Time-?out|upstream unreachable|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EPIPE|EAI_AGAIN|fetch failed|network error|socket hang up|AggregateError|Request timed out|^API Error:\s*The operation timed out|^The operation timed out|stream ended before a terminal|Connection error|upstream stream error/i.test(
      message,
    )
  );
}
