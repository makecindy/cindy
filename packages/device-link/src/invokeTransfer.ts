import type { InvokePayload, InvokeResultPayload } from './protocol.js';
import { byteLength } from './transport.js';
import {
  applyInvokeResultPatchValue,
  computeInvokeResultPatch,
  sampleInvokeResultText,
  isInvokeDeltaChannel,
  type InvokeDeltaBases,
  type InvokeResultDelta,
  type InvokeResultPatch,
} from './invokeDelta.js';

/**
 * invoke 结果的传输编码（弱网减流量），与业务 channel 无关：
 *
 * - 控制端在 invoke payload 上可选携带 `transfer`：能解 gzip 时带 `gzip: 1`；
 *   本机已持有同一 channel + args 的上一份结果时带它的内容标签 `ifNoneMatch`。
 * - 被控端照常执行 handler，只在发出结果时改写：大结果附带内容标签；与
 *   `ifNoneMatch` 相同则只回 `notModified`；否则在控制端声明可解时 gzip。
 *
 * handler 每次都真实执行，`notModified` 只省略字节相同的结果，因此对任何
 * channel（包括有副作用的）语义不变。旧被控端忽略 `transfer` 回普通结果；
 * 旧控制端从不携带 `transfer`，被控端也就不会对它编码。
 */

/** 控制端 → 被控端，逐请求可选。 */
export interface InvokeTransferOptions {
  /** 控制端能解开 `gzipBase64` 结果。 */
  gzip?: 1;
  /** 控制端已持有的同 channel + args 结果的内容标签。 */
  ifNoneMatch?: string;
  /**
   * 控制端能按 `ifNoneMatch` 对应的缓存全文套用增量（invokeDelta.ts）。只对
   * `INVOKE_DELTA_CHANNELS` 声明；旧被控端忽略。
   */
  delta?: 1;
}

/** 被控端记下的入站声明；`requestKey` 只在声明了 delta 的列表请求上存在。 */
export interface InboundInvokeTransfer extends InvokeTransferOptions {
  requestKey?: string;
}

/**
 * 没有 SHA-256 的控制端（Mobile）只能核对长度与抽样摘要。连续这么多次未经完整校验的
 * 增量之后，下一次读取不带基准拿一次全文，万一有未被发现的还原错误也不会一直沿用。
 */
const MAX_UNVERIFIED_DELTAS = 8;

/** 被控端 → 控制端，只出现在 ok 结果上；有 `notModified` / `gzipBase64` 时 result 为 null。 */
export interface InvokeResultTransfer {
  /** 完整结果 JSON 的内容标签；控制端据此缓存。 */
  tag?: string;
  notModified?: true;
  /** gzip(UTF-8 JSON.stringify(result)) 的 base64。 */
  gzipBase64?: string;
  /** 相对控制端缓存基准的增量；有它时 result 为 null。 */
  delta?: InvokeResultDelta;
}

/** host 注入：device-link 包保持零依赖，压缩与摘要由各端平台实现提供。 */
export interface DeviceLinkTransferCodec {
  /**
   * 控制端：解开被控端的 gzip 结果。解出的字符串超过 maxChars 时必须在继续
   * 分配前抛错——压缩包只受传输大小限制，高压缩比结果可以展开成数百 MB。
   */
  gunzipBase64?(base64: string, maxChars: number): string;
  /**
   * 控制端可选：同 gunzipBase64，但允许离开调用线程解压。提供后 gzip 结果优先走它，
   * 须遵守同样的 maxChars 约束；声明能力仍只看 gunzipBase64，wire 行为不变。
   */
  gunzipBase64Async?(base64: string, maxChars: number): Promise<string>;
  /** 被控端：压缩结果。 */
  gzipBase64?(text: string): string;
  /** 被控端：结果内容标签，须抗碰撞（如 SHA-256）。 */
  contentTag?(text: string): string;
  /**
   * 被控端可选（推送编码，见 pushTransfer.ts）：raw DEFLATE，以 ASCII 字符串 dictionary
   * 作预置字典，返回 base64。
   */
  deflateRawBase64?(text: string, dictionary: string): string;
  /**
   * 控制端可选：deflateRawBase64 的同步逆运算，同样受 maxChars 约束。推送须按序交给
   * 业务，所以只有同步版本；提供它才会在建链时声明 push-deflate 能力。
   */
  inflateRawBase64?(base64: string, maxChars: number, dictionary: string): string;
}

