import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { atomicPrivateWrite, atomicPrivateWriteSync, privateDirectory, readPrivateFile } from './platform.js';
import type { TerminalSecrets } from './contracts.js';

const deriveKey = promisify(scryptCallback);
type Envelope = { version: 1; mode: 'machine' | 'passphrase'; salt: string; iv: string; tag: string; data: string };

/** Authenticated encryption; all writes are serialized by the service owner. */
export class TerminalSecretStore implements TerminalSecrets {
  private key: Buffer | null = null;
  private envelope: Envelope | null = null;
  private values: Record<string, string> | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  private get vaultPath() { return path.join(this.directory, 'secrets.enc'); }
  private get keyPath() { return path.join(this.directory, 'machine.key'); }

  async open(): Promise<void> {
    await privateDirectory(this.directory);
    const raw = await readPrivateFile(this.vaultPath);
    if (!raw) return;
    const data = JSON.parse(raw.toString()) as Envelope;
    if (data.version !== 1 || !['machine', 'passphrase'].includes(data.mode) ||
        typeof data.salt !== 'string' || Buffer.from(data.salt, 'base64').length !== 32 ||
        typeof data.iv !== 'string' || Buffer.from(data.iv, 'base64').length !== 12 ||
        typeof data.tag !== 'string' || Buffer.from(data.tag, 'base64').length !== 16 ||
        typeof data.data !== 'string') throw new Error('VAULT_FORMAT_UNSUPPORTED');
    this.envelope = data;
    if (data.mode === 'machine') {
      const key = await readPrivateFile(this.keyPath);
      if (!key || key.length !== 32) throw new Error('VAULT_MACHINE_KEY_MISSING');
      this.decrypt(key);
    }
  }

  status() { return { initialized: Boolean(this.envelope), locked: this.values === null, mode: this.envelope?.mode ?? null }; }

  initialize(mode: 'machine' | 'passphrase', passphrase?: string): Promise<void> {
    const operation = this.pending.then(() => this.setup(mode, passphrase));
    this.pending = operation.catch(() => undefined);
    return operation;
  }

  private async setup(mode: 'machine' | 'passphrase', passphrase?: string): Promise<void> {
    if (this.envelope || await readPrivateFile(this.vaultPath)) throw new Error('VAULT_ALREADY_INITIALIZED');
    if (mode !== 'machine' && mode !== 'passphrase') throw new Error('INVALID_VAULT_MODE');
    if (mode === 'passphrase' && (!passphrase || passphrase.length < 12)) throw new Error('VAULT_PASSPHRASE_TOO_SHORT');
    const salt = randomBytes(32);
    const orphan = mode === 'machine' ? await readPrivateFile(this.keyPath) : null;
    if (orphan && orphan.length !== 32) throw new Error('VAULT_MACHINE_KEY_INVALID');
    const key = mode === 'machine' ? orphan ?? randomBytes(32) : await deriveKey(passphrase!, salt, 32) as Buffer;
    if (mode === 'machine') {
      // A crash between key creation and vault commit is recoverable without
      // replacing the key. The service owns the profile before entering here.
      if (!orphan) {
        const handle = await fs.open(this.keyPath, 'wx', 0o600);
        try { await handle.writeFile(key); await handle.sync(); } finally { await handle.close(); }
      }
    }
    this.key = key;
    this.values = Object.create(null) as Record<string, string>;
    this.envelope = { version: 1, mode, salt: salt.toString('base64'), iv: '', tag: '', data: '' };
    try { await this.persist(); }
    catch (error) { this.lock(); this.envelope = null; throw error; }
  }

  async unlock(passphrase: string): Promise<void> {
    await this.pending;
    if (!this.envelope) throw new Error('VAULT_NOT_INITIALIZED');
    if (this.envelope.mode !== 'passphrase') throw new Error('VAULT_NOT_PASSPHRASE');
    const key = await deriveKey(passphrase, Buffer.from(this.envelope.salt, 'base64'), 32) as Buffer;
    try { this.decrypt(key); } catch { key.fill(0); throw new Error('VAULT_UNLOCK_FAILED'); }
  }

  lock(): void { this.key?.fill(0); this.key = null; this.values = null; }
  async flush(): Promise<void> { await this.pending; }

  async get(key: string): Promise<string | null> {
    await this.pending;
    if (!this.values) throw new Error('VAULT_LOCKED');
    return Object.hasOwn(this.values, key) ? this.values[key] : null;
  }

  set(key: string, value: string): Promise<void> { return this.change(key, value); }
  delete(key: string): Promise<void> { return this.change(key, null); }

  /** Shared plugin OAuth and connection managers require a durable boolean
   * result before advancing their account state. All post-unlock mutations use
   * this same synchronous commit, so async callers cannot overwrite them later. */
  getSync(key: string): string | null {
    if (!this.values || !this.envelope?.iv) throw new Error('VAULT_LOCKED');
    return Object.hasOwn(this.values,key) ? this.values[key] : null;
  }
  setSync(key: string, value: string): void { this.changeSync(key,value); }
  deleteSync(key: string): void { this.changeSync(key,null); }

  private change(key: string, value: string | null): Promise<void> {
    try { this.changeSync(key,value); return Promise.resolve(); }
    catch (error) { return Promise.reject(error); }
  }
  private changeSync(key: string, value: string | null): void { this.setManySync({[key]:value}); }
  /** One encrypted commit for related identity moves; no partial credential copy. */
  setManySync(entries:Record<string,string|null>):void {
    for(const [key,value] of Object.entries(entries))if(!key||key.length>1024||(value!==null&&(typeof value!=='string'||Buffer.byteLength(value)>4*1024*1024)))throw new Error('VAULT_ENTRY_INVALID');
    if (!this.values || !this.envelope?.iv) throw new Error('VAULT_LOCKED');
    const previous=this.values;
    this.values=Object.assign(Object.create(null),previous) as Record<string,string>;
    for(const [key,value] of Object.entries(entries))if(value===null)delete this.values[key];else this.values[key]=value;
    try{const envelope=this.encode();atomicPrivateWriteSync(this.vaultPath,JSON.stringify(envelope));this.envelope=envelope;}
    catch(error){this.values=previous;throw error;}
  }

  private decrypt(key: Buffer): void {
    const envelope = this.envelope!;
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    cipher.setAAD(Buffer.from(`cindy-terminal-vault:1:${envelope.mode}:${envelope.salt}`));
    cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plain = Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]);
    try {
      const values: unknown = JSON.parse(plain.toString());
      if (!values || typeof values !== 'object' || Array.isArray(values) || Object.values(values).some(v => typeof v !== 'string')) throw new Error('VAULT_INVALID_CONTENT');
      this.values = Object.assign(Object.create(null), values) as Record<string, string>;
      this.key = key;
    } finally { plain.fill(0); }
  }

  private async persist(): Promise<void> {
    const envelope=this.encode();
    await atomicPrivateWrite(this.vaultPath,JSON.stringify(envelope));
    this.envelope=envelope;
  }
  private encode(): Envelope {
    if (!this.key || !this.values || !this.envelope) throw new Error('VAULT_LOCKED');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`cindy-terminal-vault:1:${this.envelope.mode}:${this.envelope.salt}`));
    const plain = Buffer.from(JSON.stringify(this.values));
    try {
      if (plain.length > 8 * 1024 * 1024) throw new Error('VAULT_CAPACITY_EXCEEDED');
      const data = Buffer.concat([cipher.update(plain), cipher.final()]);
      const envelope: Envelope = { ...this.envelope, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
      return envelope;
    } finally { plain.fill(0); }
  }
}
