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
import type { ContactsSyncClock } from '@cindy/maker-core';

import {
  decryptContactsSyncBytes,
  encryptContactsSyncBytes,
  type ContactsSyncEncryptionContext,
} from './crypto.js';

export const CONTACTS_SYNC_MAX_COMPRESSED_BYTES =
  CONTACTS_SYNC_CHUNK_BYTES * CONTACTS_SYNC_MAX_CHUNKS;
export const CONTACTS_SYNC_MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;

export interface ContactsSyncStateMessage {
  version: 1;
  type: 'state';
  state: unknown;
  requestReply?: boolean;
}

interface ContactsSyncEncodeCommonOptions {
  ownPrivateKey: string;
  ownPublicKey: string;
  peerPublicKey: string;
  srcDeviceId: string;
  dstDeviceId: string;
}

export interface ContactsSyncDatabaseSource {
  dbPath: string;
  betterSqliteModulePath?: string;
  nativeBinding?: string;
}

export interface ContactsSyncMessageEncodeOptions extends ContactsSyncEncodeCommonOptions {
  message: ContactsSyncStateMessage;
  database?: never;
}

export interface ContactsSyncDatabaseEncodeOptions extends ContactsSyncEncodeCommonOptions {
  message?: never;
  database: {
    source: ContactsSyncDatabaseSource;
    knownClocks?: ContactsSyncClock[];
    requestReply?: boolean;
  };
}

export type ContactsSyncEncodeOptions =
  | ContactsSyncMessageEncodeOptions
  | ContactsSyncDatabaseEncodeOptions;

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
  databaseSource?: ContactsSyncDatabaseSource;
}

export interface ContactsSyncAppliedStateResult {
  version: 1;
  type: 'applied-state';
  changed: boolean;
  clocks: ContactsSyncClock[];
  requestReply?: boolean;
}

export type ContactsSyncDecodeResult = ContactsSyncStateMessage | ContactsSyncAppliedStateResult;

export interface ContactsSyncEncodeResult {
  frames: ContactsSyncCipherChunkFrame[];
  materialized: boolean;
}

export interface ContactsSyncEncodedPayload {
  transferId: string;
  total: number;
  iv: string;
  tag: string;
  ciphertext: Uint8Array<ArrayBuffer>;
  materialized: boolean;
}

export interface ContactsSyncCodec {
  encode(
    options: ContactsSyncEncodeOptions,
    signal?: AbortSignal,
  ): Promise<ContactsSyncEncodeResult>;
  decode(
    options: ContactsSyncDecodeOptions,
    signal?: AbortSignal,
  ): Promise<ContactsSyncDecodeResult>;
}

export type ContactsSyncCodecWorkerRequest = {
  id: string;
  cancellation?: SharedArrayBuffer;
} &
  (
    | { type: 'encode'; options: ContactsSyncEncodeOptions }
    | { type: 'decode'; options: ContactsSyncDecodeOptions }
    | { type: 'prepare'; source: ContactsSyncDatabaseSource }
  );

export interface ContactsSyncCodecWorkerResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export function encodeContactsSyncMessageInProcess(
  options: ContactsSyncMessageEncodeOptions,
): ContactsSyncEncodeResult {
  const payload = encodeContactsSyncJsonInProcess(
    Buffer.from(JSON.stringify(options.message), 'utf8'),
    options,
  );
  return {
    frames: createContactsSyncFrames(payload, options.ownPublicKey),
    materialized: false,
  };
}

export function encodeContactsSyncJsonInProcess(
  json: Uint8Array,
  options: ContactsSyncEncodeCommonOptions,
  materialized = false,
): ContactsSyncEncodedPayload {
  if (json.byteLength > CONTACTS_SYNC_MAX_DECOMPRESSED_BYTES) {
    throw new Error(`contacts sync state is too large (${json.byteLength} decompressed bytes)`);
  }
  const transferId = randomUUID();
  const compressed = gzipSync(json);
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
  const ciphertext = copyBytes(encrypted.ciphertext);
  return { transferId, total, iv: encrypted.iv, tag: encrypted.tag, ciphertext, materialized };
}

export function createContactsSyncFrames(
  payload: ContactsSyncEncodedPayload,
  senderPublicKey: string,
): ContactsSyncCipherChunkFrame[] {
  const frames: ContactsSyncCipherChunkFrame[] = [];
  const ciphertext = Buffer.from(payload.ciphertext);
  for (let index = 0; index < payload.total; index += 1) {
    frames.push({
      version: CONTACTS_SYNC_WIRE_VERSION,
      type: 'cipher-chunk',
      senderPublicKey,
      transferId: payload.transferId,
      index,
      total: payload.total,
      iv: payload.iv,
      tag: payload.tag,
      compression: 'gzip',
      data: ciphertext
        .subarray(
          index * CONTACTS_SYNC_CHUNK_BYTES,
          Math.min((index + 1) * CONTACTS_SYNC_CHUNK_BYTES, ciphertext.length),
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
  const json = gunzipSync(compressed, {
    maxOutputLength: CONTACTS_SYNC_MAX_DECOMPRESSED_BYTES,
  }).toString('utf8');
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
  encode: async (options) => {
    if (!options.message) throw new Error('in-process contacts codec requires a message');
    return encodeContactsSyncMessageInProcess(options);
  },
  decode: async (options) => decodeContactsSyncMessageInProcess(options),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function copyBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}
