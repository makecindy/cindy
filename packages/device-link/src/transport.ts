import { PROTOCOL_VERSION, type Envelope } from './protocol.js';

/**
 * Device-link 端到端可靠传输能力。
 *
 * relay 只看 kind / dst，payload 对 relay 不透明，所以可靠传输可以作为
 * 现有 invoke / invoke-result / push 的 payload wrapper 增量加入，不需要
 * 改动 v1 的路由集合，也不会让旧客户端收到新的 kind。
 */
export const DEVICE_LINK_CAPABILITY_RELIABLE_TRANSPORT = 'reliable-transport-v1';

/** transport ACK 使用普通 push 承载，且 ACK 本身永不再包 transport。 */
export const DEVICE_LINK_TRANSPORT_ACK_CHANNEL = '__cindy/device-link/transport-ack';

/** 分片目标大小；给 JSON envelope 的路由头和 wrapper 留出足够余量。 */
export const MAX_TRANSPORT_CHUNK_BYTES = 128 * 1024;
/** 单条逻辑消息最多允许的分片数。 */
export const MAX_TRANSPORT_SEGMENTS = 64;
/** 单条逻辑消息上限；大于旧 2MB 帧上限，但必须能被有界 pending 完整保留。 */
export const MAX_TRANSPORT_MESSAGE_BYTES = 4 * 1024 * 1024;
/** 同一接收 stream 的待重组/待交付总字节上限。 */
export const MAX_TRANSPORT_REASSEMBLY_BYTES = 16 * 1024 * 1024;
/** 同一 peer 同时等待的重组消息上限。 */
export const MAX_TRANSPORT_REASSEMBLIES = 16;
/** 允许的最大乱序窗口；与发送端 pending 消息上限一致。 */
export const MAX_TRANSPORT_SEQUENCE_WINDOW = 64;
/** 单个 peer 未确认的逻辑消息上限。 */
export const MAX_TRANSPORT_PENDING_MESSAGES = 64;
/** 单个 peer 未确认消息的总字节上限。 */
export const MAX_TRANSPORT_PENDING_BYTES = 16 * 1024 * 1024;
/** WebSocket native send buffer 上限，超过后让可靠层收敛而不是继续灌数据。 */
export const MAX_TRANSPORT_WEBSOCKET_BUFFERED_BYTES = 8 * 1024 * 1024;
/** 未收到 ACK 时的重发间隔。 */
export const TRANSPORT_RETRY_INTERVAL_MS = 2_000;
/** 连续重发上限；之后保留消息等待重连，避免弱网下无限制造流量。 */
export const TRANSPORT_MAX_RETRY_ATTEMPTS = 5;
/**
 * pending 里 push 帧的最大滞留时长（按单调时钟计量，不受墙钟校正影响）。push 是
 * 尽力而为的实时镜像旁路，长时间未被 ACK（典型是对端离线）后只剩历史价值；
 * 超龄后在普通入队压力下被兜底清扫，避免陈旧 push 独占有界 pending 缓冲。
 * 重连重放前与 invoke-result 腾位不看此 TTL：这两条路径直接丢弃队头整个可丢弃
 * 前缀（含新鲜 push 与 transport-skip 占位），保证 invoke-result 是最早的 live seq。
 */
export const TRANSPORT_PENDING_PUSH_MAX_AGE_MS = 5 * 60_000;

const TRANSPORT_MARKER = '__cindyDeviceLinkTransport';
const TRANSPORT_SKIP_MARKER = '__cindyDeviceLinkTransportSkip';
const TRANSPORT_VERSION = 1;

export interface ReliableTransportMeta {
  version: 1;
  streamId: string;
  seq: number;
  /** 发送端当前仍可能重放的最小 seq，用于接收端进程重启后恢复累计 ACK 基线。 */
  baseSeq?: number;
  segment?: {
    index: number;
    total: number;
    totalBytes: number;
  };
}

export interface ReliableTransportPayload {
  [TRANSPORT_MARKER]: ReliableTransportMeta;
  /** JSON.stringify(payload) 的 UTF-8 字符串；分片时是一个片段。 */
  data: string;
}

export interface TransportAckPayload {
  streamId: string;
  ackSeq: number;
}

export interface TransportSkipPayload {
  [TRANSPORT_SKIP_MARKER]: true;
}

export interface ParsedTransportPayload {
  meta: ReliableTransportMeta;
  data: string;
}

export function byteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index)!;
    if (codePoint > 0xffff) index += 1;
    bytes += codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
        ? 2
        : codePoint <= 0xffff
          ? 3
          : 4;
  }
  return bytes;
}

/**
 * 把 JSON 文本按 UTF-8 字节切开，不从多字节字符中间切断。
 * for...of 按 code point 遍历，因此不会拆开 surrogate pair。
 */
function splitUtf8(text: string, maxBytes: number): string[] {
  if (maxBytes <= 0) throw new Error('maxBytes must be positive');
  const chunks: string[] = [];
  let chunkStart = 0;
  let offset = 0;
  let chunkBytes = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    const charBytes = codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
        ? 2
        : codePoint <= 0xffff
          ? 3
          : 4;
    if (offset > chunkStart && chunkBytes + charBytes > maxBytes) {
      chunks.push(text.slice(chunkStart, offset));
      chunkStart = offset;
      chunkBytes = 0;
    }
    // 单个 code point 不可能超过 4 bytes；保留这个分支让边界参数错误
    // 变成显式失败，而不是生成一个超过约定大小的片段。
    if (charBytes > maxBytes) throw new Error('transport chunk size is smaller than one code point');
    offset += char.length;
    chunkBytes += charBytes;
  }
  if (offset > chunkStart || text.length === 0) chunks.push(text.slice(chunkStart, offset));
  return chunks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function makeTransportSkipPayload(): TransportSkipPayload {
  return { [TRANSPORT_SKIP_MARKER]: true };
}

