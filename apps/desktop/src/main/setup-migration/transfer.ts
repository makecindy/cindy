/**
 * Keys and SSH step of new-computer setup (docs/product-rules/new-device-setup-migration.md).
 *
 * Other computer (`handleSetupTransfer`): nothing is read or changed until a person there allows
 * the request; the prompt names the requesting computer, every key and server by this computer's
 * own names, and a six-digit code the new computer shows too. Keys are sealed for that request
 * only (ephemeral X25519 + HKDF-SHA256 + AES-256-GCM); SSH runs over the connections it already
 * has. The relay that routes the request remains a trust root, as for plugin sign-in.
 *
 * New computer (`requestSetupTransfer`): makes the request key, shows the code, opens the reply
 * and bounds it. Writing happens in `transferApply.ts`.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

import {
  SETUP_TRANSFER_CONFIRM_MS,
  SETUP_TRANSFER_LIMITS,
  SETUP_TRANSFER_VERSION,
  parseSetupSecretBundle,
  parseSetupTransferReply,
  parseSetupTransferRequest,
  setupTransferCapsVersion,
  type SetupSecretBundle,
  type SetupTransferCaps,
  type SetupTransferReply,
  type SetupTransferRequest,
  type SetupTransferSecretsRequest,
  type SetupTransferSshRequest,
  type SetupTransferSshResult,
} from '@cindy/device-link';

const INFO = 'cindy-setup-transfer-v1';

/** The six digits both computers show for one request key. */
export function setupTransferConfirmCode(publicKey: string): string {
  const digest = createHash('sha256').update(`${INFO}:${publicKey}`).digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

export class SetupTransferBox {
  private readonly privateKey: KeyObject;
  readonly publicKey: string;

  constructor() {
    const pair = generateKeyPairSync('x25519');
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  }

  private key(peer: string, requestId: string): Buffer {
    const key = createPublicKey({ key: Buffer.from(peer, 'base64url'), type: 'spki', format: 'der' });
    if (key.asymmetricKeyType !== 'x25519') throw new Error('SETUP_TRANSFER_INVALID');
    const shared = diffieHellman({ privateKey: this.privateKey, publicKey: key });
    try {
      return Buffer.from(hkdfSync('sha256', shared, requestId, `${INFO}:secrets`, 32));
    } finally {
      shared.fill(0);
    }
  }

  seal(peer: string, requestId: string, value: unknown): string {
    const key = this.key(peer, requestId);
    const iv = randomBytes(12);
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`${INFO}:${requestId}`));
      const body = Buffer.from(JSON.stringify(value));
      const sealed = Buffer.concat([iv, cipher.update(body), cipher.final(), cipher.getAuthTag()]).toString('base64url');
      body.fill(0);
      if (sealed.length > SETUP_TRANSFER_LIMITS.sealedBytes) throw new Error('SETUP_TRANSFER_TOO_LARGE');
      return sealed;
    } finally {
      key.fill(0);
    }
  }

  open(peer: string, requestId: string, sealed: string): unknown {
    try {
      const data = Buffer.from(sealed, 'base64url');
      if (data.length < 29) throw new Error('short');
      const key = this.key(peer, requestId);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
        decipher.setAAD(Buffer.from(`${INFO}:${requestId}`));
        decipher.setAuthTag(data.subarray(-16));
        const body = Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]);
        try {
          return JSON.parse(body.toString('utf8'));
        } finally {
          body.fill(0);
        }
      } finally {
        key.fill(0);
      }
    } catch {
      throw new Error('SETUP_TRANSFER_INVALID');
    }
  }
}

/** What the person on the other computer is asked to allow, in that computer's own names. */
export interface SetupTransferPrompt {
  requester: string;
  code: string;
  secrets: string[];
  ssh: { hosts: string[]; fingerprint: string | null } | null;
}

export interface SetupTransferSourceDeps {
  /** Signed-in account scope; null while signed out or switching. */
  ownerKey(): string | null;
  /** Name of the asking computer on this account, or null when it is not one of them. */
  requesterName(controllerDeviceId: string): Promise<string | null>;
  /** Names of the items this computer actually has, for the prompt. */
  describeSecrets(request: SetupTransferSecretsRequest): Promise<string[]>;
  describeSshHosts(hosts: readonly string[]): Promise<string[]>;
  sshKeyFingerprint(publicKey: string): string | null;
  /** Resolves true only when a person allowed it; false on refusal or after `timeoutMs`. */
  confirm(prompt: SetupTransferPrompt, timeoutMs: number): Promise<boolean>;
  collectSecrets(request: SetupTransferSecretsRequest): Promise<SetupSecretBundle>;
  authorizeSsh(request: SetupTransferSshRequest): Promise<SetupTransferSshResult[]>;
}

function transferError(code: string): Error {
  return new Error(code);
}