/**
 * 内容标签（及 notModified 短路）的门槛：更小的结果不带标签、不进控制端缓存。缓存只有 32 条，
 * 让大量小结果占位会把真正值得短路的大页挤出去，所以这个门槛不随压缩门槛一起下调。
 */
export const INVOKE_TRANSFER_MIN_CHARS = 4 * 1024;
/**
 * gzip 的门槛，按 UTF-8 字节计（与比较收益、传输层计帧的口径一致）。原来与标签共用 4096 字符：
 * 正文复用、增量读取把很多结果缩到 1–4 KB，于是原样发送，还在可靠层里被二次转义（基准
 * reconnect 阶段重连后的预读页比首读还大）。1 KiB 以上的 JSON 结果 gzip+base64 稳定省 40% 左右，
 * 再小的省下来抵不过包装；10% 收益判据照旧兜底。只是被控端的选择：控制端声明 gzip 即可解任意大小。
 */
export const INVOKE_TRANSFER_MIN_GZIP_BYTES = 1024;
/**
 * 压缩形状比原结果多出的固定包装 `null,"transfer":{"gzipBase64":""}`（可靠层转义后约 40 B）。
 * 4 KB 以上可以忽略；门槛降到 1 KiB 后约占 4%，收益判据要算进去。
 */
const INVOKE_TRANSFER_GZIP_WRAPPER_BYTES = 48;
/** 列表补丁压缩后只是把 `"patch":` 换成 `"gzipBase64":""`，可靠层转义后约多 9 B。 */
const INVOKE_DELTA_GZIP_WRAPPER_BYTES = 16;
/**
 * 编码结果的解压上限，与传输层单条逻辑消息上限同量级：更大的结果被控端不编码，
 * 仍走原有的超限处理；控制端解压超过即判失败。
 */
export const INVOKE_TRANSFER_MAX_CHARS = 4 * 1024 * 1024;
const MAX_TAG_CHARS = 128;
/** 缓存键（channel + args）过长说明 args 本身就是大载荷，不值得缓存。 */
const MAX_CACHE_KEY_CHARS = 4 * 1024;
const MAX_CACHE_ENTRIES = 32;
/** JS 字符串按 UTF-16 计，约 8MB 内存。 */
const MAX_CACHE_CHARS = INVOKE_TRANSFER_MAX_CHARS;
const MAX_INBOUND_OPTIONS = 512;

export function parseInvokeTransferOptions(value: unknown): InvokeTransferOptions | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const options: InvokeTransferOptions = {};
  if (raw.gzip === 1) options.gzip = 1;
  if (typeof raw.ifNoneMatch === 'string' && raw.ifNoneMatch.length > 0
    && raw.ifNoneMatch.length <= MAX_TAG_CHARS) {
    options.ifNoneMatch = raw.ifNoneMatch;
  }
  if (raw.delta === 1) options.delta = 1;
  return options.gzip || options.ifNoneMatch || options.delta ? options : null;
}

/** 被控端增量上下文：结果发给谁，以及该发送方各请求最近一次发出的全文。 */
export interface InvokeResultDeltaContext {
  src: string;
  bases: InvokeDeltaBases;
}

