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

/**
 * 单个 Error → 可读片段:message 为空时回退 errno / name,message 不含 errno
 * 时补注。空 message + 带 code 的形态在 undici 里真实存在,直接取 message 会
 * 在诊断串里留下空段。
 */
function describeSingle(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as NodeJS.ErrnoException).code;
  let part = err.message || (code ? String(code) : err.name);
  if (code && err.message && !err.message.includes(String(code))) part += ` (${code})`;
  return part;
}

/** 把 Error 的 cause 链(含 AggregateError 分支)拍平成单行可读诊断串。 */
export function describeErrorChain(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    let part = describeSingle(current);
    if (current instanceof AggregateError && current.errors.length > 0) {
      // 聚合分支同样走 describeSingle:happy-eyeballs 的地址族错误正是最需要
      // errno 的地方,只取 message 会丢码、空 message 还会留下空段。
      part += ` [${current.errors.map(describeSingle).filter(Boolean).join('; ')}]`;
    }
    parts.push(part);
    current = current.cause;
  }
  return parts.filter(Boolean).join(' <- ');
}
