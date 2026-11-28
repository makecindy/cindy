/**
 * Before-send account switching of plugin engine tasks (subscription-account-pools.md 插件引擎的账号),
 * the same rules as subscription-accounts/prepareSend.ts and failover.ts:
 *
 * - the task's account was paused or removed: hand the task to another account of its provider
 *   (context handoff, fresh native session), or report that none is available;
 * - the account cannot take the task's model right now (remembered failure, used-up quota, signed
 *   out): move when another account can take it, otherwise send to the original account.
 *
 * Both local tasks and same-account remote Agent tasks move here (SSH and provider shares never
 * move). For a remote Agent task, the controller asks the executing computer over the existing
 * owner-only account channel; when confirmed, it hands off context so the next fresh start on the
 * executing computer picks the replacement account. The old native session stays bound to the
 * account that owns its history; only the task's binding changes. A running turn is never moved.
 */
import { isProviderShareAgentDeviceId } from '../../shared/providerShare.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import type { RemoteSubscriptionInvoke } from '../subscription-accounts/runtime.js';
import { parsePluginEngineProviderId, pluginEngineProviderId } from './ids.js';
import {
  acquirePluginEngineAccount,
  anyPluginEngineAccountPool,
  canSwitchPluginEngineAccount,
  pluginEngineHasAccountPool,
  readPluginEngineAccountBlocked,
  readPluginEngineTaskAccount,
  readRemotePluginEngineAccount,
  refreshPluginEngineAccountForSend,
} from './runtime.js';
import { effectivePluginEnginePool } from './store.js';

export interface PluginEngineFailoverSession {
  status: string;
  providerId: string | null;
  agentKind?: string | null;
  model?: string | null;
  sdkSessionId?: string | null;
  remoteHostId?: string | null;
  agentDeviceId?: string | null;
}

export interface PluginEngineFailoverDeps {
  readSession(id: string): Promise<PluginEngineFailoverSession | null>;
  isRunning(id: string): boolean;
  /** Retires the idle runtime and durably saves a context handoff; calls `assertCurrent` before committing. */
  rebuild(id: string, assertCurrent: () => void): Promise<void>;
  /** Owner-only session-account read on the task's executing computer (same-account remote Agent). */
  invokeRemote?: RemoteSubscriptionInvoke;
  log?(message: string, fields: Record<string, unknown>): void;
}

interface TaskAccount {
  /** The provider the account belongs to now: the replacement is picked there. */
  providerId: string;
  /** The provider the task is routed to; it stays the task's route after the handoff. */
  routeProviderId: string;
  engineKey: string;
  accountId: string;
  model: string | undefined;
}

function taskAccount(sessionId: string, row: PluginEngineFailoverSession | null): TaskAccount | null {
  if (!row || row.status === 'deleted' || row.remoteHostId || row.agentDeviceId || row.agentKind !== 'acp') return null;
  const ref = parsePluginEngineProviderId(row.providerId);
  if (!ref || !pluginEngineHasAccountPool(ref.engineKey)) return null;
  // A conversation from before the engine had accounts lives in the agent's original login.
  const binding = readPluginEngineTaskAccount(ref.engineKey, sessionId, row.sdkSessionId ?? undefined)
    ?? (row.sdkSessionId ? { accountId: 'default' } : undefined);
  if (!binding) return null;
  const pool = effectivePluginEnginePool(ref.engineKey);
  // The task follows its account: pick within the provider the account belongs to now.
  const suffix = pool.placement?.[binding.accountId] ?? null;
  return {
    providerId: pool.accounts.some(account => account.id === binding.accountId)
      ? pluginEngineProviderId(ref.engineKey, suffix) : ref.providerId,
    routeProviderId: ref.providerId,
    engineKey: ref.engineKey,
    accountId: binding.accountId,
    model: row.model ?? undefined,
  };
}

async function handOff(
  sessionId: string,
  row: PluginEngineFailoverSession,
  task: TaskAccount,
  deps: PluginEngineFailoverDeps,
  reason: 'disabled' | 'blocked',
): Promise<boolean> {
  const owner = activeOwnerScopeKey();
  const lease = await acquirePluginEngineAccount(task.providerId, task.model, [], {
    resuming: false, exclude: new Set([task.accountId]),
  });
  if (!lease) return false;
  try {
    const assertCurrent = () => {
      if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) throw new Error('Subscription account owner changed');
      lease.assertDispatchable();
      if (deps.isRunning(sessionId)) throw new Error('Cannot switch a running task subscription account');
      if ((readPluginEngineTaskAccount(task.engineKey, sessionId, row.sdkSessionId ?? undefined)?.accountId ?? 'default') !== task.accountId)
        throw new Error('The task subscription account changed');
    };
    assertCurrent();
    // Context first: a failed binding write leaves a recoverable handoff on the old account.
    if (row.sdkSessionId) await deps.rebuild(sessionId, assertCurrent);
    assertCurrent();
    // The handoff keeps the task's route (a taken-out provider merged back included): bind through it,
    // so the next start keeps this account instead of picking again in a provider with no accounts.
    await lease.bind([`task:${sessionId}`], task.routeProviderId);
    lease.reserveForTask(sessionId);
    deps.log?.('plugin engine account: moved task before send', {
      sessionId, engine: task.engineKey, reason, from: task.accountId, to: lease.accountId,
    });
    return true;
  } finally {
    lease.release();
  }
}