/** 被控端：按控制端在该请求上的声明改写 ok 结果；不满足条件时原样返回。 */
export function encodeInvokeResultTransfer(
  options: InboundInvokeTransfer,
  payload: InvokeResultPayload,
  codec: DeviceLinkTransferCodec,
  deltaContext?: InvokeResultDeltaContext,
): InvokeResultPayload {
  if (!payload.ok || payload.transfer) return payload;
  let text: string | undefined;
  try {
    text = JSON.stringify(payload.result);
  } catch {
    return payload;
  }
  if (text === undefined || text.length > INVOKE_TRANSFER_MAX_CHARS) return payload;
  const taggable = text.length >= INVOKE_TRANSFER_MIN_CHARS;
  const bytes = options.gzip === 1 ? byteLength(text) : 0;
  const compressible = options.gzip === 1 && bytes >= INVOKE_TRANSFER_MIN_GZIP_BYTES;
  if (!taggable && !compressible) return payload;
  const tag = taggable ? codec.contentTag?.(text) : undefined;
  const requestKey = options.requestKey;
  // 只有声明了 delta、能打标签的结果才记作下次的基准；旧控制端不占这份内存。
  const delta = deltaContext && requestKey && tag !== undefined ? { ...deltaContext, requestKey } : undefined;
  if (tag !== undefined && options.ifNoneMatch === tag) {
    delta?.bases.remember(delta.src, delta.requestKey, tag, text);
    return { ok: true, result: null, transfer: { tag, notModified: true } };
  }
  if (delta && tag !== undefined) {
    const base = options.ifNoneMatch ? delta.bases.get(delta.src, delta.requestKey) : undefined;
    delta.bases.remember(delta.src, delta.requestKey, tag, text);
    const patch = base?.tag === options.ifNoneMatch && base
      ? computeInvokeResultPatch(base.text, text, INVOKE_TRANSFER_MAX_CHARS) : null;
    if (patch) {
      return { ok: true, result: null, transfer: { tag, delta: encodeDelta(options, base!.tag, text, patch, codec) } };
    }
  }
  const gzipBase64 = compressible ? gzipWhenSmaller(text, bytes, INVOKE_TRANSFER_GZIP_WRAPPER_BYTES, codec) : undefined;
  if (gzipBase64 !== undefined) {
    return { ok: true, result: null, transfer: { ...(tag ? { tag } : {}), gzipBase64 } };
  }
  return tag ? { ...payload, transfer: { tag } } : payload;
}

/**
 * 整份结果与列表补丁共用的压缩判据：UTF-8 ≥ 1 KiB，且压缩后加上各自的包装仍省 10% 以上。
 * `bytes` 由调用方算好（未声明 gzip 时传 0）。
 */
function gzipWhenSmaller(text: string, bytes: number, wrapperBytes: number, codec: DeviceLinkTransferCodec): string | undefined {
  if (bytes < INVOKE_TRANSFER_MIN_GZIP_BYTES || !codec.gzipBase64) return undefined;
  const gzipBase64 = codec.gzipBase64(text);
  // Base64 is ASCII, whereas Chinese/emoji JSON takes multiple UTF-8 bytes
  // per character. Compare transmitted bytes, not JS string lengths.
  return gzipBase64.length + wrapperBytes < bytes * 0.9 ? gzipBase64 : undefined;
}

function encodeDelta(
  options: InvokeTransferOptions,
  base: string,
  text: string,
  patch: InvokeResultPatch,
  codec: DeviceLinkTransferCodec,
): InvokeResultDelta {
  const check = { base, length: text.length, sample: sampleInvokeResultText(text) };
  const patchText = JSON.stringify(patch);
  // Same threshold and saving rule as a whole result, with the patch's own smaller wrapper:
  // one changed row plus the reused indexes is usually 1–3 KB, which would otherwise go out raw
  // and be escaped again inside the reliable frame.
  // Host-side choice only: a controller that declared gzip decodes a gzip patch of any size.
  // The content tag / notModified threshold is about the whole result and is unchanged.
  const patchBytes = options.gzip === 1 ? byteLength(patchText) : 0;
  const gzipBase64 = gzipWhenSmaller(patchText, patchBytes, INVOKE_DELTA_GZIP_WRAPPER_BYTES, codec);
  return gzipBase64 !== undefined ? { ...check, gzipBase64 } : { ...check, patch };
}

