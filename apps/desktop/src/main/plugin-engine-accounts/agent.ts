/**
 * Puts plugin engine tasks on accounts (subscription-account-pools.md 插件引擎的账号), like
 * subscription-accounts/agent.ts does for Claude Code and Codex: the executing computer picks an
 * account from the task's provider when the runtime starts, keeps a task on its bound account, moves
 * a new task to the next account when one fails to start, and tells the pool about load and
 * failures. Engines whose plugin does not keep accounts apart run exactly as before.
 */
import {
  AgentNotAuthenticatedError,
  AgentStartupCleanupPendingError,
  AgentStartupStoppedError,
  NATIVE_SUBSCRIPTION_ACCOUNT,
  isTerminalTurnEvent,
  type AgentSessionHandle,
  type BaseAgent,
  type NativeSubscriptionAccount,
  type StartSessionOptions,
} from '@cindy/maker-core';

import { parsePluginEngineProviderId } from './ids.js';
import { readPluginEngineBinding, writePluginEngineBindings } from './store.js';
import {
  acquirePluginEngineAccount,
  pluginEngineHasAccountPool,
  type PluginEngineAccountLease,
} from './runtime.js';

/** The account directory travels to the ACP engine on the start options' account capability. */
function accountCapability(lease: PluginEngineAccountLease): NativeSubscriptionAccount {
  return {
    id: `plugin-engine:${lease.accountId}`,
    configDir: lease.accountDir ?? '',
    defaultProfile: lease.accountDir === undefined,
    assertCurrent: () => lease.assertDispatchable(),
    readState: async () => ({ authenticated: true }),
  };
}

function wrapHandle(handle: AgentSessionHandle, lease: PluginEngineAccountLease, model: string | undefined): AgentSessionHandle {
  let closing = false;
  let currentModel = model;
  return new Proxy(handle, {
    get(target, property) {
      if (property === 'send')
        return async (...args: Parameters<AgentSessionHandle['send']>) => {
          if (closing) throw new Error('Subscription account runtime is closing');
          lease.assertDispatchable();
          lease.running(true);
          try {
            return await target.send(...args);
          } catch (error) {
            lease.observeFailure(error, currentModel, 'run');
            if (!closing) lease.running(false);
            throw error;
          }
        };
      if (property === 'setModel' && target.setModel)
        return async (...args: Parameters<NonNullable<AgentSessionHandle['setModel']>>) => {
          const result = await target.setModel!(...args);
          currentModel = args[0];
          return result;
        };
      if (property === 'close' || property === 'detach') {
        const method = target[property];
        return method
          ? async (...args: Parameters<AgentSessionHandle['close']>) => {
              closing = true;
              lease.running(true);
              const result = await method.apply(target, args);
              lease.release();
              return result;
            }
          : undefined;
      }
      if (property === 'events')
        return async function* () {
          for await (const event of target.events()) {
            if (event.type === 'error' && isTerminalTurnEvent(event)) lease.observeFailure(event.data, currentModel, 'run');
            if (event.type === 'session_id') await lease.bind([`native:${target.id}`]);
            if (isTerminalTurnEvent(event) && !closing) lease.running(false);
            if (event.type === 'status' && (event.data as { isRunning?: boolean })?.isRunning) lease.running(true);
            yield event;
          }
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Wraps the ACP engine; runs on the executing computer (also for tasks of other computers). */
export function withPluginEngineAccounts<T extends BaseAgent>(agent: T): T {
  return new Proxy(agent, {
    get(target, property) {
      if (property === 'startSession')
        return async (options: StartSessionOptions) => {
          const ref = parsePluginEngineProviderId(options.providerId);
          if (!ref || !pluginEngineHasAccountPool(ref.engineKey)) return target.startSession(options);
          const keys = [
            options.sessionId ? `task:${options.sessionId}` : '',
            options.resumeSessionId ? `native:${options.resumeSessionId}` : '',
          ].filter(Boolean);
          // A conversation from before the engine had accounts lives in the agent's original login.
          if (options.resumeSessionId && !keys.some(key => readPluginEngineBinding(ref.engineKey, key))) {
            try {
              await writePluginEngineBindings(ref.engineKey, keys, 'default', ref.providerId);
            } catch (error) {
              throw new AgentStartupStoppedError(error);
            }
          }
          // Provider group §6.1 for accounts: a new task that fails while starting moves to the next
          // account without showing the error; each account at most once, then the last real failure.
          const tried = new Set<string>();
          let lastFailure: unknown;
          for (;;) {
            let lease: PluginEngineAccountLease | null;
            try {
              lease = await acquirePluginEngineAccount(ref.providerId, options.model, keys, {
                resuming: !!options.resumeSessionId,
                ...(tried.size ? { exclude: tried } : {}),
              });
            } catch (error) {
              if (lastFailure !== undefined) throw lastFailure;
              // Nothing started yet; Maker may release the task's worktree lease.
              throw new AgentStartupStoppedError(error);
            }
            if (!lease) {
              if (lastFailure !== undefined) throw lastFailure;
              return target.startSession(options);
            }
            const current = lease;
            let handle: AgentSessionHandle | undefined;
            try {
              handle = await target.startSession({ ...options, [NATIVE_SUBSCRIPTION_ACCOUNT]: accountCapability(current) });
              await current.bind([...keys, `native:${handle.id}`]);
              return wrapHandle(handle, current, options.model);
            } catch (error) {
              let failure: unknown = error;
              const switchable = current.observeFailure(error, options.model, 'start');
              let stopped = false;
              if (handle) {
                await handle.close();
                current.release();
                stopped = true;
                failure = new AgentStartupStoppedError(error);
              } else if (error instanceof AgentStartupStoppedError || error instanceof AgentNotAuthenticatedError) {
                current.release();
                stopped = true;
              } else if (error instanceof AgentStartupCleanupPendingError) {
                void error.whenStopped.then(() => current.release(), () => {});
              }
              // A failure that may still own a process keeps its account until the process exits, and
              // never gets a second runtime beside it. Resumes and bound tasks stay on their account.
              if (!stopped || !switchable || current.pinned || options.resumeSessionId) throw failure;
              tried.add(current.accountId);
              lastFailure = failure;
            }
          }
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
