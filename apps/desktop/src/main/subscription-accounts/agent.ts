import {
  NATIVE_SUBSCRIPTION_ACCOUNT,
  AgentStartupStoppedError,
  AgentStartupCleanupPendingError,
  AgentNotAuthenticatedError,
  isTerminalTurnEvent,
  resolveAgentCredentialMode,
  type AuthAdapter,
  type BaseAgent,
  type AgentSessionHandle,
  type StartSessionOptions,
  type ForkSdkSessionOptions,
  type RefreshLocalModelsOptions,
} from '@cindy/maker-core';
import { CHATGPT_MODEL_PREFIX } from '@cindy/model-providers/classification';
import {
  isSubscriptionProvider,
  type SubscriptionProvider,
} from '../../shared/subscriptionAccounts.js';
import {
  acquireSubscriptionAccount,
  codexSubscriptionAccountForHistoryHome,
  observeSubscriptionAccountUsage,
  type SubscriptionAccountLease,
} from './runtime.js';
import { readAccountBinding, readPool, writeAccountBindings, readLegacyCodexAccountId } from './store.js';
import { registerSessionSubscriptionAccount } from './session.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';

interface SubscriptionRouteOptions {
  providerId?: string | null;
  remoteHostId?: string | null;
  model?: string;
}
interface SubscriptionAccountRouting extends Pick<AuthAdapter, 'getState'> {
  /** Host-owned thread history lookup; no credential reads or history relocation. */
  resolveCodexHistoryHome?(threadId: string): Promise<string | undefined>;
  /** Codex can use an OAuth host while routing an implicit model elsewhere. */
  resolveDefaultProvider?(model?: string): string | null | Promise<string | null>;
}

async function providerFor(
  agent: Pick<BaseAgent, 'kind'>,
  options: SubscriptionRouteOptions,
  auth?: SubscriptionAccountRouting,
): Promise<SubscriptionProvider | null> {
  if (options.remoteHostId) return null;
  const requested = options.providerId?.trim() || null;
  let providerId = isSubscriptionProvider(requested)
    ? requested
    : requested && readLegacyCodexAccountId(requested) ? 'openai' : null;
  // This reserved namespace always uses the OpenAI subscription bridge, even
  // without an explicit provider. Its account must be registered for the bridge.
  if (!requested && agent.kind === 'claude-code' && options.model?.startsWith(CHATGPT_MODEL_PREFIX))
    return 'openai';
  if (!requested && auth && (agent.kind === 'claude-code' || agent.kind === 'codex')) {
    const native = agent.kind === 'claude-code' ? 'anthropic' : 'openai';
    // An implicit route may use the native login or the gateway. Ask the same
    // adapter as startup; a same-name catalog model is not proof of its source.
    if (readPool(native) && !resolveAgentCredentialMode({ agentKind: agent.kind, model: options.model })) {
      const source = agent.kind === 'codex' ? await auth.resolveDefaultProvider?.(options.model) : null;
      if (source && source !== native) return null;
      const state = await auth.getState({ model: options.model });
      if (state.authenticated && state.authSource === 'oauth') providerId = native;
    }
  }
  return (agent.kind === 'claude-code' && providerId === 'anthropic') ||
    (providerId === 'openai' && ['codex', 'claude-code', 'pi'].includes(agent.kind))
    ? providerId
    : null;
}
function assertOwnerCurrent(owner: string) {
  if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending())
    throw new Error('Subscription account owner changed');
}

/** Resolve the actual default source before a new task persists its provider. */
export async function resolveSubscriptionPoolProvider(
  agent: Pick<BaseAgent, 'kind'>,
  options: SubscriptionRouteOptions,
  auth?: SubscriptionAccountRouting,
): Promise<SubscriptionProvider | null> {
  const owner = activeOwnerScopeKey();
  const provider = await providerFor(agent, options, auth);
  assertOwnerCurrent(owner);
  return provider && readPool(provider) ? provider : null;
}
/** Existing native history proves its login independently of the old default auth.
 * Share this gate between resume and fork so implicit routes keep the same boundaries.
 */
