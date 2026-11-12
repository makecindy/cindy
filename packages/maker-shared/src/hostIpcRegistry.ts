/**
 * Registry of desktop IPC channels that a Host serves through one generic route
 * (`POST /api/ipc/<channel>`).
 *
 * Pure data and validation only: the web client, the desktop proxy and the Host
 * all load this file, and none of them may pull in Node or Electron through it.
 * Handlers are bound on the Node side (`apps/host/src/ipc-bindings/`).
 *
 * Entries live one family per file in `hostIpcEntries/`, listed in
 * HOST_IPC_FAMILIES by family name; entries inside a family are sorted by
 * channel. The registry test keeps both orders and the fingerprint snapshot
 * sorted, so parallel changes land in different places.
 *
 * A registered entry is a long-lived wire contract. A window can be newer or
 * older than the Host it attaches to, for as long as a task keeps that Host
 * running. The fingerprint matches exactly, so:
 * - any change to arguments or result shape, including one added optional
 *   field, changes the fingerprint and the snapshot test fails on purpose;
 * - such a change takes a new channel name. A window on a Host that lacks the
 *   new name treats it as unsupported; a window that still needs the old
 *   Hosts keeps calling the old name until they are gone;
 * - a change of meaning without a shape change bumps `contractVersion`.
 *
 * Handlers receive the checked positional arguments only. Before a write
 * channel or a long-running read is registered, the handler signature must
 * gain a context (caller audience, ingress owner stamp, AbortSignal): today a
 * proxy timeout or abort does not cancel the Host-side handler.
 */

import { MAKER_SESSION_BACKGROUND_TASKS_IPC } from './hostIpcEntries/makerSessionBackgroundTasks.js';
import { MAKER_SIDE_CHAT_IPC } from './hostIpcEntries/makerSideChat.js';

/** Who may call an entry. Only the profile bearer (`local-api:*`) exists in batch 1a. */
export type HostIpcAudience = 'local';

/** Reads only in batch 1a; writes need ordering and no-replay rules first. */
export type HostIpcAccess = 'read';

/**
 * Sender admission the desktop proxy applies before forwarding. It names the
 * check the embedded handler uses, or a stricter one where the embedded handler
 * has none, so client mode is never looser.
 */
export type HostIpcSenderKind = 'trusted-app-renderer';

export type HostIpcSchema = (
  | {
    readonly type: 'string'; readonly nonBlank?: boolean; readonly maxLength?: number;
    /** Closed set of values, e.g. a TypeScript string union. */
    readonly enum?: readonly string[];
  }
  | { readonly type: 'number'; readonly integer?: boolean }
  | { readonly type: 'boolean' }
  | { readonly type: 'array'; readonly items: HostIpcSchema; readonly maxItems?: number }
  | { readonly type: 'object'; readonly properties: Readonly<Record<string, HostIpcSchema>> }
) & {
  /** Object property only: may be absent (JSON drops `undefined`). */
  readonly optional?: boolean;
};

export interface HostIpcEntry {
  readonly channel: string;
  /** Bump when the meaning changes without a shape change. */
  readonly contractVersion: number;
  readonly audience: readonly HostIpcAudience[];
  readonly access: HostIpcAccess;
  readonly sender: HostIpcSenderKind;
  /** Positional renderer arguments, checked on the Host before the handler runs. */
  readonly params: readonly HostIpcSchema[];
  /** Exact result shape; behaviour tests check real handler output against it. */
  readonly result: HostIpcSchema;
  /** Proxy timeout. Embedded IPC has none, so the default is generous. */
  readonly timeoutMs?: number;
}

export const HOST_IPC_PROTOCOL = 1;
export const HOST_IPC_PATH_PREFIX = '/api/ipc/';
export const HOST_IPC_MANIFEST_PATH = '/control/ipc-manifest';
export const HOST_INSTANCE_HEADER = 'x-cindy-host-instance';
export const HOST_IPC_CONTRACT_HEADER = 'x-cindy-ipc-contract';
export const HOST_IPC_DEFAULT_TIMEOUT_MS = 30_000;
export const HOST_IPC_MANIFEST_TIMEOUT_MS = 5_000;

/** Route rejections. Business errors from a handler keep their IPC error code. */
export const HOST_IPC_REJECTION = {
  instanceRequired: 'host_instance_required',
  instanceChanged: 'host_instance_changed',
  channelUnknown: 'channel_unknown',
  channelUnsupported: 'channel_unsupported',
  audienceDenied: 'audience_denied',
  contractMismatch: 'contract_mismatch',
  ownerScopeChanged: 'owner_scope_changed',
} as const;

