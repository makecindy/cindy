/**
 * networkSlot.ts — network 槽代理 fetch(docs/dev-rules/plugin-security-and-authoring.md)。
 * ---------------------------------------------------------------------------
 * 意识自带服务的出网通道。沙箱本身保持零直连(electronSandboxAdapter 的
 * onBeforeRequest 断网闸不放开),意识想访问自己声明的域名只能经管子上行:
 *
 *   电子脑 cindy.send({type:'fetch-request', url, method?, headers?, body?, …})
 *     → 资格审(声明了 'network' 卡槽 + 详单?)
 *     → URL 硬校验(仅 https 默认端口;host 命中 network.hosts 白名单)
 *     → 意识自带 headers 消毒(协议关键头/凭证类头一律剥除)
 *     → 凭证注入(保险库现读明文,按 secret.inject 声明拼进请求头——
 *       key 只流向它声明的域名;意识代码从头到尾摸不到凭证字节;
 *       声明了 exchange 的凭证先照单换令牌:缓存 + 单飞 + 401 作废重换)
 *     → 主机真实 HTTP(注入的 fetchImpl;超时 clamp;重定向逐跳重验白名单)
 *     → 响应文本化(体积上限截断;响应头只回白名单字段)
 *     → 只回结构化 GhostPipeFetchResult(永不 reject)
 *
 * 安全纪律:凭证明文与响应体永不进日志(只记 ghostId / host / 状态码 /
 * callId);URL 只记 host + pathname,query 可能携带敏感参数,不记。
 *
 * 依赖注入(规则 14):凭证读取与 HTTP 执行全部经 deps,单测直测零 Electron。
 */

import { randomUUID } from 'node:crypto';

import { sniffMediaMime, additionalMp3BytesNeeded } from '../cindy-media/sniffMediaMime.js';

import {
  GHOST_FETCH_BODY_MAX_BYTES,
  GHOST_FETCH_INFLIGHT_LIMIT,
  GHOST_FETCH_LABEL_MAX_CHARS,
  GHOST_FETCH_MEDIA_MAX_BYTES,
  GHOST_FETCH_MEDIA_TIMEOUT_DEFAULT_MS,
  GHOST_FETCH_MEDIA_TIMEOUT_MAX_MS,
  GHOST_FETCH_METHODS,
  GHOST_FETCH_RESPONSE_MAX_BYTES,
  GHOST_FETCH_TIMEOUT_DEFAULT_MS,
  GHOST_FETCH_TIMEOUT_MAX_MS,
  GHOST_FETCH_TIMEOUT_MIN_MS,
  GHOST_FETCH_UPLOAD_FIELD_RE,
  GHOST_FETCH_UPLOAD_MAX_BYTES_PER_FILE,
  GHOST_FETCH_UPLOAD_MAX_FILES,
  GHOST_FETCH_UPLOAD_MAX_TOTAL_BYTES,
  GHOST_DIR_DEPOSIT_TOKEN_RE,
  GHOST_FETCH_FILE_MAX_BYTES,
  GHOST_FETCH_FILE_NAME_MAX_CHARS,
  GHOST_FETCH_DIR_UPLOAD_FIELD_VALUE_MAX_CHARS,
  GHOST_FETCH_DIR_UPLOAD_MAX_BYTES_PER_FILE,
  GHOST_FETCH_DIR_UPLOAD_MAX_FIELDS,
  GHOST_FETCH_DIR_UPLOAD_MAX_TOTAL_BYTES,
  GHOST_MEDIA_HASH_RE,
  GHOST_SECRET_EXCHANGE_TTL_DEFAULT_S,
  ghostNetworkHostMatches,
  type GhostConnectionDecl,
  type GhostFetchMethod,
  type GhostSecretOauthDecl,
  type GhostPipeFetchResult,
  type GhostSecretDecl,
  type InstalledGhost,
} from '../../shared/ghost.js';

export interface NetworkSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  /**
   * 读某意识某条凭证的明文(safeStorage 现读,不缓存——用户改了 key 下一单
   * 即生效);未配置 / 读失败返回 null。
   */
  readSecret(ghostId: string, secretKey: string): string | null;
  /**
   * 当前登录账号的邮箱(source:'login-email' 凭证的值来源;现读登录态,
   * 登出/切号下一单即生效)。未登录 / 登录态缺 email 返回 null。
   */
  getLoginEmail(): string | null;
  /**
   * 真实 HTTP 执行(生产注入 Electron net.fetch;单测注入假实现)。
   * 必须尊重 init.signal(超时经 AbortController 下发)与 redirect:'manual'
   * (重定向由本模块逐跳校验白名单,不许实现自动跟)。body 为 Uint8Array
   * 时是主机代组的 multipart 上传体。
   */
  fetchImpl(url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
    signal: AbortSignal;
    redirect: 'manual';
  }): Promise<Response>;
  /**
   * 上传通道:按指纹读"该意识名下"的总仓媒体字节(生产实现内做归属查账
   * ghostCanRead——出生自它 / 挂它画廊 / 用户显式过户;越权与不存在统一
   * 返回 null,不给探测空间)。ext 含点(如 '.png')。
   */
  readGhostMedia(ghostId: string, hash: string): Promise<{
    buffer: Uint8Array;
    mimeType: string;
    ext: string;
  } | null>;
  /**
   * 目录上传通道:凭一次性过户票据取货(生产为 dirDeposit 票据库的 take——
   * ghostId 绑定 + TTL + 单次消费;无效原因不分类统一 null,不给探测空间)。
   * 文件字节经 read() 闭包按需读盘,networkSlot 保持零 fs 依赖。
   */
  takeDirDeposit(ghostId: string, token: string): {
    files: Array<{ relPath: string; size: number; read(): Promise<Uint8Array> }>;
    totalBytes: number;
  } | null;
  /**
   * 下行落盘通道(as:'file';生产为 saveDeposit 票据库的 write):凭票把
   * 响应字节写进主 agent 过户的 workdir 目录——文件名主机消毒去重,绝对
   * 路径不出主机;无效票据统一 null。
   */
  writeSaveDeposit(
    ghostId: string,
    token: string,
    fileName: string,
    bytes: Uint8Array,
  ): Promise<{ fileName: string } | null>;
  /**
   * 媒体模式(as:'media')落仓 + 记账(ghost-gallery,出生=该意识;生产为
   * cindy-media 的 ingestMedia)。字节从响应流直达此处,不进沙箱。
   */
  saveGhostMedia(params: {
    ghostId: string;
    buffer: Uint8Array;
    mimeType: string;
    label?: string;
    /** 署名调用的 tool-call callId(记入 ghostMediaLedger 供收口带回);
     *  未署名('unattributed')不传、不记账。 */
    callId?: string;
  }): Promise<{ url: string; hash: string; ext: string }>;
  /** 归一化后的 mime 是否可入总仓(生产为 cindy-media 的 supportedMime)。 */
  isSupportedMediaMime(mime: string): boolean;
  /**
   * OAuth 凭证通道(source:'oauth';生产注入 GhostOauthAccountManager)。
   * 出网时现取新鲜 access token(内部缓存 + 单飞刷新),401 时经
   * invalidateAccessToken 作废后整链重试一次(与 exchange 同套路)。
   * 未注入时 oauth 凭证一律快速失败(接线缺失是主机 bug,不静默跳过)。
   */
  oauthTokens?: {
    getFreshAccessToken(
      ghostId: string,
      secretKey: string,
      decl: GhostSecretOauthDecl,
      accountId?: string,
    ): Promise<
      | { ok: true; accessToken: string; accountId: string }
      | {
          ok: false;
          error: 'NO_CLIENT_CONFIG' | 'NO_ACCOUNT' | 'AUTH_EXPIRED' | 'REFRESH_FAILED' | 'NETWORK';
          detail?: string;
        }
    >;
    invalidateAccessToken(ghostId: string, secretKey: string, accountId: string): void;
  };
  /**
   * Cindy organization identity assertions (`source: 'oidc-token'`). Audience
   * resolution is Host-owned; manifests and runtime messages cannot choose it.
   */
  connectionTokens?: {
    resolve(ghostId: string): {
      membershipId: string;
      audience: string;
      allowedHosts: readonly string[];
    } | null;
    getToken(input: { membershipId: string; audience: string }): Promise<string>;
    invalidate(input: { membershipId: string; audience: string }): void;
  };
  /**
   * 多连接凭证通道(network.connections;生产由 index.ts 注入闭包,内部按
   * manifest.network.connections 逐 decl 查 GhostConnectionManager)。
   * - hostsFor:该意识名下用户已添加的全部连接地址(小写裸域;动态白名单,
   *   与静态 hosts 并集放行,精确匹配不吃通配);
   * - tokenFor:hostname 精确命中某条连接时返回该连接自己的 token 与注入
   *   形态(同一 hostname 命中多个 decl 时取第一个);查无地址或 token 读
   *   不到返回 null(调用方按"凭证未配置"快速失败)。
   * 未注入时连接声明形同虚设(动态地址不放行),fail-closed。
   */
  connections?: {
    hostsFor(ghostId: string): string[];
    tokenFor(ghostId: string, hostname: string): { value: string; header: string; format: string } | null;
  };
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/** 归因号长度上限(与 cindySlot 同口径)。 */
const MAX_CALL_ID_LEN = 128;

/** 意识自带请求头条数上限(超出视为沙箱乱塞)。 */
const MAX_REQUEST_HEADERS = 16;
/** 单条请求头值长度上限。 */
const MAX_HEADER_VALUE_LEN = 2048;

/** 重定向最大跳数(逐跳重验白名单;超出按失败收)。 */
const MAX_REDIRECTS = 3;

/** Only these methods may be automatically replayed after a Connection JWT 401. */
const CONNECTION_RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 意识自带请求头的剥除名单(小写):协议关键头由 HTTP 栈管,凭证类头由
 * 保险库注入独占——意识写了也不生效(消毒后静默丢弃,不算错误,保持
 * 幂等确定性)。sec- / proxy- 前缀另行整族剥除。
 */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'upgrade',
  'cookie', 'set-cookie', 'origin', 'referer', 'authorization',
]);

/** 请求头名合法形状(与清单 inject.header 校验同口径)。 */
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * 回给沙箱的响应头白名单(小写);其余一律不透传。
 * mcp-session-id:Streamable HTTP MCP(mcp.slack.com 这类远程 MCP server)
 * 在 initialize 响应头下发会话 id,后续请求需回带——它只是上游会话句柄,
 * 不含凭证字节,且本就只回给发起该次 fetch 的意识自己。
 */
const RESPONSE_HEADER_WHITELIST = [
  'content-type', 'content-length', 'cache-control', 'etag', 'last-modified', 'retry-after',
  'mcp-session-id',
];

