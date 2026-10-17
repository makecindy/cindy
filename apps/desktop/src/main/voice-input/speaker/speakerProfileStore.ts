import fs from 'node:fs';
import path from 'node:path';

import { speakerModelAsset } from '@cindy/voice-input-core';

export type SpeakerProfileCipher = {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
};

export type SpeakerProfile = {
  embedding: Float32Array;
  createdAt: number;
};

type StoredFile = {
  version: 1;
  /** safeStorage ciphertext of {@link StoredPayload}, base64. */
  data: string;
};

type StoredPayload = {
  embedding: number[];
  createdAt: number;
  /** Embedding model that produced the voiceprint; another model cannot compare it. */
  modelSha256: string;
};

const MAX_FILE_BYTES = 64 * 1024;
const MAX_EMBEDDING_DIM = 4096;

/**
 * The enrolled voiceprint of this device's user, one per account.
 *
 * It is biometric data: it stays on this device (never synced or uploaded),
 * is encrypted with the OS keychain through safeStorage, and is dropped as
 * soon as the user deletes it. A voiceprint from another embedding model
 * reads as "not enrolled" so the user records again.
 */
export class SpeakerProfileStore {
  private cache: { file: string; profile: SpeakerProfile } | null = null;

  constructor(
    private readonly filePath: () => string,
    private readonly cipher: SpeakerProfileCipher,
  ) {}

  read(): SpeakerProfile | null {
    const file = this.filePath();
    if (this.cache?.file === file) return this.cache.profile;
    // Recover abandoned atomic writes after a crash. A busy/locked file can be
    // retried later; it must not make the committed profile unreadable.
    try { this.removeTemporaryFiles(file, true); } catch { /* Retried on delete/write. */ }
    const profile = this.load(file);
    // A failed read (e.g. keychain still locked) is retried next time.
    this.cache = profile ? { file, profile } : null;
    return profile;
  }

  /** Throws when the OS keychain is unavailable; nothing is written then. */
  write(embedding: Float32Array, createdAt = Date.now()): SpeakerProfile {
    if (!this.cipher.isAvailable()) throw new SpeakerProfileStorageUnavailableError();
    const payload: StoredPayload = {
      embedding: Array.from(embedding),
      createdAt,
      modelSha256: speakerModelAsset('embedding').sha256,
    };
    const stored: StoredFile = {
      version: 1,
      data: this.cipher.encrypt(JSON.stringify(payload)).toString('base64'),
    };
    const file = this.filePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { this.removeTemporaryFiles(file, true); } catch { /* Explicit delete reports failures. */ }
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } finally {
      // Includes a partial write or failed rename; preserve the original I/O
      // error if cleanup also fails. Startup/delete retry any remaining file.
      try { fs.rmSync(tmp, { force: true }); } catch { /* Retried on read/write/delete. */ }
    }
    const profile = { embedding: Float32Array.from(embedding), createdAt };
    this.cache = { file, profile };
    return profile;
  }

  delete(): void {
    const file = this.filePath();
    this.cache = null;
    const errors: unknown[] = [];
    try { fs.rmSync(file, { force: true }); } catch (error) { errors.push(error); }
    try { this.removeTemporaryFiles(file, false); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Speaker profile cleanup failed');
  }

  private removeTemporaryFiles(file: string, staleOnly: boolean): void {
    const dir = path.dirname(file);
    const prefix = `${path.basename(file)}.`;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const errors: unknown[] = [];
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      const pidText = name.slice(prefix.length, -4);
      if (!/^[1-9]\d*$/.test(pidText)) continue;
      const pid = Number(pidText);
      if (staleOnly && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          continue; // Another instance may be in the middle of its atomic write.
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
        }
      }
      try { fs.rmSync(path.join(dir, name), { force: true }); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Speaker profile temporary cleanup failed');
  }

  private load(file: string): SpeakerProfile | null {
    let raw: string;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      return null;
    }
    try {
      const stored = JSON.parse(raw) as Partial<StoredFile>;
      if (stored.version !== 1 || typeof stored.data !== 'string') return null;
      const payload = JSON.parse(this.cipher.decrypt(Buffer.from(stored.data, 'base64'))) as Partial<StoredPayload>;
      if (payload.modelSha256 !== speakerModelAsset('embedding').sha256) return null;
      const embedding = payload.embedding;
      if (
        !Array.isArray(embedding) ||
        embedding.length === 0 ||
        embedding.length > MAX_EMBEDDING_DIM ||
        !embedding.every((value) => typeof value === 'number' && Number.isFinite(value))
      ) {
        return null;
      }
      return {
        embedding: Float32Array.from(embedding),
        createdAt: typeof payload.createdAt === 'number' ? payload.createdAt : 0,
      };
    } catch {
      // Unreadable (keychain locked, other profile's key, corrupt): treat as
      // not enrolled. The gate stays off; the user can record again.
      return null;
    }
  }
}

export class SpeakerProfileStorageUnavailableError extends Error {
  constructor() {
    super('secure storage is unavailable');
    this.name = 'SpeakerProfileStorageUnavailableError';
  }
}
