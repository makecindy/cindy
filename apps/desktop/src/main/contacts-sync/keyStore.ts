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
import path from 'node:path';

import { getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import { createBetterSqliteDatabase } from '../localDb/betterSqliteFactory.js';
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
    const file = this.requireFile();
    return withKeyFileLock(file, () => {
      // 共享 userData 的另一实例可能刚写入新 pin；锁内强制从磁盘取最新基线，
      // 不能用本实例缓存做 read-modify-write，否则会静默覆盖对方的 pin。
      const data = this.readOrCreateLocked(file);
      this.loadedPath = file;
      this.data = data;
      const current = data.peers[deviceId];
      if (current === publicKey) return false;
      if (current) throw new Error('contacts sync peer identity changed');
      const next: StoredContactsSyncKeys = {
        ...data,
        peers: { ...data.peers, [deviceId]: publicKey },
      };
      this.persistLocked(file, next);
      this.loadedPath = file;
      this.data = next;
      return true;
    });
  }

  resetMemory(): void {
    this.loadedPath = null;
    this.data = null;
  }

  private load(): StoredContactsSyncKeys {
    const file = this.requireFile();
    if (this.loadedPath !== file) {
      this.loadedPath = file;
      this.data = null;
    }
    if (this.data) return this.data;

    return withKeyFileLock(file, () => {
      // exists/read/create 都在同一把跨进程锁内；等待者拿锁后必须重读，保证多个
      // Desktop 实例首次启用时最终采用同一份设备身份。
      const data = this.readOrCreateLocked(file);
      this.loadedPath = file;
      this.data = data;
      return data;
    });
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
 * 密钥 API 为同步调用（握手验签和 LAN allowlist 都依赖它），因此临界区也保持
 * 同步。SQLite 的进程级写锁负责等待与崩溃自动释放，避免自制 lockfile 在多个
 * 等待者同时接管陈旧锁时出现 compare-then-unlink 竞态；超时后 fail closed。
 */
function withKeyFileLock<T>(file: string, task: () => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lockDbPath = `${file}.lock.sqlite`;
  // 统一走 Desktop factory：dev Electron 需要显式选择 Electron ABI 的 native binding，
  // packaged 路径和数据库文件权限也由同一入口处理。
  const db = createBetterSqliteDatabase(lockDbPath);
  try {
    db.pragma(`busy_timeout = ${LOCK_WAIT_MS}`);
    db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      // 首次创建也在同一事务内；后续 BEGIN IMMEDIATE 会由 SQLite 串行化。
      db.exec(`
        CREATE TABLE IF NOT EXISTS contacts_sync_key_mutex (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
        );
        INSERT OR IGNORE INTO contacts_sync_key_mutex(singleton) VALUES (1);
      `);
      const result = task();
      db.exec('COMMIT');
      committed = true;
      return result;
    } finally {
      if (!committed && db.inTransaction) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // close 仍会释放 SQLite 进程锁；保留原始业务异常。
        }
      }
    }
  } finally {
    try {
      db.close();
    } catch {
      // close 失败不能覆盖密钥读写的原始结果或异常。
    }
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