export function isTransportSkipPayload(payload: unknown): payload is TransportSkipPayload {
  return isRecord(payload) && payload[TRANSPORT_SKIP_MARKER] === true;
}

/** 创建一个或多个仍使用原 kind 的 payload 分片。 */
export function encodeReliableFrames(
  env: Envelope,
  streamId: string,
  seq: number,
  baseSeq = 1,
): Envelope[] {
  if (
    !streamId
    || !Number.isSafeInteger(seq)
    || seq <= 0
    || !Number.isSafeInteger(baseSeq)
    || baseSeq <= 0
    || baseSeq > seq
  ) {
    throw new Error('invalid transport stream metadata');
  }
  const json = JSON.stringify(env.payload);
  if (typeof json !== 'string') throw new Error('transport payload is not JSON serializable');
  const totalBytes = byteLength(json);
  if (totalBytes > MAX_TRANSPORT_MESSAGE_BYTES) {
    throw new Error(`transport payload exceeds ${MAX_TRANSPORT_MESSAGE_BYTES} bytes`);
  }
  const chunks = splitUtf8(json, MAX_TRANSPORT_CHUNK_BYTES);
  if (chunks.length > MAX_TRANSPORT_SEGMENTS) {
    throw new Error(`transport payload exceeds ${MAX_TRANSPORT_SEGMENTS} segments`);
  }
  return chunks.map((data, index) => {
    const meta: ReliableTransportMeta = {
      version: TRANSPORT_VERSION,
      streamId,
      seq,
      ...(baseSeq > 1 ? { baseSeq } : {}),
      ...(chunks.length > 1
        ? { segment: { index, total: chunks.length, totalBytes } }
        : {}),
    };
    return {
      ...env,
      payload: {
        [TRANSPORT_MARKER]: meta,
        data,
      } satisfies ReliableTransportPayload,
    };
  });
}

/** 返回 null 表示这是旧客户端的普通 payload，而不是 transport 帧。 */
export function parseTransportPayload(payload: unknown): ParsedTransportPayload | null {
  if (!isRecord(payload)) return null;
  const rawMeta = payload[TRANSPORT_MARKER];
  if (!isRecord(rawMeta) || rawMeta.version !== TRANSPORT_VERSION) return null;
  const streamId = rawMeta.streamId;
  const seq = rawMeta.seq;
  const baseSeq = rawMeta.baseSeq === undefined ? 1 : rawMeta.baseSeq;
  if (
    typeof streamId !== 'string' ||
    streamId.length < 1 ||
    streamId.length > 128 ||
    typeof seq !== 'number' ||
    !Number.isSafeInteger(seq) ||
    seq <= 0 ||
    typeof baseSeq !== 'number' ||
    !Number.isSafeInteger(baseSeq) ||
    baseSeq <= 0 ||
    baseSeq > seq ||
    typeof payload.data !== 'string'
  ) {
    return null;
  }
  const segment = rawMeta.segment;
  if (segment !== undefined) {
    if (!isRecord(segment)) return null;
    const index = segment.index;
    const total = segment.total;
    const totalBytes = segment.totalBytes;
    if (
      typeof index !== 'number' ||
      typeof total !== 'number' ||
      typeof totalBytes !== 'number' ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(total) ||
      !Number.isSafeInteger(totalBytes) ||
      index < 0 ||
      total < 2 ||
      index >= total ||
      total > MAX_TRANSPORT_SEGMENTS ||
      totalBytes < 0 ||
      totalBytes > MAX_TRANSPORT_MESSAGE_BYTES ||
      totalBytes <= MAX_TRANSPORT_CHUNK_BYTES ||
      totalBytes > total * MAX_TRANSPORT_CHUNK_BYTES
    ) {
      return null;
    }
    return {
      meta: {
        version: TRANSPORT_VERSION,
        streamId,
        seq,
        ...(baseSeq > 1 ? { baseSeq } : {}),
        segment: {
          index,
          total,
          totalBytes,
        },
      },
      data: payload.data,
    };
  }
  return {
    meta: {
      version: TRANSPORT_VERSION,
      streamId,
      seq,
      ...(baseSeq > 1 ? { baseSeq } : {}),
    },
    data: payload.data,
  };
}

export function decodeTransportJson(json: string, expectedBytes?: number): unknown {
  if (expectedBytes !== undefined && byteLength(json) !== expectedBytes) {
    throw new Error('transport payload byte length mismatch');
  }
  return JSON.parse(json);
}

export function makeTransportAck(
  dst: string,
  streamId: string,
  ackSeq: number,
): Envelope {
  return {
    v: PROTOCOL_VERSION,
    kind: 'push',
    dst,
    payload: {
      channel: DEVICE_LINK_TRANSPORT_ACK_CHANNEL,
      payload: { streamId, ackSeq } satisfies TransportAckPayload,
    },
  };
}

export function parseTransportAck(env: Envelope): TransportAckPayload | null {
  if (env.kind !== 'push' || !isRecord(env.payload)) return null;
  if (env.payload.channel !== DEVICE_LINK_TRANSPORT_ACK_CHANNEL) return null;
  const payload = env.payload.payload;
  const streamId = isRecord(payload) ? payload.streamId : undefined;
  const ackSeq = isRecord(payload) ? payload.ackSeq : undefined;
  if (
    typeof streamId !== 'string' ||
    typeof ackSeq !== 'number' ||
    !Number.isSafeInteger(ackSeq) ||
    ackSeq < 0
  ) {
    return null;
  }
  return { streamId, ackSeq };
}
