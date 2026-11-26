/**
 * SSH access for the owner's own devices (docs/dev-rules/protocol-compatibility/device-link-ssh-access.md, decisions
 * approved 2026-11-26). A computer that allows it (the TARGET: a Cindy cloud host by default, any macOS/Linux Cindy by
 * the person's choice) accepts one dedicated ed25519 key per same-account desktop that passes the remote-control
 * admission, and writes them into a Cindy-managed authorized-keys file. The owner's other desktops (CONTROLLERS) ask
 * for the target's endpoint and enroll their key.
 *
 * - Invoke `device-link:ssh-access:v1` (controller → target): `status` is read-only; `enroll` is idempotent and
 *   replaces the caller's own line; `withdraw` removes it. Same-account desktops only; the target's dispatch refuses
 *   shared-task guests, provider-share guests and phones, and keeps the ordinary REMOTE_DISABLED / ACCESS_REVOKED
 *   admission. Older targets do not list the channel → CHANNEL_NOT_ALLOWED ("that computer needs a Cindy update").
 * - Push `device-link:ssh-access:announce` (target → each online desktop peer) tells a controller that the target's
 *   state or that controller's authorization changed; it needs no open control link. Older controllers drop it.
 * - Replies and pushes are field-tolerant (unknown fields are ignored, unknown enum values degrade); requests are
 *   validated strictly, and every endpoint value is checked against a narrow character set because controllers write
 *   it into an SSH config file.
 *
 * No new frame kind, capability bit or relay behaviour: official and self-hosted relays forward both like any other
 * invoke and push. Not used by phones.
 */
export const SSH_ACCESS_CHANNEL = 'device-link:ssh-access:v1';
export const SSH_ACCESS_ANNOUNCE_CHANNEL = 'device-link:ssh-access:announce';
export const SSH_ACCESS_VERSION = 1;
export const SSH_ACCESS_MAX_ADDRESSES = 8;
export const SSH_ACCESS_MAX_HOST_KEYS = 6;
/** Pasted key text above this size is refused before parsing. */
export const SSH_ACCESS_MAX_KEY_TEXT_CHARS = 4096;

export type SshAccessRequest =
  | { action: 'status' }
  /** Idempotent: replaces the caller's line. `publicKey` is exactly `ssh-ed25519 <base64>` (no comment, no options). */
  | { action: 'enroll'; requestId: string; publicKey: string }
  | { action: 'withdraw'; requestId: string };

/** Why the target cannot accept SSH right now even though access is on (or, for PLATFORM_UNSUPPORTED, can never). */
export type SshAccessBlock = 'SSHD_UNREACHABLE' | 'REMOTE_LOGIN_OFF' | 'AUTHORIZED_KEYS_UNSUPPORTED' | 'PLATFORM_UNSUPPORTED';
/** A reason sent by a newer target that this build does not know yet. */
export type SshAccessParsedBlock = SshAccessBlock | 'UNKNOWN';

export type SshAccessAddressKind = 'public' | 'lan' | 'mdns';
export interface SshAccessAddress { kind: SshAccessAddressKind; host: string }

export interface SshAccessEndpoint {
  /** The OS account that runs Cindy on the target. */
  user: string;
  port: number;
  /** At most SSH_ACCESS_MAX_ADDRESSES, most useful first (public, LAN IPv4, mDNS, LAN IPv6). */
  addresses: SshAccessAddress[];
  /** `<type> <base64>` lines of the target's sshd host keys, at most SSH_ACCESS_MAX_HOST_KEYS. */
  hostKeys: string[];
}

/** Reply to every action. */
export interface SshAccessStatus<Block = SshAccessBlock> {
  version: number;
  /** The target allows SSH from the owner's devices (its setting and its remote-control switch are both on). */
  enabled: boolean;
  blocked: Block | null;
  /** The caller's own key is in the target's authorized-keys file now. */
  authorized: boolean;
  /**
   * Opaque: changes whenever `enabled`, `blocked` or `endpoint` changes. Compare for equality only; it is not ordered and
   * not persisted, so a target restart may produce a different value for the same state.
   */
  revision: number;
  /** Null while disabled or blocked. */
  endpoint: SshAccessEndpoint | null;
}

/** Push sent per desktop peer when the target's revision or that peer's authorization changes. */
export interface SshAccessAnnounce {
  version: number;
  enabled: boolean;
  revision: number;
  authorized: boolean;
}

