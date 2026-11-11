/** Read-only, owner-scoped directory continuity. Never used for execution grants or mutations. */
import { createHash } from 'node:crypto';
import { MetadataContinuityReader, PROVIDER_GROUP_REMOTE_CHANNEL, readProviderMetadataContinuity, isProviderAccessDeniedError,
  type Envelope, type InvokeResultPayload, type MetadataContinuityScope } from '@cindy/device-link';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { MODEL_CATALOG_READ_CHANNELS } from '../../shared/controlledModelCatalog.js';
import { PROVIDER_GROUP_IPC } from '../../shared/providerGroup.js';

const READ_CHANNELS = new Set<string>(MODEL_CATALOG_READ_CHANNELS);

const TEMPORARY_CODES = new Set([
  'NETWORK_ERROR', 'NOT_CONNECTED', 'DEVICE_LINK_NOT_CONNECTED', 'DEVICE_OFFLINE',
  'DEVICE_UNRESPONSIVE', 'TIMEOUT', 'INVOKE_TIMEOUT', 'BACKPRESSURE', 'PEER_RESET',
  'LINK_CLOSED', 'LINK_NOT_OPEN', 'RATE_LIMITED', 'SERVICE_UNAVAILABLE',
]);

export function isTemporaryProviderMetadataFailure(error: unknown): boolean {
  const row = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown } : {};
  const code = row.code === undefined || row.code === 'IPC_ERROR'
    ? typeof row.message === 'string' ? /^\[([A-Z_]+)\]/.exec(row.message)?.[1] : undefined : row.code;
  if (typeof code === 'string' && /REVOKED|DENIED|REMOVED|PAUSED|DISABLED|UNAUTHORIZED|FORBIDDEN|INVALID|SCOPE_CHANGED/.test(code)) return false;
  if (typeof code === 'string' && TEMPORARY_CODES.has(code)) return true;
  // dispatch uses [UNAVAILABLE] while the provider-group handler is still
  // registering. That is a startup not-ready condition, not an authoritative
  // directory denial. Keep Fast-policy errors terminal, matching the group
  // continuity retry policy.
  if (code === 'UNAVAILABLE') return !/Fast policy/i.test(String(row.message ?? ''));
  const status = row.statusCode ?? row.status;
  return status === 0 || status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
}

const reader = new MetadataContinuityReader({ retryable: isTemporaryProviderMetadataFailure });
const directoryDenialListeners = new Set<() => void>();
/** Denials fence already captured fallbacks without requesting a mutation retry. */
let directoryDenialGeneration = 0;
/** Renderer-wide invalidation for an authoritative directory denial. */
export function onProviderDirectoryDenied(listener: () => void): () => void {
  directoryDenialListeners.add(listener);
  return () => { directoryDenialListeners.delete(listener); };
}
const directoryReader = new MetadataContinuityReader({
  retryable: isTemporaryProviderMetadataFailure,
  onDenied: (_resource, error) => {
    const status = error && typeof error === 'object'
      ? (error as { status?: unknown; statusCode?: unknown }).statusCode ?? (error as { status?: unknown }).status
      : undefined;
    if (!isProviderAccessDeniedError(error) && status !== 401 && status !== 403) return;
    directoryDenialGeneration += 1;
    directoryReader.clear();
    for (const listener of directoryDenialListeners) {
      try { listener(); } catch { /* Notification cannot restore the denied directory. */ }
    }
  },
});
let generation = 0;
const TARGET_GENERATION_CAP = 1024;
const targetGenerations = new Map<string, number>();
function ensureTargetGeneration(target: string): number | undefined {
  const existing = targetGenerations.get(target);
  if (existing !== undefined) return existing;
  if (targetGenerations.size >= TARGET_GENERATION_CAP) return undefined;
  targetGenerations.set(target, 0);
  return 0;
}
/** Directory mutations are independent of provider/group snapshots. */
let directoryGeneration = 0;
const denialListeners = new Set<(target: string) => void>();
/** A late denial must retire displays which already received the bounded fallback. */
export function onProviderMetadataDenied(listener: (target: string) => void): () => void {
  denialListeners.add(listener);
  return () => { denialListeners.delete(listener); };
}

