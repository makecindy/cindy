import type { InvokePayload, InvokeResultPayload } from './protocol.js';
import { byteLength } from './transport.js';

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
}

/** 被控端 → 控制端，只出现在 ok 结果上；有 `notModified` / `gzipBase64` 时 result 为 null。 */
export interface InvokeResultTransfer {
  /** 完整结果 JSON 的内容标签；控制端据此缓存。 */
  tag?: string;
  notModified?: true;
  /** gzip(UTF-8 JSON.stringify(result)) 的 base64。 */
  gzipBase64?: string;
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
}

/** 小结果编码收益抵不过开销，原样发送。 */
export const INVOKE_TRANSFER_MIN_CHARS = 4 * 1024;
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
  return options.gzip || options.ifNoneMatch ? options : null;
}

/** 被控端：按控制端在该请求上的声明改写 ok 结果；不满足条件时原样返回。 */
export function encodeInvokeResultTransfer(
  options: InvokeTransferOptions,
  payload: InvokeResultPayload,
  codec: DeviceLinkTransferCodec,
): InvokeResultPayload {
  if (!payload.ok || payload.transfer) return payload;
  let text: string | undefined;
  try {
    text = JSON.stringify(payload.result);
  } catch {
    return payload;
  }
  if (text === undefined || text.length < INVOKE_TRANSFER_MIN_CHARS
    || text.length > INVOKE_TRANSFER_MAX_CHARS) return payload;
  const tag = codec.contentTag?.(text);
  if (tag !== undefined && options.ifNoneMatch === tag) {
    return { ok: true, result: null, transfer: { tag, notModified: true } };
  }
  if (options.gzip && codec.gzipBase64) {
    const gzipBase64 = codec.gzipBase64(text);
    // Base64 is ASCII, whereas Chinese/emoji JSON takes multiple UTF-8 bytes
    // per character. Compare transmitted bytes, not JS string lengths.
    if (gzipBase64.length < byteLength(text) * 0.9) {
      return { ok: true, result: null, transfer: { ...(tag ? { tag } : {}), gzipBase64 } };
    }
  }
  return tag ? { ...payload, transfer: { tag } } : payload;
}

/** 被控端：记住每个入站 invoke 的声明，供回结果（含补发 / 降级重发）时编码。 */
export class InboundInvokeTransferOptions {
  private readonly options = new Map<string, InvokeTransferOptions>();

  record(src: string, requestId: string, payload: unknown): void {
    const transfer = parseInvokeTransferOptions((payload as InvokePayload | undefined)?.transfer);
    if (!transfer) return;
    const key = `${src}\u0000${requestId}`;
    this.options.delete(key);
    this.options.set(key, transfer);
    while (this.options.size > MAX_INBOUND_OPTIONS) {
      this.options.delete(this.options.keys().next().value!);
    }
  }

  get(src: string, requestId: string): InvokeTransferOptions | undefined {
    return this.options.get(`${src}\u0000${requestId}`);
  }

  clear(): void {
    this.options.clear();
  }
}

interface CachedResult {
  tag: string;
  text: string;
}

/** 控制端发出一次 invoke 前固定的编码上下文；结果回来时只用这份快照解码。 */
export interface PreparedInvokeTransfer {
  payload: InvokePayload;
  /** 只有走 gunzipBase64Async 时才返回 Promise；调用方统一 await。 */
  decode(
    result: InvokeResultPayload,
    observe?: InvokeDecodeObserver,
  ): InvokeResultPayload | Promise<InvokeResultPayload>;
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
    if (cached) transfer.ifNoneMatch = cached.tag;
    const prepared = transfer.gzip || transfer.ifNoneMatch ? { ...payload, transfer } : payload;
    return {
      payload: prepared,
      decode: (result, observe) => this.decode(key, epoch, cached, result, observe),
    };
  }

  clear(): void {
    this.entries.clear();
    this.chars = 0;
    this.epoch += 1;
  }

  private decode(
    key: string | null,
    epoch: number,
    cached: CachedResult | undefined,
    result: InvokeResultPayload,
    observe?: InvokeDecodeObserver,
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
      return parsed(cached.text);
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
    return this.finishDecode(key, epoch, transfer, text, result.result);
  }

  private finishDecode(
    key: string | null,
    epoch: number,
    transfer: InvokeResultTransfer,
    text: string,
    value: unknown,
  ): InvokeResultPayload {
    if (key && epoch === this.epoch && typeof transfer.tag === 'string' && transfer.tag.length <= MAX_TAG_CHARS) {
      this.remember(key, { tag: transfer.tag, text });
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

function cacheKey(dst: string, payload: InvokePayload): string | null {
  let args: string;
  try {
    args = JSON.stringify(payload.args ?? []);
  } catch {
    return null;
  }
  const key = `${dst}\u0000${payload.channel}\u0000${args}`;
  return key.length <= MAX_CACHE_KEY_CHARS ? key : null;
}
