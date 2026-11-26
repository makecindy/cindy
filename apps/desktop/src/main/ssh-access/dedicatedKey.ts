/**
 * This computer's dedicated SSH key for the person's own devices (decision 7, 2026-11-26): one ed25519 key per
 * owner, made by Cindy and kept only under Cindy's data directory (`owners/<owner>/ssh-access/id_ed25519` and
 * `id_ed25519.pub`), never one of the person's own keys. It is unencrypted so the terminal alias works without a
 * prompt; the directory is 0700 and the private file 0600, and a looser mode found on disk is tightened before use
 * (OpenSSH refuses a private key others can read). The private key never leaves this computer: only the public key
 * is sent, to the person's own devices when enrolling.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseSshEd25519PublicKey } from '@cindy/device-link';
import type { OpenSshKeyPair } from '@cindy/maker-remote-ssh';
import { sshKeyFingerprint } from './sshAccessRecord.js';

export const DEDICATED_KEY_FILE = 'id_ed25519';

export interface DedicatedKey {
  privateKeyPath: string;
  publicKeyPath: string;
  /** Canonical `ssh-ed25519 <base64>`. */
  publicKey: string;
  fingerprint: string;
}

const paths = (dir: string) => ({
  privateKeyPath: path.join(dir, DEDICATED_KEY_FILE),
  publicKeyPath: path.join(dir, `${DEDICATED_KEY_FILE}.pub`),
});

async function regularFile(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function tighten(file: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return;
  const stat = await fs.stat(file);
  if ((stat.mode & 0o777 & ~mode) !== 0) await fs.chmod(file, mode);
}

/** The existing key pair, or null when either half is missing or the public half is not a single ed25519 key. */
export async function loadDedicatedKey(dir: string): Promise<DedicatedKey | null> {
  const { privateKeyPath, publicKeyPath } = paths(dir);
  if (!(await regularFile(privateKeyPath)) || !(await regularFile(publicKeyPath))) return null;
  const parsed = parseSshEd25519PublicKey(await fs.readFile(publicKeyPath, 'utf8'));
  if (!parsed) return null;
  await tighten(dir, 0o700);
  await tighten(privateKeyPath, 0o600);
  return { privateKeyPath, publicKeyPath, publicKey: parsed.publicKey, fingerprint: sshKeyFingerprint(parsed.publicKey) };
}

async function replaceFile(file: string, content: string, mode: number): Promise<void> {
  const temp = `${file}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temp, content, { flag: 'wx', mode });
    if (process.platform !== 'win32') await fs.chmod(temp, mode);
    await fs.rename(temp, file);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** Makes a new key pair, replacing any previous one (the private half first, so a crash never pairs it wrongly). */
export async function createDedicatedKey(
  dir: string,
  generate: (comment: string) => Promise<OpenSshKeyPair>,
  comment: string,
): Promise<DedicatedKey> {
  const { privateKeyPath, publicKeyPath } = paths(dir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await tighten(dir, 0o700);
  const pair = await generate(comment);
  if (!parseSshEd25519PublicKey(pair.publicKey)) throw new Error('generated key is not a single ed25519 public key');
  await fs.rm(publicKeyPath, { force: true });
  await replaceFile(privateKeyPath, pair.privateKey, 0o600);
  await replaceFile(publicKeyPath, `${pair.publicKey} ${comment}\n`, 0o644);
  return { privateKeyPath, publicKeyPath, publicKey: pair.publicKey, fingerprint: sshKeyFingerprint(pair.publicKey) };
}