interface LiveFenceMeta {
  key: string;
  target: string;
  owner: string;
  endpoint: string;
  generation: number;
}
interface LiveFence {
  meta: LiveFenceMeta;
  invalidated: boolean;
  active: number;
}
type LiveOnlyScope = MetadataContinuityScope & {
  liveOnly?: true;
  liveFence?: LiveFenceMeta;
};
/** Main push entry used by the controller's accepted frame handler. */
const PROVIDER_METADATA_SOURCE_CHANGE_CHANNELS = new Set<string>([
  'maker:provider:changed',
  'maker:agents:changed',
  PROVIDER_GROUP_IPC.CHANGED,
]);

export function handleProviderMetadataSourcePush(env: Envelope): boolean {
  if (env.kind !== 'push' || !env.src) return false;
  const payload = env.payload as { channel?: unknown } | undefined;
  if (!payload || typeof payload.channel !== 'string' || !PROVIDER_METADATA_SOURCE_CHANGE_CHANNELS.has(payload.channel)) return false;
  invalidateProviderMetadataContinuity(env.src);
  return true;
}

/** Only in-flight capacity fallbacks live here; entries vanish when they settle. */
const LIVE_FENCE_LIMIT = 256;
const liveFences = new Map<string, LiveFence>();

function beginLiveFence(meta: LiveFenceMeta): LiveFence {
  let fence = liveFences.get(meta.key);
  if (fence?.invalidated) fence = undefined;
  if (!fence) {
    if (liveFences.size >= LIVE_FENCE_LIMIT) {
      throw Object.assign(new Error('[REMOTE_AGENT_UNAVAILABLE] metadata live-read fence is full'),
        { code: 'REMOTE_AGENT_UNAVAILABLE' });
    }
    fence = { meta, invalidated: false, active: 0 };
    liveFences.set(meta.key, fence);
  }
  fence.active += 1;
  return fence;
}

function endLiveFence(fence: LiveFence): void {
  fence.active -= 1;
  if (fence.active === 0 && liveFences.get(fence.meta.key) === fence) liveFences.delete(fence.meta.key);
}

function invalidateLiveFences(target: string): void {
  const owner = activeOwnerScopeKey();
  const endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
  const epoch = generation;
  for (const fence of liveFences.values()) {
    if (fence.meta.target === target && fence.meta.owner === owner
      && fence.meta.endpoint === endpoint && fence.meta.generation === epoch) fence.invalidated = true;
  }
}

function invalidateAllLiveFences(): void {
  for (const fence of liveFences.values()) fence.invalidated = true;
}

/**
 * Denial episodes are tracked per target. Registered targets have a slot in
 * the existing bounded target registry; live-only targets use a separate
 * recent-episode ring. A live-only episode that is evicted is a new episode on
 * its next read, not a silent denial; the ring is a memory/backpressure budget,
 * not a claim about the total number of live targets.
 *
 * Keys deliberately exclude target generation: a refusal path invalidates the
 * target again and must not re-arm the same notification. Only a fresh
 * same-resource success or an explicit permission transition clears it.
 */
