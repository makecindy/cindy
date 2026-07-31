/**
 * 通讯录同步的 CPU 密集型编解码核心。
 *
 * 生产环境只在专用 worker_threads 中调用这些同步函数；Main 通过
 * ContactsSyncCodec 的异步接口使用，避免大状态 JSON/gzip/加密阻塞事件循环。
 */

import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  CONTACTS_SYNC_CHUNK_BYTES,
  CONTACTS_SYNC_MAX_CHUNKS,
  CONTACTS_SYNC_WIRE_VERSION,
  type ContactsSyncCipherChunkFrame,
} from '@cindy/device-link';

import {
  decryptContactsSyncBytes,
  encryptContactsSyncBytes,
  type ContactsSyncEncryptionContext,
} from './crypto.js';

export const CONTACTS_SYNC_MAX_COMPRESSED_BYTES =
  CONTACTS_SYNC_CHUNK_BYTES * CONTACTS_SYNC_MAX_CHUNKS;
const MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;

export interface ContactsSyncStateMessage {
  version: 1;
  type: 'state';
  state: unknown;
  requestReply?: boolean;
}

export interface ContactsSyncEncodeOptions {
  message: ContactsSyncStateMessage;
  ownPrivateKey: string;
  ownPublicKey: string;
  peerPublicKey: string;
  srcDeviceId: string;
  dstDeviceId: string;
}

export interface ContactsSyncDecodeOptions {
  ciphertext: Uint8Array;
  iv: string;
  tag: string;
  ownPrivateKey: string;
  expectedPeerPublicKey: string;
  srcDeviceId: string;
  dstDeviceId: string;
  transferId: string;
  totalChunks: number;
}

export interface ContactsSyncCodec {
  encode(
    options: ContactsSyncEncodeOptions,
    signal?: AbortSignal,
  ): Promise<ContactsSyncCipherChunkFrame[]>;
  decode(
    options: ContactsSyncDecodeOptions,
    signal?: AbortSignal,
  ): Promise<ContactsSyncStateMessage>;
}

export type ContactsSyncCodecWorkerRequest =
  | { id: string; type: 'encode'; options: ContactsSyncEncodeOptions }
  | { id: string; type: 'decode'; options: ContactsSyncDecodeOptions };

export interface ContactsSyncCodecWorkerResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export function encodeContactsSyncMessageInProcess(
  options: ContactsSyncEncodeOptions,
): ContactsSyncCipherChunkFrame[] {
  const transferId = randomUUID();
  const compressed = gzipSync(Buffer.from(JSON.stringify(options.message), 'utf8'));
  if (compressed.length > CONTACTS_SYNC_MAX_COMPRESSED_BYTES) {
    throw new Error(`contacts sync state is too large (${compressed.length} compressed bytes)`);
  }
  const total = Math.max(1, Math.ceil(compressed.length / CONTACTS_SYNC_CHUNK_BYTES));
  const context: ContactsSyncEncryptionContext = {
    srcDeviceId: options.srcDeviceId,
    dstDeviceId: options.dstDeviceId,
    transferId,
    totalChunks: total,
  };
  const encrypted = encryptContactsSyncBytes(
    compressed,
    options.ownPrivateKey,
    options.peerPublicKey,
    context,
  );
  const frames: ContactsSyncCipherChunkFrame[] = [];
  for (let index = 0; index < total; index += 1) {
    frames.push({
      version: CONTACTS_SYNC_WIRE_VERSION,
      type: 'cipher-chunk',
      senderPublicKey: options.ownPublicKey,
      transferId,
      index,
      total,
      iv: encrypted.iv,
      tag: encrypted.tag,
      compression: 'gzip',
      data: encrypted.ciphertext
        .subarray(
          index * CONTACTS_SYNC_CHUNK_BYTES,
          Math.min((index + 1) * CONTACTS_SYNC_CHUNK_BYTES, encrypted.ciphertext.length),
        )
        .toString('base64'),
    });
  }
  return frames;
}

export function decodeContactsSyncMessageInProcess(
  options: ContactsSyncDecodeOptions,
): ContactsSyncStateMessage {
  const context: ContactsSyncEncryptionContext = {
    srcDeviceId: options.srcDeviceId,
    dstDeviceId: options.dstDeviceId,
    transferId: options.transferId,
    totalChunks: options.totalChunks,
  };
  const compressed = decryptContactsSyncBytes(
    { iv: options.iv, tag: options.tag, ciphertext: Buffer.from(options.ciphertext) },
    options.ownPrivateKey,
    options.expectedPeerPublicKey,
    context,
  );
  const json = gunzipSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_BYTES }).toString('utf8');
  const message: unknown = JSON.parse(json);
  if (!isContactsSyncStateMessage(message)) throw new Error('invalid contacts sync message');
  return message;
}

export function isContactsSyncStateMessage(value: unknown): value is ContactsSyncStateMessage {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    value.type === 'state' &&
    value.state !== undefined &&
    (value.requestReply === undefined || typeof value.requestReply === 'boolean')
  );
}

export const inProcessContactsSyncCodec: ContactsSyncCodec = {
  encode: async (options) => encodeContactsSyncMessageInProcess(options),
  decode: async (options) => decodeContactsSyncMessageInProcess(options),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
