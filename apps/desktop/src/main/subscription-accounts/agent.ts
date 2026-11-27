import {
  NATIVE_SUBSCRIPTION_ACCOUNT,
  LOCAL_AGENT_CLIENT,
  isolatedBotProfile,
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
  type NativeSubscriptionAccount,
  type RefreshLocalModelsOptions,
} from '@cindy/maker-core';
import { CHATGPT_MODEL_PREFIX } from '@cindy/model-providers/classification';
import { apiKeyEngineModel } from './apiKeyModel.js';
import { isSubscriptionProvider, type SubscriptionProvider } from '../../shared/subscriptionAccounts.js';
import {
  acquireSubscriptionAccount,
  codexSubscriptionAccountForHistoryHome,
  observeSubscriptionAccountUsage,
  refreshSubscriptionPool,
  refreshSubscriptionPoolCodexModels,
  refreshSubscriptionPoolClaudeModels,
  hasConnectedSubscriptionPool,
  hasUnavailableSubscriptionPoolAccount,
  isStandaloneApiKeyPoolConnection,
  type SubscriptionAccountLease,
} from './runtime.js';
import { readAccountBinding, readPool, writeAccountBindings, readLegacyCodexProviderId } from './store.js';
import { apiKeyPoolMember, apiKeyPoolMembers, legacyApiKeyPoolBinding } from './apiKeyMembers.js';
import {
  readMergedProviderAccount,
  accountProviderId,
  pinnedOwnAccount,
  resolveSubscriptionPoolProvider as resolveSubscriptionPoolProviderRef,
} from './placement.js';
import { bindPoolExecutionRoute, getSessionSubscriptionAccount, poolFailuresAfterOutput, registerSessionSubscriptionAccount } from './session.js';
import { captureOpenAiGroupApiResponse, settleOpenAiGroupAccountHealth } from '../provider-group/localOpenAiAccounts.js';
import { PROVIDER_GROUP_FAILURE_COOLDOWN_MS } from '../provider-group/cooling.js';
import { classifyTurnOverload } from '../goal-host/usageLimit.js';
import { readProviderBillingCode } from '@cindy/maker-shared/error-redaction';
import type { OpenAiGroupProbeResult } from '../../shared/openAiAccountGroup.js';
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
  preparePool?(providerId: string): Promise<void>;
}

/**
 * The provider whose accounts serve this start: a built-in subscription, a provider Cindy created
 * for subscription accounts, or a registered legacy Codex connection (placement.ts). Returns the
 * provider id, never a different provider: each provider assigns only among its own accounts.
 */
async function providerFor(
  agent: Pick<BaseAgent, 'kind'>,
  options: SubscriptionRouteOptions,
  auth?: SubscriptionAccountRouting,
  detectUnpooledDefault = false,
): Promise<string | null> {
  if (options.remoteHostId) return null;
  const requested = options.providerId?.trim() || null;
  let ref = requested ? resolveSubscriptionPoolProviderRef(requested) : null;
  // This reserved namespace always uses the OpenAI subscription bridge, even
  // without an explicit provider. Its account must be registered for the bridge.
  if (!requested && agent.kind === 'claude-code' && options.model?.startsWith(CHATGPT_MODEL_PREFIX))
    return 'openai';
  if (!requested && auth && (agent.kind === 'claude-code' || agent.kind === 'codex')) {
    const native = agent.kind === 'claude-code' ? 'anthropic' : 'openai';
    // An implicit route may use the native login or the gateway. Ask the same
    // adapter as startup; a same-name catalog model is not proof of its source.
    if ((detectUnpooledDefault || readPool(native)) && !resolveAgentCredentialMode({ agentKind: agent.kind, model: options.model })) {
      const source = agent.kind === 'codex' ? await auth.resolveDefaultProvider?.(options.model) : null;
      if (source && source !== native) return null;
      const state = await auth.getState({ model: options.model });
      if (state.authenticated && state.authSource === 'oauth') ref = { kind: native, providerId: native };
    }
  }
  if (!ref) return null;
  return (agent.kind === 'claude-code' && ref.kind === 'anthropic') ||
    (ref.kind === 'openai' && ['codex', 'claude-code', 'pi'].includes(agent.kind))
    ? ref.providerId
    : null;
}

