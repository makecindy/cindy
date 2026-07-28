/**
 * Loopback HTTP 反向代理实现 ——
 *
 * 设计要点 / 性能保证:
 *   1. 监听 127.0.0.1 随机端口,避开 Fetch 禁用端口,纯进程内 loopback,不暴露任何外部接口
 *   2. 响应路径: 字节级 pipe,完全不解析(SSE 流式响应低延迟的命脉)
 *   3. 请求路径:
 *      - 非 POST / Content-Type 不是 JSON → 整条字节透传
 *      - JSON POST → 缓冲到完整 body,跑 transform 链,re-serialize 后转发
 *      - transform 抛错 / 上游挂 → 退化为透传(透传也失败再给客户端报错)
 *   4. dispose: 立即 destroy 所有 in-flight socket + 等 server.close 回调(~10ms)。
 *      退出场景下客户端 (Claude Code 子进程) 也即将被 SIGTERM, 保留 in-flight 请求无意义;
 *      详见 dispose() 内注释。
 */

import { createServer, request as httpRequest, type IncomingMessage, type RequestOptions, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket, TcpSocketConnectOpts } from 'node:net';
import { URL } from 'node:url';
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';

import { DEFAULT_THREAD_ID_HEADERS, selectedHeaderValue } from './headers.js';
import {
  formatAuthority,
  formatHostHeader,
  isLoopbackHostname,
  OutboundProxyAgentPool,
  outboundProxyAgentKey,
  parseOutboundProxyUrl,
  redactProxyUrlForLog,
  TunnelingHttpsAgent,
  type OutboundProxyAgent,
  type OutboundProxyTarget,
} from './outbound-proxy.js';
import { Socks5HttpAgent, Socks5HttpsAgent } from './socks5.js';
import { stripNonAnthropicFields, stripToolUseProviderSpecificFields } from './transform.js';
import type {
  LocalRequestHandler,
  ProxyHandle,
  ProxyLogger,
  ProxyOptions,
  RecoveryRule,
  RequestTransform,
  RequestTransformCtx,
  ResponseObserver,
  ResponseObserverSink,
  RoutingDecision,
} from './types.js';

// 单条请求最大 body 大小的**默认值** —— Claude Code 请求 body 几 KB 到几百 KB,
// 留 32MB 给极端的长上下文 + 大附件;超出回 413,避免内存被打爆。
// 调用方可用 ProxyOptions.maxRequestBodyBytes 覆盖(codex 全量重发历史的场景需要更大)。
const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

// 413 响应写回后,等客户端读到响应自行断开的宽限期;超时强制 destroy 防连接悬挂。
const REQUEST_TOO_LARGE_DRAIN_TIMEOUT_MS = 10 * 1000;

// 转发请求的客户端不响应超时(socket 级别);LLM 请求经常 60s+,这里保守给 10 分钟。
const UPSTREAM_SOCKET_TIMEOUT_MS = 10 * 60 * 1000;

// Happy Eyeballs 单地址连接尝试超时。Node 20+ 默认开启 autoSelectFamily(双栈并竞),
// 但每个地址的 TCP 握手默认只给 250ms(net.getDefaultAutoSelectFamilyAttemptTimeout());
// 高延迟网络下到 Cloudflare 系上游(chatgpt.com 等)握手经常 >250ms,DNS 解出的所有地址
// 会被逐个砍掉,整个连接直接抛 AggregateError → 客户端收到 502 "upstream unreachable"
// (curl / 浏览器没有这么激进的 per-attempt 超时,所以只有 Node 转发这条路挂,2026-07 实踩)。
// 显式放宽到 2.5s:只拉长新建连接时 v6/v4 地址间的争抢窗口,连接成功后无影响,
// 请求整体超时仍由 UPSTREAM_SOCKET_TIMEOUT_MS 管。
const UPSTREAM_CONNECT_ATTEMPT_TIMEOUT_MS = 2500;

// proxy URL 会交给 Claude/Codex SDK；调用方可能使用 Fetch，因此对外端口必须避开
// Fetch 标准 bad ports。主动从高位私有端口区间选候选，避免依赖 OS 随机分配后再补漏。
const LOOPBACK_BIND_MAX_ATTEMPTS = 32;
const LOOPBACK_CANDIDATE_PORT_MIN = 49152;
const LOOPBACK_CANDIDATE_PORT_MAX = 65535;
const LOOPBACK_CANDIDATE_PORT_COUNT = LOOPBACK_CANDIDATE_PORT_MAX - LOOPBACK_CANDIDATE_PORT_MIN + 1;

const FETCH_BLOCKED_PORTS = new Set<number>([
  0, 1, 7, 9, 11, 13, 15, 17, 19,
  20, 21, 22, 23, 25, 37, 42, 43,
  53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117,
  119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526,
  530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719,
  1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export function isFetchBlockedPort(port: number): boolean {
  return FETCH_BLOCKED_PORTS.has(port);
}

// 请求 dump 的字节上限。入站请求带上下文也很少超 64KB,典型只有几 KB。
// 超出截断后追加 "... (truncated, total N bytes)"。
// 2xx 响应不 dump body —— SSE 一个 turn 几 MB 起步, dump 反而把日志刷爆且没什么排查价值,
// 只记 status / content-type / 字节数。
const DEBUG_REQUEST_DUMP_MAX_BYTES = 64 * 1024;

// 错误响应 (status >= 400) body 的 dump 上限。错误响应通常只是一个 JSON error 对象
// (~几百字节),给 16KB 已经非常宽裕,超出按相同截断策略尾部追加 "... (truncated, total N bytes)"。
const ERROR_RESPONSE_DUMP_MAX_BYTES = 16 * 1024;

interface UpstreamTarget {
  hostname: string;
  port: number;
  protocol: 'http:' | 'https:';
  basePath: string;  // 上游路径前缀(例 "" 或 "/v1")
  baseQuery: string; // 不含前导 '?'
}

/**
 * 一次请求已解析好的出站代理。在请求处理层(路由决策后)解析一次,透明重试沿用同一份,
 * 保证重试与首发走同一条网络路径。
 */
interface ResolvedOutboundProxy {
  target: OutboundProxyTarget;
  /**
   * 转发要挂的 agent。HTTP 代理:https 上游用 CONNECT 隧道 agent,http 上游走绝对形式
   * 请求不需要 agent(undefined);SOCKS5:两种上游都靠 agent 建隧道,恒有值。
   */
  agent?: OutboundProxyAgent;
}

function parseUpstream(upstream: string): UpstreamTarget {
  const u = new URL(upstream);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`anthropic-compat-proxy: upstream must be http(s), got ${u.protocol}`);
  }
  return {
    hostname: u.hostname,
    port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80),
    protocol: u.protocol,
    basePath: u.pathname.replace(/\/+$/, ''),  // 去末尾斜杠,防止后面拼出双斜杠
    baseQuery: u.search.slice(1),
  };
}

/**
 * 把一个 UpstreamTarget 拼回可读 baseURL(默认端口省略,跟人类阅读习惯一致)——
 * 给 debug 日志用,让人直接看出请求**最终**流向哪个上游。默认上游与 per-request
 * override(routingTransform 的 upstreamOverride,如订阅直连 api.anthropic.com)共用。
 */
