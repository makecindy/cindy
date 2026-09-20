import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
} from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { oauthExact, oauthId, oauthPublicKey } from '@cindy/device-link';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';

export interface OauthIdentityScope {
  realm: 'cn' | 'global';
  membershipId: string;
  deviceId: string;
}
export interface OauthSigningKey {
  publicKey: string;
  privateKey: string;
}
interface StoredIdentity extends OauthSigningKey {
  version: 1;
  scope: OauthIdentityScope;
  peers: Record<string, string>;
}
export interface OauthIdentityStoreDeps {
  filePath(scope: OauthIdentityScope): string;
  available(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}
const fail = () => new Error('OAUTH_IDENTITY_UNAVAILABLE');
const MAX_PEERS = 1000;
const MAX_BYTES = 256 * 1024;

export function oauthSecureStorageAvailable(input: {
  platform: NodeJS.Platform;
  available: boolean;
  backend?: string;
}): boolean {
  return (
    input.available &&
    (input.platform !== 'linux' ||
      (!!input.backend && input.backend !== 'basic_text' && input.backend !== 'unknown'))
  );
}

export function oauthIdentityScopeKey(scope: OauthIdentityScope): string {
  if (
    !['cn', 'global'].includes(scope.realm) ||
    !oauthId(scope.membershipId) ||
    !oauthId(scope.deviceId)
  )
    throw fail();
  return createHash('sha256')
    .update(JSON.stringify([scope.realm, scope.membershipId, scope.deviceId]))
    .digest('hex');
}

/** Separate-purpose keys and pins. Called only by an explicit authorization operation, never at startup. */
export class OauthIdentityStore {
  constructor(private readonly deps: OauthIdentityStoreDeps) {}

  async load(scope: OauthIdentityScope, assertCurrent: () => void): Promise<OauthSigningKey> {
    return this.locked(scope, assertCurrent, (data) => ({
      publicKey: data.publicKey,
      privateKey: data.privateKey,
    }));
  }

  /** First use trusts the authenticated account route; changed keys are never silently replaced. */
  async trustPeer(
    scope: OauthIdentityScope,
    deviceId: string,
    publicKey: string,
    assertCurrent: () => void,
  ): Promise<void> {
    if (!oauthId(deviceId) || deviceId === scope.deviceId || !oauthPublicKey(publicKey))
      throw fail();
    if (
      createPublicKey({ key: Buffer.from(publicKey, 'base64url'), type: 'spki', format: 'der' })
        .asymmetricKeyType !== 'ed25519'
    )
      throw fail();
    await this.locked(scope, assertCurrent, (data, save) => {
      const pin = data.peers[deviceId];
      if (pin === publicKey) return;
      if (pin || Object.keys(data.peers).length >= MAX_PEERS) throw fail();
      save({ ...data, peers: { ...data.peers, [deviceId]: publicKey } });
    });
  }

  private async locked<T>(
    scope: OauthIdentityScope,
    assertCurrent: () => void,
    operation: (data: StoredIdentity, save: (data: StoredIdentity) => void) => T,
  ): Promise<T> {
    oauthIdentityScopeKey(scope);
    const file = this.deps.filePath(scope);
    const check = () => {
      assertCurrent();
      if (this.deps.filePath(scope) !== file || !this.deps.available()) throw fail();
    };
    check();
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    return withCrossProcessLock(
      `${file}.lock`,
      { label: 'plugin-oauth-identity', waitMs: 12_000 },
      async (status) => {
        check();
        if (!status.held) throw fail();
        const save = (data: StoredIdentity) => {
          check();
          const temp = `${file}.${randomUUID()}.tmp`;
          try {
            const encrypted = this.deps.encrypt(JSON.stringify(data));
            check();
            const fd = fs.openSync(temp, 'wx', 0o600);
            try {
              fs.writeFileSync(fd, encrypted);
              fs.fsyncSync(fd);
            } finally {
              fs.closeSync(fd);
            }
            check();
            fs.renameSync(temp, file);
          } finally {
            fs.rmSync(temp, { force: true });
          }
        };
        let data: StoredIdentity;
        let fd: number | undefined;
        try {
          fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw fail();
        }
        if (fd === undefined) {
          const pair = generateKeyPairSync('ed25519');
          data = {
            version: 1,
            scope: { ...scope },
            peers: {},
            publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
            privateKey: pair.privateKey
              .export({ type: 'pkcs8', format: 'der' })
              .toString('base64url'),
          };
          save(data);
        } else {
          try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.size > MAX_BYTES || stat.size === 0) throw fail();
            data = parseStoredIdentity(JSON.parse(this.deps.decrypt(fs.readFileSync(fd))), scope);
          } catch {
            throw fail();
          } finally {
            fs.closeSync(fd);
          }
        }
        check();
        const result = operation(data, save);
        check();
        return result;
      },
    );
  }
}

function parseStoredIdentity(raw: unknown, scope: OauthIdentityScope): StoredIdentity {
  const value = oauthExact(raw, ['version', 'scope', 'publicKey', 'privateKey', 'peers']);
  const storedScope = oauthExact(value.scope, ['realm', 'membershipId', 'deviceId']);
  if (
    value.version !== 1 ||
    storedScope.realm !== scope.realm ||
    storedScope.membershipId !== scope.membershipId ||
    storedScope.deviceId !== scope.deviceId ||
    !oauthPublicKey(value.publicKey) ||
    typeof value.privateKey !== 'string' ||
    value.privateKey.length > 256 ||
    !value.peers ||
    typeof value.peers !== 'object' ||
    Array.isArray(value.peers)
  )
    throw fail();
  const key = createPrivateKey({
    key: Buffer.from(value.privateKey, 'base64url'),
    type: 'pkcs8',
    format: 'der',
  });
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64url') !==
      value.publicKey
  )
    throw fail();
  const peers = Object.entries(value.peers);
  if (peers.length > MAX_PEERS || peers.some(([id, pin]) => !oauthId(id) || !oauthPublicKey(pin)))
    throw fail();
  return value as unknown as StoredIdentity;
}