/** 被控端：记住每个入站 invoke 的声明，供回结果（含补发 / 降级重发）时编码。 */
export class InboundInvokeTransferOptions {
  private readonly options = new Map<string, InboundInvokeTransfer>();

  record(src: string, requestId: string, payload: unknown): void {
    const invoke = payload as InvokePayload | undefined;
    const parsed = parseInvokeTransferOptions(invoke?.transfer);
    if (!parsed) return;
    const transfer: InboundInvokeTransfer = parsed;
    if (parsed.delta && isInvokeDeltaChannel(invoke?.channel)) {
      // 与控制端缓存键同口径：channel + 原样 args（不含 transfer）。
      const requestKey = invokeRequestKey(invoke!);
      if (requestKey) transfer.requestKey = requestKey;
    }
    const key = `${src}\u0000${requestId}`;
    this.options.delete(key);
    this.options.set(key, transfer);
    while (this.options.size > MAX_INBOUND_OPTIONS) {
      this.options.delete(this.options.keys().next().value!);
    }
  }

  get(src: string, requestId: string): InboundInvokeTransfer | undefined {
    return this.options.get(`${src}\u0000${requestId}`);
  }

  clear(): void {
    this.options.clear();
  }
}

interface CachedResult {
  tag: string;
  text: string;
  /** 这份全文由几次未经 SHA-256 核对的还原（增量或重新序列化）得来；0 或缺省为逐字节来自被控端。 */
  unverified?: number;
}

/** 控制端发出一次 invoke 前固定的编码上下文；结果回来时只用这份快照解码。 */
export interface PreparedInvokeTransfer {
  payload: InvokePayload;
  /** 只有走 gunzipBase64Async 时才返回 Promise；调用方统一 await。 */
  decode(
    result: InvokeResultPayload,
    observe?: InvokeDecodeObserver,
  ): InvokeResultPayload | Promise<InvokeResultPayload>;
  /**
   * decode 之后为 true：增量无法套用（基准不符、补丁损坏），该基准已丢弃；
   * 这次只读请求可以不带基准重发一次拿全文。
   */
  retryWithoutBase(): boolean;
}

/** inflateMs 对异步解压是等待时长，不等于占用调用线程的时间；parseMs 总在调用线程。 */
export type InvokeDecodeObserver = (timing: { inflateMs: number; parseMs: number }) => void;

