/**
 * errorChain.ts — 网络/IO 错误链展开(main 侧通用)。
 *
 * undici 把一切网络层失败包成裸 `TypeError: fetch failed`,可行动的细节
 * (connect ETIMEDOUT / ECONNREFUSED / 证书错误,以及 happy-eyeballs 下每个
 * 地址族各自的失败)全藏在 `cause` 链与 `AggregateError.errors` 里。只记
 * `err.message` 的日志永远只剩 'fetch failed',区分不了"端点挂了"和"本机
 * 网络路径断了",线上反馈拿回来也没法判因。
 */

const MAX_CAUSE_DEPTH = 4;

/** 把 Error 的 cause 链(含 AggregateError 分支)拍平成单行可读诊断串。 */
export function describeErrorChain(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    let part = current.message || (code ? String(code) : current.name);
    if (code && current.message && !current.message.includes(String(code))) part += ` (${code})`;
    if (current instanceof AggregateError && current.errors.length > 0) {
      part += ` [${current.errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ')}]`;
    }
    parts.push(part);
    current = current.cause;
  }
  return parts.filter(Boolean).join(' <- ');
}