/** 文本形态:content-type 命中这些形状才把 body 透传回沙箱。 */
function isTextualContentType(ct: string): boolean {
  const mime = normalizeMime(ct);
  if (mime.startsWith('text/')) return true;
  if (mime === 'application/json' || mime === 'application/xml') return true;
  if (mime.endsWith('+json') || mime.endsWith('+xml')) return true;
  if (mime === 'application/x-www-form-urlencoded' || mime === 'application/javascript') return true;
  // 无 content-type 的按文本试读(不少小服务不带头;截断护栏仍在)。
  return mime === '';
}

/**
 * Generic octet-stream is not automatically text: only a bounded, valid UTF-8
 * prefix without NUL/control bytes may use the polling/text fallback.
 */
function isProbablyUtf8Text(bytes: Uint8Array, complete: boolean): boolean {
  if (bytes.byteLength === 0) return true;
  for (const byte of bytes) {
    if (byte === 0x00 || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) {
      return false;
    }
  }
  try {
    // An open probe may end in the middle of a valid multi-byte sequence. A
    // complete body must flush the decoder so a dangling sequence is rejected.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: !complete });
    return true;
  } catch {
    return false;
  }
}

/**
 * An empty Content-Type is historically text-compatible; octet-stream falls
 * back only after the bytes themselves pass the conservative text check.
 */
function allowsSniffedTextFallback(probe: Uint8Array, complete: boolean): boolean {
  return isProbablyUtf8Text(probe, complete);
}

/**
 * 常见非标 mime → 总仓白名单正名(blobStore EXT_BY_MIME 只认正名)。
 * 音频三兄弟的别名野得很(audio/mp3 / x-wav / wave / x-m4a 满天飞),
 * 漏归一 = 该文件在媒体模式整单拒、文本模式也拒,两头都取不回。
 */
const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/x-m4a': 'audio/mp4',
  'model/glb': 'model/gltf-binary',
};

/** content-type → 裸 mime(去参数、小写)+ 别名归一。 */
function normalizeMime(ct: string): string {
  const mime = ct.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_ALIASES[mime] ?? mime;
}

/**
 * These response types are frequently omitted or misconfigured by object stores/CDNs.
 * Only this narrow set is eligible for byte-signature recovery in as:'media' mode;
 * specific unsupported types such as application/zip remain rejected without sniffing.
 */
const SNIFFABLE_GENERIC_MEDIA_MIMES = new Set([
  '',
  'text/plain',
  'application/octet-stream',
  'binary/octet-stream',
]);

function shouldSniffMediaMime(mime: string): boolean {
  return SNIFFABLE_GENERIC_MEDIA_MIMES.has(mime);
}

/**
 * 大小写不敏感地删掉 headers 对象里某头名的全部变体。普通对象里
 * `X-Token` 与 `x-token` 是两个键,但 fetch 把对象转 Headers 时按大小写
 * 不敏感**合并**——不把变体删干净,意识自带的伪造值会和主机注入的真值
 * 拼成 `forged, real` 一起出网(凭证头必须主机独占)。
 */
function deleteHeaderVariants(headers: Record<string, string>, name: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
}

/**
 * 大读闸挂钩:读体累计超过 thresholdBytes 时调 tryAcquire 申请继续,拿不到
 * 就地断流返回 gateBusy(闸的占用/释放语义由调用方负责,本函数只问一次)。
 */
interface LargeReadGate {
  thresholdBytes: number;
  tryAcquire: () => boolean;
}

/**
 * 流式读响应体,硬顶 maxBytes:超限即停读并取消流。绝不整体缓冲——
 * 白名单域名可能是意识作者自己的服务器,恶意吐超大响应不能拖垮主进程。
 * 无流的响应(204 / 测试假体)退回一次性读取,同样截断。
 * 传 largeGate 时,累计超过门槛必须先拿到闸才继续读,拿不到返回 gateBusy。
 */
async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }>;
async function readBodyCapped(
  response: Response,
  maxBytes: number,
  largeGate: LargeReadGate,
): Promise<{ bytes: Uint8Array; truncated: boolean } | { gateBusy: true }>;
async function readBodyCapped(
  response: Response,
  maxBytes: number,
  largeGate?: LargeReadGate,
): Promise<{ bytes: Uint8Array; truncated: boolean } | { gateBusy: true }> {
  const body = (response as { body?: ReadableStream<Uint8Array> | null }).body;
  if (!body) {
    const raw = new Uint8Array(await response.arrayBuffer());
    if (largeGate && raw.byteLength > largeGate.thresholdBytes && !largeGate.tryAcquire()) {
      return { gateBusy: true };
    }
    return raw.byteLength > maxBytes
      ? { bytes: raw.slice(0, maxBytes), truncated: true }
      : { bytes: raw, truncated: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  let gateAcquired = largeGate === undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (!gateAcquired && largeGate && total + value.byteLength > largeGate.thresholdBytes) {
        if (!largeGate.tryAcquire()) {
          try {
            await reader.cancel();
          } catch {
            /* 取消失败不影响拒绝结果 */
          }
          return { gateBusy: true };
        }
        gateAcquired = true;
      }
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (truncated) {
      try {
        await reader.cancel();
      } catch {
        /* 取消失败不影响已读结果 */
      }
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}

const MEDIA_SNIFF_PROBE_BYTES = 4096;

type SniffableBodyResult =
  | { kind: 'media'; bytes: Uint8Array; mime: string; overLimit: boolean }
  | { kind: 'text'; bytes: Uint8Array; truncated: boolean }
  | { kind: 'unsupported' }
  | { kind: 'mediaTooLarge' }
  | { kind: 'gateBusy' };

function joinChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function inferredMediaMime(
  bytes: Uint8Array,
  isSupportedMediaMime: (mime: string) => boolean,
  declaredMime: string,
): string | null {
  const sniffed = sniffMediaMime(bytes, declaredMime);
  return sniffed && isSupportedMediaMime(sniffed) ? sniffed : null;
}

function pendingMp3Bytes(bytes: Uint8Array): number | null {
  return additionalMp3BytesNeeded(bytes);
}

/**
 * Read a response whose declared MIME is missing/generic without penalizing real text:
 * inspect at most the first 4 KiB, then commit to either the media cap+global gate,
 * the existing text cap+size-gated gate, or an immediate unsupported-binary reject.
 */
async function readSniffableBody(
  response: Response,
  declaredMime: string,
  tryAcquireGate: () => boolean,
  releaseGate: () => void,
  allowTextFallback: boolean,
  isSupportedMediaMime: (mime: string) => boolean,
  expectedMedia = false,
): Promise<SniffableBodyResult> {
  const body = (response as { body?: ReadableStream<Uint8Array> | null }).body;
  if (!body) {
    // Without a stream there is no bounded way to inspect the body before
    // arrayBuffer(). Hold the gate first so an unknown-length generic response
    // cannot fill memory before being rejected or classified.
    if (!tryAcquireGate()) return { kind: 'gateBusy' };
    let retainGate = false;
    try {
      const raw = new Uint8Array(await response.arrayBuffer());
      const initialProbe = raw.subarray(0, MEDIA_SNIFF_PROBE_BYTES);
      const mp3BytesNeeded = pendingMp3Bytes(initialProbe);
      const probe = raw.subarray(
        0,
        Math.min(raw.byteLength, mp3BytesNeeded ?? MEDIA_SNIFF_PROBE_BYTES),
      );
      const mime = inferredMediaMime(probe, isSupportedMediaMime, declaredMime);
      if (mime) {
        retainGate = true;
        return {
          kind: 'media',
          bytes: raw.subarray(0, GHOST_FETCH_MEDIA_MAX_BYTES),
          mime,
          overLimit: raw.byteLength > GHOST_FETCH_MEDIA_MAX_BYTES,
        };
      }
      if (
        !allowTextFallback ||
        !allowsSniffedTextFallback(probe, raw.byteLength <= MEDIA_SNIFF_PROBE_BYTES)
      ) {
        return { kind: 'unsupported' };
      }
      const textBytes = raw.subarray(0, GHOST_FETCH_RESPONSE_MAX_BYTES);
      if (!isProbablyUtf8Text(textBytes, true)) return { kind: 'unsupported' };
      return {
        kind: 'text',
        bytes: textBytes,
        truncated: raw.byteLength > GHOST_FETCH_RESPONSE_MAX_BYTES,
      };
    } finally {
      if (!retainGate) releaseGate();
    }
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let kind: 'media' | 'text' | null = null;
  let mediaMime = '';
  let gateAcquired = false;
  let truncated = false;
  let retainedTotal = 0;
  let readerDone = false;
  let readerCancelled = false;

  const cancelReader = async (): Promise<void> => {
    if (readerDone || readerCancelled) return;
    readerCancelled = true;
    await reader.cancel().catch(() => {});
  };

  let undecidedCap = MEDIA_SNIFF_PROBE_BYTES;
  let pendingMp3 = false;
  const acquireGate = (): boolean => {
    if (gateAcquired) return true;
    if (!tryAcquireGate()) return false;
    gateAcquired = true;
    return true;
  };
  if (expectedMedia && !acquireGate()) {
    await cancelReader();
    return { kind: 'gateBusy' };
  }
  const classify = async (complete: boolean): Promise<'ok' | 'unsupported' | 'pending' | 'gateBusy'> => {
    const joined = joinChunks(chunks, retainedTotal);
    const sniffed = inferredMediaMime(joined, isSupportedMediaMime, declaredMime);
    if (sniffed) {
      if (!acquireGate()) return 'gateBusy';
      kind = 'media';
      mediaMime = sniffed;
      return 'ok';
    }
    const mp3BytesNeeded = pendingMp3Bytes(joined);
    if (!complete && mp3BytesNeeded !== null && mp3BytesNeeded > retainedTotal) {
      if (mp3BytesNeeded > GHOST_FETCH_MEDIA_MAX_BYTES) return 'unsupported';
      undecidedCap = mp3BytesNeeded;
      pendingMp3 = true;
      return 'pending';
    }
    const textProbe = joined.subarray(0, MEDIA_SNIFF_PROBE_BYTES);
    if (!allowTextFallback || !allowsSniffedTextFallback(textProbe, complete)) return 'unsupported';
    kind = 'text';
    if (total > LARGE_TEXT_GATE_BYTES && !acquireGate()) return 'gateBusy';
    return 'ok';
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        readerDone = true;
        if (kind === null) {
          const classified = await classify(true);
          if (classified !== 'ok') return { kind: classified === 'pending' ? 'unsupported' : classified };
        }
        break;
      }
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      const activeCap = kind === 'media'
        ? GHOST_FETCH_MEDIA_MAX_BYTES
        : kind === 'text'
          ? GHOST_FETCH_RESPONSE_MAX_BYTES
          : undecidedCap;
      if (
        kind === 'text' &&
        !gateAcquired &&
        retainedTotal + value.byteLength > LARGE_TEXT_GATE_BYTES &&
        !acquireGate()
      ) {
        await cancelReader();
        return { kind: 'gateBusy' };
      }
      let keptFromValue = 0;
      if (retainedTotal < activeCap) {
        const keep = Math.min(value.byteLength, activeCap - retainedTotal);
        if (keep > 0) {
          chunks.push(keep === value.byteLength ? value : value.slice(0, keep));
          retainedTotal += keep;
          keptFromValue = keep;
        }
      }

      if (kind === null && retainedTotal >= undecidedCap) {
        const classified = await classify(false);
        if (classified === 'pending') {
          if (!acquireGate()) {
            await cancelReader();
            return { kind: 'gateBusy' };
          }
          // A valid ID3 tag may put the first MPEG frame after the initial
          // probe. Keep reading until that frame can be inspected.
          if (keptFromValue < value.byteLength && retainedTotal < undecidedCap) {
            const keepRemainder = Math.min(value.byteLength - keptFromValue, undecidedCap - retainedTotal);
            if (keepRemainder > 0) {
              chunks.push(value.slice(keptFromValue, keptFromValue + keepRemainder));
              retainedTotal += keepRemainder;
              keptFromValue += keepRemainder;
            }
          }
          if (retainedTotal >= undecidedCap) {
            const resolved = await classify(false);
            if (resolved !== 'ok') {
              await cancelReader();
              return { kind: resolved === 'pending' ? 'unsupported' : resolved };
            }
          }
        } else if (classified !== 'ok') {
          await cancelReader();
          return { kind: classified };
        }
        if (kind !== null) {
          // Keep the remainder of the current chunk now that the final
          // text/media cap is known.
          const decidedCap = kind === 'media' ? GHOST_FETCH_MEDIA_MAX_BYTES : GHOST_FETCH_RESPONSE_MAX_BYTES;
          if (
            kind === 'text' &&
            !gateAcquired &&
            retainedTotal < LARGE_TEXT_GATE_BYTES &&
            retainedTotal + (value.byteLength - keptFromValue) > LARGE_TEXT_GATE_BYTES &&
            !acquireGate()
          ) {
            await cancelReader();
            return { kind: 'gateBusy' };
          }
          if (keptFromValue < value.byteLength && retainedTotal < decidedCap) {
            const keepRemainder = Math.min(value.byteLength - keptFromValue, decidedCap - retainedTotal);
            if (keepRemainder > 0) {
              chunks.push(value.slice(keptFromValue, keptFromValue + keepRemainder));
              retainedTotal += keepRemainder;
            }
          }
        }
      }
      if (kind === 'text' && total > LARGE_TEXT_GATE_BYTES && !acquireGate()) {
        await cancelReader();
        return { kind: 'gateBusy' };
      }
      const maxBytes = kind === 'media'
        ? GHOST_FETCH_MEDIA_MAX_BYTES
        : kind === 'text'
          ? GHOST_FETCH_RESPONSE_MAX_BYTES
          : pendingMp3
            ? undecidedCap
            : GHOST_FETCH_RESPONSE_MAX_BYTES;
      if (kind !== null && total > maxBytes) {
        truncated = true;
        await cancelReader();
        break;
      }
    }
  } finally {
    await cancelReader();
  }

  const maxBytes = kind === 'media' ? GHOST_FETCH_MEDIA_MAX_BYTES : GHOST_FETCH_RESPONSE_MAX_BYTES;
  const joined = joinChunks(chunks, retainedTotal);
  const bytes = joined.subarray(0, maxBytes);
  if (kind === 'media') {
    if (truncated || total > maxBytes) return { kind: 'mediaTooLarge' };
    return { kind: 'media', bytes, mime: mediaMime, overLimit: false };
  }
  if (!isProbablyUtf8Text(bytes, true)) return { kind: 'unsupported' };
  return { kind: 'text', bytes, truncated: truncated || total > maxBytes };
}

/** 解析并硬校验目标 URL:仅 https、默认端口、无内嵌凭证。失败返回人话原因。 */
function parseTargetUrl(raw: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'url 不是合法的绝对地址' };
  }
  if (url.protocol !== 'https:') return { error: '仅支持 https 地址' };
  if (url.port !== '') return { error: '仅支持默认端口(443)' };
  if (url.username || url.password) return { error: 'url 不允许内嵌用户名/密码' };
  return { url };
}