/** Carried as `[CODE] message` inside the ordinary IPC_ERROR invoke error. */
export type SshAccessErrorCode =
  | 'SSH_ACCESS_DISABLED'
  | 'SSH_ACCESS_INVALID'
  | 'SSH_ACCESS_KEY_IN_USE'
  | 'SSH_ACCESS_UNAVAILABLE'
  | 'SSH_ACCESS_WRITE_FAILED';

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
/**
 * The whole base64 of an ed25519 public key blob: uint32(11) "ssh-ed25519" uint32(32) <32 bytes> = 51 bytes = 68 chars
 * without padding. The first 25 chars encode the fixed header (the 25th also the top bits of the first key byte), so
 * this pattern is a complete structural check of the blob.
 */
const ED25519_BASE64 = /^AAAAC3NzaC1lZDI1NTE5AAAAI[A-P][A-Za-z0-9+/]{42}$/;
const HOST_KEY = /^(?:ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/]{16,1400}={0,2}$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** A host name or address a controller may write into an SSH config `HostName`. */
export function isSshAccessHost(host: unknown): host is string {
  if (typeof host !== 'string' || !host || host.length > 253) return false;
  if (IPV4.test(host)) return true;
  if (host.includes(':')) return IPV6.test(host) && (host.match(/:/g)?.length ?? 0) >= 2;
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  // A purely numeric dotted name that is not a valid IPv4 address is refused rather than resolved.
  return !!name && !/^[\d.]+$/.test(name) && name.split('.').every((label) => DNS_LABEL.test(label));
}

/**
 * One pasted or received public key line: `ssh-ed25519 <base64> [comment]`, a single line (one trailing newline is
 * tolerated), no options before the key type, no control characters, at most SSH_ACCESS_MAX_KEY_TEXT_CHARS. Returns the
 * canonical `ssh-ed25519 <base64>` and the comment (null when absent). Anything else, including other key types, is null.
 */
export function parseSshEd25519PublicKey(text: unknown): { publicKey: string; comment: string | null } | null {
  if (typeof text !== 'string' || text.length > SSH_ACCESS_MAX_KEY_TEXT_CHARS) return null;
  const line = text.replace(/\r?\n$/, '').replace(/^[ \t]+|[ \t]+$/g, '');
  if (!line || CONTROL.test(line)) return null;
  const match = /^ssh-ed25519[ \t]+(\S+)(?:[ \t]+(.*))?$/.exec(line);
  if (!match || !ED25519_BASE64.test(match[1]!)) return null;
  const comment = match[2]?.trim() || null;
  return { publicKey: `ssh-ed25519 ${match[1]}`, comment };
}

/** Strict: wrong types, malformed ids or keys make the whole request invalid. Unknown fields are ignored. */
export function parseSshAccessRequest(value: unknown): SshAccessRequest | null {
  const root = record(value);
  if (!root) return null;
  if (root.action === 'status') return { action: 'status' };
  const requestId = typeof root.requestId === 'string' && REQUEST_ID.test(root.requestId) ? root.requestId : null;
  if (!requestId) return null;
  if (root.action === 'withdraw') return { action: 'withdraw', requestId };
  if (root.action !== 'enroll') return null;
  const key = parseSshEd25519PublicKey(root.publicKey);
  // The wire form is canonical: a comment, extra whitespace or a trailing newline is a malformed request.
  if (!key || key.comment !== null || key.publicKey !== root.publicKey) return null;
  return { action: 'enroll', requestId, publicKey: key.publicKey };
}

function parseEndpoint(value: unknown): SshAccessEndpoint | null {
  const root = record(value);
  if (!root || typeof root.user !== 'string' || !USER.test(root.user)) return null;
  const port = root.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const addresses: SshAccessAddress[] = [];
  for (const item of Array.isArray(root.addresses) ? root.addresses : []) {
    const row = record(item);
    // Unknown kinds (a newer target) and invalid hosts are skipped individually.
    if (!row || (row.kind !== 'public' && row.kind !== 'lan' && row.kind !== 'mdns') || !isSshAccessHost(row.host)) continue;
    if (addresses.some((known) => known.host === row.host)) continue;
    addresses.push({ kind: row.kind, host: row.host });
    if (addresses.length === SSH_ACCESS_MAX_ADDRESSES) break;
  }
  const hostKeys: string[] = [];
  for (const key of Array.isArray(root.hostKeys) ? root.hostKeys : []) {
    if (typeof key !== 'string' || !HOST_KEY.test(key) || hostKeys.includes(key)) continue;
    hostKeys.push(key);
    if (hostKeys.length === SSH_ACCESS_MAX_HOST_KEYS) break;
  }
  return { user: root.user, port, addresses, hostKeys };
}

const isRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Field-tolerant reply parser; an endpoint with an invalid user or port is dropped (null), invalid entries are skipped. */
export function parseSshAccessStatus(value: unknown): SshAccessStatus<SshAccessParsedBlock> | null {
  const root = record(value);
  if (!root || typeof root.enabled !== 'boolean' || typeof root.authorized !== 'boolean' || !isRevision(root.revision)) return null;
  const blocked = root.blocked === null || root.blocked === undefined ? null
    : root.blocked === 'SSHD_UNREACHABLE' || root.blocked === 'REMOTE_LOGIN_OFF'
      || root.blocked === 'AUTHORIZED_KEYS_UNSUPPORTED' || root.blocked === 'PLATFORM_UNSUPPORTED'
      ? root.blocked : 'UNKNOWN';
  return {
    version: typeof root.version === 'number' ? root.version : SSH_ACCESS_VERSION,
    enabled: root.enabled,
    blocked,
    authorized: root.authorized,
    revision: root.revision,
    endpoint: root.endpoint === null || root.endpoint === undefined ? null : parseEndpoint(root.endpoint),
  };
}

export function parseSshAccessAnnounce(value: unknown): SshAccessAnnounce | null {
  const root = record(value);
  if (!root || typeof root.enabled !== 'boolean' || typeof root.authorized !== 'boolean' || !isRevision(root.revision)) return null;
  return {
    version: typeof root.version === 'number' ? root.version : SSH_ACCESS_VERSION,
    enabled: root.enabled,
    revision: root.revision,
    authorized: root.authorized,
  };
}

/** Reads `[SSH_ACCESS_*]` out of an IPC error message; null for anything else. */
export function sshAccessErrorCode(message: unknown): SshAccessErrorCode | null {
  const match = typeof message === 'string' ? /\[(SSH_ACCESS_[A-Z_]+)\]/.exec(message) : null;
  const code = match?.[1];
  return code === 'SSH_ACCESS_DISABLED' || code === 'SSH_ACCESS_INVALID' || code === 'SSH_ACCESS_KEY_IN_USE'
    || code === 'SSH_ACCESS_UNAVAILABLE' || code === 'SSH_ACCESS_WRITE_FAILED' ? code : null;
}

const KEY_A = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJfYPtO9L0UmsOJcs+BJ3iMNHFGtQIONiQHLRdZfuvr7';
const KEY_B = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMaGP9ZBWsUOAER5H5Zf4eYmzMBURk1Zj2heBDSMKSOi';
const ENDPOINT: SshAccessEndpoint = {
  user: 'ubuntu',
  port: 22,
  addresses: [{ kind: 'public', host: '203.0.113.7' }, { kind: 'lan', host: '10.0.0.5' }, { kind: 'mdns', host: 'studio.local' }],
  hostKeys: [KEY_B],
};

/**
 * Valid and invalid wire examples shared by the target's and the controller's tests (protocol-compatibility.md §1: the
 * same fixtures on both ends). Every `valid` row lists the parsed value it must produce; every `invalid` row must parse
 * to null. Keys are throwaway fixtures, never used anywhere.
 */
