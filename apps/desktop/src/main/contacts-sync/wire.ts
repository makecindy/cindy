/**
 * 智能通讯录同步的设备间 wire 格式。
 *
 * relay 和局域网 TCP 都只搬运这里定义的帧。通讯录状态先 gzip，再作为一个整体
 * AES-GCM 加密，最后切片；接收端收齐全部切片后才解密/解压/解析。
 */

import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  decryptContactsSyncBytes,
  encryptContactsSyncBytes,
  isValidContactsSyncPublicKey,
  type ContactsSyncEncryptionContext,
} from './crypto.js';

export const CONTACTS_SYNC_WIRE_VERSION = 1;
export const DL_CONTACTS_SYNC_CHANNEL = 'device-link:contacts:sync:v1';

const CHUNK_BYTES = 256 * 1024;
const MAX_CHUNKS = 128;
const MAX_COMPRESSED_BYTES = CHUNK_BYTES * MAX_CHUNKS;
const MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_ACTIVE_TRANSFERS_PER_PEER = 4;
const TRANSFER_TTL_MS = 2 * 60 * 1000;

export interface ContactsSyncKeyFrame {
  version: typeof CONTACTS_SYNC_WIRE_VERSION;
  type: 'key';
  publicKey: string;
}

export interface ContactsSyncCipherChunkFrame {
  version: typeof CONTACTS_SYNC_WIRE_VERSION;
  type: 'cipher-chunk';
  senderPublicKey: string;
  transferId: string;
  index: number;
  total: number;
  iv: string;
  tag: string;
  compression: 'gzip';
  data: string;
}

export type ContactsSyncWireFrame = ContactsSyncKeyFrame | ContactsSyncCipherChunkFrame;

export interface ContactsSyncStateMessage {
  version: 1;
  type: 'state';
  state: unknown;
  requestReply?: boolean;
}

interface PendingTransfer {
  createdAt: number;
  senderPublicKey: string;
  total: number;
  iv: string;
  tag: string;
  chunks: Map<number, Buffer>;
  totalBytes: number;
}

export function createContactsSyncKeyFrame(publicKey: string): ContactsSyncKeyFrame {
  if (!isValidContactsSyncPublicKey(publicKey)) throw new Error('invalid contacts sync public key');
  return { version: CONTACTS_SYNC_WIRE_VERSION, type: 'key', publicKey };
}

export function encodeContactsSyncMessage(options: {
  message: ContactsSyncStateMessage;
  ownPrivateKey: string;
  ownPublicKey: string;
  peerPublicKey: string;
  srcDeviceId: string;
  dstDeviceId: string;
}): ContactsSyncCipherChunkFrame[] {
  const transferId = randomUUID();
  const compressed = gzipSync(Buffer.from(JSON.stringify(options.message), 'utf8'));
  if (compressed.length > MAX_COMPRESSED_BYTES) {
    throw new Error(`contacts sync state is too large (${compressed.length} compressed bytes)`);
  }
  const total = Math.max(1, Math.ceil(compressed.length / CHUNK_BYTES));
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
          index * CHUNK_BYTES,
          Math.min((index + 1) * CHUNK_BYTES, encrypted.ciphertext.length),
        )
        .toString('base64'),
    });
  }
  return frames;
}

export function isContactsSyncWireFrame(value: unknown): value is ContactsSyncWireFrame {
  if (!isRecord(value) || value.version !== CONTACTS_SYNC_WIRE_VERSION) return false;
  if (value.type === 'key') return isValidContactsSyncPublicKey(value.publicKey);
  if (value.type !== 'cipher-chunk') return false;
  return (
    isValidContactsSyncPublicKey(value.senderPublicKey) &&
    isBoundedText(value.transferId, 128) &&
    Number.isInteger(value.index) &&
    (value.index as number) >= 0 &&
    Number.isInteger(value.total) &&
    (value.total as number) >= 1 &&
    (value.total as number) <= MAX_CHUNKS &&
    (value.index as number) < (value.total as number) &&
    isBoundedText(value.iv, 64) &&
    isBoundedText(value.tag, 64) &&
    value.compression === 'gzip' &&
    isBoundedText(value.data, Math.ceil((CHUNK_BYTES * 4) / 3) + 8)
  );
}

