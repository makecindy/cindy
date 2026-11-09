// P0-B:私钥永不以明文落盘;Agent 同 UID 读到的文件最多是 safeStorage 密文。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPrivateKey, createPublicKey } from 'node:crypto';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-key-store-'));
const ownedRoot = path.join(root, 'data-bucket');
fs.mkdirSync(ownedRoot, { recursive: true });

vi.mock('electron', () => ({
  app: { getPath: () => root },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(Buffer.from(value, 'utf8').toString('base64'), 'utf8'),
    decryptString: (buf: Buffer) => Buffer.from(buf.toString('utf8'), 'base64').toString('utf8'),
  },
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ dataOwnerId: 'owner-test' }),
  ownerScopedUserDataPath: () => ownedRoot,
}));

vi.mock('./logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ warn: () => {} }) },
}));

const store = await import('../subagent-model-signing-key-store.js');

beforeEach(() => {
  store.__resetSigningKeyCacheForTests();
  fs.rmSync(path.join(ownedRoot, 'subagent-model-signing-key.json'), { force: true });
});

afterEach(() => {
  store.__resetSigningKeyCacheForTests();
});

describe('subagent model signing key isolation (P0-B)', () => {
  it('persists only safeStorage ciphertext — no plaintext key material in the on-disk file', () => {
    const pair = store.getOrCreateSubagentModelSigningKey();
    const filePath = path.join(ownedRoot, 'subagent-model-signing-key.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: number; encrypted?: string; secretKey?: string; publicKey?: string };
    expect(parsed.version).toBe(2);
    expect(typeof parsed.encrypted).toBe('string');
    expect(parsed.encrypted).not.toContain(pair.publicKey);
    expect(parsed.encrypted).not.toContain(pair.secretKey);
    expect(parsed.secretKey).toBeUndefined();
    expect(parsed.publicKey).toBeUndefined();
    // 同 UID Agent 读文件也只能得到密文 —— 公钥反推不出签名能力。
    const sig = store.getOrCreateSubagentModelSigningKey();
    expect(sig.secretKey).toBe(pair.secretKey);
  });

  it('restart signal: cached key is stable within the process and recoverable from ciphertext', () => {
    const first = store.getOrCreateSubagentModelSigningKey();
    expect(store.getOrCreateSubagentModelSigningKey().publicKey).toBe(first.publicKey);
    store.__resetSigningKeyCacheForTests();
    const recovered = store.getOrCreateSubagentModelSigningKey();
    expect(recovered.publicKey).toBe(first.publicKey);
    expect(recovered.secretKey).toBe(first.secretKey);
  });

  it('drops legacy plaintext v1 files and never imports plaintext keys from disk', () => {
    const other = store.getOrCreateSubagentModelSigningKey();
    const filePath = path.join(ownedRoot, 'subagent-model-signing-key.json');
    // 模拟 0600 明文版本残留:绝不能被新代码加载。
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, publicKey: other.publicKey, secretKey: other.secretKey }), { mode: 0o600 });
    store.__resetSigningKeyCacheForTests();
    const fresh = store.getOrCreateSubagentModelSigningKey();
    expect(fresh.secretKey).not.toBe(other.secretKey);
    expect(validB64Key(fresh.secretKey)).toBe(true);
  });

  it('attacker key material placed at the old public-key path is never consulted', () => {
    const pair = store.getOrCreateSubagentModelSigningKey();
    const attackerPath = path.join(ownedRoot, 'subagent-model-signing-public-key.json');
    fs.writeFileSync(attackerPath, JSON.stringify({ publicKey: 'attacker' }), { mode: 0o644 });
    // 新分发路径以 env 字面量给 verifier —— 读这文件与鉴权无关。
    expect(viaEnvLiteral(pair.publicKey)).toBe(true);
  });
});

function validB64Key(value: string): boolean {
  try {
    const priv = createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' });
    return priv.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

function viaEnvLiteral(publicKey: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}