/**
 * 媒体读体的全局串行闸(跨意识,进程内单实例):流式读上限 256MB + 组装
 * 成品的瞬时峰值 ~512MB/单,若放任每意识 4 单并发 × 多意识叠加,恶意白名单
 * 服务器可把主进程内存压穿。v1 保守取全局同时 1 单在读(mivo 类意识本来
 * 就是逐单轮询取件);满了直接结构化拒绝,意识稍后重试即可。
 */
const MEDIA_READ_GLOBAL_LIMIT = 1;

/**
 * 文本读体的"大响应"门槛:累计超过此值的文本响应必须占到上面的全局串行闸
 * 才允许继续读(2026-07-21 文本上限 1MB→50MB 放宽的配套护栏)。绝大多数 API
 * 响应远小于门槛、完全不碰闸;超门槛的大响应跨意识全局同时只读一单,防
 * 每意识 4 单并发 × 多意识叠加把 50MB 级缓冲堆成主进程 OOM。闸忙时结构化
 * 拒绝,意识稍后重试即可。
 */
const LARGE_TEXT_GATE_BYTES = 1024 * 1024;

/** 凭证交换(key 换令牌)请求自身的护栏:主机内部动作,不占意识在途名额。 */
const SECRET_EXCHANGE_TIMEOUT_MS = 15_000;
/** 交换响应体积上限(令牌响应都是小 JSON,超了就是端点行为异常)。 */
const SECRET_EXCHANGE_RESPONSE_MAX_BYTES = 256 * 1024;
/** 交换失败时回给意识的错误里,上游响应体摘录长度上限(诊断用,不泄凭证)。 */
const SECRET_EXCHANGE_ERROR_SNIPPET_CHARS = 200;

/**
 * 按点分路径读 JSON(不支持数组下标;路径不通返回 undefined)。只认自有
 * 属性(hasOwn):__proto__ / constructor 这类原型链段名一律取不到值。
 */
function readDotPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    if (!Object.hasOwn(cur as Record<string, unknown>, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export class GhostNetworkSlot {
  private readonly inflight = new Map<string, number>();
  private mediaReadsInflight = 0;
  /**
   * 交换型凭证的令牌缓存(内存,不落盘——重启重换一次开销可忽略,也免去
   * 磁盘上多一份凭证态文件)。键 `${ghostId}\u0000${secretKey}`;sourceValue
   * 是换令牌时用的原始 key,用户改了 key 立即失配重换。
   */
  private readonly exchangedTokens = new Map<
    string,
    { sourceValue: string; token: string; expiresAt: number }
  >();
  /** 交换单飞:同一凭证并发请求只发一次交换,其余等同一张票。 */
  private readonly exchangeInflight = new Map<string, Promise<string>>();

  constructor(private readonly deps: NetworkSlotDeps) {}

  /**
   * 处理一条 fetch-request(ghost-pipe:send 的 invoke 返回值即本结果)。
   * 永不 reject——一切失败折叠成 { ok:false, message }。
   */
  async handleFetchRequest(ghostId: string, payload: unknown): Promise<GhostPipeFetchResult> {
    const p = payload as {
      url?: unknown;
      method?: unknown;
      headers?: unknown;
      body?: unknown;
      upload?: unknown;
      uploadDir?: unknown;
      timeoutMs?: unknown;
      as?: unknown;
      label?: unknown;
      authAccount?: unknown;
      callId?: unknown;
    };

    // ── 载荷形状校验(不占在途名额)──────────────────────────────────
    if (typeof p?.url !== 'string' || p.url.length === 0 || p.url.length > 2048) {
      return { ok: false, message: 'url 必须是 1–2048 字符的字符串' };
    }
    let method: GhostFetchMethod = 'GET';
    if (p.method !== undefined) {
      if (typeof p.method !== 'string' || !(GHOST_FETCH_METHODS as readonly string[]).includes(p.method)) {
        return { ok: false, message: `method 仅支持 ${GHOST_FETCH_METHODS.join(' / ')}` };
      }
      method = p.method as GhostFetchMethod;
    }
    if (p.callId !== undefined && (typeof p.callId !== 'string' || p.callId.length === 0 || p.callId.length > MAX_CALL_ID_LEN)) {
      return { ok: false, message: 'callId 不合法(1–128 字符的字符串,或不传)' };
    }
    const callId = (p.callId as string | undefined) ?? 'unattributed';
    let body: string | Uint8Array | undefined;
    if (p.body !== undefined) {
      if (typeof p.body !== 'string') return { ok: false, message: 'body 必须是字符串' };
      // DELETE 带 body 是少数 REST API 的既定形态(如 GitHub 移除 assignee /
      // reviewer),与 fetch 规范不冲突,一并放行;GET/HEAD 仍拒。
      if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') {
        return { ok: false, message: 'body 仅在 POST / PUT / PATCH / DELETE 时允许' };
      }
      if (Buffer.byteLength(p.body, 'utf8') > GHOST_FETCH_BODY_MAX_BYTES) {
        return { ok: false, message: `body 过大(上限 ${GHOST_FETCH_BODY_MAX_BYTES} 字节)` };
      }
      body = p.body;
    }
    // ── 响应模式:text(缺省)/ media(字节落总仓)/ file(字节落 save
    // 票据目录)——后两种字节都不进沙箱。
    let asMode: 'text' | 'media' | 'file' = 'text';
    if (p.as !== undefined) {
      if (p.as !== 'text' && p.as !== 'media' && p.as !== 'file') {
        return { ok: false, message: "as 仅支持 'text' / 'media' / 'file'" };
      }
      asMode = p.as;
    }
    // 下行落盘票据(仅 as:'file' 必填):形状校验在此,验票在写盘时。
    let saveTo: { token: string; filename?: string } | undefined;
    if (asMode === 'file') {
      const st = (p as { saveTo?: unknown }).saveTo;
      if (typeof st !== 'object' || st === null || Array.isArray(st)) {
        return { ok: false, message: "as:'file' 需要 saveTo(token 来自 args.save_deposit)" };
      }
      const sto = st as { token?: unknown; filename?: unknown };
      if (typeof sto.token !== 'string' || !GHOST_DIR_DEPOSIT_TOKEN_RE.test(sto.token)) {
        return { ok: false, message: 'saveTo.token 不是合法票据' };
      }
      if (sto.filename !== undefined) {
        if (
          typeof sto.filename !== 'string' ||
          sto.filename.length === 0 ||
          sto.filename.length > GHOST_FETCH_FILE_NAME_MAX_CHARS
        ) {
          return { ok: false, message: `saveTo.filename 必须是 1–${GHOST_FETCH_FILE_NAME_MAX_CHARS} 字符(或不传)` };
        }
      }
      saveTo = { token: sto.token, ...(sto.filename !== undefined ? { filename: sto.filename as string } : {}) };
    } else if ((p as { saveTo?: unknown }).saveTo !== undefined) {
      return { ok: false, message: "saveTo 仅在 as:'file' 时允许" };
    }
    // ── 上传通道(媒体模式的镜像):意识只报指纹,主机验归属读字节代组
    // multipart。字节不进沙箱。
    let upload: { hashes: string[]; field: string; fields: Record<string, string> } | undefined;
    if (p.upload !== undefined) {
      if (typeof p.upload !== 'object' || p.upload === null || Array.isArray(p.upload)) {
        return { ok: false, message: 'upload 必须是对象({ hashes, field?, fields? })' };
      }
      const u = p.upload as { hashes?: unknown; field?: unknown; fields?: unknown };
      if (!Array.isArray(u.hashes) || u.hashes.length === 0 || u.hashes.length > GHOST_FETCH_UPLOAD_MAX_FILES) {
        return { ok: false, message: `upload.hashes 必须是 1–${GHOST_FETCH_UPLOAD_MAX_FILES} 条的数组` };
      }
      const hashes: string[] = [];
      for (const h of u.hashes) {
        if (typeof h !== 'string' || !GHOST_MEDIA_HASH_RE.test(h)) {
          return { ok: false, message: 'upload.hashes 含非法指纹(需 64 位十六进制)' };
        }
        if (hashes.includes(h)) {
          return { ok: false, message: 'upload.hashes 含重复指纹' };
        }
        hashes.push(h);
      }
      let field = 'file';
      if (u.field !== undefined) {
        if (typeof u.field !== 'string' || !GHOST_FETCH_UPLOAD_FIELD_RE.test(u.field)) {
          return { ok: false, message: 'upload.field 必须是 1–64 位字母/数字/_/- 的字段名(或不传,缺省 "file")' };
        }
        field = u.field;
      }
      // 随行普通表单字段(与 uploadDir.fields 同规格;值里的 "{bytes}" 由
      // buildUploadBody 替换成总字节数——飞书 upload_all 的 size 字段用)。
      const uploadFields: Record<string, string> = {};
      if (u.fields !== undefined) {
        if (typeof u.fields !== 'object' || u.fields === null || Array.isArray(u.fields)) {
          return { ok: false, message: 'upload.fields 必须是对象(字段名 → 字符串值)' };
        }
        const entries = Object.entries(u.fields as Record<string, unknown>);
        if (entries.length > GHOST_FETCH_DIR_UPLOAD_MAX_FIELDS) {
          return { ok: false, message: `upload.fields 过多(上限 ${GHOST_FETCH_DIR_UPLOAD_MAX_FIELDS} 条)` };
        }
        for (const [name, value] of entries) {
          if (!GHOST_FETCH_UPLOAD_FIELD_RE.test(name)) {
            return { ok: false, message: `upload.fields 含非法字段名 ${JSON.stringify(name)}` };
          }
          if (
            typeof value !== 'string' ||
            value.length > GHOST_FETCH_DIR_UPLOAD_FIELD_VALUE_MAX_CHARS ||
            /[\r\n]/.test(value)
          ) {
            return { ok: false, message: `upload.fields 字段 ${JSON.stringify(name)} 的值不合法` };
          }
          uploadFields[name] = value;
        }
      }
      if (method !== 'POST') return { ok: false, message: 'upload 仅在 POST 时允许' };
      if (body !== undefined) return { ok: false, message: 'upload 与 body 互斥(multipart 体由主机代组)' };
      if (asMode === 'media') {
        // 上传响应(入库回执 JSON)按文本回;禁掉组合免与取件闸互相占坑。
        return { ok: false, message: "upload 与 as:'media' 不可同时使用(上传响应按文本形态返回)" };
      }
      upload = { hashes, field, fields: uploadFields };
    }
    // ── 目录上传通道(uploadDir):意识只报过户票据,主机凭票读盘代组
    // multipart(文件字段 file-N,filename=相对路径)。路径与字节都不进沙箱。
    let uploadDir:
      | { token: string; fields: Record<string, string>; fileFieldPrefix: string; fileField?: string }
      | undefined;
    if (p.uploadDir !== undefined) {
      if (typeof p.uploadDir !== 'object' || p.uploadDir === null || Array.isArray(p.uploadDir)) {
        return { ok: false, message: 'uploadDir 必须是对象({ token, fields?, fileFieldPrefix?, fileField? })' };
      }
      const d = p.uploadDir as {
        token?: unknown;
        fields?: unknown;
        fileFieldPrefix?: unknown;
        fileField?: unknown;
      };
      if (typeof d.token !== 'string' || !GHOST_DIR_DEPOSIT_TOKEN_RE.test(d.token)) {
        return { ok: false, message: 'uploadDir.token 不合法(需 ghost_call 目录过户注入的 args.dir_deposit.token)' };
      }
      const fields: Record<string, string> = {};
      if (d.fields !== undefined) {
        if (typeof d.fields !== 'object' || d.fields === null || Array.isArray(d.fields)) {
          return { ok: false, message: 'uploadDir.fields 必须是对象(字段名 → 字符串值)' };
        }
        const entries = Object.entries(d.fields as Record<string, unknown>);
        if (entries.length > GHOST_FETCH_DIR_UPLOAD_MAX_FIELDS) {
          return { ok: false, message: `uploadDir.fields 过多(上限 ${GHOST_FETCH_DIR_UPLOAD_MAX_FIELDS} 条)` };
        }
        for (const [name, value] of entries) {
          if (!GHOST_FETCH_UPLOAD_FIELD_RE.test(name)) {
            return { ok: false, message: `uploadDir.fields 含非法字段名 ${JSON.stringify(name)}` };
          }
          if (
            typeof value !== 'string' ||
            value.length > GHOST_FETCH_DIR_UPLOAD_FIELD_VALUE_MAX_CHARS ||
            /[\r\n]/.test(value)
          ) {
            return { ok: false, message: `uploadDir.fields 字段 ${JSON.stringify(name)} 的值不合法` };
          }
          fields[name] = value;
        }
      }
      let fileFieldPrefix = 'file-';
      if (d.fileFieldPrefix !== undefined) {
        if (typeof d.fileFieldPrefix !== 'string' || !GHOST_FETCH_UPLOAD_FIELD_RE.test(d.fileFieldPrefix)) {
          return { ok: false, message: 'uploadDir.fileFieldPrefix 必须是 1–64 位字母/数字/_/- 的前缀(或不传,缺省 "file-")' };
        }
        fileFieldPrefix = d.fileFieldPrefix;
      }
      // 单文件精确字段名(飞书 im 文件上传这类"字段名钉死 file"的服务):
      // 与前缀形态互斥,消费时票据必须恰含 1 个文件(buildDirUploadBody 钳)。
      let fileField: string | undefined;
      if (d.fileField !== undefined) {
        if (typeof d.fileField !== 'string' || !GHOST_FETCH_UPLOAD_FIELD_RE.test(d.fileField)) {
          return { ok: false, message: 'uploadDir.fileField 必须是 1–64 位字母/数字/_/- 的字段名' };
        }
        if (d.fileFieldPrefix !== undefined) {
          return { ok: false, message: 'uploadDir.fileField 与 fileFieldPrefix 互斥(单文件精确字段名 vs 多文件前缀)' };
        }
        fileField = d.fileField;
      }
      if (method !== 'POST') return { ok: false, message: 'uploadDir 仅在 POST 时允许' };
      if (body !== undefined) return { ok: false, message: 'uploadDir 与 body 互斥(multipart 体由主机代组)' };
      if (upload !== undefined) return { ok: false, message: 'uploadDir 与 upload 互斥(一单一种上传形态)' };
      if (asMode === 'media') {
        return { ok: false, message: "uploadDir 与 as:'media' 不可同时使用(上传响应按文本形态返回)" };
      }
      uploadDir = { token: d.token, fields, fileFieldPrefix, ...(fileField ? { fileField } : {}) };
    }
    let label: string | undefined;
    if (p.label !== undefined) {
      if (typeof p.label !== 'string' || p.label.trim().length === 0 || p.label.length > GHOST_FETCH_LABEL_MAX_CHARS) {
        return { ok: false, message: `label 必须是 1–${GHOST_FETCH_LABEL_MAX_CHARS} 字符的字符串(或不传)` };
      }
      label = p.label;
    }

    // OAuth 多账号选择(仅 source:'oauth' 凭证消费;账号是否存在由令牌
    // 管理器判定,这里只做形状校验)。
    let authAccount: string | undefined;
    if (p.authAccount !== undefined) {
      if (typeof p.authAccount !== 'string' || p.authAccount.length === 0 || p.authAccount.length > 64) {
        return { ok: false, message: 'authAccount 必须是 1–64 字符的账号 id(或不传)' };
      }
      authAccount = p.authAccount;
    }

    // 超时分档:媒体/文件下载与上传天然更久,缺省/上限用 MEDIA_* 档;下限共用。
    const isHeavy = asMode === 'media' || asMode === 'file' || upload !== undefined || uploadDir !== undefined;
    const timeoutDefault = isHeavy ? GHOST_FETCH_MEDIA_TIMEOUT_DEFAULT_MS : GHOST_FETCH_TIMEOUT_DEFAULT_MS;
    const timeoutMax = isHeavy ? GHOST_FETCH_MEDIA_TIMEOUT_MAX_MS : GHOST_FETCH_TIMEOUT_MAX_MS;
    let timeoutMs = timeoutDefault;
    if (p.timeoutMs !== undefined) {
      if (typeof p.timeoutMs !== 'number' || !Number.isFinite(p.timeoutMs)) {
        return { ok: false, message: 'timeoutMs 必须是数字' };
      }
      // 越界 clamp 不拒单(作者拍脑袋写 5 分钟不至于整单失败)。
      timeoutMs = Math.min(timeoutMax, Math.max(GHOST_FETCH_TIMEOUT_MIN_MS, p.timeoutMs));
    }

    // ── 意识自带 headers 消毒 ────────────────────────────────────────
    const requestHeaders: Record<string, string> = {};
    if (p.headers !== undefined) {
      if (typeof p.headers !== 'object' || p.headers === null || Array.isArray(p.headers)) {
        return { ok: false, message: 'headers 必须是对象' };
      }
      const entries = Object.entries(p.headers as Record<string, unknown>);
      if (entries.length > MAX_REQUEST_HEADERS) {
        return { ok: false, message: `headers 过多(上限 ${MAX_REQUEST_HEADERS} 条)` };
      }
      for (const [name, value] of entries) {
        if (!HEADER_NAME_RE.test(name)) return { ok: false, message: `非法请求头名 ${JSON.stringify(name)}` };
        if (typeof value !== 'string' || value.length > MAX_HEADER_VALUE_LEN || /[\r\n]/.test(value)) {
          return { ok: false, message: `请求头 ${JSON.stringify(name)} 的值不合法` };
        }
        const lower = name.toLowerCase();
        // 协议关键头/凭证类头静默剥除(文档契约:写了也不生效,不算错误)。
        if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
        if (lower.startsWith('sec-') || lower.startsWith('proxy-')) continue;
        requestHeaders[name] = value;
      }
    }

    // ── URL 硬校验 + 白名单 ─────────────────────────────────────────
    const parsed = parseTargetUrl(p.url);
    if ('error' in parsed) return { ok: false, message: parsed.error };
    const url = parsed.url;

    // ── 资格审:意识在场 + 槽 + 详单 ─────────────────────────────────
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost || !ghost.enabled) {
      return { ok: false, message: '意识不在可用状态' };
    }
    if (!ghost.manifest.slots?.includes('network')) {
      return { ok: false, message: '本意识未声明 network 卡槽,无权出网' };
    }
    const net = ghost.manifest.network;
    // 静态 hosts 与动态连接地址(network.connections,用户在设置页添加、
    // 逐条过主机受信确认)至少有其一,才算"声明过白名单"。
    const connectionDecls = net?.connections ?? [];
    if (!net || (net.hosts.length === 0 && connectionDecls.length === 0)) {
      return { ok: false, message: '本意识未声明域名白名单(身份卡缺 network.hosts),请意识作者更新声明' };
    }
    // 连接地址每单现读快照(用户在设置页增删地址下一单即生效);本单内含
    // 重定向逐跳都用同一份快照,避免跳转中途清单变化产生放行摇摆。
    const connectionHosts =
      connectionDecls.length > 0 ? (this.deps.connections?.hostsFor(ghostId) ?? []) : [];
    // 白名单判定:静态条目走通配语义,连接地址只精确匹配(不吃通配)。
    const hostAllowed = (hostname: string): boolean =>
      net.hosts.some((pattern) => ghostNetworkHostMatches(pattern, hostname)) ||
      connectionHosts.includes(hostname);
    if (!hostAllowed(url.hostname)) {
      const declared = [...net.hosts, ...connectionHosts];
      return {
        ok: false,
        message:
          `目标域名不在本意识的白名单内(声明:${declared.join(' / ') || '尚未添加任何连接地址'})` +
          (connectionDecls.length > 0 ? ';如是自建服务地址,请先在意识设置页添加该连接' : ''),
      };
    }

    // ── 凭证注入:命中本次目标域名的每条声明凭证,保险库现读明文拼头
    // (交换型凭证在此换取/取缓存令牌)。未配置的凭证快速失败(带清晰
    // 指引),不发一个注定 401 的请求。
    const inject0 = await this.injectSecrets(ghostId, net.secrets ?? [], connectionDecls, url.hostname, net.hosts, requestHeaders, authAccount);
    if (inject0.error) return { ok: false, message: inject0.error };
    let usedExchange = inject0.usedExchange;
    const oauthInjected = new Map(inject0.oauthInjected);
    const connectionInjected = new Map(inject0.connectionInjected);
    let initialConnectionInjected = new Map(inject0.connectionInjected);

    // ── 在途并发闸(常量硬顶,防死循环刷单;不是配额)──────────────────
    const inflight = this.inflight.get(ghostId) ?? 0;
    if (inflight >= GHOST_FETCH_INFLIGHT_LIMIT) {
      return { ok: false, message: `同时进行的网络请求已达上限(${GHOST_FETCH_INFLIGHT_LIMIT}),请等在途请求返回` };
    }

    this.inflight.set(ghostId, inflight + 1);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let holdingMediaGate = false;
    try {
      this.deps.log?.info('ghost fetch-request start', {
        ghostId, callId, method, host: url.hostname, path: url.pathname,
        ...(upload ? { uploadFiles: upload.hashes.length } : {}),
        ...(uploadDir ? { dirUpload: true } : {}),
      });

      // ── 上传体组装(全局媒体闸内:multipart 体整体驻内存直到请求结束,
      // 峰值必须封顶,闸也持到 finally 才诚实)──────────────────────────
      if (upload) {
        if (this.mediaReadsInflight >= MEDIA_READ_GLOBAL_LIMIT) {
          return { ok: false, message: '媒体通道正忙(全局同时只处理一单),请稍后重试' };
        }
        this.mediaReadsInflight += 1;
        holdingMediaGate = true;
        const built = await this.buildUploadBody(ghostId, upload);
        if ('error' in built) return { ok: false, message: built.error };
        body = built.body;
        // multipart 的 Content-Type(含 boundary)由主机独占,意识自带的删干净。
        deleteHeaderVariants(requestHeaders, 'Content-Type');
        requestHeaders['Content-Type'] = `multipart/form-data; boundary=${built.boundary}`;
      }

      // ── 目录上传体组装(同一媒体闸:multipart 体整体驻内存,峰值封顶)──
      if (uploadDir) {
        if (this.mediaReadsInflight >= MEDIA_READ_GLOBAL_LIMIT) {
          return { ok: false, message: '媒体通道正忙(全局同时只处理一单),请稍后重试' };
        }
        this.mediaReadsInflight += 1;
        holdingMediaGate = true;
        const built = await this.buildDirUploadBody(ghostId, uploadDir);
        if ('error' in built) return { ok: false, message: built.error };
        body = built.body;
        deleteHeaderVariants(requestHeaders, 'Content-Type');
        requestHeaders['Content-Type'] = `multipart/form-data; boundary=${built.boundary}`;
      }

      // ── 执行(重定向逐跳手动跟,每跳重验白名单 + 重算凭证注入)────────
      // 外层 attempt 循环只为交换型 / oauth / Connection 凭证的 401 兜底:令牌可能被
      // 服务端提前作废,作废本地缓存重换/重刷一次再整链重试;第二次仍
      // 401 就原样回给意识。原始请求方法也参与判定:POST/上传即使因 3xx
      // 降级成 GET,仍不得在 401 后重放最初的副作用请求。
      let response: Response | null = null;
      const originalRequestMethod = method;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          this.invalidateExchangedTokens(ghostId, net.secrets ?? []);
          for (const [secretKey, accountId] of oauthInjected) {
            this.deps.oauthTokens?.invalidateAccessToken(ghostId, secretKey, accountId);
          }
          for (const input of connectionInjected.values()) {
            this.deps.connectionTokens?.invalidate({
              membershipId: input.membershipId,
              audience: input.audience,
            });
          }
          const reInject = await this.injectSecrets(ghostId, net.secrets ?? [], connectionDecls, url.hostname, net.hosts, requestHeaders, authAccount);
          if (reInject.error) return { ok: false, message: reInject.error };
          initialConnectionInjected = new Map(reInject.connectionInjected);
          for (const [k, v] of reInject.oauthInjected) oauthInjected.set(k, v);
          for (const [k, v] of reInject.connectionInjected) connectionInjected.set(k, v);
          this.deps.log?.info('ghost fetch-request 401 → re-auth retry', {
            ghostId, callId, host: url.hostname,
          });
        }
        let currentUrl = url;
        let currentMethod: string = method;
        let currentBody = body;
        let bodyDropped = false;
        let responseConnectionInjected = new Map(initialConnectionInjected);
        let responseMethod = currentMethod;
        response = null;
        let currentConnectionInjected = initialConnectionInjected;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          const hopHeaders = { ...requestHeaders };
          // 降级丢 body 后 Content-Type 也要跟着剥(fetch 规范的 request-body-
          // headers 语义;multipart 的 boundary 头留着会误导服务端)。
          if (bodyDropped) deleteHeaderVariants(hopHeaders, 'Content-Type');
          if (hop > 0) {
            // 换了域名的跳转:上一跳注入的凭证不能跟着走,按新 host 重算
            // (injectSecrets 开头会先把所有声明凭证头的大小写变体删干净)。
            const hopInject = await this.injectSecrets(ghostId, net.secrets ?? [], connectionDecls, currentUrl.hostname, net.hosts, hopHeaders, authAccount);
            if (hopInject.error) return { ok: false, message: hopInject.error };
            currentConnectionInjected = hopInject.connectionInjected;
            usedExchange ||= hopInject.usedExchange;
            for (const [k, v] of hopInject.oauthInjected) oauthInjected.set(k, v);
            for (const [k, v] of hopInject.connectionInjected) connectionInjected.set(k, v);
          }
          if (currentConnectionInjected.size > 0) {
            let current: {
              membershipId: string;
              audience: string;
              allowedHosts: readonly string[];
            } | null = null;
            try {
              current = this.deps.connectionTokens?.resolve(ghostId) ?? null;
            } catch {
              current = null;
            }
            const stillCurrent =
              current !== null
              && [...currentConnectionInjected.values()].every(
                (input) =>
                  input.membershipId === current.membershipId
                  && input.audience === current.audience
                  && input.hostname === currentUrl.hostname
                  && current.allowedHosts.includes(input.hostname),
              );
            if (!stillCurrent) {
              return {
                ok: false,
                message: 'Cindy 企业账号已切换，本次请求已取消，请重试',
              };
            }
          }
          response = await this.deps.fetchImpl(currentUrl.toString(), {
            method: currentMethod,
            headers: hopHeaders,
            ...(currentBody !== undefined ? { body: currentBody } : {}),
            signal: controller.signal,
            redirect: 'manual',
          });
          responseConnectionInjected = currentConnectionInjected;
          responseMethod = currentMethod;
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get('location');
          if (!location) break; // 3xx 无 Location:按普通响应回给意识
          if (hop === MAX_REDIRECTS) {
            return { ok: false, message: `重定向次数过多(上限 ${MAX_REDIRECTS} 跳)` };
          }
          let nextUrl: URL;
          try {
            nextUrl = new URL(location, currentUrl);
          } catch {
            return { ok: false, message: '重定向地址不合法' };
          }
          if (nextUrl.protocol !== 'https:' || nextUrl.port !== '') {
            return { ok: false, message: '重定向到了非 https/非默认端口地址,已阻断' };
          }
          // 静态白名单与用户添加的连接地址一并算放行域(连接地址精确匹配)。
          if (!hostAllowed(nextUrl.hostname)) {
            return { ok: false, message: '重定向超出了本意识的域名白名单,已阻断' };
          }
          // 303(以及 301/302 的 POST)按惯例降级为 GET 并丢 body。
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === 'POST')) {
            currentMethod = 'GET';
            currentBody = undefined;
            bodyDropped = true;
          }
          currentUrl = nextUrl;
        }
        if (!response) break;
        if (
          response.status === 401
          && responseConnectionInjected.size > 0
          && (
            !CONNECTION_RETRYABLE_METHODS.has(responseMethod)
            || !CONNECTION_RETRYABLE_METHODS.has(originalRequestMethod)
          )
        ) {
          for (const input of responseConnectionInjected.values()) {
            this.deps.connectionTokens?.invalidate({
              membershipId: input.membershipId,
              audience: input.audience,
            });
          }
          this.deps.log?.info('ghost fetch-request Connection 401 cache invalidated without replay', {
            ghostId, callId, method: responseMethod, host: url.hostname,
          });
          break;
        }
        if (
          response.status === 401
          && (usedExchange || oauthInjected.size > 0 || responseConnectionInjected.size > 0)
          && attempt === 0
        ) {
          // 丢弃本次响应体(best-effort),换新令牌整链重试一次。
          try {
            await (response as { body?: ReadableStream<Uint8Array> | null }).body?.cancel();
          } catch {
            /* 丢弃失败不影响重试 */
          }
          continue;
        }
        break;
      }
      if (!response) return { ok: false, message: '请求未获得响应' };

      // ── 响应收敛:媒体落仓 / 文本透传;体积护栏;响应头白名单 ──────────
      const contentType = response.headers.get('content-type') ?? '';
      const responseHeaders: Record<string, string> = {};
      for (const name of RESPONSE_HEADER_WHITELIST) {
        const v = response.headers.get(name);
        if (v !== null) responseHeaders[name] = v;
      }

      // 媒体模式:2xx 且总仓受支持的媒体 → 字节直落总仓记到本意识名下,
      // 沙箱只拿取件单。非 2xx / 文本类响应回落下面的文本形态(错误 JSON
      // 意识看得到);2xx 的其它二进制(zip 等)不进仓也不进沙箱,整单拒。
      // 文件模式:2xx 的任意类型字节凭票写进 save 目录(不进沙箱不进总仓);
      // 非 2xx 回落文本形态(错误 JSON 意识看得到)。与媒体取件共用全局
      // 串行闸(体整体驻内存直到写盘,峰值封顶)。
      if (asMode === 'file' && saveTo && response.status >= 200 && response.status < 300) {
        const declaredLength = Number(response.headers.get('content-length') ?? Number.NaN);
        if (Number.isFinite(declaredLength) && declaredLength > GHOST_FETCH_FILE_MAX_BYTES) {
          return { ok: false, message: `文件过大(声明 ${declaredLength} 字节,上限 ${GHOST_FETCH_FILE_MAX_BYTES})` };
        }
        if (this.mediaReadsInflight >= MEDIA_READ_GLOBAL_LIMIT) {
          return { ok: false, message: '媒体通道正忙(全局同时只取一单),请稍后重试' };
        }
        this.mediaReadsInflight += 1;
        try {
          const { bytes: fileBytes, truncated: overLimit } = await readBodyCapped(response, GHOST_FETCH_FILE_MAX_BYTES);
          if (overLimit) {
            return { ok: false, message: `文件过大(上限 ${GHOST_FETCH_FILE_MAX_BYTES} 字节)——截断的文件是坏文件,整单拒` };
          }
          // 文件名:意识建议名 > Content-Disposition > URL 尾段;消毒去重由
          // 票据库负责(主机独占,建议名只是建议)。
          let suggested = saveTo.filename;
          if (!suggested) {
            const disposition = response.headers.get('content-disposition') ?? '';
            const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
            if (m?.[1]) {
              try {
                suggested = decodeURIComponent(m[1].trim());
              } catch {
                suggested = m[1].trim();
              }
            }
          }
          if (!suggested) suggested = url.pathname.split('/').filter(Boolean).pop() ?? 'download';
          const written = await this.deps.writeSaveDeposit(ghostId, saveTo.token, suggested, fileBytes);
          if (!written) {
            return { ok: false, message: '落盘票据无效(过期 / 已用完 / 超预算)——请让主 agent 重新过户 save_dir' };
          }
          this.deps.log?.info('ghost fetch-request done (file)', {
            ghostId, callId, method, host: url.hostname, status: response.status,
            bytes: fileBytes.byteLength, fileName: written.fileName,
          });
          return {
            ok: true,
            status: response.status,
            headers: responseHeaders,
            file: {
              file_name: written.fileName,
              bytes: fileBytes.byteLength,
              mime_type: normalizeMime(contentType) || 'application/octet-stream',
            },
          };
        } finally {
          this.mediaReadsInflight -= 1;
        }
      }

      if (asMode === 'media' && response.status >= 200 && response.status < 300) {
        const declaredMime = normalizeMime(contentType);
        const sniffGeneric = shouldSniffMediaMime(declaredMime);
        if (this.deps.isSupportedMediaMime(declaredMime) || sniffGeneric) {
          // 诚实服务器的超大文件在读之前就拒掉,不白读 256MB;撒谎/缺头的
          // 由下面的流式硬顶兜底。
          const declaredLength = Number(response.headers.get('content-length') ?? Number.NaN);
          if (
            Number.isFinite(declaredLength) &&
            declaredLength > GHOST_FETCH_MEDIA_MAX_BYTES
          ) {
            return { ok: false, message: `媒体过大(声明 ${declaredLength} 字节,上限 ${GHOST_FETCH_MEDIA_MAX_BYTES})` };
          }
          const sniffed = await readSniffableBody(
            response,
            declaredMime,
            () => {
              if (holdingMediaGate) return true;
              if (this.mediaReadsInflight >= MEDIA_READ_GLOBAL_LIMIT) return false;
              this.mediaReadsInflight += 1;
              holdingMediaGate = true;
              return true;
            },
            () => {
              if (!holdingMediaGate) return;
              this.mediaReadsInflight -= 1;
              holdingMediaGate = false;
            },
            sniffGeneric,
            this.deps.isSupportedMediaMime,
            !sniffGeneric,
          );
          if (sniffed.kind === 'gateBusy') {
            return { ok: false, message: '媒体/大响应通道正忙(全局同时只处理一单),请稍后重试' };
          }
          if (sniffed.kind === 'unsupported') {
            return { ok: false, message: `该媒体类型不受总仓支持(${declaredMime || 'unknown'}),无法取回` };
          }
          if (sniffed.kind === 'mediaTooLarge') {
            return { ok: false, message: `媒体过大(上限 ${GHOST_FETCH_MEDIA_MAX_BYTES} 字节)——截断的媒体是坏文件,整单拒` };
          }
          if (sniffed.kind === 'text') {
            const bodyText = new TextDecoder('utf-8', { fatal: false }).decode(sniffed.bytes);
            this.deps.log?.info('ghost fetch-request done', {
              ghostId, callId, method, host: url.hostname, status: response.status,
              bytes: sniffed.bytes.byteLength, mediaSniffMiss: true,
              ...(sniffed.truncated ? { truncated: true } : {}),
            });
            return {
              ok: true,
              status: response.status,
              headers: responseHeaders,
              body: bodyText,
              ...(sniffed.truncated ? { truncated: true } : {}),
            };
          }
          if (sniffed.overLimit) {
            return { ok: false, message: `媒体过大(上限 ${GHOST_FETCH_MEDIA_MAX_BYTES} 字节)——截断的媒体是坏文件,整单拒` };
          }
          const saved = await this.deps.saveGhostMedia({
            ghostId,
            buffer: sniffed.bytes,
            // Always persist the MIME recovered from bytes, never the external
            // declaration. This also corrects a valid but misdeclared response.
            mimeType: sniffed.mime,
            ...(label !== undefined ? { label } : {}),
            ...(callId !== 'unattributed' ? { callId } : {}),
          });
          this.deps.log?.info('ghost fetch-request done (media)', {
            ghostId, callId, method, host: url.hostname, status: response.status,
            bytes: sniffed.bytes.byteLength, hash: saved.hash, mime: sniffed.mime,
            ...(sniffGeneric ? { recoveredBySniff: true } : {}),
            declaredMime,
          });
          return {
            ok: true,
            status: response.status,
            headers: responseHeaders,
            media: { ...saved, bytes: sniffed.bytes.byteLength },
          };
        }
        if (!isTextualContentType(contentType)) {
          return { ok: false, message: `该媒体类型不受总仓支持(${declaredMime || 'unknown'}),无法取回` };
        }
        // 2xx 但内容是文本(如返回 JSON 的"生成中"状态):回落文本形态。
      }

      if (!isTextualContentType(contentType)) {
        return {
          ok: false,
          message: `响应不是文本类型(${normalizeMime(contentType)})——媒体内容请用 as:'media' 落总仓取件`,
        };
      }
      // 大文本与媒体/上传共用全局串行闸:超 1MB 才申请,占到后持到 finally
      // 统一释放(解码 + 回传期间峰值仍在闸内诚实记账);上传单已持闸直接复用。
      const textRead = await readBodyCapped(response, GHOST_FETCH_RESPONSE_MAX_BYTES, {
        thresholdBytes: LARGE_TEXT_GATE_BYTES,
        tryAcquire: () => {
          if (holdingMediaGate) return true;
          if (this.mediaReadsInflight >= MEDIA_READ_GLOBAL_LIMIT) return false;
          this.mediaReadsInflight += 1;
          holdingMediaGate = true;
          return true;
        },
      });
      if ('gateBusy' in textRead) {
        return { ok: false, message: '文本响应超过 1MB 且大响应通道正忙(全局同时只读一单),请稍后重试' };
      }
      const { bytes: rawBytes, truncated } = textRead;
      const bodyText = new TextDecoder('utf-8', { fatal: false }).decode(rawBytes);
      this.deps.log?.info('ghost fetch-request done', {
        ghostId, callId, method, host: url.hostname, status: response.status,
        bytes: rawBytes.byteLength, ...(truncated ? { truncated } : {}),
      });
      return {
        ok: true,
        status: response.status,
        headers: responseHeaders,
        body: bodyText,
        ...(truncated ? { truncated } : {}),
      };
    } catch (err) {
      const aborted = controller.signal.aborted;
      const message = aborted
        ? `请求超时(${timeoutMs}ms)`
        : err instanceof Error ? err.message : String(err);
      // 错误消息可能带 URL(含 query),日志只记 host,消息本身回给沙箱前不动
      // (意识本来就知道自己请求了什么,不构成泄露)。
      this.deps.log?.warn('ghost fetch-request failed', {
        ghostId, callId, method, host: url.hostname, aborted, error: message,
      });
      return { ok: false, message: `请求失败:${message}` };
    } finally {
      clearTimeout(timer);
      if (holdingMediaGate) this.mediaReadsInflight -= 1;
      const left = (this.inflight.get(ghostId) ?? 1) - 1;
      if (left <= 0) this.inflight.delete(ghostId);
      else this.inflight.set(ghostId, left);
    }
  }

  /**
   * 把命中 hostname 的声明凭证注入 headers(原地写)。有凭证声明命中但
   * 保险库没值 → 返回人话错误(快速失败,指引用户去设置页填);全部注入
   * 成功 error 为 null。usedExchange = 本次是否注入过交换型凭证(调用方
   * 据此决定 401 是否触发重换重试)。凭证值只进 headers,不进日志、不进
   * 返回值。
   */
  private async injectSecrets(
    ghostId: string,
    secrets: readonly GhostSecretDecl[],
    connectionDecls: readonly GhostConnectionDecl[],
    hostname: string,
    allHosts: readonly string[],
    headers: Record<string, string>,
    authAccount?: string,
  ): Promise<{
    error: string | null;
    usedExchange: boolean;
    /** 本次注入过的 oauth 凭证(secretKey → 实际用的账号 id;401 作废用)。 */
    oauthInjected: Map<string, string>;
    /** 本次注入过的 Connection 凭证(secretKey → 缓存键;401 作废用)。 */
    connectionInjected: Map<
      string,
      { membershipId: string; audience: string; hostname: string }
    >;
  }> {
    // 声明的凭证头一律主机独占:先把意识自带(或上一跳残留)的任何大小写
    // 变体删干净,再按本 host 注入——不管这条凭证这一跳注不注入都要删,
    // 否则伪造值/上一跳注入值会经 Headers 大小写不敏感合并混出网。
    // 连接声明的注入头同一纪律(跳到另一个连接地址时注入那个地址自己的
    // token,上一跳的绝不跟着走)。
    for (const secret of secrets) {
      deleteHeaderVariants(headers, secret.inject.header);
    }
    for (const decl of connectionDecls) {
      deleteHeaderVariants(headers, decl.inject.header);
    }
    let usedExchange = false;
    const oauthInjected = new Map<string, string>();
    const connectionInjected = new Map<
      string,
      { membershipId: string; audience: string; hostname: string }
    >();
    for (const secret of secrets) {
      const scope = secret.inject.hosts ?? allHosts;
      if (!scope.some((pattern) => ghostNetworkHostMatches(pattern, hostname))) continue;
      const resolved = await this.resolveSecretValue(ghostId, secret, hostname, authAccount);
      if ('error' in resolved) {
        return { error: resolved.error, usedExchange, oauthInjected, connectionInjected };
      }
      if (secret.exchange !== undefined) usedExchange = true;
      if (resolved.oauthAccountId !== undefined) oauthInjected.set(secret.key, resolved.oauthAccountId);
      if (resolved.connectionTokenKey !== undefined) {
        connectionInjected.set(secret.key, resolved.connectionTokenKey);
      }
      // 函数式替换同 performExchange:凭证/令牌含 $ 不得触发特殊序列解释。
      headers[secret.inject.header] = secret.inject.format.replace('{value}', () => resolved.value);
    }
    // 多连接凭证(network.connections):hostname 精确命中某条用户添加的
    // 连接地址时,注入那条连接自己的 token(按声明的 header/format)。命中
    // 地址但 token 读不到 = 半身位(理论上不该出现:入库先 token 后清单),
    // 与 secrets 同款快速失败,不发一个注定 401 的请求。
    if (connectionDecls.length > 0 && this.deps.connections) {
      const connHosts = this.deps.connections.hostsFor(ghostId);
      if (connHosts.includes(hostname)) {
        const tok = this.deps.connections.tokenFor(ghostId, hostname);
        if (!tok) {
          return {
            error: `连接地址 ${hostname} 的凭证读取失败——请到主界面侧边栏「插件」的本插件详情页重新添加该连接`,
            usedExchange,
            oauthInjected,
            connectionInjected,
          };
        }
        deleteHeaderVariants(headers, tok.header);
        headers[tok.header] = tok.format.replace('{value}', () => tok.value);
      }
    }
    return { error: null, usedExchange, oauthInjected, connectionInjected };
  }

  /**
   * 解析一条凭证的注入值:无 exchange 声明 = 保险库原始值(source:'login-email'
   * 则是登录邮箱);有 exchange = 换来的令牌(缓存命中直接用;用户改了 key /
   * 换了登录账号或缓存过期则重换,单飞去重——交换缓存按 sourceValue 失配重换,
   * 登录邮箱变更天然生效)。
   */
  private async resolveSecretValue(
    ghostId: string,
    secret: GhostSecretDecl,
    hostname: string,
    authAccount?: string,
  ): Promise<
    | {
        value: string;
        oauthAccountId?: string;
        connectionTokenKey?: { membershipId: string; audience: string; hostname: string };
      }
    | { error: string }
  > {
    if (secret.source === 'oidc-token') {
      const manager = this.deps.connectionTokens;
      if (!manager) {
        return { error: 'Cindy 企业身份通道未就绪，请升级应用或反馈' };
      }
      let resolution: {
        membershipId: string;
        audience: string;
        allowedHosts: readonly string[];
      } | null;
      try {
        resolution = manager.resolve(ghostId);
      } catch {
        this.deps.log?.warn('ghost Connection audience resolver unavailable', { ghostId });
        return { error: 'Cindy 企业身份暂时不可用，请稍后重试或反馈' };
      }
      if (!resolution) {
        this.deps.log?.warn('ghost Connection audience resolution returned no result', {
          ghostId,
          host: hostname,
        });
        return { error: '当前 Cindy 企业身份不可用于此插件，请确认已登录正确的企业账号' };
      }
      if (!resolution.allowedHosts.includes(hostname)) {
        this.deps.log?.warn('ghost Connection audience host rejected', {
          ghostId,
          host: hostname,
        });
        return { error: '当前 Cindy 企业身份不可用于此服务地址' };
      }
      const tokenInput = {
        membershipId: resolution.membershipId,
        audience: resolution.audience,
      };
      try {
        const token = await manager.getToken(tokenInput);
        return {
          value: token,
          connectionTokenKey: { ...tokenInput, hostname },
        };
      } catch (error) {
        this.deps.log?.warn('ghost Connection token issuance failed', {
          ghostId,
          host: hostname,
          error: error instanceof Error ? error.message : String(error),
        });
        return { error: '暂时无法获取 Cindy 企业身份，请检查网络后重试' };
      }
    }
    // source:'oauth':令牌管理器现取新鲜 access token(缓存 + 单飞刷新在
    // 管理器内);错误折叠成人话(不含任何令牌字节),可自愈的引导去设置页。
    if (secret.source === 'oauth') {
      if (!secret.oauth) {
        return { error: `凭证「${secret.label}」声明损坏(缺 oauth 详单),请意识作者修复` };
      }
      const mgr = this.deps.oauthTokens;
      if (!mgr) {
        return { error: 'OAuth 凭证通道未就绪(主机未接线),请升级应用或反馈' };
      }
      const result = await mgr.getFreshAccessToken(ghostId, secret.key, secret.oauth, authAccount);
      if (!result.ok) {
        switch (result.error) {
          case 'NO_CLIENT_CONFIG':
            return { error: `凭证「${secret.label}」尚未配置——请到主界面侧边栏「插件」的本插件详情页填入 OAuth 客户端凭证并连接账号` };
          case 'NO_ACCOUNT':
            return { error: `凭证「${secret.label}」尚未连接账号(或指定的账号不存在)——请到主界面侧边栏「插件」的本插件详情页点「连接账号」完成授权` };
          case 'AUTH_EXPIRED':
            return { error: `凭证「${secret.label}」的账号授权已失效——请到主界面侧边栏「插件」的本插件详情页重新连接该账号` };
          case 'NETWORK':
            return { error: `凭证「${secret.label}」刷新令牌时网络失败,请稍后重试` };
          default:
            return { error: `凭证「${secret.label}」刷新令牌失败${result.detail ? `:${result.detail}` : ''},请稍后重试` };
        }
      }
      return { value: result.accessToken, oauthAccountId: result.accountId };
    }
    let raw: string;
    if (secret.source === 'login-email') {
      const resolved = this.resolveLoginEmail(secret);
      if ('error' in resolved) return resolved;
      raw = resolved.value;
    } else {
      const stored = this.deps.readSecret(ghostId, secret.key);
      if (stored === null || stored.length === 0) {
        return { error: `凭证「${secret.label}」尚未配置——请到主界面侧边栏「插件」的本插件详情页填入后再试` };
      }
      raw = stored;
    }
    if (secret.exchange === undefined) return { value: raw };
    const cacheKey = `${ghostId}\u0000${secret.key}`;
    const cached = this.exchangedTokens.get(cacheKey);
    if (cached && cached.sourceValue === raw && Date.now() < cached.expiresAt) {
      return { value: cached.token };
    }
    let inflightExchange = this.exchangeInflight.get(cacheKey);
    if (!inflightExchange) {
      inflightExchange = this.performExchange(ghostId, secret, raw, cacheKey).finally(() => {
        this.exchangeInflight.delete(cacheKey);
      });
      this.exchangeInflight.set(cacheKey, inflightExchange);
    }
    try {
      return { value: await inflightExchange };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 执行一次 key→令牌交换(照意识清单声明代办)。成功写缓存并返回令牌;
   * 失败 throw 人话错误(不含原始 key / 令牌字节)。交换请求不占意识在途
   * 名额(主机内部动作,自带 15s 超时),重定向一律阻断(令牌端点没有
   * 跳转的正当理由,跟跳只会把 key 带去别处)。
   */
  private async performExchange(
    ghostId: string,
    secret: GhostSecretDecl,
    raw: string,
    cacheKey: string,
  ): Promise<string> {
    const ex = secret.exchange;
    if (ex === undefined) throw new Error('内部错误:无 exchange 声明');
    const contentType = ex.contentType ?? 'application/json';
    // 占位替换按 contentType 确定性转义:json 走 JSON 字符串转义(key 含
    // 引号/反斜杠不破坏模板结构),form 走 percent 编码。
    const escaped =
      contentType === 'application/json'
        ? JSON.stringify(raw).slice(1, -1)
        : encodeURIComponent(raw);
    // 函数式替换:字符串形态的替换串会解释 $& / $` / $' 等特殊序列
    // (JSON.stringify 不转义 $),含 $ 的 key 会拼出坏 JSON 或错误凭证。
    const exchangeBody = ex.bodyFormat.replace('{value}', () => escaped);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SECRET_EXCHANGE_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await this.deps.fetchImpl(ex.url, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: exchangeBody,
        signal: controller.signal,
        redirect: 'manual',
      });
      if (response.status >= 300 && response.status < 400) {
        throw new Error(`凭证「${secret.label}」换取令牌失败:交换端点返回重定向,已阻断`);
      }
      if (response.status < 200 || response.status >= 300) {
        const { bytes } = await readBodyCapped(response, SECRET_EXCHANGE_RESPONSE_MAX_BYTES);
        const snippet = new TextDecoder('utf-8', { fatal: false })
          .decode(bytes)
          .slice(0, SECRET_EXCHANGE_ERROR_SNIPPET_CHARS);
        throw new Error(
          `凭证「${secret.label}」换取令牌失败:HTTP ${response.status}${snippet ? ` - ${snippet}` : ''}`,
        );
      }
      const { bytes } = await readBodyCapped(response, SECRET_EXCHANGE_RESPONSE_MAX_BYTES);
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
      } catch {
        throw new Error(`凭证「${secret.label}」换取令牌失败:交换响应不是合法 JSON`);
      }
      const token = readDotPath(parsedBody, ex.tokenPath);
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error(
          `凭证「${secret.label}」换取令牌失败:响应里没找到令牌(tokenPath: ${ex.tokenPath})`,
        );
      }
      const ttlMs = (ex.ttlSeconds ?? GHOST_SECRET_EXCHANGE_TTL_DEFAULT_S) * 1000;
      this.exchangedTokens.set(cacheKey, {
        sourceValue: raw,
        token,
        expiresAt: Date.now() + ttlMs,
      });
      this.deps.log?.info('ghost secret exchange done', {
        ghostId, secretKey: secret.key, host: new URL(ex.url).hostname,
      });
      return token;
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`凭证「${secret.label}」换取令牌超时(${SECRET_EXCHANGE_TIMEOUT_MS}ms)`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * source:'login-email' 凭证的值解析:现取登录态邮箱,fail-closed——未登录 /
   * 缺 email / 形态不像邮箱都拒(带重登指引),绝不注入一个坏值发出去。
   * 形态校验只做极简兜底(与服务端鉴权解耦),真正校验在服务端。
   */
  private resolveLoginEmail(secret: GhostSecretDecl): { value: string } | { error: string } {
    const email = this.deps.getLoginEmail();
    if (email === null || email.trim().length === 0) {
      return {
        error:
          `凭证「${secret.label}」取自登录邮箱,但当前登录态没有邮箱——` +
          '请到 设置 → 通用 退出登录后重新登录(授权页勾选邮箱权限)再试',
      };
    }
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      // 错误消息直达沙箱内第三方意识代码:邮箱原文绝不能出现在这里
      // (与 FORGE_GUIDE §4.7"邮箱不进沙箱"同一不变量),诊断走主机日志。
      this.deps.log?.warn('ghost login-email secret rejected: malformed email in auth state', {
        secretKey: secret.key,
      });
      return { error: `凭证「${secret.label}」取自登录邮箱,但登录态里的邮箱形态不合法——请退出登录后重新登录再试` };
    }
    return { value: trimmed };
  }

  /** 作废某意识全部交换型凭证的令牌缓存(401 重试前调用)。 */
  private invalidateExchangedTokens(ghostId: string, secrets: readonly GhostSecretDecl[]): void {
    for (const secret of secrets) {
      if (secret.exchange === undefined) continue;
      this.exchangedTokens.delete(`${ghostId}\u0000${secret.key}`);
    }
  }

  /**
   * 组装上传通道的 multipart/form-data 体:逐指纹验归属读字节(readGhostMedia
   * 越权与不存在统一 null,错误话术也不区分——不给探测空间),按 RFC 2046
   * 手工拼接(确定性,规则 9;不依赖运行时 FormData 的实现差异)。
   * filename 用指纹前 16 位 + 总仓后缀,不含任何用户可控文本。
   */
  private async buildUploadBody(
    ghostId: string,
    upload: { hashes: string[]; field: string; fields?: Record<string, string> },
  ): Promise<{ body: Uint8Array; boundary: string } | { error: string }> {
    const boundary = `----cindy-ghost-${randomUUID()}`;
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const fileParts: Uint8Array[] = [];
    for (const hash of upload.hashes) {
      const media = await this.deps.readGhostMedia(ghostId, hash);
      if (!media) {
        return { error: `媒体不存在或不属于本意识(${hash.slice(0, 8)}…)——只能上传自己名下/用户过户的总仓媒体` };
      }
      if (media.buffer.byteLength > GHOST_FETCH_UPLOAD_MAX_BYTES_PER_FILE) {
        return { error: `上传文件过大(${media.buffer.byteLength} 字节,单文件上限 ${GHOST_FETCH_UPLOAD_MAX_BYTES_PER_FILE})` };
      }
      total += media.buffer.byteLength;
      if (total > GHOST_FETCH_UPLOAD_MAX_TOTAL_BYTES) {
        return { error: `上传总量超上限(${GHOST_FETCH_UPLOAD_MAX_TOTAL_BYTES} 字节)` };
      }
      fileParts.push(
        encoder.encode(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${upload.field}"; filename="${hash.slice(0, 16)}${media.ext}"\r\n` +
          `Content-Type: ${media.mimeType}\r\n\r\n`,
        ),
        media.buffer,
        encoder.encode('\r\n'),
      );
    }
    // 普通字段在文件段之前;值里的 "{bytes}" 替换成全部文件的总字节数
    // (飞书 upload_all 这类要求 size 字段的服务;字段值已在解析层消毒)。
    for (const [name, value] of Object.entries(upload.fields ?? {})) {
      const resolved = value.replace('{bytes}', () => String(total));
      chunks.push(
        encoder.encode(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${resolved}\r\n`,
        ),
      );
    }
    chunks.push(...fileParts);
    chunks.push(encoder.encode(`--${boundary}--\r\n`));
    const body = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { body, boundary };
  }

  /**
   * 组装目录上传的 multipart/form-data 体:凭一次性过户票据取货(票据由
   * ghost_call 的 dir 过户发放,ghostId 绑定 + 单次消费 + TTL),先拼普通
   * 表单字段,再逐文件读盘拼 `<prefix>N` 文件段(filename = 相对路径,
   * 服务端按它还原目录结构;Content-Type 统一 octet-stream,与 MCP 版
   * FormData+Blob 行为一致)。读盘期间总量再钳一次(过户后文件可能被改)。
   */
  private async buildDirUploadBody(
    ghostId: string,
    uploadDir: {
      token: string;
      fields: Record<string, string>;
      fileFieldPrefix: string;
      fileField?: string;
    },
  ): Promise<{ body: Uint8Array; boundary: string } | { error: string }> {
    const deposit = this.deps.takeDirDeposit(ghostId, uploadDir.token);
    if (!deposit) {
      return { error: '目录过户票据无效(不存在 / 已使用 / 已过期)——请让主 agent 重新经 ghost_call 的 dir 参数过户目录' };
    }
    // 单文件精确字段名形态:票据必须恰含 1 个文件(过户的是单文件或单文件
    // 目录),否则整单拒——多文件没有"钉死字段名"的正当语义。
    if (uploadDir.fileField !== undefined && deposit.files.length !== 1) {
      return { error: `uploadDir.fileField 要求票据恰含 1 个文件(实际 ${deposit.files.length} 个)——请让主 agent 用 ghost_call 的 dir 参数过户单个文件` };
    }
    const boundary = `----cindy-ghost-${randomUUID()}`;
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    // 普通字段在文件段之前;值里的 "{bytes}" 替换成全部文件的总字节数
    // (票据元数据的 size 之和;与 upload 通道同一约定)。
    const declaredTotal = deposit.files.reduce((n, f) => n + f.size, 0);
    for (const [name, value] of Object.entries(uploadDir.fields)) {
      const resolved = value.replace('{bytes}', () => String(declaredTotal));
      chunks.push(
        encoder.encode(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${resolved}\r\n`,
        ),
      );
    }
    let total = 0;
    for (let i = 0; i < deposit.files.length; i++) {
      const file = deposit.files[i];
      let bytes: Uint8Array;
      try {
        bytes = await file.read();
      } catch (err) {
        // fs 错误的 message 自带绝对路径,绝不能回沙箱("路径不进沙箱"
        // 不变量);诊断走主机日志,沙箱只见相对路径 + 分类原因。
        this.deps.log?.warn('ghost dir-upload read failed', {
          ghostId, relPath: file.relPath,
          error: err instanceof Error ? err.message : String(err),
        });
        return { error: `读取文件失败(${file.relPath}):文件可能已被移动、删除或占用——请让主 agent 重新过户目录后重试` };
      }
      // 过户后文件可能被构建进程改写:单文件与总量都按上限重钳,防瞬时
      // 内存峰值脱离限额保护。
      if (bytes.byteLength > GHOST_FETCH_DIR_UPLOAD_MAX_BYTES_PER_FILE) {
        return { error: `单文件超过限额(${file.relPath},上限 ${GHOST_FETCH_DIR_UPLOAD_MAX_BYTES_PER_FILE} 字节)` };
      }
      total += bytes.byteLength;
      if (total > GHOST_FETCH_DIR_UPLOAD_MAX_TOTAL_BYTES) {
        return { error: `目录总体积超过限额(${GHOST_FETCH_DIR_UPLOAD_MAX_TOTAL_BYTES} 字节)` };
      }
      // filename 的引号与换行按 RFC 2046 语境消毒(relPath 来自文件系统,
      // 极端文件名不许破坏 multipart 结构)。单文件精确字段名形态下
      // filename 只取文件名(不含目录段——目标服务按普通文件收,不还原结构)。
      const rawName = uploadDir.fileField !== undefined
        ? (file.relPath.split('/').pop() ?? file.relPath)
        : file.relPath;
      const safeName = rawName.replace(/"/g, '%22').replace(/[\r\n]/g, '');
      const partField = uploadDir.fileField ?? `${uploadDir.fileFieldPrefix}${i}`;
      chunks.push(
        encoder.encode(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${partField}"; filename="${safeName}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
        ),
        bytes,
        encoder.encode('\r\n'),
      );
    }
    chunks.push(encoder.encode(`--${boundary}--\r\n`));
    const body = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { body, boundary };
  }
}
