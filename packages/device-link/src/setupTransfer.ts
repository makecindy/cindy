/**
 * New-computer setup, secret and SSH part (docs/product-rules/new-device-setup-migration.md).
 *
 * After reading the non-secret snapshot (`setupSnapshot.ts`), the new computer may ask the other
 * computer of the same account, in one request, to
 * - copy the API keys / access tokens of chosen connections, sealed for this request only, and
 * - add this computer's new SSH public key to the servers it can already reach.
 *
 * Nothing is sent before a person allows it on that computer: it shows the requesting computer,
 * every item by name and a short code that the new computer shows too. OAuth sign-ins and
 * private keys never travel; the target still writes everything through its own stores.
 *
 * Older Desktops do not list the channel → CHANNEL_NOT_ALLOWED, and those items stay on the
 * one-time checklist.
 */
export const SETUP_TRANSFER_CHANNEL = 'maker:setup-transfer';
export const SETUP_TRANSFER_VERSION = 1;
/** Waiting for a person on the other computer, then up to a few SSH servers at a time. */
export const SETUP_TRANSFER_TIMEOUT_MS = 5 * 60_000;
/** How long the other computer waits for its confirmation before refusing. */
export const SETUP_TRANSFER_CONFIRM_MS = 2 * 60_000;

export const SETUP_TRANSFER_LIMITS = {
  providers: 64,
  mcpServers: 100,
  builtinKeys: 16,
  plugins: 300,
  sshHosts: 64,
  /** Sealed reply budget, kept below the relay frame together with the envelope. */
  sealedBytes: 1_400_000,
} as const;

export interface SetupTransferPluginRef {
  ghostId: string;
  namespace: string | null;
}

/** What the new computer asks for; the other computer sends only what it has. */
export interface SetupTransferSecretsRequest {
  providers: string[];
  mcpServers: string[];
  builtinKeys: string[];
  plugins: SetupTransferPluginRef[];
}

export interface SetupTransferSshRequest {
  /** One OpenSSH public key line generated on the new computer. */
  publicKey: string;
  /** Host aliases from the snapshot. */
  hosts: string[];
}

export type SetupTransferRequest =
  | { action: 'caps' }
  | {
      action: 'transfer';
      requestId: string;
      /** X25519 public key (SPKI DER, base64url) of this request only. */
      publicKey: string;
      secrets: SetupTransferSecretsRequest | null;
      ssh: SetupTransferSshRequest | null;
    };

export interface SetupTransferCaps {
  setupTransfer: number;
}

export type SetupTransferSshOutcome = 'added' | 'present' | 'failed';

export interface SetupTransferSshResult {
  host: string;
  outcome: SetupTransferSshOutcome;
  /** Stable code when it failed (e.g. `SSH_CONNECT_FAILED`). */
  code?: string;
}

export interface SetupTransferReply {
  /** X25519 public key of the other computer for this request; null when no secrets were asked. */
  publicKey: string | null;
  /** AES-GCM sealed `SetupSecretBundle`; null when no secrets were asked. */
  sealed: string | null;
  ssh: SetupTransferSshResult[] | null;
}

/** Plain secret values, only ever inside `sealed` and the target's Main memory. */
export interface SetupSecretBundle {
  providers: Array<{
    id: string;
    /** The connection exactly as stored there, including addresses and request headers. */
    config: Record<string, unknown>;
    /** Runtime agent → API key. */
    keys: Record<string, string>;
  }>;
  mcpServers: Array<{
    id: string;
    url: string;
    headers: Record<string, string>;
    token: string | null;
  }>;
  builtinKeys: Array<{ id: string; value: string }>;
  plugins: Array<{ ghostId: string; namespace: string | null; secrets: Record<string, string> }>;
}

/** Built-in keys that are plain API keys. OAuth blobs and paired settings never travel. */
export const SETUP_TRANSFER_BUILTIN_KEY_IDS: readonly string[] = ['brave', 'tavily', 'mivo', 'gemini', 'openai-images'];

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@%+~-]{0,255}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const X25519_SPKI_RE = /^[A-Za-z0-9_-]{59}$/;
const SSH_ALIAS_RE = /^[A-Za-z0-9._@:+-]{1,255}$/;
/** Only the key type this feature generates. */
const ED25519_PUBLIC_KEY_RE = /^ssh-ed25519 [A-Za-z0-9+/]{68}(?: [A-Za-z0-9._@+-]{1,128})?$/;

export function isSetupTransferPublicKeyLine(value: unknown): value is string {
  return typeof value === 'string' && ED25519_PUBLIC_KEY_RE.test(value);
}

export function setupTransferCapsVersion(value: unknown): number {
  if (!isRecord(value)) return 0;
  const version = value.setupTransfer;
  return typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : 0;
}

export function parseSetupTransferRequest(value: unknown): SetupTransferRequest {
  if (!isRecord(value)) throw new Error('SETUP_TRANSFER_INVALID');
  if (value.action === 'caps') return { action: 'caps' };
  if (value.action !== 'transfer') throw new Error('SETUP_TRANSFER_INVALID');
  if (typeof value.requestId !== 'string' || !REQUEST_ID_RE.test(value.requestId)) {
    throw new Error('SETUP_TRANSFER_INVALID');
  }
  if (typeof value.publicKey !== 'string' || !X25519_SPKI_RE.test(value.publicKey)) {
    throw new Error('SETUP_TRANSFER_INVALID');
  }
  const secrets = value.secrets === null || value.secrets === undefined ? null : parseSecretsRequest(value.secrets);
  const ssh = value.ssh === null || value.ssh === undefined ? null : parseSshRequest(value.ssh);
  if (!secrets && !ssh) throw new Error('SETUP_TRANSFER_INVALID');
  return { action: 'transfer', requestId: value.requestId, publicKey: value.publicKey, secrets, ssh };
}

