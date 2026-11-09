import {
  NATIVE_SUBSCRIPTION_ACCOUNT,
  AgentStartupStoppedError,
  AgentStartupCleanupPendingError,
  AgentNotAuthenticatedError,
  isTerminalTurnEvent,
  type BaseAgent,
  type AgentSessionHandle,
  type StartSessionOptions,
  type ForkSdkSessionOptions,
  type RefreshLocalModelsOptions,
} from '@cindy/maker-core';
import {
  isSubscriptionProvider,
  type SubscriptionProvider,
} from '../../shared/subscriptionAccounts.js';
import {
  acquireSubscriptionAccount,
  observeSubscriptionAccountUsage,
  type SubscriptionAccountLease,
} from './runtime.js';
import { readAccountBinding, readPool, writeAccountBindings } from './store.js';
import { registerSessionSubscriptionAccount } from './session.js';

function providerFor(
  agent: BaseAgent,
  options: { providerId?: string | null; remoteHostId?: string | null },
): SubscriptionProvider | null {
  if (options.remoteHostId || !isSubscriptionProvider(options.providerId)) return null;
  return (agent.kind === 'claude-code' && options.providerId === 'anthropic') ||
    (options.providerId === 'openai' && ['codex', 'claude-code', 'pi'].includes(agent.kind))
    ? options.providerId
    : null;
}
function wrapHandle(
  handle: AgentSessionHandle,
  lease: SubscriptionAccountLease,
  unregister: () => void,
): AgentSessionHandle {
  let cleanupPending = false;
  return new Proxy(handle, {
    get(target, property) {
      if (property === 'send')
        return async (...args: Parameters<AgentSessionHandle['send']>) => {
          if (cleanupPending) throw new Error('Subscription account runtime is closing');
          lease.account.assertCurrent();
          lease.running(true);
          try {
            return await target.send(...args);
          } catch (error) {
            if (!cleanupPending) lease.running(false);
            throw error;
          }
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
): AgentSessionHandle {
  let providerId = initial.providerId;
  const crossesPool = (target?: { providerId?: string | null }) => {
    const next = target?.providerId !== undefined ? target.providerId : providerId;
    return (
      next !== providerId &&
      [providerId, next].some((id) => {
        const provider = providerFor(agent, { providerId: id, remoteHostId: initial.remoteHostId });
        return provider && readPool(provider);
      })
    );
  };
  return new Proxy(handle, {
    get(target, property) {
      if (property === 'requiresModelSwitchRebuild')
        return async (model: string, options?: { providerId?: string | null }) =>
          crossesPool(options) ||
          (await target.requiresModelSwitchRebuild?.(model, options)) ||
          false;
      if (property === 'previewModelSwitch' && target.previewModelSwitch)
        return async (model: string, options?: { providerId?: string | null }) =>
          crossesPool(options)
            ? {
                action: 'rebuild',
                targetContextWindow: null,
                windowVerified: false,
                reason: 'Select the subscription account for the new provider',
              }
            : target.previewModelSwitch!(model, options);
      if (property === 'setModel' && target.setModel)
        return async (...args: Parameters<NonNullable<AgentSessionHandle['setModel']>>) => {
          if (crossesPool(args[1]))
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
export function withSubscriptionAccounts<T extends BaseAgent>(agent: T): T {
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
            guardAccountSwitch(await target.startSession(options), target, options);
          const keys = [
            options.sessionId ? `task:${options.sessionId}` : '',
            options.resumeSessionId ? `native:${options.resumeSessionId}` : '',
          ].filter(Boolean);
          let lease: SubscriptionAccountLease | null = null;
          let unregister = () => {};
          try {
            const provider = providerFor(target, options);
            if (!provider || !readPool(provider)) return startLegacy();
            if (options.resumeSessionId && !keys.some((key) => readAccountBinding(key, provider))) {
              // Legacy Codex may use Cindy's private home, not ~/.codex. Keep that route.
              if (provider === 'openai') return startLegacy();
              await writeAccountBindings(keys, provider, 'default');
            }
            lease = await acquireSubscriptionAccount(provider, options.model, keys);
            if (!lease) return startLegacy();
            unregister = registerSessionSubscriptionAccount(options.sessionId, lease.account);
          } catch (error) {
            lease?.release();
            // No underlying runtime has been started; Maker may release its worktree lease.
            throw new AgentStartupStoppedError(error);
          }
          let handle: AgentSessionHandle | undefined;
          try {
            handle = await target.startSession({
              ...options,
              [NATIVE_SUBSCRIPTION_ACCOUNT]: lease.account,
            });
            await lease.bind([...keys, `native:${handle.id}`]);
            lease.running(false);
            return guardAccountSwitch(wrapHandle(handle, lease, unregister), target, options);
          } catch (error) {
            const release = () => {
              unregister();
              lease.release();
            };
            if (handle) {
              await handle.close();
              release();
              throw new AgentStartupStoppedError(error);
            }
            if (
              error instanceof AgentStartupStoppedError ||
              error instanceof AgentNotAuthenticatedError
            )
              release();
            else if (error instanceof AgentStartupCleanupPendingError)
              void error.whenStopped.then(release, () => {});
            // An opaque adapter failure may still own a process, just as in Maker's
            // worktree protection contract. Retain the account until exit is proven.
            throw error;
          }
        };
      if (property === 'forkSdkSession')
        return async (options: ForkSdkSessionOptions) => {
          const provider = providerFor(target, options);
          if (!provider || !readPool(provider)) return target.forkSdkSession(options);
          const key = `native:${options.sourceSdkSessionId}`;
          if (!readAccountBinding(key, provider)) {
            if (provider === 'openai') return target.forkSdkSession(options);
            await writeAccountBindings([key], provider, 'default');
          }
          const lease = await acquireSubscriptionAccount(provider, options.model, [key], true);
          if (!lease) return target.forkSdkSession(options);
          try {
            const result = await target.forkSdkSession({
              ...options,
              [NATIVE_SUBSCRIPTION_ACCOUNT]: lease.account,
            });
            await lease.bind([`native:${result.newSdkSessionId}`]);
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