/**
 * Below this wrapper the engines know only the built-in subscription routes. A start routed
 * through another provider's accounts runs on its kind's built-in route with the selected account,
 * so the engine uses that account's directory. A legacy Codex connection running its own account
 * keeps its id (its directory is the connection's own), as before 2026-11-13.
 */
function engineProviderId(providerId: string | null | undefined, accountId: string): string | null | undefined {
  const api = apiKeyPoolMember(accountId);
  if (api) return api.connectionId;
  const ref = resolveSubscriptionPoolProviderRef(providerId);
  if (!ref || ref.providerId === ref.kind) return providerId;
  if (!ref.created && ref.ownAccount === accountId) return providerId;
  return ref.kind;
}

/** Validate the shared identity before translating this call to the native engine's route.
 * The outer session/grant remains on the original provider; only the engine-facing copy changes,
 * with exactly the same model allowlist, route token and selected account capability.
 */
function engineOptions<T extends Pick<StartSessionOptions, 'providerId' | 'deviceHosted'>>(
  options: T, lease: SubscriptionAccountLease, kind: BaseAgent['kind'],
): T & { [NATIVE_SUBSCRIPTION_ACCOUNT]?: NativeSubscriptionAccount } {
  const requested = options.providerId?.trim();
  if (!requested) return { ...options, [NATIVE_SUBSCRIPTION_ACCOUNT]: lease.account };
  const guest = options.deviceHosted?.guest ? options.deviceHosted.guestProvider : undefined;
  if (guest && guest.providerId !== requested)
    throw new AgentStartupStoppedError(new Error('[REMOTE_AGENT_PROVIDER_NOT_ALLOWED] this provider is not allowed for remote use on this computer'));
  const providerId = engineProviderId(requested, lease.accountId)!;
  // Codex runs on its native route, but its per-session proxy must check the
  // original grant. Carry that identity on the host-issued account capability.
  const account = lease.account && guest && kind === 'codex' && providerId === 'openai' && requested !== providerId
    ? { ...lease.account, sharedProviderId: requested }
    : lease.account;
  return { ...options, providerId,
    [NATIVE_SUBSCRIPTION_ACCOUNT]: account,
    ...(guest && (providerId !== requested || lease.apiConnectionId && kind === 'pi') ? { deviceHosted: { ...options.deviceHosted!,
      guestProvider: { ...guest, providerId,
        modelIds: lease.apiConnectionId && kind === 'pi'
          ? [...new Set(guest.modelIds.map(id => apiKeyEngineModel(id, kind)))] : guest.modelIds,
      } } } : {}) };
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
): Promise<string | null> {
  const owner = activeOwnerScopeKey();
  const provider = await providerFor(agent, options, auth);
  assertOwnerCurrent(owner);
  const kind = provider ? resolveSubscriptionPoolProviderRef(provider)?.kind : undefined;
  return provider && kind && readPool(kind) ? provider : null;
}
function kindOf(providerId: string): SubscriptionProvider {
  return resolveSubscriptionPoolProviderRef(providerId)?.kind ?? (providerId as SubscriptionProvider);
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
/**
 * A provider merged into another one with no accounts left (a legacy connection or a created
 * provider) still pins its own account for its old tasks. A provider that owns accounts assigns
 * among them like any provider (placement.ts), so nothing is pinned here.
 */
function legacyConnectionAccount(providerId: string | null | undefined, keys: string[], agentKind: string, hasNativeHistory: boolean): string | undefined {
  const ref = resolveSubscriptionPoolProviderRef(providerId);
  const ownAccount = ref?.ownAccount;
  if (!ref || !ownAccount) return;
  if (ref.apiKey) return pinnedOwnAccount(ref);
  if (!readPool(ref.kind)?.accounts.some(entry => entry.id === ownAccount)) {
    const removedBinding = keys.map(key => readAccountBinding(key, ref.kind))
      .find(binding => binding?.accountId === ownAccount);
    if (removedBinding) {
      // When starting fresh after handoff, let the built-in Claude pool replace its
      // own removed binding. Native resumes and historical aliases still pin the old account.
      if (!hasNativeHistory && ref.providerId === 'anthropic'
        && (removedBinding.via ?? ref.kind) === ref.providerId
        && accountProviderId(ref.kind, ownAccount) === ref.providerId) return;
      throw new AgentNotAuthenticatedError(agentKind, 'Subscription account was removed');
    }
  }
  const fallback = readMergedProviderAccount(ref.providerId);
  if (!fallback) return;
  const bindings = keys.map(key => readAccountBinding(key, ref.kind)).filter(Boolean);
  // A builtin with its CLI profile moved out is only a historical route. Fresh tasks cannot
  // turn that history fallback into an explicit account selection in another provider.
  if (ref.providerId === ref.kind && !hasNativeHistory && bindings.length === 0) return;
  const binding = bindings[0];
  if (bindings.some(entry => entry?.accountId !== binding?.accountId)
    || (binding && binding.accountId !== fallback && (binding.via ?? ref.kind) !== ref.providerId))
    throw new Error('The task subscription account changed');
  // A merged provider may previously have hosted several accounts. Recorded history keeps its
  // actual account; only an old route without any binding falls back to the provider's first one.
  const account = binding?.accountId ?? fallback;
  if (!readPool(ref.kind)?.accounts.some(entry => entry.id === account))
    throw new AgentNotAuthenticatedError(agentKind, 'Subscription account was removed');
  return account;
}
function wrapHandle(
  handle: AgentSessionHandle,
  lease: SubscriptionAccountLease,
  unregister: () => void,
  model: string | undefined,
  agent?: 'codex' | 'pi' | 'claude-code',
  poolTurn?: { current?: { delivered: boolean; rejection?: OpenAiGroupProbeResult } },
): AgentSessionHandle {
  let cleanupPending = false;
  let observe: ReturnType<typeof captureOpenAiGroupApiResponse>;
  const modelForEngine = (id: string) => lease.apiConnectionId && agent ? apiKeyEngineModel(id, agent) : id;
  return new Proxy(handle, {
    get(target, property) {
      if (property === 'send')
        return async (...args: Parameters<AgentSessionHandle['send']>) => {
          if (cleanupPending) throw new Error('Subscription account runtime is closing');
          if (lease.verifyLinkedLogin) await lease.verifyLinkedLogin();
          lease.assertDispatchable();
          if (poolTurn) poolTurn.current = { delivered: false };
          if (lease.apiConnectionId && (agent === 'codex' || agent === 'pi'))
            observe = captureOpenAiGroupApiResponse(lease.apiConnectionId, agent);
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
        return async (next: string, options?: Parameters<NonNullable<AgentSessionHandle['setModel']>>[1]) => {
          if (cleanupPending) throw new Error('Subscription account runtime is closing');
          return lease.changeModel(next, async () => {
            await target.setModel!(modelForEngine(next), options);
            // The runtime already switched even if the lease's final grant check fails.
            model = next;
          });
        };
      if (property === 'previewModelSwitch' && target.previewModelSwitch)
        return (next: string, options?: Parameters<NonNullable<AgentSessionHandle['previewModelSwitch']>>[1]) =>
          target.previewModelSwitch!(modelForEngine(next), options);
      if (property === 'requiresModelSwitchRebuild' && target.requiresModelSwitchRebuild)
        return (next: string, options?: Parameters<NonNullable<AgentSessionHandle['requiresModelSwitchRebuild']>>[1]) =>
          target.requiresModelSwitchRebuild!(modelForEngine(next), options);
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
            const turn = event.turnScope === 'background' ? undefined : poolTurn?.current;
            if (turn && (event.type === 'text' || event.type === 'thinking' || event.type === 'tool_use'
              || event.type === 'tool_result' || event.type === 'tool_result_full' || event.type === 'image'
              || event.type === 'interaction_request' || event.type === 'turn_diff' || event.type === 'agent_task_update'))
              turn.delivered = true;
            if (event.type === 'account_usage' && lease.account)
              observeSubscriptionAccountUsage(lease.account, event.data);
            if (event.type === 'error' && isTerminalTurnEvent(event)) {
              lease.observeFailure(event.data, model, 'run');
              if (observe && event.turnScope !== 'background') {
                const error = event.data as { message?: string; errorStatus?: number };
                const billingCode = readProviderBillingCode(error.errorStatus, error.message ?? '');
                if (billingCode) await observe({ ok: false, code: 'QUOTA_EXCEEDED', billingCode }).catch(() => {});
                else if (error.errorStatus === 401) await observe({ ok: false, code: 'AUTH_INVALID' }).catch(() => {});
                else if (error.errorStatus === 429) await observe({ ok: false, code: 'RATE_LIMITED' }).catch(() => {});
                else if (error.errorStatus === 529 || classifyTurnOverload(event.data)) await observe({ ok: false, code: 'RATE_LIMITED' },
                  undefined, PROVIDER_GROUP_FAILURE_COOLDOWN_MS).catch(() => {});
                if (turn && !turn.rejection && (billingCode || error.errorStatus === 401)) {
                  turn.rejection = billingCode ? { ok: false, code: 'QUOTA_EXCEEDED', billingCode } : { ok: false, code: 'AUTH_INVALID' };
                }
              }
              if (lease.apiConnectionId && agent && event.turnScope !== 'background')
                await settleOpenAiGroupAccountHealth(lease.apiConnectionId, agent);
            }
            if (event.type === 'session_id') await lease.bind([`native:${target.id}`]);
            if (turn && isTerminalTurnEvent(event) && poolTurn) poolTurn.current = undefined;
            if (isTerminalTurnEvent(event) && !cleanupPending) lease.running(false);
            if (event.type === 'status' && (event.data as { isRunning?: boolean })?.isRunning)
              lease.running(true);
            const rejected = event.type === 'error' && isTerminalTurnEvent(event) && !turn?.delivered
              ? turn?.rejection : undefined;
            if (event.type === 'error' && isTerminalTurnEvent(event) && turn?.delivered)
              poolFailuresAfterOutput.add(event);
            yield rejected?.code === 'QUOTA_EXCEEDED' || rejected?.code === 'AUTH_INVALID'
              ? { ...event, data: { ...(event.data as Record<string, unknown>),
                ...(rejected.code === 'AUTH_INVALID' ? { errorStatus: 401, sdkError: 'authentication_failed' }
                  : { errorStatus: 429, sdkError: 'billing_error' }),
              } }
              : event.type === 'account_usage' && lease.account
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
  /** The provider id the engine actually runs on (engineProviderId); same as initial by default. */
  engineId: string | null | undefined = initial.providerId,
  legacyDefaultProvider?: SubscriptionProvider,
): AgentSessionHandle {
  const owner = activeOwnerScopeKey();
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
  // Staying on the task's own provider means staying on the engine's route.
  const toEngine = <T extends { providerId?: string | null } | undefined>(options: T): T =>
    options && options.providerId !== undefined && options.providerId === providerId && engineId !== providerId
      ? { ...options, providerId: engineId } : options;
  return new Proxy(handle, {
    get(target, property) {
      if (property === 'send')
        return async (...args: Parameters<AgentSessionHandle['send']>) => {
          // The first pool setting can be saved after this default-account runtime started.
          // Do not create a pool on startup, but honor its live pause/removal once it exists.
          if (legacyDefaultProvider) {
            assertOwnerCurrent(owner);
            const pool = readPool(legacyDefaultProvider);
            const account = pool?.accounts.find(a => a.id === 'default');
            if (pool && (pool.disconnected || !account || account.paused))
              throw new Error('The task subscription account is disabled; retry to switch accounts');
          }
          return target.send(...args);
        };
      if (property === 'requiresModelSwitchRebuild')
        return async (model: string, options?: { providerId?: string | null }) =>
          (await crossesPool(model, options)) ||
          (await target.requiresModelSwitchRebuild?.(model, toEngine(options))) ||
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
            : target.previewModelSwitch!(model, toEngine(options));
      if (property === 'setModel' && target.setModel)
        return async (...args: Parameters<NonNullable<AgentSessionHandle['setModel']>>) => {
          if (await crossesPool(args[0], args[1]))
            throw new Error('Subscription provider switch requires rebuilding the session');
          const nextProviderId = args[1]?.providerId !== undefined ? args[1].providerId : providerId;
          const next = await providerFor(agent, { ...initial, model: args[0], providerId: nextProviderId }, auth, true);
          assertOwnerCurrent(owner);
          // Unknown historical accounts in an existing pool must retain their legacy route.
          const nextDefault = next && isSubscriptionProvider(next) && (!readPool(next) || next === legacyDefaultProvider)
            ? next : undefined;
          const result = await target.setModel!(args[0], toEngine(args[1]), ...(args.slice(2) as []));
          providerId = nextProviderId;
          legacyDefaultProvider = nextDefault;
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
          const ref = options?.providerId ? resolveSubscriptionPoolProviderRef(options.providerId) : null;
          if (
            !readPool(provider) ||
            (options?.providerId && ref?.kind !== provider) ||
            (ref && !ref.created && ref.providerId !== provider) ||
            options?.[NATIVE_SUBSCRIPTION_ACCOUNT] ||
            options?.credentialMode === 'gateway-key'
          )
            return target.refreshLocalModels(options);
          if (provider === 'anthropic')
            return refreshSubscriptionPoolClaudeModels(true, options?.providerId ?? undefined);
          if (provider === 'openai' && readPool(provider)?.accounts.some(a => !readLegacyCodexProviderId(a.id))) {
            const providers = options?.providerId ? [options.providerId]
              : [...new Set(readPool(provider)!.accounts.filter(account => !readLegacyCodexProviderId(account.id))
                .map(account => accountProviderId(provider, account.id)))];
            await Promise.all(providers.map(id => refreshSubscriptionPool(id)));
            await refreshSubscriptionPoolCodexModels(true, options?.providerId ?? undefined);
            return providers.some(id => hasConnectedSubscriptionPool(id) && !hasUnavailableSubscriptionPoolAccount(id));
          }
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
          const startLegacy = async () => {
            const owner = activeOwnerScopeKey();
            // A native default login can predate its first account-pool setting.
            const provider = await providerFor(target, options, auth, true);
            assertOwnerCurrent(owner);
            const legacyDefaultProvider = provider && isSubscriptionProvider(provider) && !readPool(provider) ? provider : undefined;
            return guardAccountSwitch(await target.startSession(options), target, options, auth, undefined, legacyDefaultProvider);
          };
          const keys = [
            options.sessionId ? `task:${options.sessionId}` : '',
            options.resumeSessionId ? `native:${options.resumeSessionId}` : '',
          ].filter(Boolean);
          let provider: string | null = null;
          let imported: string | undefined;
          try {
            if (!options.remoteHostId && options.providerId) await auth?.preparePool?.(options.providerId);
            imported = await historicalCodexAccount(target, options, options.resumeSessionId, keys, auth);
            provider = imported ? 'openai' : await resolveSubscriptionPoolProvider(target, options, auth);
            if (!provider) return startLegacy();
            const kind = kindOf(provider);
            const ref = resolveSubscriptionPoolProviderRef(provider);
            // Retain the member ID for old bindings, but an explicitly selected,
            // independent local Key runs through its normal direct provider.
            const legacyKey = ref?.apiKey ? legacyApiKeyPoolBinding(options.sessionId, provider) : undefined;
            const standaloneKey = ref?.apiKey && options.providerId === provider && !options.deviceHosted
              && isStandaloneApiKeyPoolConnection(provider) && (!legacyKey || legacyKey === ref.ownAccount)
              && keys.every(key => {
                const binding = readAccountBinding(key, kind);
                return !binding || binding.accountId === ref.ownAccount;
              });
            if (standaloneKey) return startLegacy();
            if (ref?.apiKey && pinnedOwnAccount(ref) && !keys.some(key => readAccountBinding(key, kind))
              && !legacyKey) return startLegacy();
            if (kind === 'openai' && options.providerId && keys.length
              && !keys.some(key => readAccountBinding(key, kind))) {
              const migrated = ref?.apiKey ? legacyKey : legacyApiKeyPoolBinding(options.sessionId, options.providerId);
              if (migrated) {
                await writeAccountBindings(keys, kind, migrated, options.providerId);
                imported = migrated;
              }
            }
            imported ??= legacyConnectionAccount(options.providerId?.trim(), keys, target.kind, !!options.resumeSessionId);
            if (!imported && options.resumeSessionId && !keys.some(key => readAccountBinding(key, kind))) {
              // Unknown Codex homes retain their legacy route; never pick another account.
              if (kind === 'openai') return startLegacy();
              // An unbound Claude resume can only use the default home. Do not
              // pin the task to a removed account before the fresh handoff retry.
              if (!readPool(kind)?.accounts.some(account => account.id === 'default'))
                throw new Error('[SUBSCRIPTION_ACCOUNT_UNAVAILABLE] The task subscription account is unavailable');
              await writeAccountBindings(keys, kind, 'default');
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
            let startOptions: StartSessionOptions;
            let unregister = () => {};
            const poolTurn: { current?: { delivered: boolean; rejection?: OpenAiGroupProbeResult } } = {};
            try {
              lease = await acquireSubscriptionAccount(poolProvider, options.model, keys, false, {
                remote: !!options.deviceHosted, ownComputer: !!options.deviceHosted && !options.deviceHosted.guest,
                accountId: imported, resuming: !!options.resumeSessionId, includeApiKeys: true,
                ...(target.kind === 'codex' || target.kind === 'pi' || target.kind === 'claude-code' ? { agent: target.kind } : {}),
                ...(tried.size ? { exclude: tried } : {}),
                // Mirrors the Claude adapter's settingSources: these sessions start without user settings.
                ...(target.kind === 'claude-code' && (options.reviewMode || options.deviceHosted
                  || isolatedBotProfile(options.botRuntimeProfile) || options[LOCAL_AGENT_CLIENT]?.hostToolsOnly)
                  ? { userSettingsLoaded: false } : {}),
              });
              if (!lease) {
                if (lastFailure !== undefined) throw lastFailure;
                return startLegacy();
              }
              const routed = engineOptions(options, lease, target.kind);
              if (routed[NATIVE_SUBSCRIPTION_ACCOUNT]) unregister = registerSessionSubscriptionAccount(options.sessionId, routed[NATIVE_SUBSCRIPTION_ACCOUNT]);
              else if (lease.apiConnectionId) unregister = bindPoolExecutionRoute(options.sessionId, {
                providerId: options.providerId?.trim() || poolProvider,
                connectionId: lease.apiConnectionId,
                assertCurrent: lease.assertDispatchable,
                logicalModel: lease.logicalModel,
                captureTurnRejection: () => {
                  const turn = poolTurn.current;
                  return turn && (result => {
                    if (poolTurn.current === turn && !result.ok
                      && (result.code === 'QUOTA_EXCEEDED' || result.code === 'AUTH_INVALID')) turn.rejection = result;
                  });
                },
              });
              startOptions = lease.apiConnectionId && options.model
                ? { ...routed, model: apiKeyEngineModel(options.model, target.kind) } : routed;
            } catch (error) {
              lease?.release();
              if (lastFailure !== undefined) throw lastFailure;
              // No underlying runtime has been started; Maker may release its worktree lease.
                throw error instanceof AgentStartupStoppedError ? error : new AgentStartupStoppedError(error);
            }
            const current = lease;
            let handle: AgentSessionHandle | undefined;
            try {
              const sessionProvider = options.providerId?.trim() || poolProvider;
              const engineId = engineProviderId(sessionProvider, current.accountId);
              handle = await target.startSession(startOptions);
              await current.bind([...keys, `native:${handle.id}`]);
              // Startup owns its slot until the first turn completes or the runtime closes.
              return guardAccountSwitch(wrapHandle(handle, current, unregister, options.model,
                target.kind === 'codex' || target.kind === 'pi' || target.kind === 'claude-code' ? target.kind : undefined,
                current.apiConnectionId || (kindOf(poolProvider) === 'openai'
                  && apiKeyPoolMembers(accountProviderId('openai', current.accountId)).length) ? poolTurn : undefined), target, {
                ...options,
                // Keep the effective native source for later switch checks even if
                // the user's implicit default changes while this runtime is alive.
                providerId: sessionProvider,
              }, auth, engineId);
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
      if (property === 'requiresCodexThreadHostTransfer')
        return async (options: Parameters<BaseAgent['requiresCodexThreadHostTransfer']>[0]) => {
          // The live session's host carries the subscription account it runs on. When the target
          // route stays on that account, compare against that same host instead of mistaking it for
          // another writer of the thread (which closed and relinked unchanged sessions).
          // A running account that was since removed or disconnected cannot be the target's writer;
          // check the target as before instead of failing a switch to another working source.
          let account: ReturnType<typeof getSessionSubscriptionAccount>;
          try { account = getSessionSubscriptionAccount(options.sessionId); } catch { account = undefined; }
          const ref = resolveSubscriptionPoolProviderRef(options.providerId?.trim());
          // A provider can hold several accounts; its first (`ownAccount`) is only one of them. The
          // route stays on the running account when that account belongs to the target provider.
          const sameAccount = account && ref
            && (accountProviderId(ref.kind, account.id) === ref.providerId || ref.ownAccount === account.id);
          return target.requiresCodexThreadHostTransfer(sameAccount
            ? { ...options, [NATIVE_SUBSCRIPTION_ACCOUNT]: account } : options);
        };
      if (property === 'forkSdkSession')
        return async (options: ForkSdkSessionOptions) => {
          const key = `native:${options.sourceSdkSessionId}`;
          let imported = await historicalCodexAccount(target, options, options.sourceSdkSessionId, [key], auth);
          const provider = imported ? 'openai' : await resolveSubscriptionPoolProvider(target, options, auth);
          if (!provider) return target.forkSdkSession(options);
          imported ??= legacyConnectionAccount(options.providerId?.trim(), [key], target.kind, true);
          const kind = kindOf(provider);
          if (!imported && !readAccountBinding(key, kind)) {
            if (kind === 'openai') {
              return target.forkSdkSession(options);
            } else await writeAccountBindings([key], kind, 'default');
          }
          const pinned = readAccountBinding(key, kind);
          const api = kind === 'openai' && pinned ? apiKeyPoolMember(pinned.accountId) : undefined;
          const engine = target.kind === 'codex' || target.kind === 'pi' ? target.kind : undefined;
          if (api && !engine)
            throw new Error('[SUBSCRIPTION_ACCOUNT_UNAVAILABLE] The task API key account is unavailable');
          const lease = api
            ? await acquireSubscriptionAccount(provider, options.model, [key], true, {
              accountId: imported, resuming: true, includeApiKeys: true,
              agent: engine,
              remote: !!options.hostedForkAccess || !!options.hostedGuestHome,
              ownComputer: options.hostedForkAccess?.ownComputer === true,
              forkHistoryGuard: () => options.hostedForkAccess?.assertCurrent(),
            })
            : await acquireSubscriptionAccount(provider, options.model, [key], true, { accountId: imported, resuming: true });
          if (!lease) {
            if (api) throw new Error('[SUBSCRIPTION_ACCOUNT_UNAVAILABLE] The task API key account is unavailable');
            return target.forkSdkSession(options);
          }
          try {
            const routed = engineOptions(options, lease, target.kind);
            if (api) options.hostedForkAccess?.assertCurrent();
            const result = await target.forkSdkSession(lease.apiConnectionId
              ? { ...routed, providerId: lease.apiConnectionId,
                model: routed.model ? apiKeyEngineModel(routed.model, target.kind) : routed.model } : routed);
            // A key's source affinity is an immutable record of where its history ran.
            await lease.bind([...(api ? [] : [key]), `native:${result.newSdkSessionId}`]);
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