const DENIAL_RESOURCES_PER_TARGET = 64;
// Registered target episodes are bounded by the target registry itself; a
// registered neighbour always has a slot because the registry includes it.
const DENIAL_REGISTERED_TARGET_LIMIT = TARGET_GENERATION_CAP;
// Live-only targets are not in the registry. Keep a bounded dedup ring of
// recent live episodes; an evicted inactive target is a new read episode.
const DENIAL_LIVE_TARGET_LIMIT = 256;
interface DenialEpisode { target: string; resources: Set<string>; overflow: boolean; rearmed: Map<string, true>; visible: boolean }
const deniedMetadataTargets = new Map<string, DenialEpisode>();
const deniedLiveMetadataTargets = new Map<string, DenialEpisode>();
function denialTargetKey(target: string): string {
  return JSON.stringify([activeOwnerScopeKey(), getClientEndpoint('deviceLinkApiBaseUrl'), generation, target]);
}
function denialMapFor(target: string): Map<string, DenialEpisode> {
  return targetGenerations.has(target) ? deniedMetadataTargets : deniedLiveMetadataTargets;
}
function denialMarked(target: string, resource: string): boolean {
  const state = denialMapFor(target).get(denialTargetKey(target));
  if (state === undefined) return false;
  if (state.visible) return false;
  return !state.rearmed.has(resource) && (state.overflow || state.resources.has(resource));
}
function liveFenceActive(state: DenialEpisode, owner: string, endpoint: string, epoch: number): boolean {
  for (const fence of liveFences.values()) {
    if (fence.meta.target === state.target && fence.meta.owner === owner
      && fence.meta.endpoint === endpoint && fence.meta.generation === epoch
      && !fence.invalidated) return true;
  }
  return false;
}
function evictOldestLiveTarget(): boolean {
  const owner = activeOwnerScopeKey();
  const endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
  const epoch = generation;
  for (const [key, state] of deniedLiveMetadataTargets) {
    if (!liveFenceActive(state, owner, endpoint, epoch)) {
      deniedLiveMetadataTargets.delete(key);
      return true;
    }
  }
  return false;
}
function markDenial(target: string, resource: string): boolean {
  const key = denialTargetKey(target);
  const registered = targetGenerations.has(target);
  const map = registered ? deniedMetadataTargets : deniedLiveMetadataTargets;
  let state = map.get(key);
  if (!state) {
    if (registered) {
      if (map.size >= DENIAL_REGISTERED_TARGET_LIMIT) return false;
    } else if (map.size >= DENIAL_LIVE_TARGET_LIMIT) {
      if (!evictOldestLiveTarget()) return false;
    }
    state = { target, resources: new Set(), overflow: false, rearmed: new Map(), visible: false };
    map.set(key, state);
  }
  if (state.visible) {
    state.visible = false;
    state.rearmed.delete(resource);
    if (!state.resources.has(resource)) {
      if (state.resources.size < DENIAL_RESOURCES_PER_TARGET) state.resources.add(resource);
      else state.overflow = true;
    }
    map.delete(key); map.set(key, state);
    return true;
  }
  if (state.rearmed.has(resource)) {
    state.rearmed.delete(resource);
    if (state.resources.size < DENIAL_RESOURCES_PER_TARGET) state.resources.add(resource);
    else state.overflow = true;
    map.delete(key); map.set(key, state);
    return true;
  }
  if (state.resources.has(resource) || state.overflow) {
    // Touch on every refusal so the live-only ring evicts the least recently
    // denied inactive target, not a target still being refreshed.
    map.delete(key); map.set(key, state);
    return true;
  }
  if (state.resources.size >= DENIAL_RESOURCES_PER_TARGET) {
    state.overflow = true;
    map.delete(key); map.set(key, state);
    return true;
  }
  state.resources.add(resource);
  map.delete(key); map.set(key, state);
  return true;
}
function hasVisibleMetadataState(channel: string, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as { providers?: unknown; members?: unknown; config?: unknown };
  if (channel === 'maker:provider:list') {
    return Array.isArray(row.providers) && row.providers.length > 0;
  }
  if (channel === PROVIDER_GROUP_REMOTE_CHANNEL) {
    return (Array.isArray(row.members) && row.members.length > 0)
      || (row.config !== undefined && row.config !== null);
  }
  if (channel === 'maker:get-capabilities' || channel === 'maker:agent:status') {
    return Object.keys(row).some(key => key !== 'providerContinuity');
  }
  return false;
}
function clearDenialMark(target: string, resource: string, channel: string, value: unknown): void {
  const key = denialTargetKey(target);
  for (const map of [deniedMetadataTargets, deniedLiveMetadataTargets]) {
    const state = map.get(key);
    if (!state) continue;
    state.resources.delete(resource);
    state.rearmed.delete(resource);
    if (hasVisibleMetadataState(channel, value)) state.visible = true;
    if (state.overflow) {
      state.rearmed.set(resource, true);
      while (state.rearmed.size > DENIAL_RESOURCES_PER_TARGET) {
        const oldest = state.rearmed.keys().next().value;
        if (oldest === undefined) break;
        state.rearmed.delete(oldest);
      }
    }
    if (!state.overflow && !state.visible && state.resources.size === 0) map.delete(key);
  }
}
function clearTargetDenials(target: string): void {
  const key = denialTargetKey(target);
  deniedMetadataTargets.delete(key);
  deniedLiveMetadataTargets.delete(key);
}
function fenceTarget(target: string): void {
  invalidateLiveFences(target);
  const current = targetGenerations.get(target);
  if (current !== undefined) targetGenerations.set(target, current + 1);
}