export const SSH_ACCESS_EXAMPLES = {
  publicKey: {
    valid: [
      { input: KEY_A, expected: { publicKey: KEY_A, comment: null } },
      { input: `${KEY_A} dash@laptop\n`, expected: { publicKey: KEY_A, comment: 'dash@laptop' } },
      { input: `  ${KEY_B}\twork key  `, expected: { publicKey: KEY_B, comment: 'work key' } },
    ],
    invalid: [
      '',
      `from="10.0.0.1" ${KEY_A}`,
      `command="/bin/true" ${KEY_A}`,
      `${KEY_A}\n${KEY_B}`,
      `${KEY_A}\r\n\r\n`,
      `${KEY_A} bad\u0000comment`,
      'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQDP863DXU2kt+JxGl4OIGkm5niIiGGWywhJGTjR7FoN',
      'sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIJfYPtO9L0UmsOJcs+BJ3iMNHFGtQIONiQHLRdZfuvr7',
      // Truncated, padded and wrong-header blobs.
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJfYPtO9L0UmsOJcs+BJ3iMNHFGtQIONiQHLRdZfuvr',
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJfYPtO9L0UmsOJcs+BJ3iMNHFGtQIONiQHLRdZfuvr7==',
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAQJfYPtO9L0UmsOJcs+BJ3iMNHFGtQIONiQHLRdZfuvr7',
      `${KEY_A} ${'x'.repeat(SSH_ACCESS_MAX_KEY_TEXT_CHARS)}`,
    ],
  },
  request: {
    valid: [
      { input: { action: 'status' }, expected: { action: 'status' } },
      { input: { action: 'status', future: true }, expected: { action: 'status' } },
      { input: { action: 'enroll', requestId: 'enroll-0001', publicKey: KEY_A }, expected: { action: 'enroll', requestId: 'enroll-0001', publicKey: KEY_A } },
      { input: { action: 'withdraw', requestId: 'withdraw_0001' }, expected: { action: 'withdraw', requestId: 'withdraw_0001' } },
    ],
    invalid: [
      null,
      [],
      { action: 'unknown' },
      { action: 'enroll', requestId: 'short', publicKey: KEY_A },
      { action: 'enroll', requestId: 'enroll-0001', publicKey: `${KEY_A} comment` },
      { action: 'enroll', requestId: 'enroll-0001', publicKey: `${KEY_A}\n` },
      { action: 'enroll', requestId: 'enroll-0001', publicKey: `no-pty ${KEY_A}` },
      { action: 'enroll', requestId: 'enroll-0001' },
      { action: 'withdraw', requestId: 'has space 0001' },
      { action: 'withdraw' },
    ],
  },
  status: {
    valid: [
      {
        input: { version: 1, enabled: true, blocked: null, authorized: true, revision: 42, endpoint: ENDPOINT },
        expected: { version: 1, enabled: true, blocked: null, authorized: true, revision: 42, endpoint: ENDPOINT },
      },
      {
        // A newer target: unknown fields, an unknown block reason and an unknown address kind degrade instead of failing.
        input: {
          version: 2, enabled: true, blocked: 'NEW_REASON', authorized: false, revision: 0, extra: { a: 1 },
          endpoint: { ...ENDPOINT, addresses: [{ kind: 'relay', host: 'r.example.com' }, { kind: 'lan', host: 'fd00::5' }] },
        },
        expected: {
          version: 2, enabled: true, blocked: 'UNKNOWN', authorized: false, revision: 0,
          endpoint: { ...ENDPOINT, addresses: [{ kind: 'lan', host: 'fd00::5' }] },
        },
      },
      {
        // Values that would inject SSH config lines are dropped; an invalid user drops the whole endpoint.
        input: {
          version: 1, enabled: true, blocked: null, authorized: true, revision: 7,
          endpoint: { ...ENDPOINT, addresses: [{ kind: 'lan', host: 'a.local\nProxyCommand evil' }], hostKeys: [`${KEY_A}\nHost *`] },
        },
        expected: {
          version: 1, enabled: true, blocked: null, authorized: true, revision: 7,
          endpoint: { ...ENDPOINT, addresses: [], hostKeys: [] },
        },
      },
      {
        input: { version: 1, enabled: true, blocked: null, authorized: true, revision: 8, endpoint: { ...ENDPOINT, user: 'root\nHost *' } },
        expected: { version: 1, enabled: true, blocked: null, authorized: true, revision: 8, endpoint: null },
      },
      {
        input: { version: 1, enabled: false, blocked: 'PLATFORM_UNSUPPORTED', authorized: false, revision: 3, endpoint: null },
        expected: { version: 1, enabled: false, blocked: 'PLATFORM_UNSUPPORTED', authorized: false, revision: 3, endpoint: null },
      },
    ],
    invalid: [
      null,
      { enabled: 'yes', blocked: null, authorized: true, revision: 1, endpoint: null },
      { enabled: true, blocked: null, authorized: true, revision: -1, endpoint: null },
      { enabled: true, blocked: null, authorized: true, revision: 1.5, endpoint: null },
      { enabled: true, blocked: null, revision: 1, endpoint: null },
    ],
  },
  announce: {
    valid: [
      { input: { version: 1, enabled: true, revision: 9, authorized: false }, expected: { version: 1, enabled: true, revision: 9, authorized: false } },
      { input: { enabled: false, revision: 0, authorized: false, extra: 'x' }, expected: { version: 1, enabled: false, revision: 0, authorized: false } },
    ],
    invalid: [null, { enabled: true, revision: '9', authorized: false }, { enabled: true, revision: 9 }],
  },
} as const;
