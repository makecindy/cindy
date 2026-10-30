import { afterEach, describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OauthIdentityStore,
  oauthIdentityScopeKey,
  type OauthIdentityScope,
} from '../identityStore.js';
import { testOauthSigningKey } from './fixtures.js';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const scope: OauthIdentityScope = {
  realm: 'global',
  membershipId: 'synthetic-member',
  deviceId: 'local-device',
};
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-oauth-identity-'));
  directories.push(dir);
  const encryptionKey = randomBytes(32);
  let available = true;
  let current = true;
  const filePath = (s: OauthIdentityScope) => path.join(dir, oauthIdentityScopeKey(s) + '.enc');
  const encrypt = (plaintext: string) => {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  };
  const decrypt = (value: Buffer) => {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
  };
  const deps = { filePath, available: () => available, encrypt, decrypt };
  const assertCurrent = () => {
    if (!current) throw new Error('cancelled');
  };
  return {
    dir,
    deps,
    filePath,
    assertCurrent,
    store: new OauthIdentityStore(deps),
    lock: () => {
      available = false;
    },
    cancel: () => {
      current = false;
    },
  };
}

describe('persistent authorization identity and peer continuity', () => {
  it('does no startup I/O, stores encrypted keys, and survives a fresh store instance', async () => {
    const f = fixture();
    expect(fs.readdirSync(f.dir)).toEqual([]);
    const identity = await f.store.load(scope, f.assertCurrent);
    const saved = fs.readFileSync(f.filePath(scope));
    expect(saved.includes(identity.privateKey)).toBe(false);
    expect(saved.includes(scope.membershipId)).toBe(false);
    expect(await new OauthIdentityStore(f.deps).load(scope, f.assertCurrent)).toEqual(identity);
    expect(fs.readFileSync(f.filePath(scope))).toEqual(saved);
  });
  it('pins only the first key and refuses substitution across process restarts', async () => {
    const f = fixture(),
      peer = await testOauthSigningKey(),
      replacement = await testOauthSigningKey();
    await f.store.trustPeer(scope, 'peer-device', peer.publicKey, f.assertCurrent);
    const saved = fs.readFileSync(f.filePath(scope));
    const restarted = new OauthIdentityStore(f.deps);
    await restarted.trustPeer(scope, 'peer-device', peer.publicKey, f.assertCurrent);
    await expect(
      restarted.trustPeer(scope, 'peer-device', replacement.publicKey, f.assertCurrent),
    ).rejects.toThrow();
    expect(fs.readFileSync(f.filePath(scope))).toEqual(saved);
  });
  it('isolates realm, membership and controller device without erasing existing pins', async () => {
    const f = fixture();
    const first = await f.store.load(scope, f.assertCurrent);
    for (const other of [
      { ...scope, realm: 'cn' as const },
      { ...scope, membershipId: 'other-member' },
      { ...scope, deviceId: 'other-device' },
    ]) {
      expect((await f.store.load(other, f.assertCurrent)).publicKey).not.toBe(first.publicKey);
    }
    expect(await f.store.load(scope, f.assertCurrent)).toEqual(first);
  });
  it('does not regenerate a corrupted or transplanted encrypted identity', async () => {
    const f = fixture();
    await f.store.load(scope, f.assertCurrent);
    const other = { ...scope, deviceId: 'other-device' };
    const encrypted = fs.readFileSync(f.filePath(scope));
    fs.writeFileSync(f.filePath(other), encrypted);
    await expect(f.store.load(other, f.assertCurrent)).rejects.toThrow();
    expect(fs.readFileSync(f.filePath(other))).toEqual(encrypted);
    fs.writeFileSync(f.filePath(scope), 'invalid-synthetic-ciphertext');
    await expect(f.store.load(scope, f.assertCurrent)).rejects.toThrow();
    expect(fs.readFileSync(f.filePath(scope), 'utf8')).toBe('invalid-synthetic-ciphertext');
  });
  it('fails while secure storage is unavailable without creating plaintext or replacing existing data', async () => {
    const f = fixture();
    f.lock();
    await expect(f.store.load(scope, f.assertCurrent)).rejects.toThrow();
    expect(fs.readdirSync(f.dir)).toEqual([]);
  });
  it('rechecks cancellation after encryption, before committing a key or pin', async () => {
    const f = fixture();
    const store = new OauthIdentityStore({
      ...f.deps,
      encrypt: (value) => {
        const result = f.deps.encrypt(value);
        f.cancel();
        return result;
      },
    });
    await expect(store.load(scope, f.assertCurrent)).rejects.toThrow();
    expect(fs.existsSync(f.filePath(scope))).toBe(false);
  });
  it('serializes competing first admissions and never replaces the winner', async () => {
    const f = fixture(),
      a = await testOauthSigningKey(),
      b = await testOauthSigningKey();
    const stores = [new OauthIdentityStore(f.deps), new OauthIdentityStore(f.deps)];
    const result = await Promise.allSettled(
      stores.map((store, i) =>
        store.trustPeer(scope, 'peer-device', [a, b][i].publicKey, f.assertCurrent),
      ),
    );
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const winner = result[0].status === 'fulfilled' ? a : b;
    await new OauthIdentityStore(f.deps).trustPeer(
      scope,
      'peer-device',
      winner.publicKey,
      f.assertCurrent,
    );
    expect(await stores[0].load(scope, f.assertCurrent)).toEqual(
      await stores[1].load(scope, f.assertCurrent),
    );
  });
  it('rejects malformed and self device identities', async () => {
    const f = fixture(),
      peer = await testOauthSigningKey();
    await expect(
      f.store.trustPeer(scope, scope.deviceId, peer.publicKey, f.assertCurrent),
    ).rejects.toThrow();
    await expect(
      f.store.trustPeer(scope, '../other', peer.publicKey, f.assertCurrent),
    ).rejects.toThrow();
    await expect(
      f.store.trustPeer(scope, 'peer-device', 'not-a-key', f.assertCurrent),
    ).rejects.toThrow();
    expect(fs.readdirSync(f.dir)).toEqual([]);
  });
});
