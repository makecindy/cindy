/**
 * 智能通讯录同步的设备间 wire 格式。
 *
 * relay 和局域网 TCP 都只搬运这里定义的帧。Main 只做有界分片组装；完整状态的
 * JSON/gzip/加解密由专用 worker 完成，避免大通讯录阻塞 Electron 事件循环。
 */

import {
  CONTACTS_SYNC_CHUNK_BYTES,
  CONTACTS_SYNC_WIRE_VERSION,
  DL_CONTACTS_SYNC_CHANNEL,
  isContactsSyncWireFrame as isSharedContactsSyncWireFrame,
  type ContactsSyncCipherChunkFrame,
  type ContactsSyncKeyFrame,
  type ContactsSyncWireFrame,
} from '@cindy/device-link';

import { isValidContactsSyncPublicKey } from './crypto.js';
import {
  CONTACTS_SYNC_MAX_COMPRESSED_BYTES,
  type ContactsSyncCodec,
  type ContactsSyncDatabaseEncodeOptions,
  type ContactsSyncDatabaseSource,
  type ContactsSyncDecodeResult,
  type ContactsSyncEncodeResult,
  type ContactsSyncEncodeOptions,
  type ContactsSyncStateMessage,
} from './contactsSyncCodec.js';
import { workerContactsSyncCodec } from './contactsSyncCodecWorkerClient.js';

export { CONTACTS_SYNC_WIRE_VERSION, DL_CONTACTS_SYNC_CHANNEL };
export type { ContactsSyncCipherChunkFrame, ContactsSyncKeyFrame, ContactsSyncWireFrame };
export type { ContactsSyncStateMessage };

const MAX_ACTIVE_TRANSFERS_PER_PEER = 4;
const TRANSFER_TTL_MS = 2 * 60 * 1000;

interface PendingTransfer {
  lastActivityAt: number;
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

export function encodeContactsSyncMessage(
  options: ContactsSyncEncodeOptions & { signal?: AbortSignal },
  codec: ContactsSyncCodec = workerContactsSyncCodec,
): Promise<ContactsSyncCipherChunkFrame[]> {
  const { signal, ...codecOptions } = options;
  return codec.encode(codecOptions, signal).then((result) => result.frames);
}

export function encodeContactsSyncDatabaseState(
  options: ContactsSyncDatabaseEncodeOptions & { signal?: AbortSignal },
  codec: ContactsSyncCodec = workerContactsSyncCodec,
): Promise<ContactsSyncEncodeResult> {
  const { signal, ...codecOptions } = options;
  return codec.encode(codecOptions, signal);
}

export function isContactsSyncWireFrame(value: unknown): value is ContactsSyncWireFrame {
  if (!isSharedContactsSyncWireFrame(value)) return false;
  return isValidContactsSyncPublicKey(
    value.type === 'key' ? value.publicKey : value.senderPublicKey,
  );
}

export class ContactsSyncWireDecoder {
  private readonly pending = new Map<string, PendingTransfer>();
  private readonly decoding = new Map<string, symbol>();
  private decodeAbortController = new AbortController();
  private generation = 0;

  constructor(private readonly codec: ContactsSyncCodec = workerContactsSyncCodec) {}

  async accept(options: {
    srcDeviceId: string;
    dstDeviceId: string;
    frame: ContactsSyncCipherChunkFrame;
    ownPrivateKey: string;
    expectedPeerPublicKey: string;
    databaseSource?: ContactsSyncDatabaseSource;
    now?: number;
  }): Promise<ContactsSyncDecodeResult | null> {
    const now = options.now ?? Date.now();
    this.prune(now);
    const frame = options.frame;
    if (frame.senderPublicKey !== options.expectedPeerPublicKey) {
      throw new Error('contacts sync peer key mismatch');
    }
    const chunk = decodeCanonicalBase64(frame.data);
    if (chunk.length > CONTACTS_SYNC_CHUNK_BYTES) {
      throw new Error('contacts sync chunk is too large');
    }

    const key = `${options.srcDeviceId}\u0000${frame.transferId}`;
    if (this.decoding.has(key)) return null;
    let transfer = this.pending.get(key);
    if (!transfer) {
      const peerPrefix = `${options.srcDeviceId}\u0000`;
      const pendingForPeer = [...this.pending].filter(([item]) => item.startsWith(peerPrefix));
      const decodingForPeer = [...this.decoding.keys()].filter((item) =>
        item.startsWith(peerPrefix),
      ).length;
      if (pendingForPeer.length + decodingForPeer >= MAX_ACTIVE_TRANSFERS_PER_PEER) {
        const oldestPending = pendingForPeer.reduce<[string, PendingTransfer] | undefined>(
          (oldest, candidate) =>
            !oldest || candidate[1].lastActivityAt < oldest[1].lastActivityAt ? candidate : oldest,
          undefined,
        );
        if (!oldestPending) return null;
        this.pending.delete(oldestPending[0]);
      }
      transfer = {
        lastActivityAt: now,
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
      transfer.lastActivityAt = now;
      if (transfer.totalBytes > CONTACTS_SYNC_MAX_COMPRESSED_BYTES + 32) {
        this.pending.delete(key);
        throw new Error('contacts sync transfer is too large');
      }
    }
    if (transfer.chunks.size !== transfer.total) return null;

    this.pending.delete(key);
    const decodeToken = Symbol(key);
    const generation = this.generation;
    const decodeSignal = this.decodeAbortController.signal;
    this.decoding.set(key, decodeToken);
    const ciphertext = Buffer.concat(
      Array.from({ length: transfer.total }, (_, index) => {
        const value = transfer!.chunks.get(index);
        if (!value) throw new Error('contacts sync transfer has a missing chunk');
        return value;
      }),
    );
    try {
      const message = await this.codec.decode(
        {
          ciphertext,
          iv: transfer.iv,
          tag: transfer.tag,
          ownPrivateKey: options.ownPrivateKey,
          expectedPeerPublicKey: options.expectedPeerPublicKey,
          srcDeviceId: options.srcDeviceId,
          dstDeviceId: options.dstDeviceId,
          transferId: frame.transferId,
          totalChunks: frame.total,
          ...(options.databaseSource ? { databaseSource: options.databaseSource } : {}),
        },
        decodeSignal,
      );
      return generation === this.generation ? message : null;
    } finally {
      if (this.decoding.get(key) === decodeToken) this.decoding.delete(key);
    }
  }

  reset(): void {
    this.generation += 1;
    this.decodeAbortController.abort();
    this.decodeAbortController = new AbortController();
    this.pending.clear();
    this.decoding.clear();
  }

  private prune(now: number): void {
    for (const [key, transfer] of this.pending) {
      if (now - transfer.lastActivityAt > TRANSFER_TTL_MS) this.pending.delete(key);
    }
  }
}

function decodeCanonicalBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('invalid contacts sync chunk encoding');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new Error('invalid contacts sync chunk encoding');
  return decoded;
}