function formatUpstreamBase(t: UpstreamTarget): string {
  const defaultPort = t.protocol === 'https:' ? 443 : 80;
  return (
    `${t.protocol}//${t.hostname}` +
    (t.port === defaultPort ? '' : `:${t.port}`) +
    t.basePath +
    (t.baseQuery ? `?${t.baseQuery}` : '')
  );
}

function isRetryableListenError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EADDRINUSE' || code === 'EACCES';
}

function randomLoopbackPort(): number {
  return LOOPBACK_CANDIDATE_PORT_MIN + Math.floor(Math.random() * LOOPBACK_CANDIDATE_PORT_COUNT);
}

async function listenOnLoopbackPort(server: Server, host: string, port: number): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const cleanup = (): void => {
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onListening = (): void => {
      cleanup();
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        const error = new Error('anthropic-compat-proxy: failed to bind loopback port');
        server.close(() => reject(error));
        return;
      }
      resolve(addr.port);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

/** @internal Exported for deterministic port-retry tests; not part of the package entrypoint. */
export async function listenOnFetchSafeLoopbackPort(
  server: Server,
  host: string,
  logger: ProxyLogger,
): Promise<number> {
  const triedPorts = new Set<number>();
  let lastRetryableError: Error | null = null;
  for (let attempt = 1; attempt <= LOOPBACK_BIND_MAX_ATTEMPTS; attempt += 1) {
    // Windows exclusions are contiguous ranges (often hundreds of ports), so
    // retrying adjacent candidates can deterministically exhaust every attempt.
    let port = randomLoopbackPort();
    while (triedPorts.has(port)) {
      port = port === LOOPBACK_CANDIDATE_PORT_MAX ? LOOPBACK_CANDIDATE_PORT_MIN : port + 1;
    }
    triedPorts.add(port);

    if (isFetchBlockedPort(port)) {
      logger.warn?.('anthropic-compat-proxy skipped Fetch-blocked loopback port candidate', {
        port,
        attempt,
      });
      continue;
    }

    try {
      return await listenOnLoopbackPort(server, host, port);
    } catch (error) {
      if (!isRetryableListenError(error)) {
        throw error;
      }
      lastRetryableError = error instanceof Error ? error : new Error(String(error));
      logger.warn?.('anthropic-compat-proxy loopback port candidate unavailable; retrying', {
        port,
        attempt,
        err: String(error),
      });
    }
  }

  throw new Error(
    `anthropic-compat-proxy: failed to bind Fetch-safe loopback port after ${LOOPBACK_BIND_MAX_ATTEMPTS} attempts` +
      (lastRetryableError === null ? '' : `; last error ${lastRetryableError.message}`),
  );
}

/**
 * 把路由解析失败收敛为单请求的结构化错误,不能让 async HTTP handler 的 rejected
 * Promise 漂成 process-level unhandledRejection。错误详情只进日志,响应不回显 URL。
 */
function respondRoutingFailure(
  res: ServerResponse,
  logger: ProxyLogger,
  reqId: number,
  status: 502 | 503,
  message: string,
  err: unknown,
): void {
  logger.warn?.(message, { reqId, err: String(err) });
  if (!res.headersSent) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'proxy_error', message } }));
    return;
  }
  res.destroy(err instanceof Error ? err : new Error(String(err)));
}

/** 路由层是最后的信任边界；任何调用方给出的路径覆盖都必须保持同源且不可注入 header。 */
function isSafePathOverride(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const queryIndex = value.indexOf('?');
  const pathname = queryIndex === -1 ? value : value.slice(0, queryIndex);
  const hasEncodedPathSeparator = /%(?:2f|5c)/i.test(pathname);
  const hasDotSegment = pathname
    .split('/')
    .some((segment) => {
      const normalizedDots = segment.replace(/%2e/gi, '.');
      return normalizedDots === '.' || normalizedDots === '..';
    });
  return (
    value.length >= 1
    && value.length <= 2_048
    && value.startsWith('/')
    && !value.startsWith('//')
    && !value.includes('#')
    && !value.includes('\\')
    && !/[^\u0021-\u007e]/.test(value)
    && /^\/[A-Za-z0-9\-._~%!$&()*+,;=:@/?]*$/.test(value)
    && !/%(?![0-9A-Fa-f]{2})/.test(value)
    && !hasEncodedPathSeparator
    && !hasDotSegment
  );
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * 执行路由决策命中的本地 handler(见 types.LocalRequestHandler 契约)。
 *
 * 错误语义与 forward 的上游错误一致:
 *   - handler 抛错且未写响应头 → 502 fail-open(客户端得到明确错误,不挂死);
 *   - 已写头(流式中途炸)→ destroy socket;
 *   - handler resolve 但没 end 响应 → 防御性收尾(未写头按 502 算),请求绝不悬挂。
 */
async function runLocalHandler(
  handler: LocalRequestHandler,
  args: { rawBody: Buffer; parsedBody: unknown; ctx: RequestTransformCtx; res: ServerResponse },
  logger: ProxyLogger,
  reqId: number,
): Promise<void> {
  const { res } = args;
  try {
    await handler(args);
    if (!res.writableEnded) {
      logger.warn?.('local handler resolved without ending response; closing defensively', { reqId });
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'proxy_error', message: 'local handler produced no response' } }));
      } else {
        res.end();
      }
    }
  } catch (err) {
    logger.error?.('local handler failed', { reqId, err: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'proxy_error', message: `local handler failed: ${String(err)}` } }));
    } else {
      res.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/**
 * 收集请求 body 到 Buffer。超 maxBytes 时 reject(err.message = 'REQUEST_TOO_LARGE',
 * err.receivedBytes = 已收字节数)让 caller 走 respondRequestTooLarge 回 413。
 * 不解析 JSON —— 解析在 transform 阶段做,先确保拿到完整字节。
 *
 * 超限时**不能**在这里 destroy socket:413 响应还没写回,先斩连接客户端只会看到
 * 含糊的传输层错误(reqwest: "error sending request for url (…)"),且无从排查
 * (2026-07 导入超大 codex 会话实踩)。这里只停止消费,响应与收尾交给调用方。
 */
function collectRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const onEnd = () => resolve(Buffer.concat(chunks));
    const onError = (e: Error) => reject(e);
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // 三个监听器一起摘干净 —— 调用方随后 resume drain 剩余 body,end/error
        // 留着虽因 Promise 已 settled 只是 no-op,但没必要挂到 GC。
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
        req.pause();
        const err = new Error('REQUEST_TOO_LARGE') as Error & { receivedBytes?: number };
        err.receivedBytes = total;
        reject(err);
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/**
 * 请求 body 超限的统一收尾:先把**完整的 413 响应**写回、再让连接关闭,顺序不能反。
 * 历史实现是先 req.destroy() 再写 413 —— socket 已死,413 永远到不了客户端,
 * codex/reqwest 端只能报 "stream disconnected before completion: error sending
 * request for url (http://127.0.0.1:PORT/responses)" 这种传输层错误;且旧路径
 * 一行日志都没有,线上完全无从定位。现在:
 *   1. warn 日志(threadId + 上限 + 声明/实收字节数),让 main log 可直接 grep 到;
 *   2. 全量写出 413 字节(显式 content-length,客户端边传边读即可完整解析)
 *      + connection: close;
 *   3. resume 丢弃剩余上传字节(无 listener,不占内存),**等请求体 drain 完再
 *      res.end()** —— Node 在"请求未读完就结束响应"时会主动 destroySoon socket,
 *      客户端还没来得及解析 413 就撞上 RST/EPIPE,等 drain 完收尾才是干净的 FIN;
 *   4. 宽限期超时强制收尾兜底,防止不守规矩的客户端把连接挂死。
 */
function respondRequestTooLarge(opts: {
  req: IncomingMessage;
  res: ServerResponse;
  logger: ProxyLogger;
  reqId: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  limitBytes: number;
  /** Content-Length 预检命中时的声明字节数;流式守卫命中时为 null。 */
  declaredBytes: number | null;
  receivedBytes: number;
}): void {
  const { req, res, logger } = opts;
  logger.warn?.('✖ request body exceeds proxy limit → 413', {
    reqId: opts.reqId,
    method: opts.method,
    url: opts.url,
    threadId: selectedHeaderValue(opts.headers, DEFAULT_THREAD_ID_HEADERS) || undefined,
    limitBytes: opts.limitBytes,
    declaredBytes: opts.declaredBytes ?? undefined,
    receivedBytes: opts.receivedBytes,
  });
  const payload = Buffer.from(JSON.stringify({
    error: {
      type: 'proxy_error',
      message: `request body too large: ${opts.declaredBytes ?? `>${opts.receivedBytes}`} bytes exceeds proxy limit of ${opts.limitBytes} bytes`,
    },
  }));
  res.writeHead(413, {
    'content-type': 'application/json',
    'content-length': String(payload.length),
    connection: 'close',
  });
  res.write(payload);

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(killTimer);
    res.end();
  };
  const killTimer = setTimeout(() => {
    finish();
    req.destroy();
  }, REQUEST_TOO_LARGE_DRAIN_TIMEOUT_MS);
  killTimer.unref?.();

  if (req.readableEnded) {
    finish();
  } else {
    req.once('end', finish);
    req.once('close', finish);
    req.resume();
  }
}