export interface HostIpcOwnerStamp {
  readonly dataOwnerId: string | null;
  readonly ownerGeneration: number;
}

export interface HostIpcRequestBody {
  readonly args: readonly unknown[];
  readonly owner: HostIpcOwnerStamp;
}

export type HostIpcResponseBody =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export interface HostIpcManifest {
  readonly protocol: number;
  readonly instanceId: string;
  readonly entries: readonly { readonly channel: string; readonly fingerprint: string }[];
}

/** One file per family in `hostIpcEntries/`; keys sorted (registry test). */
export const HOST_IPC_FAMILIES: Readonly<Record<string, readonly HostIpcEntry[]>> = {
  'maker-session-background-tasks': MAKER_SESSION_BACKGROUND_TASKS_IPC,
  'maker-side-chat': MAKER_SIDE_CHAT_IPC,
};

const byChannel = (a: HostIpcEntry, b: HostIpcEntry) => (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0);

/** Every registered entry, sorted by channel (the manifest order). */
export const HOST_IPC_ENTRIES: readonly HostIpcEntry[] = Object.values(HOST_IPC_FAMILIES).flat().sort(byChannel);

export function findHostIpcEntry(channel: string, entries = HOST_IPC_ENTRIES): HostIpcEntry | undefined {
  return entries.find((entry) => entry.channel === channel);
}

export function hostIpcPath(channel: string): string {
  return `${HOST_IPC_PATH_PREFIX}${encodeURIComponent(channel)}`;
}

/** Stable JSON: object keys sorted, so property order never changes a fingerprint. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** FNV-1a 64: a compatibility check between cooperating builds, not a security boundary. */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Contract fingerprint: channel, semantic version, parameter and result shape.
 * Audience, sender and timeout are local policy and stay out of it.
 */
export function hostIpcFingerprint(entry: HostIpcEntry): string {
  return fnv1a64(canonical({
    channel: entry.channel,
    contractVersion: entry.contractVersion,
    params: entry.params,
    result: entry.result,
  }));
}

/**
 * Null when `value` matches `schema`; otherwise where and why it does not. The
 * position names object keys but never values; the Host logs it as is, so a
 * schema with user data as object keys needs a keyless position first.
 */
export function checkHostIpcValue(schema: HostIpcSchema, value: unknown, at = 'value'): string | null {
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') return `${at} must be a string`;
      if (schema.enum && !schema.enum.includes(value)) return `${at} is not an allowed value`;
      if (schema.nonBlank && value.trim() === '') return `${at} must not be blank`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${at} is too long`;
      return null;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${at} must be a finite number`;
      if (schema.integer && !Number.isInteger(value)) return `${at} must be an integer`;
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${at} must be a boolean`;
    case 'array': {
      if (!Array.isArray(value)) return `${at} must be an array`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${at} has too many items`;
      for (let index = 0; index < value.length; index += 1) {
        const problem = checkHostIpcValue(schema.items, value[index], `${at}[${index}]`);
        if (problem) return problem;
      }
      return null;
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return `${at} must be an object`;
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) return `${at}.${key} is not part of the contract`;
      }
      for (const [key, property] of Object.entries(schema.properties)) {
        if (property.optional && record[key] === undefined) continue;
        const problem = checkHostIpcValue(property, record[key], `${at}.${key}`);
        if (problem) return problem;
      }
      return null;
    }
  }
}

/** Positional arguments: exactly the declared count, each matching its schema. */
export function checkHostIpcArgs(entry: HostIpcEntry, args: unknown): string | null {
  if (!Array.isArray(args)) return 'args must be an array';
  if (args.length !== entry.params.length) return `expected ${entry.params.length} argument(s), got ${args.length}`;
  for (let index = 0; index < args.length; index += 1) {
    const problem = checkHostIpcValue(entry.params[index]!, args[index], `argument ${index + 1}`);
    if (problem) return problem;
  }
  return null;
}

export function isHostIpcOwnerStamp(value: unknown): value is HostIpcOwnerStamp {
  if (!value || typeof value !== 'object') return false;
  const owner = value as { dataOwnerId?: unknown; ownerGeneration?: unknown };
  return (owner.dataOwnerId === null || typeof owner.dataOwnerId === 'string')
    && Number.isSafeInteger(owner.ownerGeneration) && (owner.ownerGeneration as number) >= 0;
}