/** Other computer: one request at a time, nothing before the person's answer. */
export function createSetupTransferSource(deps: SetupTransferSourceDeps) {
  let pending = false;
  return async function handleSetupTransfer(
    raw: unknown,
    controllerDeviceId: string | null,
  ): Promise<SetupTransferCaps | SetupTransferReply> {
    const request = parseSetupTransferRequest(raw);
    if (request.action === 'caps') return { setupTransfer: SETUP_TRANSFER_VERSION };
    const owner = deps.ownerKey();
    if (!owner || !controllerDeviceId) throw transferError('SETUP_SOURCE_UNAVAILABLE');
    if (pending) throw transferError('SETUP_TRANSFER_BUSY');
    pending = true;
    try {
      const requester = await deps.requesterName(controllerDeviceId);
      if (!requester) throw transferError('SETUP_TRANSFER_DECLINED');
      const secrets = request.secrets ? await deps.describeSecrets(request.secrets) : [];
      const sshHosts = request.ssh ? await deps.describeSshHosts(request.ssh.hosts) : [];
      if (secrets.length === 0 && sshHosts.length === 0) {
        return { publicKey: null, sealed: null, ssh: request.ssh ? [] : null };
      }
      const allowed = await deps.confirm(
        {
          requester,
          code: setupTransferConfirmCode(request.publicKey),
          secrets,
          ssh: sshHosts.length > 0 && request.ssh
            ? { hosts: sshHosts, fingerprint: deps.sshKeyFingerprint(request.ssh.publicKey) }
            : null,
        },
        SETUP_TRANSFER_CONFIRM_MS,
      );
      if (!allowed) throw transferError('SETUP_TRANSFER_DECLINED');
      // The account may have changed while the prompt was open.
      if (deps.ownerKey() !== owner) throw transferError('SETUP_SOURCE_UNAVAILABLE');
      return await reply(request, deps);
    } finally {
      pending = false;
    }
  };
}

async function reply(
  request: Extract<SetupTransferRequest, { action: 'transfer' }>,
  deps: SetupTransferSourceDeps,
): Promise<SetupTransferReply> {
  let publicKey: string | null = null;
  let sealed: string | null = null;
  if (request.secrets) {
    const box = new SetupTransferBox();
    publicKey = box.publicKey;
    sealed = box.seal(request.publicKey, request.requestId, await deps.collectSecrets(request.secrets));
  }
  const ssh = request.ssh ? await deps.authorizeSsh(request.ssh) : null;
  return { publicKey, sealed, ssh };
}

export interface SetupTransferClientDeps {
  invoke(deviceId: string, request: SetupTransferRequest): Promise<unknown>;
  randomId(): string;
}

export interface SetupTransferOutcome {
  secrets: SetupSecretBundle | null;
  ssh: SetupTransferSshResult[] | null;
}

/** New computer: `onCode` runs before the other computer is asked, so the code is on screen first. */
export async function requestSetupTransfer(
  deps: SetupTransferClientDeps,
  input: {
    deviceId: string;
    secrets: SetupTransferSecretsRequest | null;
    ssh: SetupTransferSshRequest | null;
    onCode(code: string): void;
  },
): Promise<SetupTransferOutcome> {
  const failed = (error: unknown, fallback: string): never => {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'CHANNEL_NOT_ALLOWED' || code === 'UNSUPPORTED_CAPABILITY') throw transferError('SETUP_SOURCE_OUTDATED');
    const message = error instanceof Error ? error.message : '';
    throw transferError(/\bSETUP_[A-Z_]+\b/.exec(message)?.[0] ?? fallback);
  };
  let caps: unknown;
  try {
    caps = await deps.invoke(input.deviceId, { action: 'caps' });
  } catch (error) {
    failed(error, 'SETUP_SOURCE_UNAVAILABLE');
  }
  if (setupTransferCapsVersion(caps) < SETUP_TRANSFER_VERSION) throw transferError('SETUP_SOURCE_OUTDATED');
  const box = new SetupTransferBox();
  const requestId = deps.randomId();
  input.onCode(setupTransferConfirmCode(box.publicKey));
  let raw: unknown;
  try {
    raw = await deps.invoke(input.deviceId, {
      action: 'transfer',
      requestId,
      publicKey: box.publicKey,
      secrets: input.secrets,
      ssh: input.ssh,
    });
  } catch (error) {
    failed(error, 'SETUP_SOURCE_UNAVAILABLE');
  }
  const reply = parseSetupTransferReply(raw);
  const secrets =
    input.secrets && reply.publicKey && reply.sealed
      ? parseSetupSecretBundle(box.open(reply.publicKey, requestId, reply.sealed))
      : null;
  return { secrets, ssh: input.ssh ? (reply.ssh ?? []) : null };
}
