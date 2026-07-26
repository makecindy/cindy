import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** OS-backed secret storage boundary. Callers receive no secret from config or logs. */
export interface HeadlessSecretStore {
  get(ref: string): Promise<string | null>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

/**
 * Linux Secret Service adapter. `secret-tool` sends secret values only on
 * stdin, never in argv, the config file, or process logs.
 */
export class SecretToolSecretStore implements HeadlessSecretStore {
  constructor(private readonly command = 'secret-tool') {}

  async get(ref: string): Promise<string | null> {
    assertSecretRef(ref);
    const result = await runSecretTool(this.command, ['lookup', 'service', 'cindy-headless', 'ref', ref]);
    if (result.code === 1) return null;
    if (result.code !== 0) throw new Error('Secret Service is unavailable; install and unlock a Secret Service provider');
    const value = result.stdout.trim();
    return value || null;
  }

  async set(ref: string, value: string): Promise<void> {
    assertSecretRef(ref);
    if (!value.trim()) throw new Error('Secret value must not be empty');
    const result = await runSecretTool(
      this.command,
      ['store', '--label=Cindy headless provider credential', 'service', 'cindy-headless', 'ref', ref],
      value,
    );
    if (result.code !== 0) throw new Error('Secret Service is unavailable; install and unlock a Secret Service provider');
  }

  async delete(ref: string): Promise<void> {
    assertSecretRef(ref);
    const result = await runSecretTool(this.command, ['clear', 'service', 'cindy-headless', 'ref', ref]);
    if (result.code !== 0 && result.code !== 1) throw new Error('Secret Service is unavailable; install and unlock a Secret Service provider');
  }
}

export class MemorySecretStore implements HeadlessSecretStore {
  private readonly values = new Map<string, string>();
  async get(ref: string): Promise<string | null> { return this.values.get(ref) ?? null; }
  async set(ref: string, value: string): Promise<void> { this.values.set(ref, value); }
  async delete(ref: string): Promise<void> { this.values.delete(ref); }
}

type VaultEntry = { iv: string; tag: string; ciphertext: string };
type VaultDocument = { version: 1; entries: Record<string, VaultEntry> };

/**
 * Server fallback for hosts without a DBus Secret Service. The vault is
 * AES-256-GCM encrypted and both it and its randomly generated key are kept
 * outside config, with restrictive permissions. This protects against casual
 * disk/config disclosure; it is deliberately not claimed to protect against
 * an attacker who already controls this Unix account or root.
 */
export class EncryptedFileSecretStore implements HeadlessSecretStore {
  constructor(
    private readonly vaultFile: string,
    private readonly keyFile: string,
  ) {}

  async get(ref: string): Promise<string | null> {
    assertSecretRef(ref);
    const vault = await this.readVault();
    const entry = vault?.entries[ref];
    if (!entry) return null;
    const key = await this.readExistingKey();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
      decipher.setAAD(Buffer.from(`cindy-headless:${ref}`, 'utf8'));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Encrypted credential vault cannot be decrypted');
    }
  }

  async set(ref: string, value: string): Promise<void> {
    assertSecretRef(ref);
    if (!value.trim()) throw new Error('Secret value must not be empty');
    const [vault, key] = await Promise.all([this.readVault(), this.ensureKey()]);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`cindy-headless:${ref}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const next: VaultDocument = {
      version: 1,
      entries: {
        ...(vault?.entries ?? {}),
        [ref]: { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') },
      },
    };
    await this.writeVault(next);
  }

  async delete(ref: string): Promise<void> {
    assertSecretRef(ref);
    const vault = await this.readVault();
    if (!vault?.entries[ref]) return;
    const entries = { ...vault.entries };
    delete entries[ref];
    await this.writeVault({ version: 1, entries });
  }

  private async readVault(): Promise<VaultDocument | null> {
    try {
      const value = JSON.parse(await readFile(this.vaultFile, 'utf8')) as unknown;
      if (!isVaultDocument(value)) throw new Error('Encrypted credential vault is malformed');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async readExistingKey(): Promise<Buffer> {
    try {
      const key = await readFile(this.keyFile);
      if (key.byteLength !== 32) throw new Error('Encrypted credential vault key is invalid');
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('Encrypted credential vault key is missing');
      }
      throw error;
    }
  }

  private async ensureKey(): Promise<Buffer> {
    try {
      return await this.readExistingKey();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Encrypted credential vault key is missing') throw error;
      await mkdir(path.dirname(this.keyFile), { recursive: true, mode: 0o700 });
      const key = randomBytes(32);
      try {
        await writeFile(this.keyFile, key, { mode: 0o400, flag: 'wx' });
        await chmod(this.keyFile, 0o400);
        return key;
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        return this.readExistingKey();
      }
    }
  }

  private async writeVault(vault: VaultDocument): Promise<void> {
    await mkdir(path.dirname(this.vaultFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.vaultFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(vault)}\n`, { mode: 0o600, flag: 'wx' });
      await chmod(temporary, 0o600);
      await rename(temporary, this.vaultFile);
      await chmod(this.vaultFile, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

/** Prefer a desktop Secret Service when present, transparently retaining a safe server fallback otherwise. */
export class ResilientSecretStore implements HeadlessSecretStore {
  constructor(
    private readonly primary: HeadlessSecretStore,
    private readonly fallback: HeadlessSecretStore,
  ) {}

  async get(ref: string): Promise<string | null> {
    try {
      const value = await this.primary.get(ref);
      if (value) return value;
    } catch {
      // A headless host normally has no DBus Secret Service. The encrypted
      // vault remains available without turning that expected condition into
      // a login failure.
    }
    return this.fallback.get(ref);
  }

  async set(ref: string, value: string): Promise<void> {
    try {
      await this.primary.set(ref, value);
      await this.fallback.delete(ref).catch(() => undefined);
    } catch {
      await this.fallback.set(ref, value);
    }
  }

  async delete(ref: string): Promise<void> {
    const results = await Promise.allSettled([this.primary.delete(ref), this.fallback.delete(ref)]);
    if (results.every((result) => result.status === 'rejected')) {
      throw new Error('No credential store is available');
    }
  }
}

function assertSecretRef(ref: string): void {
  if (!/^[a-z0-9_-]+$/.test(ref)) throw new Error('Secret reference must be a lowercase slug');
}

function isVaultDocument(value: unknown): value is VaultDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const document = value as Partial<VaultDocument>;
  if (document.version !== 1 || !document.entries || typeof document.entries !== 'object' || Array.isArray(document.entries)) return false;
  return Object.entries(document.entries).every(([ref, entry]) => {
    if (!/^[a-z0-9_-]+$/.test(ref) || !entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const encrypted = entry as Partial<VaultEntry>;
    return [encrypted.iv, encrypted.tag, encrypted.ciphertext].every((part) => typeof part === 'string' && part.length > 0);
  });
}

function runSecretTool(command: string, args: string[], input?: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