function parseSecretsRequest(value: unknown): SetupTransferSecretsRequest {
  if (!isRecord(value)) throw new Error('SETUP_TRANSFER_INVALID');
  return {
    providers: idList(value.providers, SETUP_TRANSFER_LIMITS.providers),
    mcpServers: idList(value.mcpServers, SETUP_TRANSFER_LIMITS.mcpServers),
    builtinKeys: idList(value.builtinKeys, SETUP_TRANSFER_LIMITS.builtinKeys).filter((id) =>
      SETUP_TRANSFER_BUILTIN_KEY_IDS.includes(id),
    ),
    plugins: (Array.isArray(value.plugins) ? value.plugins : [])
      .flatMap((item): SetupTransferPluginRef[] => {
        if (!isRecord(item) || !isId(item.ghostId)) return [];
        const namespace = item.namespace === null ? null : isId(item.namespace) ? item.namespace : undefined;
        return namespace === undefined ? [] : [{ ghostId: item.ghostId, namespace }];
      })
      .slice(0, SETUP_TRANSFER_LIMITS.plugins),
  };
}

function parseSshRequest(value: unknown): SetupTransferSshRequest {
  if (!isRecord(value) || !isSetupTransferPublicKeyLine(value.publicKey)) {
    throw new Error('SETUP_TRANSFER_INVALID');
  }
  const hosts = Array.isArray(value.hosts)
    ? [...new Set(value.hosts.filter((host): host is string => typeof host === 'string' && SSH_ALIAS_RE.test(host)))]
    : [];
  if (hosts.length === 0) throw new Error('SETUP_TRANSFER_INVALID');
  return { publicKey: value.publicKey, hosts: hosts.slice(0, SETUP_TRANSFER_LIMITS.sshHosts) };
}

export function parseSetupTransferReply(value: unknown): SetupTransferReply {
  if (!isRecord(value)) throw new Error('SETUP_TRANSFER_INVALID');
  const publicKey =
    typeof value.publicKey === 'string' && X25519_SPKI_RE.test(value.publicKey) ? value.publicKey : null;
  const sealed =
    typeof value.sealed === 'string' &&
    value.sealed.length > 0 &&
    value.sealed.length <= SETUP_TRANSFER_LIMITS.sealedBytes &&
    /^[A-Za-z0-9_-]+$/.test(value.sealed)
      ? value.sealed
      : null;
  if ((publicKey === null) !== (sealed === null)) throw new Error('SETUP_TRANSFER_INVALID');
  const ssh = Array.isArray(value.ssh)
    ? value.ssh.slice(0, SETUP_TRANSFER_LIMITS.sshHosts).flatMap((item): SetupTransferSshResult[] => {
        if (!isRecord(item) || typeof item.host !== 'string' || !SSH_ALIAS_RE.test(item.host)) return [];
        const outcome = item.outcome;
        if (outcome !== 'added' && outcome !== 'present' && outcome !== 'failed') return [];
        const code = typeof item.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(item.code) ? item.code : undefined;
        return [{ host: item.host, outcome, ...(code ? { code } : {}) }];
      })
    : null;
  return { publicKey, sealed, ssh };
}

/** Bounds a decrypted bundle; anything malformed is dropped, never applied. */
export function parseSetupSecretBundle(value: unknown): SetupSecretBundle {
  if (!isRecord(value)) throw new Error('SETUP_TRANSFER_INVALID');
  return {
    providers: list(value.providers, SETUP_TRANSFER_LIMITS.providers, (item) => {
      if (!isRecord(item) || !isId(item.id) || !isRecord(item.config) || item.config.id !== item.id) return null;
      return { id: item.id, config: item.config, keys: stringMap(item.keys, 8, 64, 16_384) };
    }),
    mcpServers: list(value.mcpServers, SETUP_TRANSFER_LIMITS.mcpServers, (item) => {
      if (!isRecord(item) || !isId(item.id) || typeof item.url !== 'string' || item.url.length > 4096) return null;
      if (!/^https?:\/\//i.test(item.url)) return null;
      const token = typeof item.token === 'string' && item.token.length > 0 && item.token.length <= 16_384 ? item.token : null;
      return { id: item.id, url: item.url, headers: stringMap(item.headers, 64, 256, 4096), token };
    }),
    builtinKeys: list(value.builtinKeys, SETUP_TRANSFER_LIMITS.builtinKeys, (item) => {
      if (!isRecord(item) || typeof item.id !== 'string' || !SETUP_TRANSFER_BUILTIN_KEY_IDS.includes(item.id)) return null;
      return typeof item.value === 'string' && item.value.length > 0 && item.value.length <= 16_384
        ? { id: item.id, value: item.value }
        : null;
    }),
    plugins: list(value.plugins, SETUP_TRANSFER_LIMITS.plugins, (item) => {
      if (!isRecord(item) || !isId(item.ghostId)) return null;
      const namespace = item.namespace === null ? null : isId(item.namespace) ? item.namespace : undefined;
      if (namespace === undefined) return null;
      return { ghostId: item.ghostId, namespace, secrets: stringMap(item.secrets, 32, 64, 16_384) };
    }),
  };
}

function list<T>(value: unknown, max: number, parse: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const item of value) {
    if (out.length >= max) break;
    const parsed = parse(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

function idList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isId))].slice(0, max);
}

function stringMap(value: unknown, max: number, keyMax: number, valueMax: number): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, raw] of Object.entries(value).slice(0, max)) {
    if (key.length > 0 && key.length <= keyMax && key !== '__proto__' && typeof raw === 'string' && raw.length > 0 && raw.length <= valueMax) {
      out[key] = raw;
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}
