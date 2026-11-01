/**
 * 插件代理 fetch 的网络层失败分类(networkSlot 的 catch 出口专用)。
 *
 * undici 把所有连接层失败包成 `TypeError('fetch failed')`,真正可执行的原因
 * (证书过期、DNS 失败、连接被重置……)只在 `cause.code` 里,常见形态还会再套
 * 一层 AggregateError(并发尝试多个地址全部失败)。这里沿 cause 链取第一个能
 * 识别的错误码,给插件一个稳定的 errorCode,并把原始码带进 message 方便排查。
 *
 * 识别不出的异常(主机守门抛错等)返回 null:调用方保持原 message、不打码,
 * 避免把非网络问题误标成网络错误。
 */

export type GhostFetchNetworkErrorCode =
  | 'NETWORK_TIMEOUT'
  | 'TLS_ERROR'
  | 'DNS_FAILED'
  | 'CONNECTION_REFUSED'
  | 'CONNECTION_RESET'
  | 'NETWORK_UNREACHABLE'
  | 'NETWORK_ERROR';

export interface GhostFetchNetworkFailure {
  errorCode: GhostFetchNetworkErrorCode;
  /** 底层原始错误码(如 CERT_HAS_EXPIRED);只拿到 fetch failed 时缺省。 */
  causeCode?: string;
  /** 交给插件的原因说明,不含「请求失败:」前缀。 */
  reason: string;
}

const LABELS: Record<GhostFetchNetworkErrorCode, string> = {
  // 保持「请求超时」字样:存量插件按这几个字识别超时。
  NETWORK_TIMEOUT: '请求超时',
  TLS_ERROR: 'HTTPS 证书或加密连接校验失败',
  DNS_FAILED: '域名解析失败',
  CONNECTION_REFUSED: '连接被拒绝',
  CONNECTION_RESET: '连接被中断',
  NETWORK_UNREACHABLE: '网络不可达',
  NETWORK_ERROR: '网络错误',
};

const CODE_GROUPS: ReadonlyArray<[GhostFetchNetworkErrorCode, ReadonlySet<string>]> = [
  ['NETWORK_TIMEOUT', new Set([
    'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  ])],
  ['DNS_FAILED', new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME'])],
  ['CONNECTION_REFUSED', new Set(['ECONNREFUSED'])],
  ['CONNECTION_RESET', new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED'])],
  ['NETWORK_UNREACHABLE', new Set(['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'EADDRNOTAVAIL'])],
  ['TLS_ERROR', new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'EPROTO',
  ])],
];

const TLS_CODE_PREFIXES = ['CERT_', 'ERR_TLS_', 'ERR_SSL_'];
const MAX_CAUSE_DEPTH = 4;
const CAUSE_MESSAGE_MAX_CHARS = 200;

function groupOf(code: string): GhostFetchNetworkErrorCode | null {
  for (const [group, codes] of CODE_GROUPS) {
    if (codes.has(code)) return group;
  }
  return TLS_CODE_PREFIXES.some((prefix) => code.startsWith(prefix)) ? 'TLS_ERROR' : null;
}

/** 沿 cause 链(含 AggregateError.errors)广度优先收集带 code 的错误。 */
function codedErrors(err: unknown): Array<{ code: string; message: string }> {
  const found: Array<{ code: string; message: string }> = [];
  let layer: unknown[] = [err];
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && layer.length > 0; depth += 1) {
    const next: unknown[] = [];
    for (const item of layer) {
      if (!item || typeof item !== 'object') continue;
      const { code, message, cause, errors } = item as {
        code?: unknown; message?: unknown; cause?: unknown; errors?: unknown;
      };
      if (typeof code === 'string' && code) {
        found.push({ code, message: typeof message === 'string' ? message : '' });
      }
      if (cause !== undefined) next.push(cause);
      if (Array.isArray(errors)) next.push(...errors);
    }
    layer = next;
  }
  return found;
}

function isUndiciFetchFailure(err: unknown): boolean {
  return err instanceof TypeError && (err.message === 'fetch failed' || err.message === 'terminated');
}

export function classifyFetchNetworkFailure(err: unknown): GhostFetchNetworkFailure | null {
  for (const { code, message } of codedErrors(err)) {
    const errorCode = groupOf(code);
    if (!errorCode) continue;
    const text = message.replace(/\s+/g, ' ').trim().slice(0, CAUSE_MESSAGE_MAX_CHARS);
    const detail = !text ? code : text.includes(code) ? text : `${code}: ${text}`;
    return { errorCode, causeCode: code, reason: `${LABELS[errorCode]}(${detail})` };
  }
  if (!isUndiciFetchFailure(err)) return null;
  const message = (err as Error).message;
  return { errorCode: 'NETWORK_ERROR', reason: `${LABELS.NETWORK_ERROR}(${message})` };
}

/** 主机自身的超时中断(AbortController 到点)。 */
export function fetchTimeoutFailure(timeoutMs: number): GhostFetchNetworkFailure {
  return { errorCode: 'NETWORK_TIMEOUT', reason: `${LABELS.NETWORK_TIMEOUT}(${timeoutMs}ms)` };
}
