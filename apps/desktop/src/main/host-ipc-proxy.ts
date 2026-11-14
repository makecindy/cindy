/**
 * Client-mode proxy for registered IPC channels (`@cindy/maker-shared/host-ipc-registry`).
 *
 * The embedded registrations stay untouched; in client mode each registered
 * channel is answered by forwarding to the Host's generic route. The proxy:
 *
 * - admits the sender with the entry's check: the embedded handler's, or the
 *   registered-app-window check where the embedded handler has none;
 * - negotiates once per Host instance (manifest of channel fingerprints) and
 *   treats anything the Host does not list as UNSUPPORTED_CAPABILITY. Only a
 *   definite answer is kept (a valid manifest, 404 from an older Host, another
 *   protocol); a failed negotiation fails this call and the next call asks again;
 * - stamps every call with the instance and the account the windows currently
 *   show, so a Host that switched account rejects instead of answering;
 * - after a lost connection re-attaches once for all waiting calls, and retries
 *   a read only when the same account and the same contract are confirmed.
 *   Writes are never replayed (none exist in batch 1a);
 * - when the launcher pinned an instance, never moves to another one: the event
 *   stream and the dedicated routes of this window stay on the pinned instance,
 *   so a replaced Host is CONNECTION_FAILED until the window itself is handed
 *   over. Only an unpinned proxy learns and follows the instance.
 *
 * Client-mode difference: embedded IPC has no timeout; a proxied call aborts
 * after the entry's timeout (default HOST_IPC_DEFAULT_TIMEOUT_MS).
 */

import type { IpcMainInvokeEvent } from 'electron';
import {
  HOST_INSTANCE_HEADER,
  HOST_IPC_CONTRACT_HEADER,
  HOST_IPC_DEFAULT_TIMEOUT_MS,
  HOST_IPC_ENTRIES,
  HOST_IPC_MANIFEST_PATH,
  HOST_IPC_MANIFEST_TIMEOUT_MS,
  HOST_IPC_PROTOCOL,
  HOST_IPC_REJECTION,
  hostIpcFingerprint,
  hostIpcPath,
  type HostIpcEntry,
  type HostIpcSenderKind,
} from '@cindy/maker-shared/host-ipc-registry';

import { createIpcError, isIpcErrorCode } from '../shared/ipc-errors.js';

export interface HostIpcOwnerView {
  readonly dataOwnerId: string | null;
  readonly ownerGeneration: number;
  readonly canEnterApp: boolean;
}