function decodeClock(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

/** 控制端：按 peer + channel + args 保留最近的大结果，有界 LRU，只在内存。 */
export class InvokeResultCache {
  private readonly entries = new Map<string, CachedResult>();
  private chars = 0;
  /** Bumped by clear(): a decode that finishes after it must not put its result back. */
  private epoch = 0;

  constructor(private readonly codec: DeviceLinkTransferCodec | undefined) {}

  prepare(dst: string, payload: InvokePayload): PreparedInvokeTransfer {
    const key = cacheKey(dst, payload);
    const epoch = this.epoch;
    // 请求时固定快照：结果回来前即使被淘汰，notModified 仍能还原。
    const cached = key ? this.entries.get(key) : undefined;
    const transfer: InvokeTransferOptions = {};
    if (this.codec?.gunzipBase64) transfer.gzip = 1;
    // 未经完整校验的还原链太长时不带基准，拿一次全文重新对齐。
    if (cached && (cached.unverified ?? 0) < MAX_UNVERIFIED_DELTAS) transfer.ifNoneMatch = cached.tag;
    // 首次读取也要声明：被控端从这次结果起记下基准，下次才能回增量。
    // 只给已声明传输编码的控制端加：没有注入编码器的控制端 wire 格式保持不变。
    if (key && transfer.gzip && isInvokeDeltaChannel(payload.channel)) transfer.delta = 1;
    const prepared = transfer.gzip || transfer.ifNoneMatch || transfer.delta ? { ...payload, transfer } : payload;
    const state = { deltaFailed: false };
    return {
      payload: prepared,
      decode: (result, observe) => this.decode(key, epoch, cached, result, observe, state),
      retryWithoutBase: () => state.deltaFailed,
    };
  }

  clear(): void {
    this.entries.clear();
    this.chars = 0;
    this.epoch += 1;
  }

  /** 保留已有条目，但停止前在途的解码不再写回（停连保留缓存时用）。 */
  fence(): void {
    this.epoch += 1;
  }

  private decode(
    key: string | null,
    epoch: number,
    cached: CachedResult | undefined,
    result: InvokeResultPayload,
    observe?: InvokeDecodeObserver,
    state?: { deltaFailed: boolean },
  ): InvokeResultPayload | Promise<InvokeResultPayload> {
    if (!result.ok || !result.transfer) return result;
    const transfer = result.transfer;
    const failed = (err: unknown): InvokeResultPayload => ({
      ok: false,
      error: {
        code: 'IPC_ERROR',
        message: `[INTERNAL] invalid invoke result transfer: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
    const startedAt = decodeClock();
    const parsed = (text: string): InvokeResultPayload => {
      const inflatedAt = decodeClock();
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (err) {
        return failed(err);
      }
      try {
        observe?.({ inflateMs: inflatedAt - startedAt, parseMs: decodeClock() - inflatedAt });
      } catch { /* Diagnostics must never affect delivery. */ }
      return this.finishDecode(key, epoch, transfer, text, value);
    };
    if (transfer.notModified) {
      if (!cached || cached.tag !== transfer.tag) return failed(new Error('unexpected notModified'));
      return this.finishDecodeParsed(parsed(cached.text), key, cached.unverified);
    }
    if (transfer.delta) {
      return this.decodeDelta(key, cached, transfer, (text, value, inflatedAt) => {
        try {
          observe?.({ inflateMs: inflatedAt - startedAt, parseMs: decodeClock() - inflatedAt });
        } catch { /* Diagnostics must never affect delivery. */ }
        // Desktop 已核 SHA-256，链长归零；Mobile 每次增量加一。
        const unverified = this.codec?.contentTag ? 0 : (cached?.unverified ?? 0) + 1;
        return this.finishDecode(key, epoch, transfer, text, value, unverified);
      }, state);
    }
    if (typeof transfer.gzipBase64 === 'string') {
      if (this.codec?.gunzipBase64Async) {
        return this.codec.gunzipBase64Async(transfer.gzipBase64, INVOKE_TRANSFER_MAX_CHARS)
          .then(parsed, failed);
      }
      if (!this.codec?.gunzipBase64) return failed(new Error('unexpected gzip result'));
      let text: string;
      try {
        text = this.codec.gunzipBase64(transfer.gzipBase64, INVOKE_TRANSFER_MAX_CHARS);
      } catch (err) {
        return failed(err);
      }
      return parsed(text);
    }
    let text: string;
    try {
      text = JSON.stringify(result.result);
    } catch (err) {
      return failed(err);
    }
    // 未压缩的结果按本机重新序列化的全文缓存，不是被控端的原始字节。
    return this.finishDecode(key, epoch, transfer, text, result.result, this.codec?.contentTag ? 0 : 1);
  }

  /** notModified 沿用基准的校验状态（finishDecode 会按 transfer.tag 重新记一次）。 */
  private finishDecodeParsed(result: InvokeResultPayload, key: string | null, unverified: number | undefined): InvokeResultPayload {
    if (result.ok && key && unverified) {
      const entry = this.entries.get(key);
      if (entry) entry.unverified = unverified;
    }
    return result;
  }

  /**
   * 增量只能从发请求时固定的那份基准还原。任何失败都丢掉该基准并标记可重试：
   * 调用方（DeviceLinkClient）对同一只读请求不带基准重发一次，拿全文。
   */
  private decodeDelta(
    key: string | null,
    cached: CachedResult | undefined,
    transfer: InvokeResultTransfer,
    finish: (text: string, value: unknown, inflatedAt: number) => InvokeResultPayload,
    state?: { deltaFailed: boolean },
  ): InvokeResultPayload | Promise<InvokeResultPayload> {
    const delta = transfer.delta!;
    const failed = (err: unknown): InvokeResultPayload => {
      if (key && this.entries.get(key) === cached) this.forget(key);
      if (state) state.deltaFailed = true;
      return {
        ok: false,
        error: {
          code: 'IPC_ERROR',
          message: `[INTERNAL] invalid invoke result delta: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    };
    const rebuild = (patch: unknown, inflatedAt = decodeClock()): InvokeResultPayload => {
      try {
        if (!cached || cached.tag !== delta.base) throw new Error('unexpected delta base');
        const { text, value } = applyInvokeResultPatchValue(cached.text, patch as InvokeResultPatch, INVOKE_TRANSFER_MAX_CHARS);
        if (text.length !== delta.length) throw new Error('delta length mismatch');
        // 抽样摘要成本固定，两端都核；能算 SHA-256 的控制端（Desktop）另核完整标签。
        if (sampleInvokeResultText(text) !== delta.sample) throw new Error('delta sample mismatch');
        if (this.codec?.contentTag && this.codec.contentTag(text) !== transfer.tag) throw new Error('delta tag mismatch');
        return finish(text, value, inflatedAt);
      } catch (err) {
        return failed(err);
      }
    };
    if (typeof delta.gzipBase64 === 'string') {
      const parsePatch = (text: string) => {
        const inflatedAt = decodeClock();
        try {
          return rebuild(JSON.parse(text), inflatedAt);
        } catch (err) {
          return failed(err);
        }
      };
      if (this.codec?.gunzipBase64Async) {
        return this.codec.gunzipBase64Async(delta.gzipBase64, INVOKE_TRANSFER_MAX_CHARS).then(parsePatch, failed);
      }
      if (!this.codec?.gunzipBase64) return failed(new Error('unexpected gzip delta'));
      let text: string;
      try {
        text = this.codec.gunzipBase64(delta.gzipBase64, INVOKE_TRANSFER_MAX_CHARS);
      } catch (err) {
        return failed(err);
      }
      return parsePatch(text);
    }
    return rebuild(delta.patch);
  }

  private forget(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.chars -= entry.text.length;
    this.entries.delete(key);
  }

  private finishDecode(
    key: string | null,
    epoch: number,
    transfer: InvokeResultTransfer,
    text: string,
    value: unknown,
    unverified = 0,
  ): InvokeResultPayload {
    if (key && epoch === this.epoch) {
      if (typeof transfer.tag === 'string' && transfer.tag.length <= MAX_TAG_CHARS) {
        this.remember(key, { tag: transfer.tag, text, ...(unverified ? { unverified } : {}) });
      } else {
        // 结果缩到标签门槛以下（压缩但不打标签）：旧标签再也对不上，别让它占着缓存位。
        this.forget(key);
      }
    }
    return { ok: true, result: value };
  }

  private remember(key: string, entry: CachedResult): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.chars -= previous.text.length;
      this.entries.delete(key);
    }
    if (entry.text.length > MAX_CACHE_CHARS) return;
    this.entries.set(key, entry);
    this.chars += entry.text.length;
    while (this.entries.size > MAX_CACHE_ENTRIES || this.chars > MAX_CACHE_CHARS) {
      const [oldestKey, oldest] = this.entries.entries().next().value!;
      this.chars -= oldest.text.length;
      this.entries.delete(oldestKey);
    }
  }
}

function invokeRequestKey(payload: InvokePayload): string | null {
  let args: string;
  try {
    args = JSON.stringify(payload.args ?? []);
  } catch {
    return null;
  }
  const key = `${payload.channel}\u0000${args}`;
  return key.length <= MAX_CACHE_KEY_CHARS ? key : null;
}

function cacheKey(dst: string, payload: InvokePayload): string | null {
  const request = invokeRequestKey(payload);
  const key = request ? `${dst}\u0000${request}` : null;
  return key && key.length <= MAX_CACHE_KEY_CHARS ? key : null;
}