function isDeniedError(error: unknown): boolean {
  const status = error && typeof error === 'object'
    ? (error as { status?: unknown; statusCode?: unknown }).statusCode
      ?? (error as { status?: unknown }).status
    : undefined;
  return isProviderAccessDeniedError(error) || status === 401 || status === 403;
}

/** A single directory resource reached its own budget; this is not a target permission event. */
class ProviderMetadataBudgetExpiredError extends Error {
  readonly code = 'MODEL_VISIBILITY_NOT_READY';
  constructor() {
    super('[MODEL_VISIBILITY_NOT_READY] Provider directory snapshot expired');
    this.name = 'ProviderMetadataBudgetExpiredError';
  }
}
function isProviderMetadataBudgetExpired(error: unknown): boolean {
  return error instanceof ProviderMetadataBudgetExpiredError;
}

function notifyTargetDenial(target: string, resource: string): void {
  const duplicate = denialMarked(target, resource);
  fenceTarget(target);
  // At the hard cap keep fencing reads, but do not turn an already-retired
  // target into an unbounded notification loop. The target was cleared by the
  // first episode; the resulting map is bounded.
  if (!markDenial(target, resource) || duplicate) return;
  for (const listener of denialListeners) {
    try { listener(target); } catch { /* Notification cannot undo the permission fence. */ }
  }
}

/** Known denials/permission edits invalidate even in-flight snapshots. Presence loss does not. */
export function invalidateProviderMetadataContinuity(
  target?: string,
  options?: { keepDenialNotifications?: boolean },
): void {
  if (target !== undefined) {
    fenceTarget(target);
    if (!options?.keepDenialNotifications) clearTargetDenials(target);
    return;
  }
  generation++;
  targetGenerations.clear();
  deniedMetadataTargets.clear();
  deniedLiveMetadataTargets.clear();
  reader.clear();
  directoryReader.clear();
  invalidateAllLiveFences();
}

