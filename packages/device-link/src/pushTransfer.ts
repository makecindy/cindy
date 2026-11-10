import type { DeviceLinkTransferCodec } from './invokeTransfer.js';
import type { PushPayload } from './protocol.js';
import { PUSH_TRANSFER_DICTIONARY_V1 } from './pushTransferDictionary.js';
import { byteLength } from './transport.js';

/**
 * push 的传输编码（弱网减流量），与 invoke 结果的 transfer（invokeTransfer.ts）并列。
 *
 * 控制端在 link-open 声明本能力，表示它能在交给业务前同步解开压缩推送；被控端只对
 * 声明了本能力、且走可靠传输的同账号 peer 编码。每条推送独立压缩：raw DEFLATE，
 * 以 PUSH_TRANSFER_DICTIONARY_V1 作预置字典（让几百字节的小推送也能省一半左右），
 * 不跨消息共享状态，所以丢弃、重放、降级与切换直连都不影响能否解开。
 *
 * 被压缩的推送保留 `channel` 与 `ownerStamp` 明文（可靠层的合并 / 丢弃判据与诊断只读
 * 这两项），业务 `payload` 换成 null，正文放进 `transfer.deflateBase64`。旧控制端从不
 * 声明，永远收不到新形状；新控制端连旧被控端时收到普通推送，按原路消费。中转只转发，
 * 不解析 payload，官方与自建中转都不用改。
 */
export const DEVICE_LINK_CAPABILITY_PUSH_DEFLATE_V1 = 'push-deflate-v1';

/**
 * 小于此值的推送原样发送（按 UTF-8 字节）。有字典时 ~300 B 的事件批也能压到一半多一点，
 * 再小的推送（如 `{ sessionId }` 通知）省下的不够抵 transfer 包装本身。
 */
export const PUSH_TRANSFER_MIN_BYTES = 256;
/**
 * 大于此值的推送原样发送。两个原因：
 * - 远小于可靠层单消息上限（4 MB），本来会撑爆上限、由 dispatch 改发精简版的超大推送
 *   仍走原有兜底，不会因为压缩后放得下而把完整正文发给手机；
 * - 控制端在 JS 线程同步解压，上限决定单条推送最坏的解压耗时。正常推送远小于它：
 *   事件批上限 256 KB，手机的工具结果已截到 8 KB。
 */
export const PUSH_TRANSFER_MAX_BYTES = 512 * 1024;
/** 解压上限：编码端只压不超过 PUSH_TRANSFER_MAX_BYTES 字节的推送，字符数不会更多。 */
export const PUSH_TRANSFER_MAX_CHARS = PUSH_TRANSFER_MAX_BYTES;

export interface PushTransfer {
  /** raw DEFLATE（预置字典 PUSH_TRANSFER_DICTIONARY_V1）后的 base64。 */
  deflateBase64: string;
}

/** 被压缩推送在线上的形状：原 PushPayload 的 payload 为 null，加 transfer。 */
export interface EncodedPushPayload extends PushPayload {
  payload: null;
  transfer: PushTransfer;
}

/**
 * 被控端：在确认对端已声明能力后调用。小推送、不可序列化或压缩收益不足时原样返回。
 * 不改 channel / ownerStamp，可靠层的丢弃与合并判据因此不变。
 */
export function encodePushTransfer(
  push: PushPayload,
  codec: DeviceLinkTransferCodec,
): PushPayload | EncodedPushPayload {
  if (!codec.deflateRawBase64 || push.payload === null || push.payload === undefined) return push;
  let text: string | undefined;
  try {
    text = JSON.stringify(push.payload);
  } catch {
    return push;
  }
  if (text === undefined || text.length > PUSH_TRANSFER_MAX_BYTES) return push;
  const bytes = byteLength(text);
  if (bytes < PUSH_TRANSFER_MIN_BYTES || bytes > PUSH_TRANSFER_MAX_BYTES) return push;
  const deflateBase64 = codec.deflateRawBase64(text, PUSH_TRANSFER_DICTIONARY_V1);
  // 按线上字节比较：可靠层把 payload 作为 JSON 字符串再转义一次（原文里的引号、反斜杠
  // 各多一个字节，base64 没有），压缩形状另有固定包装。省不到 10% 就原样发送。
  if (deflateBase64.length + ENCODED_WRAPPER_BYTES >= byteLength(JSON.stringify(text)) * 0.9) return push;
  return {
    channel: push.channel,
    payload: null,
    transfer: { deflateBase64 },
    ...(push.ownerStamp ? { ownerStamp: push.ownerStamp } : {}),
  };
}

/**
 * 压缩形状替换原 payload 后多出的固定包装 `null,"transfer":{"deflateBase64":""}`，
 * 按可靠层再转义一次后约 44 字节，取整留余量。
 */
const ENCODED_WRAPPER_BYTES = 48;

/** 只认本模块产出的形状；其它带 transfer 字段的推送不当作压缩推送。 */
export function isEncodedPushPayload(value: unknown): value is EncodedPushPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const push = value as Record<string, unknown>;
  if (push.payload !== null || typeof push.channel !== 'string') return false;
  const transfer = push.transfer;
  return !!transfer && typeof transfer === 'object' && !Array.isArray(transfer)
    && typeof (transfer as Record<string, unknown>).deflateBase64 === 'string';
}

export type DecodedPush =
  | { ok: true; push: PushPayload }
  | { ok: false; reason: string };

/**
 * 控制端：同步还原被压缩的推送。推送必须按 seq 原序交给业务，所以这里不走异步解压；
 * 单条推送受可靠层单消息上限约束，解压后受 PUSH_TRANSFER_MAX_CHARS 约束。
 */
export function decodePushTransfer(
  push: EncodedPushPayload,
  codec: DeviceLinkTransferCodec | undefined,
): DecodedPush {
  if (!codec?.inflateRawBase64) return { ok: false, reason: 'no deflate decoder' };
  let payload: unknown;
  try {
    payload = JSON.parse(codec.inflateRawBase64(push.transfer.deflateBase64, PUSH_TRANSFER_MAX_CHARS, PUSH_TRANSFER_DICTIONARY_V1));
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return {
    ok: true,
    push: {
      channel: push.channel,
      payload,
      ...(push.ownerStamp ? { ownerStamp: push.ownerStamp } : {}),
    },
  };
}