/**
 * 跑 transform 链。任一 transform 抛错 → 返回 null(走透传保命)。
 * 所有 transform 都返回 null → 也返回 null(透传)。
 * 至少一个 transform 改了 body → 返回最新的 body。
 */
function runTransforms(
  rawBody: Buffer,
  contentType: string,
  transforms: RequestTransform[],
  ctx: RequestTransformCtx,
  logger: ProxyLogger,
): Buffer | null {
  if (transforms.length === 0) return null;
  if (!contentType.toLowerCase().startsWith('application/json')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    logger.warn?.('json parse failed, falling back to passthrough', { err: String(err) });
    return null;
  }

  let current: unknown = parsed;
  let mutated = false;
  for (const t of transforms) {
    try {
      const next = t(current, ctx);
      if (next !== null && next !== undefined) {
        current = next;
        mutated = true;
      }
    } catch (err) {
      logger.warn?.('transform threw, skipping it', { err: String(err) });
    }
  }

  if (!mutated) return null;
  try {
    return Buffer.from(JSON.stringify(current), 'utf8');
  } catch (err) {
    logger.error?.('re-serialize failed, falling back to passthrough', { err: String(err) });
    return null;
  }
}

/**
 * 把 IncomingMessage.headers 平铺成 Record<string,string>,过滤掉 hop-by-hop headers
 * 和会让上游 / 下游困惑的字段。
 *
 * 删的字段:
 *   - host:           必须由 client lib 自己根据上游 hostname 重算
 *   - connection:     hop-by-hop
 *   - keep-alive:     hop-by-hop
 *   - transfer-encoding: 我们已经把 body 缓冲完整,改回 content-length
 *   - content-length: 由调用方根据 outBody.length 重算
 */
function flattenRequestHeaders(raw: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'connection' || lk === 'keep-alive' || lk === 'transfer-encoding' || lk === 'content-length') continue;
    if (Array.isArray(v)) out[lk] = v.join(', ');
    else if (v != null) out[lk] = String(v);
  }
  return out;
}

function flattenResponseHeaders(raw: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) out[k.toLowerCase()] = v.join(', ');
    else if (v != null) out[k.toLowerCase()] = String(v);
  }
  return out;
}

function extractBodyModel(body: Buffer): string {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const model = (parsed as Record<string, unknown>).model;
      if (typeof model === 'string') return model;
    }
  } catch { /* not JSON */ }
  return '';
}

/**
 * 把 Buffer 转成 debug 日志友好的字符串 —— UTF-8 解码 + 长度截断 + JSON pretty 尝试。
 *
 * - 优先尝试 JSON.parse + JSON.stringify(2) 输出,可读性高
 * - 解析失败回退原始 utf8 字符串
 * - 超 maxBytes 字节时尾部截断,加 "... (truncated, total N bytes)" 提示
 *
 * 仅在 isDebugEnabled 命中时才会被调用,info/warn 级别开销 0。
 */
/**
 * 从上游错误响应 body 里抽取 `error.type` (低风险字段) 用于 release 默认摘要。
 *
 * Anthropic / OpenAI / litellm 的错误体共享 `{ "error": { "type": "...", ... } }` 形态,
 * 这里只取 type 字符串,不取 message —— message 经常回显请求字段值, 会泄漏 prompt 片段。
 *
 * 任何失败 (非 JSON / content-type 不对 / 字段缺失 / body 截断到一半) 都返回 undefined,
 * 调用方直接省略 errorType 字段, 不影响主路径。
 */
function extractErrorType(buf: Buffer, contentType: string): string | undefined {
  if (!contentType.toLowerCase().startsWith('application/json')) return undefined;
  if (buf.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(buf.toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const err = (parsed as Record<string, unknown>).error;
      if (typeof err === 'object' && err !== null && !Array.isArray(err)) {
        const t = (err as Record<string, unknown>).type;
        if (typeof t === 'string' && t.length > 0) return t;
      }
    }
  } catch { /* not JSON / truncated mid-parse */ }
  return undefined;
}

function dumpBody(buf: Buffer, maxBytes: number): string {
  if (buf.length === 0) return '<empty>';
  const truncated = buf.length > maxBytes;
  const slice = truncated ? buf.subarray(0, maxBytes) : buf;
  let text = slice.toString('utf8');
  // 尝试 pretty: 整 buffer parse 成功才 pretty,截断版本通常 parse 不动直接走 utf8 原文
  if (!truncated) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch { /* not JSON / corrupted, keep utf8 */ }
  }
  if (truncated) {
    text += `\n... (truncated, total ${buf.length} bytes)`;
  }
  return text;
}