async function historicalCodexAccount(
  agent: Pick<BaseAgent, 'kind'>,
  options: SubscriptionRouteOptions,
  threadId: string | undefined,
  keys: string[],
  auth?: SubscriptionAccountRouting,
): Promise<string | undefined> {
  const requested = options.providerId?.trim() || null;
  if (agent.kind !== 'codex' || options.remoteHostId || !threadId || !readPool('openai') ||
      (requested && requested !== 'openai')) return;
  const owner = activeOwnerScopeKey();
  if (!requested) {
    if (resolveAgentCredentialMode({ agentKind: 'codex', model: options.model })) return;
    const source = await auth?.resolveDefaultProvider?.(options.model);
    assertOwnerCurrent(owner);
    if (source && source !== 'openai') return;
  }
  const binding = keys.map(key => readAccountBinding(key, 'openai')).find(Boolean);
  if (binding) return binding.accountId;
  const home = await auth?.resolveCodexHistoryHome?.(threadId);
  assertOwnerCurrent(owner);
  return home ? codexSubscriptionAccountForHistoryHome(home) : undefined;
}
function legacyConnectionAccount(providerId: string | null | undefined, keys: string[], agentKind: string): string | undefined {
  const account = providerId ? readLegacyCodexAccountId(providerId) : undefined;
  if (!account) return;
  if (!readPool('openai')?.accounts.some(entry => entry.id === account))
    throw new AgentNotAuthenticatedError(agentKind, 'Subscription account was removed');
  if (keys.some(key => {
    const binding = readAccountBinding(key, 'openai');
    return binding && binding.accountId !== account;
  })) throw new Error('The task subscription account changed');
  return account;
}
function wrapHandle(
  handle: AgentSessionHandle,
  lease: SubscriptionAccountLease,
  unregister: () => void,
  model: string | undefined,
): AgentSessionHandle {
  let cleanupPending = false;
  return new Proxy(handle, {
    get(target, property) {
      if (property === 'send')
        return async (...args: Parameters<AgentSessionHandle['send']>) => {
          if (cleanupPending) throw new Error('Subscription account runtime is closing');
          lease.assertDispatchable();
          lease.running(true);
          try {
            return await target.send(...args);
          } catch (error) {
            lease.observeFailure(error, model, 'run');
            if (!cleanupPending) lease.running(false);
            throw error;
          }
        };
      if (property === 'setModel' && target.setModel)
        return async (...args: Parameters<NonNullable<AgentSessionHandle['setModel']>>) => {
          if (cleanupPending) throw new Error('Subscription account runtime is closing');
          return lease.changeModel(args[0], async () => {
            await target.setModel!(...args);
            // The runtime already switched even if the lease's final grant check fails.
            model = args[0];
          });
        };
      if (property === 'close' || property === 'detach') {
        const method = target[property];
        return method
          ? async (...args: Parameters<AgentSessionHandle['close']>) => {
              // Closing the event queue is not proof that the process stopped.
              // Keep credentials protected through pending/failed close and any late events.
              cleanupPending = true;
              lease.running(true);
              const result = await method.apply(target, args);
              unregister();
              lease.release();
              return result;
            }
          : undefined;
      }
      if (property === 'events')
        return async function* () {
          for await (const event of target.events()) {
            if (event.type === 'account_usage')
              observeSubscriptionAccountUsage(lease.account, event.data);
            if (event.type === 'error' && isTerminalTurnEvent(event))
              lease.observeFailure(event.data, model, 'run');
            if (event.type === 'session_id') await lease.bind([`native:${target.id}`]);
            if (isTerminalTurnEvent(event) && !cleanupPending) lease.running(false);
            if (event.type === 'status' && (event.data as { isRunning?: boolean })?.isRunning)
              lease.running(true);
            yield event.type === 'account_usage'
              ? {
                  ...event,
                  data: {
                    ...(event.data as Record<string, unknown>),
                    [NATIVE_SUBSCRIPTION_ACCOUNT]: true,
                  },
                }
              : event;
          }
          // A consumer stopping (or a closed queue) does not establish runtime shutdown.
          // close/detach owns final release; ordinary terminal events release only turn load.
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** A provider switch must select its account before the new runtime starts. */
function guardAccountSwitch(
  handle: AgentSessionHandle,
  agent: BaseAgent,
  initial: StartSessionOptions,
  auth?: SubscriptionAccountRouting,
): AgentSessionHandle {
  let providerId = initial.providerId;
  const crossesPool = async (model: string, target?: { providerId?: string | null }) => {
    const next = target?.providerId !== undefined ? target.providerId : providerId;
    if (next === providerId) return false;
    for (const id of [providerId, next]) {
      if (await resolveSubscriptionPoolProvider(agent, { providerId: id, remoteHostId: initial.remoteHostId, model }, auth))
        return true;
    }
    return false;
  };
  return new Proxy(handle, {
    get(target, property) {
      if (property === 'requiresModelSwitchRebuild')
        return async (model: string, options?: { providerId?: string | null }) =>
          (await crossesPool(model, options)) ||
          (await target.requiresModelSwitchRebuild?.(model, options)) ||
          false;
      if (property === 'previewModelSwitch' && target.previewModelSwitch)
        return async (model: string, options?: { providerId?: string | null }) =>
          (await crossesPool(model, options))
            ? {
                action: 'rebuild',
                targetContextWindow: null,
                windowVerified: false,
                reason: 'Select the subscription account for the new provider',
              }
            : target.previewModelSwitch!(model, options);
      if (property === 'setModel' && target.setModel)
        return async (...args: Parameters<NonNullable<AgentSessionHandle['setModel']>>) => {
          if (await crossesPool(args[0], args[1]))
            throw new Error('Subscription provider switch requires rebuilding the session');
          const result = await target.setModel!(...args);
          if (args[1]?.providerId !== undefined) providerId = args[1].providerId;
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Runs on the executing host, including device-hosted tasks already assigned by an outer group. */
export function withSubscriptionAccounts<T extends BaseAgent>(agent: T, auth?: SubscriptionAccountRouting): T {
  return new Proxy(agent, {
    get(target, property) {
      if (property === 'refreshLocalModels')
        return async (options?: RefreshLocalModelsOptions) => {
          if (target.kind === 'pi') return target.refreshLocalModels(options);
          const provider = target.kind === 'claude-code' ? 'anthropic' : 'openai';
          if (
            !readPool(provider) ||
            (options?.providerId && options.providerId !== provider) ||
            options?.credentialMode === 'gateway-key'
          )
            return target.refreshLocalModels(options);
          const lease = await acquireSubscriptionAccount(provider, undefined, [], true);
          try {
            return await target.refreshLocalModels({
              ...options,
              [NATIVE_SUBSCRIPTION_ACCOUNT]: lease?.account,
            });
          } finally {
            lease?.release();
          }
        };
      if (property === 'startSession')
        return async (options: StartSessionOptions) => {
          const startLegacy = async () =>
            guardAccountSwitch(await target.startSession(options), target, options, auth);
          const keys = [
            options.sessionId ? `task:${options.sessionId}` : '',
            options.resumeSessionId ? `native:${options.resumeSessionId}` : '',
          ].filter(Boolean);
          let provider: SubscriptionProvider | null = null;
          let imported: string | undefined;
          try {
            imported = await historicalCodexAccount(target, options, options.resumeSessionId, keys, auth);
            provider = imported ? 'openai' : await resolveSubscriptionPoolProvider(target, options, auth);
            if (!provider) return startLegacy();
            const resolved = provider;
            imported ??= legacyConnectionAccount(options.providerId?.trim(), keys, target.kind);
            if (!imported && options.resumeSessionId && !keys.some((key) => readAccountBinding(key, resolved))) {
              if (provider === 'openai') {
                // Unknown private homes retain their legacy route; never pick another account.
                return startLegacy();
              } else await writeAccountBindings(keys, provider, 'default');
            }
          } catch (error) {
            // No underlying runtime has been started; Maker may release its worktree lease.
            throw new AgentStartupStoppedError(error);
          }
          if (!provider) return startLegacy();
          const poolProvider = provider;
          // Provider group §6.1 for accounts: a new task that fails while starting moves to the
          // next account without surfacing the error; each account is tried at most once and the
          // last real failure is returned when none is left. Pinned tasks never move here.
          const tried = new Set<string>();
          let lastFailure: unknown;
          for (;;) {
            let lease: SubscriptionAccountLease | null = null;
            let unregister = () => {};
            try {
              lease = await acquireSubscriptionAccount(poolProvider, options.model, keys, false, {
                remote: !!options.deviceHosted, ownComputer: !!options.deviceHosted && !options.deviceHosted.guest,
                accountId: imported, resuming: !!options.resumeSessionId,
                ...(tried.size ? { exclude: tried } : {}),
              });
              if (!lease) {
                if (lastFailure !== undefined) throw lastFailure;
                return startLegacy();
              }
              unregister = registerSessionSubscriptionAccount(options.sessionId, lease.account);
            } catch (error) {
              lease?.release();
              if (lastFailure !== undefined) throw lastFailure;
              // No underlying runtime has been started; Maker may release its worktree lease.
              throw new AgentStartupStoppedError(error);
            }
            const current = lease;
            let handle: AgentSessionHandle | undefined;
            try {
              handle = await target.startSession({
                ...options,
                [NATIVE_SUBSCRIPTION_ACCOUNT]: current.account,
              });
              await current.bind([...keys, `native:${handle.id}`]);
              // Startup owns its slot until the first turn completes or the runtime closes.
              return guardAccountSwitch(wrapHandle(handle, current, unregister, options.model), target, {
                ...options,
                // Keep the effective native source for later switch checks even if
                // the user's implicit default changes while this runtime is alive.
                providerId: options.providerId?.trim() || poolProvider,
              }, auth);
            } catch (error) {
              let failure: unknown = error;
              const switchable = current.observeFailure(error, options.model, 'start');
              const release = () => {
                unregister();
                current.release();
              };
              let stopped = false;
              if (handle) {
                await handle.close();
                release();
                stopped = true;
                failure = new AgentStartupStoppedError(error);
              } else if (
                error instanceof AgentStartupStoppedError ||
                error instanceof AgentNotAuthenticatedError
              ) {
                release();
                stopped = true;
              } else if (error instanceof AgentStartupCleanupPendingError)
                void error.whenStopped.then(release, () => {});
              // An opaque adapter failure may still own a process, just as in Maker's
              // worktree protection contract. Retain the account until exit is proven,
              // and never start a second runtime for the task beside it.
              if (!stopped || !switchable || current.pinned || options.resumeSessionId) throw failure;
              tried.add(current.accountId);
              lastFailure = failure;
            }
          }
        };
      if (property === 'forkSdkSession')
        return async (options: ForkSdkSessionOptions) => {
          const key = `native:${options.sourceSdkSessionId}`;
          let imported = await historicalCodexAccount(target, options, options.sourceSdkSessionId, [key], auth);
          const provider = imported ? 'openai' : await resolveSubscriptionPoolProvider(target, options, auth);
          if (!provider) return target.forkSdkSession(options);
          imported ??= legacyConnectionAccount(options.providerId?.trim(), [key], target.kind);
          if (!imported && !readAccountBinding(key, provider)) {
            if (provider === 'openai') {
              return target.forkSdkSession(options);
            } else await writeAccountBindings([key], provider, 'default');
          }
          const lease = await acquireSubscriptionAccount(provider, options.model, [key], true, { accountId: imported, resuming: true });
          if (!lease) return target.forkSdkSession(options);
          try {
            const result = await target.forkSdkSession({
              ...options,
              [NATIVE_SUBSCRIPTION_ACCOUNT]: lease.account,
            });
            await lease.bind([key, `native:${result.newSdkSessionId}`]);
            return result;
          } finally {
            lease.release();
          }
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