function scope(
  allowed: () => boolean = () => true,
  target?: string,
  options?: { liveFallback?: boolean },
): LiveOnlyScope {
  const owner = activeOwnerScopeKey();
  const endpoint = getClientEndpoint('deviceLinkApiBaseUrl');
  const epoch = generation;
  const scopeCurrent = (targetCurrent: boolean) => !isAppSessionBoundaryPending()
    && activeOwnerScopeKey() === owner
    && getClientEndpoint('deviceLinkApiBaseUrl') === endpoint && generation === epoch
    && targetCurrent && allowed();
  const targetEpoch = target === undefined ? 0 : ensureTargetGeneration(target);
  if (target !== undefined && targetEpoch === undefined) {
    // The bounded target registry is full. A live read may still use the real
    // authority, but must not mint a cache entry or claim a continuity budget.
    // Scope captures for routing contexts stay fail-closed (no liveFallback).
    if (options?.liveFallback) {
      const key = JSON.stringify([owner, endpoint, epoch, target, 'capacity-live']);
      return { key, current: () => scopeCurrent(true), signalingAvailable: () => true, validForMs: 0,
        liveOnly: true, liveFence: { key, target, owner, endpoint, generation: epoch } };
    }
    // Fail closed instead of retiring unrelated targets.
    return { key: JSON.stringify([owner, endpoint, epoch, target, 'capacity']),
      current: () => false, signalingAvailable: () => true };
  }
  return {
    key: JSON.stringify([owner, endpoint, epoch, target, targetEpoch]),
    current: () => scopeCurrent(target === undefined
      || (targetGenerations.has(target) && targetGenerations.get(target) === targetEpoch)),
    // Live direct RPCs should refresh metadata even when cloud signaling is down.
    signalingAvailable: () => true,
  };
}

export async function readProviderDirectoryContinuity<T>(request: () => Promise<T>) {
  // handleListDevices already owns its 300ms coalescing and latest-response
  // ordering; a later explicit refresh must not join a superseded directory.
  return directoryReader.read({ ...directoryScope(), joinPending: false }, 'device-directory', request);
}

/** A rename/delete changes only the directory; provider/group snapshots stay bounded. */
export function invalidateProviderDirectoryContinuity(): void {
  directoryGeneration += 1;
  directoryReader.invalidate(scope(), 'device-directory');
}

/** Main can distinguish a stale in-flight directory response from a fresh one. */
export function providerDirectoryGeneration(): number { return directoryGeneration; }

function directoryScope(): MetadataContinuityScope {
  const base = scope();
  const captured = directoryGeneration;
  const capturedDenial = directoryDenialGeneration;
  return { ...base, current: () => base.current() && captured === directoryGeneration
    && capturedDenial === directoryDenialGeneration };
}

/** Other bounded routing snapshots share the same known-permission invalidation fence. */
export function captureProviderMetadataContinuityScope(target: string): () => boolean {
  return scope(() => true, target).current;
}

/** Only the two explicit metadata reads below may use a snapshot. In particular caps, pick,
 * delegation checks, usage writes and Agent operations always reach their real authority. */