/**
 * 按 content-encoding 解压"日志用"的错误体 buffer。
 *
 * 背景: node:http 的 request 不会自动解压响应体, 上游(litellm / Azure / gateway)
 * 若带 `Content-Encoding: gzip|br|deflate`, errBuf 里就是压缩字节, 直接 toString('utf8')
 * 会得到一坨乱码(典型: 一段被 gzip 的 JSON error 体)。这里仅为让日志可读而解压一次。
 *
 * 不影响响应主路径 —— 给客户端走的是字节级 pipe + content-encoding 头透传, 客户端自己解压。
 *
 * 任何失败(未知编码 / 截断的压缩流 / 非法数据)都返回**原始 buffer 引用**, 调用方据此
 * 判断"是否成功解压"(decoded !== buf 即成功), 失败时日志退回原样, 不抛错、不影响主流程。
 */
function decodeBodyForLog(buf: Buffer, contentEncoding: string | undefined): Buffer {
  if (!contentEncoding || buf.length === 0) return buf;
  const enc = contentEncoding.toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return gunzipSync(buf);
    if (enc === 'br') return brotliDecompressSync(buf);
    if (enc === 'deflate') {
      // deflate 有两种封装: zlib 头(inflateSync)和裸 deflate(inflateRawSync), 依次尝试。
      try { return inflateSync(buf); } catch { return inflateRawSync(buf); }
    }
  } catch {
    // 截断的压缩流 / 非法数据 → 回退原始字节(日志里仍是乱码但不崩)
  }
  return buf;
}

/**
 * 实际转发到上游 + pipe 响应回客户端。
 *
 * 响应路径关键: res.writeHead + upstreamRes.pipe(res), 全程不读 body 字节,
 * 这是 SSE 流式响应延迟为零的保证。
 *
 * 响应日志只记 status / content-type / 总字节(等 'end' 后),不 dump body —— 一个
 * SSE turn 几 MB 起步, dump 把日志刷爆且没什么排查价值。要看实际响应内容,直接
 * tail cc 子进程的 cc-debug.log。
 *
 * 请求 body 在调用 forward 前已被上层在 debug 级别下 dump 过,这里不重复。
 */