export class ContactsSyncWireDecoder {
  private readonly pending = new Map<string, PendingTransfer>();

  accept(options: {
    srcDeviceId: string;
    dstDeviceId: string;
    frame: ContactsSyncCipherChunkFrame;
    ownPrivateKey: string;
    expectedPeerPublicKey: string;
    now?: number;
  }): ContactsSyncStateMessage | null {
    const now = options.now ?? Date.now();
    this.prune(now);
    const frame = options.frame;
    if (frame.senderPublicKey !== options.expectedPeerPublicKey) {
      throw new Error('contacts sync peer key mismatch');
    }
    const chunk = decodeCanonicalBase64(frame.data);
    if (chunk.length > CHUNK_BYTES) throw new Error('contacts sync chunk is too large');

    const key = `${options.srcDeviceId}\u0000${frame.transferId}`;
    let transfer = this.pending.get(key);
    if (!transfer) {
      const activeForPeer = [...this.pending.keys()].filter((item) =>
        item.startsWith(`${options.srcDeviceId}\u0000`),
      );
      if (activeForPeer.length >= MAX_ACTIVE_TRANSFERS_PER_PEER) {
        this.pending.delete(activeForPeer[0]!);
      }
      transfer = {
        createdAt: now,
        senderPublicKey: frame.senderPublicKey,
        total: frame.total,
        iv: frame.iv,
        tag: frame.tag,
        chunks: new Map(),
        totalBytes: 0,
      };
      this.pending.set(key, transfer);
    } else if (
      transfer.senderPublicKey !== frame.senderPublicKey ||
      transfer.total !== frame.total ||
      transfer.iv !== frame.iv ||
      transfer.tag !== frame.tag
    ) {
      this.pending.delete(key);
      throw new Error('contacts sync transfer metadata changed');
    }

    if (!transfer.chunks.has(frame.index)) {
      transfer.chunks.set(frame.index, chunk);
      transfer.totalBytes += chunk.length;
      if (transfer.totalBytes > MAX_COMPRESSED_BYTES + 32) {
        this.pending.delete(key);
        throw new Error('contacts sync transfer is too large');
      }
    }
    if (transfer.chunks.size !== transfer.total) return null;

    this.pending.delete(key);
    const ciphertext = Buffer.concat(
      Array.from({ length: transfer.total }, (_, index) => {
        const value = transfer!.chunks.get(index);
        if (!value) throw new Error('contacts sync transfer has a missing chunk');
        return value;
      }),
    );
    const context: ContactsSyncEncryptionContext = {
      srcDeviceId: options.srcDeviceId,
      dstDeviceId: options.dstDeviceId,
      transferId: frame.transferId,
      totalChunks: frame.total,
    };
    const compressed = decryptContactsSyncBytes(
      { iv: transfer.iv, tag: transfer.tag, ciphertext },
      options.ownPrivateKey,
      options.expectedPeerPublicKey,
      context,
    );
    const json = gunzipSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_BYTES }).toString(
      'utf8',
    );
    const message: unknown = JSON.parse(json);
    if (!isContactsSyncStateMessage(message)) throw new Error('invalid contacts sync message');
    return message;
  }

  reset(): void {
    this.pending.clear();
  }

  private prune(now: number): void {
    for (const [key, transfer] of this.pending) {
      if (now - transfer.createdAt > TRANSFER_TTL_MS) this.pending.delete(key);
    }
  }
}

function isContactsSyncStateMessage(value: unknown): value is ContactsSyncStateMessage {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    value.type === 'state' &&
    value.state !== undefined &&
    (value.requestReply === undefined || typeof value.requestReply === 'boolean')
  );
}

function decodeCanonicalBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('invalid contacts sync chunk encoding');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error('invalid contacts sync chunk encoding');
  return decoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