export interface HostIpcProxyDeps {
  readonly baseUrl: string;
  readonly token: string;
  /** Instance pinned by the launcher; learned from `/control/attachment` when absent. */
  readonly instanceId?: string;
  readonly fetch?: typeof fetch;
  /** Host auth state as the windows currently show it. */
  readonly readOwner: () => HostIpcOwnerView;
  /** Apply a freshly read Host auth state, so windows and proxy move together. */
  readonly applyAuthState: (state: unknown) => void;
  readonly log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface HostIpcProxy {
  invoke(entry: HostIpcEntry, args: readonly unknown[]): Promise<unknown>;
  /** Forget the negotiated manifest; the next call negotiates again (e.g. after the event stream reconnects). */
  invalidate(): void;
}

/** Instance changed, the Host is stopping, or the connection failed: the only failures that may re-attach. */
class ReattachNeeded extends Error {}

interface Reply { readonly status: number; readonly body: unknown }

const unsupported = (entry: HostIpcEntry) => createIpcError(
  'UNSUPPORTED_CAPABILITY', `Capability ${entry.channel} is not supported in host client mode`,
);

const HOST_STOPPING = 'host_stopping';

export function createHostIpcProxy(deps: HostIpcProxyDeps): HostIpcProxy {
  const doFetch = deps.fetch ?? fetch;
  const pinned = deps.instanceId ?? null;
  let instanceId: string | null = pinned;
  let manifest: { instanceId: string; load: Promise<Map<string, string>> } | null = null;
  const mismatched = new Set<string>();
  let attaching: Promise<boolean> | null = null;
  let reattaching: Promise<boolean> | null = null;
  let refreshing: Promise<void> | null = null;

  async function post(path: string, body: unknown, options: {
    timeoutMs: number; instance?: string | null; contract?: string;
  }): Promise<Reply> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await doFetch(`${deps.baseUrl}${path}`, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${deps.token}`,
          ...(options.instance ? { [HOST_INSTANCE_HEADER]: options.instance } : {}),
          ...(options.contract ? { [HOST_IPC_CONTRACT_HEADER]: options.contract } : {}),
        },
        body: JSON.stringify(body ?? null),
      });
      const text = await response.text();
      let parsed: unknown = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      return { status: response.status, body: parsed };
    } catch {
      if (controller.signal.aborted) throw createIpcError('CONNECTION_TIMEOUT', 'Host did not answer in time');
      throw new ReattachNeeded('Host connection failed');
    } finally {
      clearTimeout(timer);
    }
  }

  /** Learn or confirm the Host instance; `ready` is required before anything is forwarded. */
  function attach(): Promise<boolean> {
    attaching ??= (async () => {
      try {
        const reply = await post('/control/attachment', null, { timeoutMs: HOST_IPC_MANIFEST_TIMEOUT_MS });
        const body = reply.body as { protocol?: unknown; instanceId?: unknown; ready?: unknown } | null;
        if (reply.status !== 200 || body?.protocol !== 1 || typeof body.instanceId !== 'string') {
          deps.log?.('Host attachment unavailable', { status: reply.status });
          return false;
        }
        if (pinned && body.instanceId !== pinned) {
          // Rebinding is the window's handover, not this proxy's: the rest of the
          // window would still talk to the pinned instance.
          deps.log?.('Host instance changed; staying on the pinned instance', { pinned, attached: body.instanceId });
          return false;
        }
        if (body.ready !== true) {
          deps.log?.('Host attachment not ready', { instanceId: body.instanceId });
          return false;
        }
        if (body.instanceId !== instanceId) { manifest = null; mismatched.clear(); }
        instanceId = body.instanceId;
        return true;
      } catch (error) {
        if (error instanceof ReattachNeeded || (error as { code?: unknown }).code === 'CONNECTION_TIMEOUT') return false;
        throw error;
      }
    })().finally(() => { attaching = null; });
    return attaching;
  }

  /**
   * One negotiation per instance, shared by concurrent calls. A definite answer
   * is kept until invalidate(); a failure is not, so a single timeout or drop
   * cannot leave every channel unsupported for the life of the window.
   */
  function negotiated(instance: string): Promise<Map<string, string>> {
    if (manifest?.instanceId === instance) return manifest.load;
    const load = (async () => {
      // Throws CONNECTION_TIMEOUT or ReattachNeeded; neither is a definite answer.
      const reply = await post(HOST_IPC_MANIFEST_PATH, null, { timeoutMs: HOST_IPC_MANIFEST_TIMEOUT_MS, instance });
      const body = reply.body as { protocol?: unknown; instanceId?: unknown; entries?: unknown; error?: unknown } | null;
      if (reply.status === 409 && body?.error === HOST_IPC_REJECTION.instanceChanged) throw new ReattachNeeded('Host instance changed');
      if (reply.status === 503 && body?.error === HOST_STOPPING) throw new ReattachNeeded('Host is stopping');
      if (reply.status === 404) {
        // An older Host has no route: its dedicated routes keep working.
        deps.log?.('Host IPC manifest not offered', { status: reply.status });
        return new Map<string, string>();
      }
      if (reply.status === 200 && body?.protocol !== HOST_IPC_PROTOCOL) {
        deps.log?.('Host IPC manifest has another protocol', { protocol: body?.protocol });
        return new Map<string, string>();
      }
      if (reply.status !== 200 || body?.instanceId !== instance || !Array.isArray(body.entries)) {
        deps.log?.('Host IPC manifest unusable', { status: reply.status });
        if (reply.status === 401) throw createIpcError('PERMISSION_DENIED', 'The Host refused this window');
        throw createIpcError('CONNECTION_FAILED', 'Host did not negotiate; try again');
      }
      const offered = new Map<string, string>();
      for (const item of body.entries as Array<{ channel?: unknown; fingerprint?: unknown }>) {
        if (typeof item?.channel === 'string' && typeof item.fingerprint === 'string') offered.set(item.channel, item.fingerprint);
      }
      return offered;
    })();
    manifest = { instanceId: instance, load };
    load.catch(() => { if (manifest?.load === load) manifest = null; });
    return load;
  }

  /** Re-read the Host auth state once for all callers and hand it to the windows. */
  function refreshOwner(): Promise<void> {
    refreshing ??= (async () => {
      try {
        const reply = await post('/api/auth/state', null, { timeoutMs: HOST_IPC_MANIFEST_TIMEOUT_MS, instance: instanceId });
        if (reply.status === 200 && reply.body && typeof reply.body === 'object') deps.applyAuthState(reply.body);
      } catch (error) {
        deps.log?.('Host auth state refresh failed', { reason: error instanceof Error ? error.message : 'unknown' });
      }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  /** Shared by every call that hit an instance change or a lost connection. */
  function reattach(): Promise<boolean> {
    reattaching ??= (async () => {
      manifest = null;
      mismatched.clear();
      if (!(await attach())) return false;
      await refreshOwner();
      return true;
    })().finally(() => { reattaching = null; });
    return reattaching;
  }

  function interpret(entry: HostIpcEntry, reply: Reply): unknown {
    const body = reply.body as { ok?: unknown; result?: unknown; error?: unknown } | null;
    if (reply.status === 200 && body?.ok === true) return body.result;
    const error = body?.error as { code?: unknown; message?: unknown } | string | undefined;
    // Route rejections arrive enveloped; server middleware answers `{ error: '<code>' }`.
    const code = typeof error === 'string' ? error : typeof error?.code === 'string' ? error.code : null;
    const message = typeof error === 'object' && typeof error?.message === 'string' ? error.message : `Host rejected ${entry.channel}`;
    switch (code) {
      case HOST_IPC_REJECTION.instanceChanged:
        throw new ReattachNeeded('Host instance changed');
      case HOST_STOPPING:
        throw new ReattachNeeded('Host is stopping');
      case HOST_IPC_REJECTION.ownerScopeChanged:
        // A missed auth event must not leave this window failing forever.
        void refreshOwner();
        throw createIpcError('OWNER_CHANGED', 'The active account changed; try again');
      case HOST_IPC_REJECTION.contractMismatch:
        mismatched.add(entry.channel);
        throw unsupported(entry);
      case 'not_found':
      case HOST_IPC_REJECTION.channelUnknown:
      case HOST_IPC_REJECTION.channelUnsupported:
        throw unsupported(entry);
      case 'owner_runtime_unavailable':
        throw createIpcError('PRECONDITION_FAILED', 'The Host account is not ready');
      case 'unauthorized':
      case HOST_IPC_REJECTION.audienceDenied:
        throw createIpcError('PERMISSION_DENIED', 'The Host refused this window');
      default:
        if (isIpcErrorCode(code)) throw createIpcError(code, message);
        throw createIpcError('INTERNAL', `Host ${entry.channel} failed`);
    }
  }

  async function attempt(entry: HostIpcEntry, args: readonly unknown[], owner: HostIpcOwnerView): Promise<unknown> {
    if (!instanceId && !(await attach())) throw createIpcError('CONNECTION_FAILED', 'Host is not reachable');
    const instance = instanceId!;
    const fingerprint = hostIpcFingerprint(entry);
    const offered = await negotiated(instance);
    if (offered.get(entry.channel) !== fingerprint || mismatched.has(entry.channel)) throw unsupported(entry);
    const reply = await post(hostIpcPath(entry.channel), {
      args, owner: { dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.ownerGeneration },
    }, { timeoutMs: entry.timeoutMs ?? HOST_IPC_DEFAULT_TIMEOUT_MS, instance, contract: fingerprint });
    return interpret(entry, reply);
  }

  return {
    async invoke(entry, args) {
      const before = { instanceId, owner: deps.readOwner() };
      try {
        return await attempt(entry, args, before.owner);
      } catch (error) {
        if (!(error instanceof ReattachNeeded)) throw error;
        if (entry.access !== 'read' || !(await reattach())) {
          throw createIpcError('CONNECTION_FAILED', 'Lost the connection to the Host; try again');
        }
        const after = deps.readOwner();
        // Same account required; generations only compare within one Host process
        // (an unpinned proxy may have followed a replaced Host).
        const sameAccount = after.canEnterApp && after.dataOwnerId === before.owner.dataOwnerId
          && (instanceId !== before.instanceId || after.ownerGeneration === before.owner.ownerGeneration);
        if (!sameAccount) throw createIpcError('OWNER_CHANGED', 'The active account changed; try again');
        try {
          // The manifest check inside attempt() refuses a changed or missing contract.
          return await attempt(entry, args, after);
        } catch (retryError) {
          if (retryError instanceof ReattachNeeded) {
            throw createIpcError('CONNECTION_FAILED', 'Lost the connection to the Host; try again');
          }
          throw retryError;
        }
      }
    },
    invalidate() {
      manifest = null;
      mismatched.clear();
    },
  };
}

type RawHandle = (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void;

/**
 * Register a proxy for every registry entry. Call in client mode only; the
 * embedded handlers are never registered there.
 */
export function registerHostIpcProxies(input: {
  readonly ipcMain: { removeHandler(channel: string): void; handle: RawHandle };
  readonly proxy: HostIpcProxy;
  readonly admit: Readonly<Record<HostIpcSenderKind, (event: IpcMainInvokeEvent) => void>>;
  readonly entries?: readonly HostIpcEntry[];
}): string[] {
  const target = input.ipcMain as typeof input.ipcMain & { __originalHandle?: RawHandle };
  const rawHandle = (target.__originalHandle ?? target.handle).bind(target);
  const entries = input.entries ?? HOST_IPC_ENTRIES;
  for (const entry of entries) {
    if (typeof input.admit[entry.sender] !== 'function') throw new Error(`No sender admission for ${entry.sender}`);
  }
  for (const entry of entries) {
    const admit = input.admit[entry.sender];
    input.ipcMain.removeHandler(entry.channel);
    rawHandle(entry.channel, async (event, ...args) => {
      admit(event);
      return input.proxy.invoke(entry, args);
    });
  }
  return entries.map((entry) => entry.channel);
}