function forward(
  target: UpstreamTarget,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Buffer,
  clientRes: ServerResponse,
  logger: ProxyLogger,
  recoveryRules: readonly RecoveryRule[],
  reqId: number,
  // false → 本次是某条 recovery rule 的透明重试结果, 不再二次重试 (防循环)。
  canRetry = true,
  // per-request 路由 override:覆盖上游目标 / 合并额外 header(典型: 换 authorization)。
  // 省略 → 用默认 target + 原 headers(与扩展前字节级一致)。
  overrideTarget?: UpstreamTarget,
  headerOverride?: Record<string, string>,
  // 转发前从 outbound headers 删除的字段(大小写不敏感)。在 headerOverride 合并之后应用。
  headerDelete?: readonly string[],
  responseObserver?: ResponseObserver,
  // 原始客户端 model id。provider transform 可能在出站前去掉命名空间；recovery
  // controller 必须记原值，才能和下一轮主动 strip 看到的入站 model 对上。
  clientModel = '',
  // 请求处理层解析好的出站代理;undefined = 直连(与扩展前字节级一致)。
  outboundProxy?: ResolvedOutboundProxy,
  // 精确推理路径覆盖；省略时沿用客户端原始 path。
  pathOverride?: string,
): void {
  // 客户端已断开(典型:400 缓冲期间断开后走到透明重试)——'close' 已经发过,
  // 下面挂的中断传播 listener 永远不会触发,直接不发起上游请求。
  if (clientRes.destroyed) {
    logger.info?.('client already disconnected — skipping upstream forward', { reqId, method, path });
    return;
  }
  const actualTarget = overrideTarget ?? target;
  let actualHeaders = headerOverride ? { ...headers, ...headerOverride } : headers;
  if (headerDelete && headerDelete.length > 0) {
    // clone if we haven't already —— 不能就地改 `headers`(透明重试会复用同一份原始 headers)。
    if (actualHeaders === headers) actualHeaders = { ...headers };
    const toDelete = new Set(headerDelete.map((h) => h.toLowerCase()));
    for (const key of Object.keys(actualHeaders)) {
      if (toDelete.has(key.toLowerCase())) delete actualHeaders[key];
    }
  }
  const reqFn = actualTarget.protocol === 'https:' ? httpsRequest : httpRequest;
  const routedPath = pathOverride ?? path;
  const queryIndex = routedPath.indexOf('?');
  const routedPathname = queryIndex === -1 ? routedPath : routedPath.slice(0, queryIndex);
  const routedQuery = queryIndex === -1 ? '' : routedPath.slice(queryIndex + 1);
  const upstreamPathname =
    `${actualTarget.basePath}${routedPathname.startsWith('/') ? routedPathname : '/' + routedPathname}`;
  const upstreamQuery = [actualTarget.baseQuery, routedQuery].filter(Boolean).join('&');
  const upstreamPath = upstreamQuery ? `${upstreamPathname}?${upstreamQuery}` : upstreamPathname;

  // http.request 会把 options 原样透传给 agent.createConnection → net.connect,
  // 所以 socket 级 connect 选项运行时有效;但 @types/node 的 RequestOptions 没收录
  // autoSelectFamilyAttemptTimeout,用交叉类型显式补上。
  const upstreamOptions: RequestOptions & Pick<TcpSocketConnectOpts, 'autoSelectFamilyAttemptTimeout'> = {
    hostname: actualTarget.hostname,
    port: actualTarget.port,
    method,
    path: upstreamPath,
    headers: {
      ...actualHeaders,
      host: actualTarget.hostname,
      'content-length': String(body.length),
    },
    timeout: UPSTREAM_SOCKET_TIMEOUT_MS,
    autoSelectFamilyAttemptTimeout: UPSTREAM_CONNECT_ATTEMPT_TIMEOUT_MS,
  };
  if (outboundProxy) {
    if (outboundProxy.target.kind === 'socks5') {
      // SOCKS5 是 L4 隧道:握手由 agent 完成,请求本身照常发给真实上游 ——
      // hostname / port / path / Host 头一律不动(没有绝对形式请求这回事),
      // 目标域名也不在本地解析,交给代理端(见 socks5.ts 文件头)。
      upstreamOptions.agent = outboundProxy.agent;
    } else if (actualTarget.protocol === 'https:') {
      // https 上游:经 CONNECT 隧道 agent 转发(TLS 端到端,代理只见密文)。
      upstreamOptions.agent = outboundProxy.agent;
    } else {
      // http 上游:按 HTTP 代理惯例改发绝对形式请求给代理;Host 头指向真实上游。
      // socket 连的是代理,Host 头只能显式设置 —— 按 RFC 9110 带非默认端口 / IPv6 方括号。
      upstreamOptions.hostname = outboundProxy.target.hostname;
      upstreamOptions.port = outboundProxy.target.port;
      upstreamOptions.path = `http://${formatAuthority(actualTarget.hostname, actualTarget.port)}${upstreamPath}`;
      (upstreamOptions.headers as Record<string, string>).host =
        formatHostHeader(actualTarget.hostname, actualTarget.port, actualTarget.protocol);
      if (outboundProxy.target.authHeader) {
        (upstreamOptions.headers as Record<string, string>)['proxy-authorization'] = outboundProxy.target.authHeader;
      }
    }
  }
  const upstreamReq = reqFn(upstreamOptions);

  // ── 客户端中断传播 ────────────────────────────────────────────────────────
  // CC 掐流(stall 检测 / 用户 Stop / watchdog interrupt)时只会断开与本代理的
  // 连接;若不把中断传给上游,上游会把整段生成跑完并按全量输出计费(大上下文
  // 会话单笔可达数美元的费用泄漏),socket 也会悬挂到响应自然结束。这里在客户端
  // 连接于响应完成前关闭时,同步 destroy 上游请求(连带掐掉响应流)。
  // writableEnded 守卫:正常完成后的 'close'(end() 已调用)不触发。
  // 透明重试复用同一 clientRes,每次 forward 各挂一个 listener 指向自己的
  // upstreamReq —— 旧请求早已完成,destroy 是 no-op,不影响重试语义。
  let clientAborted = false;
  // 代理自己 destroy clientRes(上游故障回收客户端连接)也会触发 'close' 且
  // writableEnded 为 false —— 那不是客户端断开,不该打断开日志/置 clientAborted,
  // 否则排查上游故障时日志会把因果指向客户端。destroy 前置位此标记跳过。
  let proxyDestroyedClient = false;
  clientRes.on('close', () => {
    if (proxyDestroyedClient || clientRes.writableEnded) return;
    clientAborted = true;
    logger.info?.('client disconnected mid-response — aborting upstream request', {
      reqId,
      method,
      path: upstreamPath,
    });
    upstreamReq.destroy(new Error('client aborted before response completed'));
  });

  upstreamReq.on('response', (upstreamRes) => {
    // status + headers 透传(过滤掉 transfer-encoding 让 Node 自己处理 chunked)
    const respHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      if (k.toLowerCase() === 'transfer-encoding') continue;
      if (v !== undefined) respHeaders[k] = v;
    }
    const status = upstreamRes.statusCode ?? 502;

    // ── 上游 400/422 的透明重试 ──────────────────────────────────────────────
    // 只对可恢复的客户端错误(400/422)且尚未重试过、且有 enabled recovery rule 的请求:
    // 先把(很小的) 错误体完整缓冲下来, 在 'end' 找第一条 match 命中且 strip 出东西的规则,
    // 剥字段重发一次, 对客户端透明。
    // xAI 对不可反序列化 / 解不开的 encrypted_content 可能回 422 invalid-argument, 不能只认 400。
    // 2xx 流式响应 / 其它 4xx5xx / 已重试 / 无 enabled rule 一律走下面原有的 writeHead + pipe, 零额外延迟。
    const activeRules = canRetry && (status === 400 || status === 422)
      ? recoveryRules.filter((r) => r.enabled())
      : [];
    if (activeRules.length > 0) {
      const chunks: Buffer[] = [];
      upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk));
      upstreamRes.on('end', () => {
        const errBody = Buffer.concat(chunks);
        // 先按 content-encoding 解压一次 —— 规则 matches / errorType / body dump 都吃解压后的字节。
        // node:http 不自动解压; 上游若 gzip/br 压缩, 直接对压缩字节跑 regex 会漏判, 透明重试就不触发。
        // (回客户端仍是原始 errBody + content-encoding 头透传, 客户端自己解压, 见下方 clientRes.end)
        const decodedErrBody = decodeBodyForLog(errBody, String(upstreamRes.headers['content-encoding'] ?? ''));
        const decodedText = decodedErrBody.toString('utf8');
        // 取第一条 match 命中且 strip 出东西的规则;命中错误文案但没东西可删 → 试下一条。
        for (const [matchedIndex, rule] of activeRules.entries()) {
          if (!rule.matches(decodedText)) continue;
          const stripped = rule.strip(body);
          if (!stripped) continue;
          let retryBody = stripped;
          const appliedRules: RecoveryRule[] = [rule];
          // 透明重试只有一次。若同一历史里同时存在多类已知坏 payload,在这一次 retry
          // 前把其它安全 strip 也顺手应用掉,避免第一类 400 恢复后立刻撞第二类 400。
          for (const [extraIndex, extraRule] of activeRules.entries()) {
            if (extraIndex === matchedIndex) continue;
            const extraStripped = extraRule.strip(retryBody);
            if (!extraStripped) continue;
            retryBody = extraStripped;
            appliedRules.push(extraRule);
          }
          logger.info?.(`◀ upstream ${status} [${rule.id}] → 透明重试 (strip + 重发)`, {
            reqId,
            ruleId: rule.id,
            appliedRuleIds: appliedRules.map((r) => r.id),
            originalBytes: body.length,
            strippedBytes: retryBody.length,
          });
          const threadId = selectedHeaderValue(headers, rule.threadIdHeaders ?? DEFAULT_THREAD_ID_HEADERS);
          const model = clientModel || extractBodyModel(body);
          if (threadId && model) {
            for (const appliedRule of appliedRules) {
              appliedRule.onRetry?.(threadId, model);
            }
          }
          forward(
            target,
            method,
            path,
            headers,
            retryBody,
            clientRes,
            logger,
            recoveryRules,
            reqId,
            false,
            overrideTarget,
            headerOverride,
            headerDelete,
            responseObserver,
            clientModel,
            outboundProxy,
            pathOverride,
          );
          return;
        }
        // 无规则命中: 把这条 400 原样回给客户端 + 记 warn 日志 (与下方非 2xx 分支同语义)。
        // responseObserver 在此分支同样要喂到:这条 400 是客户端真实收到的失败,不喂会让
        // 「带 enabled recovery rule 的 400」(如 MODEL_NOT_FOUND) 静默绕过上游错误观察。
        // (规则命中并透明重试的那次 400 刻意不喂——客户端从未见到它,重试结果会正常过观察器。)
        if (responseObserver) {
          try {
            const sink = responseObserver({
              reqId,
              method,
              url: path,
              upstreamBase: formatUpstreamBase(actualTarget),
              status,
              requestHeaders: headers,
              outboundHeaders: actualHeaders,
              responseHeaders: flattenResponseHeaders(upstreamRes.headers),
              requestBody: body,
            }) ?? null;
            // 与流式路径同口径喂原始字节(观察器自己按 content-encoding 解码)。
            sink?.onData?.(errBody);
            sink?.onEnd?.();
          } catch (err) {
            logger.warn?.('responseObserver threw on buffered 400', { reqId, err: String(err) });
          }
        }
        const errorType = extractErrorType(decodedErrBody, String(upstreamRes.headers['content-type'] ?? ''));
        const baseCtx: Record<string, unknown> = {
          reqId,
          status,
          contentType: upstreamRes.headers['content-type'],
          bytes: errBody.length,  // 始终记上游回传的原始(可能压缩后)字节数
        };
        if (errorType) baseCtx.errorType = errorType;
        if (logger.isDebugEnabled?.()) baseCtx.body = dumpBody(decodedErrBody, ERROR_RESPONSE_DUMP_MAX_BYTES);
        logger.warn?.('◀ upstream response (non-2xx)', baseCtx);
        if (!clientRes.headersSent) {
          clientRes.writeHead(status, upstreamRes.statusMessage, respHeaders);
        }
        clientRes.end(errBody);
      });
      upstreamRes.on('error', (err) => {
        if (clientAborted) return;
        logger.error?.('upstream response stream error (during 400 buffering)', { reqId, err: String(err) });
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'content-type': 'application/json' });
          clientRes.end(JSON.stringify({ error: { type: 'proxy_error', message: `upstream stream error: ${String(err)}` } }));
        } else {
          proxyDestroyedClient = true;
          clientRes.destroy(err);
        }
      });
      return;
    }

    let observerSink: ResponseObserverSink | null = null;
    if (responseObserver) {
      try {
        observerSink = responseObserver({
          reqId,
          method,
          url: path,
          upstreamBase: formatUpstreamBase(actualTarget),
          status,
          requestHeaders: headers,
          outboundHeaders: actualHeaders,
          responseHeaders: flattenResponseHeaders(upstreamRes.headers),
          requestBody: body,
        }) ?? null;
      } catch (err) {
        observerSink = null;
        logger.warn?.('responseObserver threw on response start', { reqId, err: String(err) });
      }
    }
    const observerData = (chunk: Buffer) => {
      if (!observerSink?.onData) return;
      try {
        observerSink.onData(chunk);
      } catch (err) {
        observerSink = null;
        logger.warn?.('responseObserver threw on data', { reqId, err: String(err) });
      }
    };
    const observerEnd = () => {
      const sink = observerSink;
      observerSink = null;
      if (!sink?.onEnd) return;
      try {
        sink.onEnd();
      } catch (err) {
        logger.warn?.('responseObserver threw on end', { reqId, err: String(err) });
      }
    };
    const observerError = (err: Error) => {
      const sink = observerSink;
      observerSink = null;
      if (!sink?.onError) return;
      try {
        sink.onError(err);
      } catch (observerErr) {
        logger.warn?.('responseObserver threw on error', { reqId, err: String(observerErr) });
      }
    };

    clientRes.writeHead(status, upstreamRes.statusMessage, respHeaders);

    // 收 body: 总字节始终累加;status >= 400 时额外收集前 ERROR_RESPONSE_DUMP_MAX_BYTES
    // 字节做 dump 用。2xx 路径只做计数, 无内存压力。
    // 错误响应的 status 在 'response' 事件就拿到了,这里直接判断要不要开收集器。
    const collectErrBody = status >= 400;
    let totalBytes = 0;
    const errBuf: Buffer[] = [];
    let errBufBytes = 0;
    upstreamRes.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      observerData(chunk);
      if (collectErrBody && errBufBytes < ERROR_RESPONSE_DUMP_MAX_BYTES) {
        const remain = ERROR_RESPONSE_DUMP_MAX_BYTES - errBufBytes;
        errBuf.push(chunk.length <= remain ? chunk : chunk.subarray(0, remain));
        errBufBytes += Math.min(chunk.length, remain);
      }
    });
    upstreamRes.on('end', () => {
      // 4xx/5xx 用 warn 级别冒泡, 默认只记低风险摘要 (status / content-type / bytes / errorType),
      // 完整 body 只在 debug 级别下才进日志 —— 避免 release 把上游错误体里可能回显的请求字段
      // 静默落盘到用户磁盘。debug 关时 isDebugEnabled 提前返 false, 不付 dump 字符串构造开销。
      // grep `cc-proxy.log` 配合 reqId 直接拉出完整往返。
      const baseCtx: Record<string, unknown> = {
        reqId,
        status,
        contentType: upstreamRes.headers['content-type'],
        bytes: totalBytes,
      };
      if (collectErrBody) {
        const merged = Buffer.concat(errBuf);
        // 先按 content-encoding 解压(失败 / 截断会返回 merged 原引用), errorType 与 body dump 共用。
        // 注意: errBuf 最多收 16KB 压缩字节, 截断的 gzip/br 解不开 → decoded === merged → 走原始字节分支。
        const decoded = decodeBodyForLog(merged, String(upstreamRes.headers['content-encoding'] ?? ''));
        const errorType = extractErrorType(decoded, String(upstreamRes.headers['content-type'] ?? ''));
        if (errorType) baseCtx.errorType = errorType;
        if (logger.isDebugEnabled?.()) {
          if (decoded !== merged) {
            // 解压成功 —— 只在拿到完整压缩流时才会成功(截断的 gzip/br 会解压失败回退),
            // 所以这里 decoded 一定是完整错误体, 无需再加 truncated 提示。
            baseCtx.body = dumpBody(decoded, ERROR_RESPONSE_DUMP_MAX_BYTES);
          } else {
            // 未压缩 / 解压失败: 保留原始字节 + (若收集时被 16KB 截断过) 截断提示。
            baseCtx.body = totalBytes > errBufBytes
              ? merged.toString('utf8') + `\n... (truncated, total ${totalBytes} bytes)`
              : dumpBody(merged, ERROR_RESPONSE_DUMP_MAX_BYTES);
          }
        }
        logger.warn?.('◀ upstream response (non-2xx)', baseCtx);
      } else {
        logger.debug?.('◀ upstream response', baseCtx);
      }
      observerEnd();
    });
    upstreamRes.on('error', (err) => {
      observerError(err instanceof Error ? err : new Error(String(err)));
    });

    upstreamRes.pipe(clientRes);  // ← 字节级 pipe,SSE 零延迟的命脉('data' 只是计数+错误体收集, 不影响流)
  });

  upstreamReq.on('error', (err) => {
    // 客户端主动断开触发的 destroy 是预期路径:客户端已不在,不写 502、不按
    // 上游故障记 error(上面 'close' 处已记过 info)。
    if (clientAborted) return;
    logger.error?.('upstream request failed', {
      reqId,
      err: String(err),
      method,
      path: upstreamPath,
      ...(outboundProxy ? { viaProxy: outboundProxy.target.url } : {}),
    });
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: { type: 'proxy_error', message: `upstream unreachable: ${String(err)}` } }));
    } else {
      proxyDestroyedClient = true;
      clientRes.destroy(err);
    }
  });

  upstreamReq.on('timeout', () => {
    upstreamReq.destroy(new Error('upstream socket timeout'));
  });

  upstreamReq.end(body);
}