export async function invokeProviderMetadataContinuity(
  target: string, channel: string, args: unknown[], request: () => Promise<InvokeResultPayload>,
  allowed: () => boolean = () => true,
): Promise<InvokeResultPayload> {
  const groupView = channel === PROVIDER_GROUP_REMOTE_CHANNEL && args.length === 1
    && !!args[0] && typeof args[0] === 'object' && (args[0] as { action?: unknown }).action === 'view';
  if (!READ_CHANNELS.has(channel) && !groupView) return request();
  const resource = createHash('sha256').update(JSON.stringify([target, channel, args])).digest('hex');
  const capturedScope = scope(allowed, target, { liveFallback: true });
  if (capturedScope.liveOnly) {
    // Do not cache or stamp a result whose target could not enter the bounded
    // continuity registry. The caller still gets the authoritative live read,
    // fenced so a revocation observed by any concurrent read retires the rest.
    const meta = capturedScope.liveFence;
    if (!meta) throw new Error('Metadata scope changed');
    const fence = beginLiveFence(meta);
    try {
      if (!capturedScope.current()) throw new Error('Metadata scope changed');
      let result: InvokeResultPayload;
      const requestedAt = { wall: Date.now(), mono: performance.now() };
      try {
        result = await request();
      } catch (error) {
        if (!capturedScope.current() || fence.invalidated) throw new Error('Metadata scope changed');
        if (isDeniedError(error)) notifyTargetDenial(target, resource);
        else if (!isTemporaryProviderMetadataFailure(error)) invalidateProviderMetadataContinuity(target, { keepDenialNotifications: true });
        throw error;
      }
      if (!capturedScope.current() || fence.invalidated) throw new Error('Metadata scope changed');
      if (!result.ok) {
        if (isDeniedError(result.error)) notifyTargetDenial(target, resource);
        else {
          const failure = Object.assign(new Error(result.error.message), { code: result.error.code });
          if (!isTemporaryProviderMetadataFailure(failure)) invalidateProviderMetadataContinuity(target, { keepDenialNotifications: true });
        }
        return result;
      }
      const value = result.result;
      const forwarded = value && typeof value === 'object' && !Array.isArray(value)
        ? readProviderMetadataContinuity(value) : undefined;
      if (forwarded && value && typeof value === 'object' && !Array.isArray(value)) {
        const remainingMs = Math.min(
          requestedAt.wall + forwarded.remainingMs - Date.now(),
          requestedAt.mono + forwarded.remainingMs - performance.now(),
        );
        if (remainingMs <= 0) {
          // Fence local live-read siblings, but do not advance a registered target's permission epoch.
          invalidateLiveFences(target);
          throw new ProviderMetadataBudgetExpiredError();
        }
        if (!forwarded.stale) clearDenialMark(target, resource, channel, value);
        return { ...result, result: { ...value, providerContinuity: {
          stale: forwarded.stale, remainingMs,
        } } };
      }
      clearDenialMark(target, resource, channel, value);
      return result;
    } finally {
      endLiveFence(fence);
    }
  }
  capturedScope.remainingTrustMs = (value: unknown): number => {
    // Legacy array/scalar replies cannot carry a forwarding budget without
    // changing their shape. A missing stamp is also an old endpoint: it must
    // stay live, not get a synthetic cache budget or a synthetic zero stamp.
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
    return readProviderMetadataContinuity(value)?.remainingMs ?? 0;
  };
  let failure: InvokeResultPayload | undefined;
  try {
    const result = await reader.read(capturedScope, resource, async () => {
      try {
        const result = await request();
        if (!result.ok) {
          failure = result;
          throw Object.assign(new Error(result.error.message), { code: result.error.code });
        }
        const forwarded = readProviderMetadataContinuity(result.result);
        if (forwarded && forwarded.remainingMs <= 0) {
          throw new ProviderMetadataBudgetExpiredError();
        }
        return result.result;
      } catch (error) {
        // This physical read can finish after reader.read returned its 2s fallback.
        // Fence the captured owner/realm/permission generation before touching any target.
        if (capturedScope.current() && isDeniedError(error)) notifyTargetDenial(target, resource);
        throw error;
      }
    });
    const value = result.value;
    const forwarded = value && typeof value === 'object' && !Array.isArray(value)
      ? readProviderMetadataContinuity(value) : undefined;
    if (!result.stale) {
      // A fresh no-stamp object is an old endpoint. Never let an older stamped
      // snapshot for the same resource satisfy a later failure.
      if (!forwarded && value && typeof value === 'object' && !Array.isArray(value)) {
        reader.invalidate(capturedScope, resource);
      }
      if (!forwarded?.stale) clearDenialMark(target, resource, channel, value);
    }
    return { ok: true, result: forwarded && value && typeof value === 'object' && !Array.isArray(value)
      ? { ...value, providerContinuity: { stale: result.stale
        || (value as { providerContinuity?: { stale?: unknown } }).providerContinuity?.stale === true,
      remainingMs: result.remainingMs } } : value };
  } catch (error) {
    if (capturedScope.current() && !isProviderMetadataBudgetExpired(error)
      && !isTemporaryProviderMetadataFailure(error)) {
      invalidateProviderMetadataContinuity(target, { keepDenialNotifications: true });
    }
    if (failure) return failure;
    throw error;
  }
}
