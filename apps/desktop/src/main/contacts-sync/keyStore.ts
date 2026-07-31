/**
 * 通讯录同步设备密钥的 owner-scoped 安全落盘。
 *
 * 私钥和首次见到的对端公钥一起由 Electron safeStorage 加密；明文只存在于 main
 * 进程内存。对同一 deviceId 的公钥采用 TOFU pin：首次记录，之后变化即拒绝，
 * 防止普通中转链路在后续连接中替换设备身份。
 */

import { safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import {
  generateContactsSyncIdentity,
  isValidContactsSyncPublicKey,
  publicKeyFromPrivate,
  type ContactsSyncExportedIdentity,
} from './crypto.js';

const STORE_VERSION = 1;
const FILE_NAME = 'contacts-device-sync-key.v1.enc';
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

interface StoredContactsSyncKeys extends ContactsSyncExportedIdentity {
  version: typeof STORE_VERSION;
  peers: Record<string, string>;
}

export interface ContactsSyncKeyStoreDeps {
  filePath(): string | null;
  isEncryptionAvailable(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

export class ContactsSyncKeyStore {
  private loadedPath: string | null = null;
  private data: StoredContactsSyncKeys | null = null;

  constructor(private readonly deps: ContactsSyncKeyStoreDeps = desktopDeps) {}

  getIdentity(): ContactsSyncExportedIdentity {
    const data = this.load();
    return { publicKey: data.publicKey, privateKey: data.privateKey };
  }

  getPeerPublicKey(deviceId: string): string | null {
    assertDeviceId(deviceId);
    return this.load().peers[deviceId] ?? null;
  }

  /**
   * 首次见到该 deviceId 时落盘；已有 pin 一致返回 false，不一致 fail closed。
   */
  pinPeerPublicKey(deviceId: string, publicKey: string): boolean {
    assertDeviceId(deviceId);
    if (!isValidContactsSyncPublicKey(publicKey)) {
      throw new Error('invalid contacts sync peer public key');
    }
    const data = this.load();
    const current = data.peers[deviceId];
    if (current === publicKey) return false;
    if (current) throw new Error('contacts sync peer identity changed');
    const next: StoredContactsSyncKeys = {
      ...data,
      peers: { ...data.peers, [deviceId]: publicKey },
    };
    this.persist(next);
    this.data = next;
    return true;
  }

  resetMemory(): void {
    this.loadedPath = null;
    this.data = null;
  }

  private load(): StoredContactsSyncKeys {
    const file = this.deps.filePath();
    if (!file) throw new Error('contacts sync requires an authenticated owner');
    if (!this.deps.isEncryptionAvailable()) {
      throw new Error('secure storage is unavailable for contacts sync');
    }
    if (this.loadedPath !== file) {
      this.loadedPath = file;
      this.data = null;
    }
    if (this.data) return this.data;

    if (!fs.existsSync(file)) {
      const identity = generateContactsSyncIdentity();
      const created: StoredContactsSyncKeys = {
        version: STORE_VERSION,
        ...identity,
        peers: {},
      };
      this.persist(created);
      this.data = created;
      return created;
    }

    try {
      const encoded = fs.readFileSync(file, 'utf8');
      const plaintext = this.deps.decrypt(Buffer.from(encoded, 'base64'));
      const parsed: unknown = JSON.parse(plaintext);
      if (!isStoredKeys(parsed)) throw new Error('invalid contacts sync key document');
      if (publicKeyFromPrivate(parsed.privateKey) !== parsed.publicKey) {
        throw new Error('contacts sync public/private key mismatch');
      }
      this.data = parsed;
      return parsed;
    } catch (error) {
      throw new Error('stored contacts sync device key is unreadable', { cause: error });
    }
  }

  private persist(data: StoredContactsSyncKeys): void {
    const file = this.deps.filePath();
    if (!file) throw new Error('contacts sync requires an authenticated owner');
    if (!this.deps.isEncryptionAvailable()) {
      throw new Error('secure storage is unavailable for contacts sync');
    }
    const temp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, this.deps.encrypt(JSON.stringify(data)).toString('base64'), {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temp, file);
  }
}

function isStoredKeys(value: unknown): value is StoredContactsSyncKeys {
  if (!isRecord(value) || value.version !== STORE_VERSION) return false;
  if (
    !isValidContactsSyncPublicKey(value.publicKey) ||
    typeof value.privateKey !== 'string' ||
    value.privateKey.length > 512 ||
    !isRecord(value.peers)
  ) {
    return false;
  }
  const peers = Object.entries(value.peers);
  return (
    peers.length <= 1_000 &&
    peers.every(
      ([deviceId, publicKey]) =>
        DEVICE_ID_PATTERN.test(deviceId) && isValidContactsSyncPublicKey(publicKey),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertDeviceId(deviceId: string): void {
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error('invalid contacts sync device id');
}

const desktopDeps: ContactsSyncKeyStoreDeps = {
  filePath: () => (getActiveAppSession().dataOwnerId ? ownerScopedUserDataPath(FILE_NAME) : null),
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plaintext) => safeStorage.encryptString(plaintext),
  decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
};

export const contactsSyncKeyStore = new ContactsSyncKeyStore();