/**
 * 启动代理。返回 ProxyHandle —— url 给 host 用作 ANTHROPIC_BASE_URL。
 */
export async function createAnthropicCompatProxy(opts: ProxyOptions): Promise<ProxyHandle> {
  // 默认上游支持函数形态:宿主的网关 endpoint 运行期可变(如登录后由服务端下发),
  // 只在路由没有给出 upstreamOverride / localHandler 时现取。有效值按原文 memoize,
  // endpoint 未变化时零重复 parse;显式供应商路由完全不碰默认上游(热路径,规则 10)。
  const resolveTarget = ((): (() => UpstreamTarget) => {
    const raw = opts.upstream;
    const readRaw = typeof raw === 'function' ? raw : () => raw;
    let cachedRaw: string | null = null;
    let cachedTarget: UpstreamTarget | null = null;
    return () => {
      const current = readRaw()?.trim() ?? '';
      if (!current) throw new Error('default upstream is not configured');
      if (cachedTarget === null || current !== cachedRaw) {
        cachedTarget = parseUpstream(current);
        cachedRaw = current;
      }
      return cachedTarget;
    };
  })();
  const transforms = opts.transformRequest ?? [stripToolUseProviderSpecificFields, stripNonAnthropicFields];
  const logger = opts.logger ?? {};
  const host = opts.host ?? '127.0.0.1';
  const maxBodyBytes = opts.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  // 入站请求 body dump 默认关(仅显式诊断时开):高并发下 64KiB×每请求的日志
  // 构造/落盘/终端镜像会占满宿主 main event loop,详见 ProxyOptions 注释。
  const dumpRequestBody = opts.debugDumpRequestBody === true;

  /**
   * 路由优先级的唯一落点:显式 override 胜出时绝不读取默认上游;只有 decision
   * 没选目标(含仅换 header 的 gateway-key 路由)时才解析默认 endpoint。
   */
  const resolveForwardRoute = (
    decision: RoutingDecision | null,
    res: ServerResponse,
    reqId: number,
  ): {
    target: UpstreamTarget;
    overrideTarget?: UpstreamTarget;
    headerOverride?: Record<string, string>;
    headerDelete?: readonly string[];
    pathOverride?: string;
  } | null => {
    const pathOverride = decision?.pathOverride;
    if (pathOverride !== undefined && !isSafePathOverride(pathOverride)) {
      respondRoutingFailure(
        res,
        logger,
        reqId,
        502,
        'selected request path invalid',
        new Error('routingTransform returned an unsafe pathOverride'),
      );
      return null;
    }
    let overrideTarget: UpstreamTarget | undefined;
    try {
      overrideTarget = decision?.upstreamOverride
        ? parseUpstream(decision.upstreamOverride)
        : undefined;
    } catch (err) {
      respondRoutingFailure(res, logger, reqId, 502, 'selected upstream invalid', err);
      return null;
    }
    let target = overrideTarget;
    try {
      target ??= resolveTarget();
    } catch (err) {
      respondRoutingFailure(res, logger, reqId, 503, 'default upstream unavailable', err);
      return null;
    }
    return {
      target,
      overrideTarget,
      headerOverride: decision?.headerOverride,
      headerDelete: decision?.headerDelete,
      pathOverride,
    };
  };

  // 出站代理:CONNECT 隧道 agent 按代理地址缓存(keep-alive 连接池),随 dispose 销毁。
  const outboundAgentPool = new OutboundProxyAgentPool();

  /**
   * per-request 解析本次转发的出站代理。任何一步失败(resolver 抛错 / 返回不支持的
   * 代理形态)都回落直连 —— 代理解析问题绝不能比今天的裸直连更糟。loopback 上游
   * (本机 bridge / gateway / 测试桩)恒直连,不打扰 resolver。
   */
  const resolveOutboundForTarget = async (
    target: UpstreamTarget,
    reqId: number,
  ): Promise<ResolvedOutboundProxy | undefined> => {
    const resolver = opts.resolveOutboundProxy;
    if (!resolver) return undefined;
    if (isLoopbackHostname(target.hostname)) return undefined;
    // IPv6 字面量上游要按 [addr]:port 拼 origin,否则 resolver 拿到非法 URL。
    const upstreamOrigin = `${target.protocol}//${formatAuthority(target.hostname, target.port)}`;
    let raw: string | null | undefined;
    try {
      raw = await resolver(upstreamOrigin);
    } catch (err) {
      logger.warn?.('outbound proxy resolver threw — using direct connection', { reqId, err: String(err) });
      return undefined;
    }
    if (!raw) return undefined;
    const parsed = parseOutboundProxyUrl(raw);
    if (!parsed) {
      // raw 可能带凭证,只记脱敏形态。
      logger.warn?.('unsupported outbound proxy url — using direct connection', {
        reqId,
        proxy: redactProxyUrlForLog(String(raw)),
      });
      return undefined;
    }
    logger.debug?.('using outbound proxy for upstream', {
      reqId,
      proxy: parsed.url,
      upstream: upstreamOrigin,
    });
    const agentKey = outboundProxyAgentKey(parsed, target.protocol);
    if (parsed.kind === 'socks5') {
      // SOCKS5 两种上游都要 agent:https 在隧道上做 TLS,http 直接用隧道当连接。
      return {
        target: parsed,
        agent: outboundAgentPool.get(agentKey, () => (target.protocol === 'https:'
          ? new Socks5HttpsAgent(parsed)
          : new Socks5HttpAgent(parsed))),
      };
    }
    return {
      target: parsed,
      agent: target.protocol === 'https:'
        ? outboundAgentPool.get(agentKey, () => new TunnelingHttpsAgent(parsed))
        : undefined,
    };
  };

  // in-flight 请求计数 —— dispose 时等清零或 2s 超时
  let inflight = 0;
  const inflightSockets = new Set<Socket>();

  // 单调递增 reqId, 用来在 cc-proxy.log 里把"▶ forward / ◀ response / error" 三条
  // 日志归到同一笔请求,grep `reqId=N` 就能拉出完整往返。整数 wrap 后(非常远的未来)
  // 重复也无所谓,只用于读日志的人眼对齐。
  let reqIdSeq = 0;

  const server: Server = createServer(async (req, res) => {
    inflight++;
    const reqId = ++reqIdSeq;
    res.on('close', () => { inflight--; });

    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const headers = flattenRequestHeaders(req.headers);
    const requestCtx: RequestTransformCtx = { reqId, method, url, headers };
    const contentType = headers['content-type'] ?? '';

    // 非 POST / 没 body(GET / HEAD / DELETE 等)→ 不收集 stream,但仍跑一次路由决策:
    // 这类请求没有 body,routingTransform 以 `undefined` body 调用,可据 method/url/headers 路由
    // 控制面请求(典型: codex models-manager 的 `GET /models` 轮询)。transform 对 undefined body
    // 应自行短路返回 null(= 默认上游 + 透传 headers,向后兼容)。
    if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') {
      let decision: RoutingDecision | null = null;
      if (opts.routingTransform) {
        try {
          const maybeDecision = opts.routingTransform(undefined, requestCtx);
          decision = isPromiseLike<RoutingDecision | null>(maybeDecision)
            ? await maybeDecision
            : maybeDecision;
        } catch (err) {
          logger.warn?.('routingTransform threw, using default upstream', { reqId, err: String(err) });
        }
      }
      // 本地 handler 命中:不转发上游,由 handler 直接写回响应(见 LocalRequestHandler 契约)。
      if (decision?.localHandler) {
        logger.debug?.('▶ inbound request from client', { reqId, method, upstreamBase: 'local-handler', url, bytes: 0 });
        await runLocalHandler(
          decision.localHandler,
          { rawBody: Buffer.alloc(0), parsedBody: undefined, ctx: requestCtx, res },
          logger,
          reqId,
        );
        return;
      }
      const route = resolveForwardRoute(decision, res, reqId);
      if (!route) return;
      if (logger.isDebugEnabled?.()) {
        logger.debug?.('▶ inbound request from client', {
          reqId,
          method,
          upstreamBase: formatUpstreamBase(route.target),
          url,
          bytes: 0,
        });
      }
      forward(
        route.target,
        method,
        url,
        headers,
        Buffer.alloc(0),
        res,
        logger,
        opts.recoveryRules ?? [],
        reqId,
        true,
        route.overrideTarget,
        route.headerOverride,
        route.headerDelete,
        opts.responseObserver,
        '',
        await resolveOutboundForTarget(route.target, reqId),
        route.pathOverride,
      );
      return;
    }

    // Content-Length 预检: 声明就超限的直接 413,不让客户端白传几十 MB 后再失败
    // (reqwest/hyper 对缓冲 body 必带 content-length,codex 正常都命中这条快路径;
    // 只有 chunked 上传才落到 collectRequestBody 的流式守卫)。
    // 注意读原始 req.headers —— flattenRequestHeaders 会剥掉 content-length(转发时重算)。
    const declaredBytes = Number(req.headers['content-length'] ?? '');
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBodyBytes) {
      respondRequestTooLarge({
        req, res, logger, reqId, method, url, headers,
        limitBytes: maxBodyBytes,
        declaredBytes,
        receivedBytes: 0,
      });
      return;
    }

    let rawBody: Buffer;
    try {
      rawBody = await collectRequestBody(req, maxBodyBytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'REQUEST_TOO_LARGE') {
        respondRequestTooLarge({
          req, res, logger, reqId, method, url, headers,
          limitBytes: maxBodyBytes,
          declaredBytes: null,
          receivedBytes: (err as { receivedBytes?: number }).receivedBytes ?? 0,
        });
        return;
      }
      logger.warn?.('failed to read request body', { reqId, err: msg });
      res.writeHead(400);
      res.end();
      return;
    }

    // 路由决策: 基于**原始** body(transform 链改写前)判路由 —— 能看到上游看不到的原始字段
    // (例: 去前缀前的 codex/ model id)。decision 的 override 传给 forward, 默认不 override。
    // 提前到 ▶ inbound 日志**之前**计算: 路由只依赖 rawBody / headers / contentType,与下方
    // runTransforms 的输出无关,提前是安全的; 这样 inbound 日志能直接打出本请求**最终**发往的
    // upstream(订阅直连 api.anthropic.com / 走网关 endpoint),而非静态默认上游。
    let decision: RoutingDecision | null = null;
    let rawParsed: unknown = undefined;
    if (opts.routingTransform && contentType.toLowerCase().startsWith('application/json')) {
      try {
        rawParsed = JSON.parse(rawBody.toString('utf8'));
        const maybeDecision = opts.routingTransform(rawParsed, requestCtx);
        decision = isPromiseLike<RoutingDecision | null>(maybeDecision)
          ? await maybeDecision
          : maybeDecision;
      } catch (err) {
        logger.warn?.('routingTransform threw, using default upstream', { reqId, err: String(err) });
      }
    }

    // 本地 handler 命中:不转发上游、不跑 transform 链,由 handler 直接消费(协议翻译场景)。
    // parsedBody 复用路由阶段的解析结果,不二次 parse。
    if (decision?.localHandler) {
      if (logger.isDebugEnabled?.()) {
        logger.debug?.('▶ inbound request from client', {
          reqId,
          method,
          upstreamBase: 'local-handler',
          url,
          bytes: rawBody.length,
          ...(dumpRequestBody ? { body: dumpBody(rawBody, DEBUG_REQUEST_DUMP_MAX_BYTES) } : {}),
        });
      }
      await runLocalHandler(
        decision.localHandler,
        { rawBody, parsedBody: rawParsed, ctx: requestCtx, res },
        logger,
        reqId,
      );
      return;
    }
    const route = resolveForwardRoute(decision, res, reqId);
    if (!route) return;

    const debugOn = logger.isDebugEnabled?.() ?? false;
    if (debugOn) {
      logger.debug?.('▶ inbound request from client', {
        reqId,
        method,
        // 本请求**最终**发往的 upstream(per-request override 后), 不是静态默认上游 ——
        // = api.anthropic.com 即走订阅直连; = 网关 endpoint 即走网关。
        upstreamBase: formatUpstreamBase(route.target),
        url,
        bytes: rawBody.length,
        ...(dumpRequestBody ? { body: dumpBody(rawBody, DEBUG_REQUEST_DUMP_MAX_BYTES) } : {}),
      });
    }

    // transform 链的 ctx 附带最终上游(override 已生效):按目标上游做兼容改写的
    // transform 据此判断去向,不必在 host 侧复刻路由逻辑。
    const transformCtx: RequestTransformCtx = {
      ...requestCtx,
      upstreamBase: formatUpstreamBase(route.target),
    };
    const transformed = runTransforms(rawBody, contentType, transforms, transformCtx, logger);
    const outBody = transformed ?? rawBody;

    if (transformed) {
      logger.debug?.('⇄ transformed request body', {
        reqId,
        method,
        url,
        originalBytes: rawBody.length,
        outBytes: outBody.length,
      });
    }

    forward(
      route.target,
      method,
      url,
      headers,
      outBody,
      res,
      logger,
      opts.recoveryRules ?? [],
      reqId,
      true,
      route.overrideTarget,
      route.headerOverride,
      route.headerDelete,
      opts.responseObserver,
      extractBodyModel(rawBody),
      await resolveOutboundForTarget(route.target, reqId),
      route.pathOverride,
    );
  });

  // 跟踪所有底层 socket,dispose 时强制 destroy
  server.on('connection', (socket) => {
    inflightSockets.add(socket);
    socket.on('close', () => inflightSockets.delete(socket));
  });

  const port = await listenOnFetchSafeLoopbackPort(server, host, logger);
  const hostInUrl = host.includes(':') ? `[${host}]` : host;
  const url = `http://${hostInUrl}:${port}`;

  logger.debug?.('anthropic-compat-proxy listening', { url, upstream: opts.upstream });

  return {
    url,
    async dispose() {
      logger.debug?.('anthropic-compat-proxy disposing', { inflight });
      // 退出场景: 客户端(Claude Code 子进程)也即将被 SIGTERM, in-flight 请求保留无意义。
      // 立即 destroy 所有 socket → server.close 的 keep-alive 等待立刻满足 → callback
      // 立即触发, 整个 dispose 从 ~2s grace 降到 ~10ms。
      //
      // 副作用: in-flight 请求那一侧 (Claude Code 子进程) 会收 ECONNRESET。bootstrap-electron
      // 注释 (onQuit 'anthropic-compat-proxy' 段) 已显式接受此语义: "session 本来就在 close
      // 路径上, 这种 error 直接被吞, 影响可接受"。
      for (const s of inflightSockets) {
        try { s.destroy(); } catch { /* no-op */ }
      }
      // 出站代理的 keep-alive 隧道池一并断开,不留空闲 CONNECT 连接。
      outboundAgentPool.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
