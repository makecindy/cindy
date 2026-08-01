/**
 * 通讯录同步设备密钥的 owner-scoped 安全落盘。
 *
 * 私钥和首次见到的对端公钥一起由 Electron safeStorage 加密；明文只存在于 main
 * 进程内存。对同一 deviceId 的公钥采用 TOFU pin：首次记录，之后变化即拒绝，
 * 防止普通中转链路在后续连接中替换设备身份。
 */

import { safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import {
  generateContactsSyncIdentity,
  isValidContactsSyncPublicKey,
  publicKeyFromPrivate,
  type ContactsSyncExportedIdentity,
} from './crypto.js';

const STORE_VERSION = 1;
const FILE_NAME = 'contacts-device-sync-key.v1.enc';
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const LOCK_WAIT_MS = 12_000;
const MAX_PEER_PINS = 1_000;

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
  private generation = 0;

  constructor(private readonly deps: ContactsSyncKeyStoreDeps = desktopDeps) {}

  /**
   * 首次读/建密钥可能等待另一个 Desktop 实例，必须 await，不能阻塞 Electron Main。
   * 后续握手和加解密只读内存缓存，保持同步热路径。
   */
  async prepare(): Promise<void> {
    const file = this.requireFile();
    const generation = this.selectFile(file);
    if (this.data) return;
    await withKeyFileLock(file, () => {
      this.assertOperationCurrent(file, generation);
      const data = this.readOrCreateLocked(file);
      this.loadedPath = file;
      this.data = data;
    });
    this.assertOperationCurrent(file, generation);
  }

  getIdentity(): ContactsSyncExportedIdentity {
    const data = this.requireLoaded();
    return { publicKey: data.publicKey, privateKey: data.privateKey };
  }

  getPeerPublicKey(deviceId: string): string | null {
    assertDeviceId(deviceId);
    const file = this.deps.filePath();
    if (!file || !this.deps.isEncryptionAvailable()) return null;
    this.selectFile(file);
    // LAN stop / owner 切换可能与最后一个 socket 回调交错；未 prepare 时按“未 pin”拒绝，
    // 不能让一个迟到的 allowlist 查询因缓存已清空而向 EventEmitter 抛异常。
    return this.data?.peers[deviceId] ?? null;
  }

  /**
   * 首次见到该 deviceId 时落盘；已有 pin 一致返回 false，不一致 fail closed。
   */
  async pinPeerPublicKey(deviceId: string, publicKey: string): Promise<boolean> {
    assertDeviceId(deviceId);
    if (!isValidContactsSyncPublicKey(publicKey)) {
      throw new Error('invalid contacts sync peer public key');
    }
    const file = this.requireFile();
    const generation = this.selectFile(file);
    const result = await withKeyFileLock(file, () => {
      this.assertOperationCurrent(file, generation);
      // 共享 userData 的另一实例可能刚写入新 pin；锁内强制从磁盘取最新基线，
      // 不能用本实例缓存做 read-modify-write，否则会静默覆盖对方的 pin。
      const data = this.readOrCreateLocked(file);
      this.loadedPath = file;
      this.data = data;
      const current = data.peers[deviceId];
      if (current === publicKey) return false;
      if (current) throw new Error('contacts sync peer identity changed');
      if (Object.keys(data.peers).length >= MAX_PEER_PINS) {
        throw new Error('contacts sync peer limit exceeded');
      }
      const next: StoredContactsSyncKeys = {
        ...data,
        peers: { ...data.peers, [deviceId]: publicKey },
      };
      this.persistLocked(file, next);
      this.loadedPath = file;
      this.data = next;
      return true;
    });
    this.assertOperationCurrent(file, generation);
    return result;
  }

  resetMemory(): void {
    this.generation += 1;
    this.loadedPath = null;
    this.data = null;
  }

  private requireLoaded(): StoredContactsSyncKeys {
    const file = this.requireFile();
    this.selectFile(file);
    if (!this.data) throw new Error('contacts sync device key is not prepared');
    return this.data;
  }

  private selectFile(file: string): number {
    if (this.loadedPath !== file) {
      this.generation += 1;
      this.loadedPath = file;
      this.data = null;
    }
    return this.generation;
  }

  private assertOperationCurrent(file: string, generation: number): void {
    if (
      this.generation !== generation ||
      this.deps.filePath() !== file ||
      !this.deps.isEncryptionAvailable()
    ) {
      throw new Error('contacts sync key operation was invalidated');
    }
  }

  private requireFile(): string {
    const file = this.deps.filePath();
    if (!file) throw new Error('contacts sync requires an authenticated owner');
    if (!this.deps.isEncryptionAvailable()) {
      throw new Error('secure storage is unavailable for contacts sync');
    }
    return file;
  }

  /** 调用方必须持有 file 对应的锁。 */
  private readOrCreateLocked(file: string): StoredContactsSyncKeys {
    if (!fs.existsSync(file)) {
      const identity = generateContactsSyncIdentity();
      const created: StoredContactsSyncKeys = {
        version: STORE_VERSION,
        ...identity,
        peers: {},
      };
      this.persistLocked(file, created);
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
      return parsed;
    } catch (error) {
      throw new Error('stored contacts sync device key is unreadable', { cause: error });
    }
  }

  /** 调用方必须持有 file 对应的锁。 */
  private persistLocked(file: string, data: StoredContactsSyncKeys): void {
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(temp, this.deps.encrypt(JSON.stringify(data)).toString('base64'), {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.renameSync(temp, file);
    } finally {
      try {
        fs.unlinkSync(temp);
      } catch {
        // rename 成功后临时文件已不存在；失败时尽力清理，原文件保持不变。
      }
    }
  }
}

/**
 * 复用已有异步跨进程锁：等待只占 Promise，不阻塞 Electron Main。锁用 PID + mtime
 * 心跳确认陈旧 owner，释放前复核归属，避免多个等待者 compare-then-unlink；任何
 * busy / unavailable 都 fail closed，不能在没有互斥时读改写密钥文件。
 */
async function withKeyFileLock<T>(file: string, task: () => T): Promise<T> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  return withCrossProcessLock(
    `${file}.lock`,
    { label: 'contacts-sync-key', waitMs: LOCK_WAIT_MS },
    async (status) => {
      if (!status.held) {
        throw new Error(`contacts sync key lock ${status.reason}`);
      }
      return task();
    },
  );
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
    peers.length <= MAX_PEER_PINS &&
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
  isEncryptionAvailable: isDesktopContactsSyncSecureStorageAvailable,
  encrypt: (plaintext) => safeStorage.encryptString(plaintext),
  decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
};

export const contactsSyncKeyStore = new ContactsSyncKeyStore();

function isDesktopContactsSyncSecureStorageAvailable(): boolean {
  try {
    return isContactsSyncSecureStorageAvailable({
      platform: process.platform,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      backend:
        process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined,
    });
  } catch {
    return false;
  }
}

export function isContactsSyncSecureStorageAvailable(options: {
  platform: NodeJS.Platform;
  encryptionAvailable: boolean;
  backend?: string;
}): boolean {
  return (
    options.encryptionAvailable &&
    (options.platform !== 'linux' || options.backend !== 'basic_text')
  );
}