/** Under the ordinary send lock, before a runtime is created or reused. */
export async function preparePluginEngineAccountForSend(sessionId: string, deps: PluginEngineFailoverDeps): Promise<boolean> {
  const local = anyPluginEngineAccountPool();
  // Remote Agent tasks belong to their executing computer even when this computer has no local pool.
  if (!local && !deps.invokeRemote) return false;
  const owner = activeOwnerScopeKey();
  const assertOwner = () => {
    if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending())
      throw new Error('Subscription account owner changed');
  };
  const read = await deps.readSession(sessionId);
  assertOwner();
  const row = read && { ...read };
  if (row && row.status !== 'deleted' && !row.remoteHostId && row.agentDeviceId
    && !isProviderShareAgentDeviceId(row.agentDeviceId) && row.agentKind === 'acp') {
    if (!deps.invokeRemote || !row.sdkSessionId || deps.isRunning(sessionId)) return false;
    let remote: Awaited<ReturnType<typeof readRemotePluginEngineAccount>>;
    try {
      remote = await readRemotePluginEngineAccount(row, deps.invokeRemote);
    } catch {
      assertOwner();
      return false;
    }
    assertOwner();
    if (!remote) return false;
    if (remote.disabled) {
      if (!remote.available) throw new Error('No subscription account is available');
    } else if (!remote.blocked || !remote.available) {
      return false;
    }
    const assertCurrent = () => {
      assertOwner();
      if (deps.isRunning(sessionId)) throw new Error('Cannot switch a running task subscription account');
    };
    const current = await deps.readSession(sessionId);
    assertCurrent();
    if (!current || current.status === 'deleted' || current.providerId !== row.providerId
      || current.agentDeviceId !== row.agentDeviceId || current.remoteHostId !== row.remoteHostId
      || current.model !== row.model || current.sdkSessionId !== row.sdkSessionId)
      throw new Error('The task route changed');
    // Clearing native session after durable handoff lets the next fresh start on the executing computer pick the replacement.
    await deps.rebuild(sessionId, assertCurrent);
    deps.log?.('plugin engine account: moved remote task before send', {
      sessionId, deviceId: row.agentDeviceId, reason: remote.disabled ? 'disabled' : 'blocked',
    });
    return true;
  }
  if (!local) return false;
  const task = taskAccount(sessionId, row);
  if (!row || !task) return false;
  const pool = effectivePluginEnginePool(task.engineKey);
  const account = pool.accounts.find(entry => entry.id === task.accountId);
  if (account && !account.paused) {
    if (deps.isRunning(sessionId)) return false;
    // Only a provider with another account can move the task: then check what its account says now.
    const placement = pool.placement?.[task.accountId] ?? null;
    if (pool.accounts.filter(entry => (pool.placement?.[entry.id] ?? null) === placement).length < 2) return false;
    await refreshPluginEngineAccountForSend(task.engineKey, task.accountId);
    // Blocked for this model: move only when another account can take it right now.
    if (!readPluginEngineAccountBlocked(task.engineKey, task.accountId, task.model) || deps.isRunning(sessionId)) return false;
    try {
      return await handOff(sessionId, row, task, deps, 'blocked');
    } catch {
      return false;
    }
  }
  // Paused or removed: an explicit routing decision. The send fails when nothing else can take it.
  if (deps.isRunning(sessionId)) throw new Error('Cannot switch a running task subscription account');
  if (!(await handOff(sessionId, row, task, deps, 'disabled'))) throw new Error('No subscription account is available');
  return true;
}

/** Whether another account can take this task right now (continue a usage-limited turn at once). */
export async function canSwitchPluginEngineTaskAccount(
  sessionId: string,
  readSession: PluginEngineFailoverDeps['readSession'],
  invokeRemote?: RemoteSubscriptionInvoke,
): Promise<boolean> {
  const local = anyPluginEngineAccountPool();
  if (!local && !invokeRemote) return false;
  const row = await readSession(sessionId);
  if (row && row.status !== 'deleted' && !row.remoteHostId && row.agentDeviceId
    && !isProviderShareAgentDeviceId(row.agentDeviceId) && row.agentKind === 'acp') {
    if (!invokeRemote || !row.sdkSessionId) return false;
    try {
      const remote = await readRemotePluginEngineAccount(row, invokeRemote);
      return !!remote && remote.available && (remote.blocked || remote.disabled);
    } catch {
      return false;
    }
  }
  if (!local) return false;
  const task = taskAccount(sessionId, row);
  if (!task || !readPluginEngineAccountBlocked(task.engineKey, task.accountId, task.model)) return false;
  return canSwitchPluginEngineAccount(task.providerId, sessionId, task.model, {
    nativeSessionId: row?.sdkSessionId ?? undefined,
    accountId: task.accountId,
  });
}
