/**
 * Account pools of plugin engines (subscription-account-pools.md 插件引擎的账号): the same
 * behaviour as the built-in Claude Code / Codex pools, for engines whose plugin keeps each account
 * in its own directory. Selection uses the provider group scheduler, failures the provider group
 * failure policy and cooldowns its format, so assignment, limits, weights, pauses and switching
 * match the built-in providers. What the plugin knows (sign-in, identity, plan, usage, models)
 * comes from its worker; Cindy never reads the agent's credentials.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';

import type { GhostHarnessAccountStatus, GhostHarnessUsage } from '@cindy/plugin-protocol';

import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import {
  cancelPluginHarnessAccountLogin,
  getPluginHarnessRegistry,
  loginPluginHarnessAccount,
  readPluginHarnessAccountStatus,
  readPluginHarnessUsage,
  type PluginHarness,
} from '../cindy-brain/pluginHarnesses.js';
import { readTurnUsageResetAt } from '../goal-host/usageLimit.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { AccountServiceUnreachableError } from '../subscription-accounts/accountServiceError.js';
import {
  coolingScope,
  currentCooling,
  PROVIDER_GROUP_COOLING_SCOPE_CAP,
  PROVIDER_GROUP_FAILURE_COOLDOWN_MS,
} from '../provider-group/cooling.js';
import {
  clearPluginEngineAccountCooling,
  readPluginEngineAccountCooling,
  writePluginEngineAccountCooling,
} from '../provider-group/coolingStore.js';
import { decideProviderGroupFailure, providerGroupFailureSignals } from '../provider-group/failurePolicy.js';
import { PROVIDER_GROUP_DEFAULT_COOLDOWN_MS, PROVIDER_GROUP_LOCAL_PROVISIONAL_MS } from '../provider-group/router.js';
import {
  applyRouteWeightStep,
  pickRouteMember,
  routeMembersFull,
  type RouteWeightStep,
  type SchedulableMember,
} from '../provider-group/scheduler.js';
import { quotaWindowsScheduleState } from '../provider-group/usage.js';
import {
  concurrencyLimitPatch,
  effectiveConcurrencyLimit,
} from '../../shared/providerGroup.js';
import { DEFAULT_ROUTE_STRATEGY, type RouteStrategy } from '../../shared/routeStrategy.js';
import {
  MAX_SUBSCRIPTION_ACCOUNTS,
  type SubscriptionAccountCommand,
  type SubscriptionAccountView,
  type SubscriptionPoolView,
} from '../../shared/subscriptionAccounts.js';
import { PLUGIN_ENGINE_DEFAULT_MODEL } from '../../shared/pluginEngines.js';
import {
  newPluginEngineProviderSuffix,
  parsePluginEngineProviderId,
  pluginEngineProviderId,
  type PluginEngineProviderRef,
} from './ids.js';
import {
  ensurePluginEngineAccountDir,
  newPluginEngineAccountId,
  pluginEngineAccountDir,
} from './paths.js';
import {
  DEFAULT_PLUGIN_ENGINE_ACCOUNT,
  effectivePluginEnginePool,
  readPluginEngineBinding,
  readPluginEnginePool,
  updatePluginEnginePool,
  writePluginEngineBindings,
  type PluginEngineAccountConfig,
  type PluginEnginePoolConfig,
} from './store.js';

const log = desktopMakerLogger.child('plugin-engine-accounts');

/** Same wording as the built-in pool, so callers and the chat show the same message. */
export const PLUGIN_ENGINE_ACCOUNTS_FULL_ERROR =
  '[SUBSCRIPTION_ACCOUNTS_FULL] every available subscription account has reached its concurrency limit';
const STATUS_FRESH_MS = 60_000;
const STATUS_FAILURE_FRESH_MS = 5_000;
const USAGE_FRESH_MS = 60_000;
/** New assignment waits this long for every candidate's sign-in read, like the built-in pool. */
const SELECTION_READ_BUDGET_MS = 2_000;

interface StatusSnapshot {
  status: GhostHarnessAccountStatus | null;
  /** The plugin could not answer (busy, timed out, not running): not proof of a sign-out. */
  failed: boolean;
  at: number;
}

interface LoginState {
  engineKey: string;
  accountId: string;
  dir: string | undefined;
  /** A fresh account: removed again when the sign-in does not finish. */
  created: boolean;
}

interface RuntimeState {
  owner: string;
  status: Map<string, StatusSnapshot>;
  statusFlights: Map<string, Promise<StatusSnapshot>>;
  usage: Map<string, { usage: GhostHarnessUsage | null; at: number }>;
  usageFlights: Map<string, Promise<GhostHarnessUsage | null>>;
  running: Map<string, Set<string>>;
  pendingStarts: Map<string, { accountId: string; token: string; until: number }>;
  lastPicked: Map<string, string>;
  /** 「按权重」的计数，键与 lastPicked 相同。只在内存里，重启后重新开始。 */
  weightCounters: Map<string, Map<string, number>>;
  cooling: Map<string, Record<string, number>>;
  logins: Map<string, LoginState>;
}

let runtime: RuntimeState | null = null;
const listeners = new Set<(providerId: string, change?: 'usage' | 'load') => void>();

function currentRuntime(): RuntimeState {
  const owner = activeOwnerScopeKey();
  if (runtime?.owner !== owner) {
    runtime = {
      owner,
      status: new Map(),
      statusFlights: new Map(),
      usage: new Map(),
      usageFlights: new Map(),
      running: new Map(),
      pendingStarts: new Map(),
      lastPicked: new Map(),
      weightCounters: new Map(),
      cooling: new Map(),
      logins: new Map(),
    };
    try {
      for (const [engineKey, members] of Object.entries(readPluginEngineAccountCooling())) {
        for (const [accountId, value] of Object.entries(members)) {
          const scopes = currentCooling(value, Date.now());
          if (Object.keys(scopes).length) runtime.cooling.set(accountKey(engineKey, accountId), scopes);
        }
      }
    } catch (error) {
      log.warn('plugin engine accounts: reading cooldowns failed', { error: error instanceof Error ? error.name : typeof error });
    }
  }
  return runtime;
}

function assertOwner(state: RuntimeState): void {
  if (state.owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) throw new Error('Subscription accounts changed');
}

const accountKey = (engineKey: string, accountId: string) => `${engineKey}|${accountId}`;

export function onPluginEngineAccountsChanged(listener: (providerId: string, change?: 'usage' | 'load') => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function changed(engineKey: string, change?: 'usage' | 'load'): void {
  const pool = readPluginEnginePool(engineKey);
  const providerIds = [pluginEngineProviderId(engineKey),
    ...Object.keys(pool?.providers ?? {}).map(suffix => pluginEngineProviderId(engineKey, suffix))];
  for (const listener of listeners) {
    for (const providerId of providerIds) {
      try {
        listener(providerId, change);
      } catch {
        /* Views cannot invalidate a completed account operation. */
      }
    }
  }
}

/* ── Engines and providers ─────────────────────────────────────────────── */

function liveEngine(engineKey: string): PluginHarness | undefined {
  return getPluginHarnessRegistry().list().find(harness => harness.key === engineKey);
}

/** The plugin keeps accounts apart and lets Cindy add them (at least one sign-in method). */
export function pluginEngineHasAccountPool(engineKey: string): boolean {
  return !!liveEngine(engineKey)?.accounts?.methods.length;
}

/** Cheap guard for send paths: no engine here keeps accounts, so no task needs a session read. */
export function anyPluginEngineAccountPool(): boolean {
  return getPluginHarnessRegistry().list().some(harness => !!harness.accounts?.methods.length);
}

/** Accounts of one provider of the engine: its own (`suffix` null) or a taken-out one. */
function providerAccounts(pool: PluginEnginePoolConfig, suffix: string | null): PluginEngineAccountConfig[] {
  return pool.accounts.filter(account => (pool.placement?.[account.id] ?? null) === suffix);
}

function providerStrategy(pool: PluginEnginePoolConfig, suffix: string | null): RouteStrategy {
  return suffix === null ? pool.strategy : pool.providers?.[suffix]?.strategy ?? DEFAULT_ROUTE_STRATEGY;
}

/** The provider an account belongs to now. */
function accountSuffix(pool: PluginEnginePoolConfig, accountId: string): string | null {
  return pool.placement?.[accountId] ?? null;
}

/**
 * Taken-out providers that still hold accounts, with the identity of their first account; each is
 * listed like a provider of its own (a merged one has no accounts left and is not listed).
 */
export function listPluginEngineSeparateProviders(engineKey: string): Array<{ suffix: string; identity?: string }> {
  const pool = readPluginEnginePool(engineKey);
  if (!pool?.providers) return [];
  return Object.keys(pool.providers).flatMap((suffix) => {
    const first = providerAccounts(pool, suffix)[0];
    if (!first) return [];
    const identity = displayIdentity(runtime?.status.get(accountKey(engineKey, first.id))?.status) ?? first.lastConfirmedIdentity;
    return [{ suffix, ...(identity ? { identity } : {}) }];
  });
}

/** Whether a provider id names this computer's engine provider or one of its taken-out providers. */
export function resolvePluginEngineProvider(providerId: string | null | undefined): PluginEngineProviderRef | null {
  const ref = parsePluginEngineProviderId(providerId);
  if (!ref) return null;
  if (ref.suffix === null) return ref;
  return readPluginEnginePool(ref.engineKey)?.providers?.[ref.suffix] ? ref : null;
}

function dirOf(ref: { ghostId: string; harnessId: string }, accountId: string): string | undefined {
  return accountId === 'default' ? undefined : pluginEngineAccountDir(ref.ghostId, ref.harnessId, accountId);
}

/* ── What the plugin reports ───────────────────────────────────────────── */

export function displayIdentity(status: GhostHarnessAccountStatus | null | undefined): string | undefined {
  return status?.identity?.email ?? status?.identity?.name ?? status?.identity?.detail;
}

async function readStatus(
  state: RuntimeState,
  ref: { engineKey: string; ghostId: string; harnessId: string },
  accountId: string,
  force = false,
): Promise<StatusSnapshot> {
  const key = accountKey(ref.engineKey, accountId);
  const cached = state.status.get(key);
  const fresh = cached && Date.now() - cached.at < (cached.failed ? STATUS_FAILURE_FRESH_MS : STATUS_FRESH_MS);
  if (!force && fresh) return cached;
  const flight = state.statusFlights.get(key);
  if (flight && !force) return flight;
  const read = (async () => {
    let snapshot: StatusSnapshot;
    try {
      const status = await readPluginHarnessAccountStatus(ref.engineKey, dirOf(ref, accountId));
      snapshot = { status, failed: status === null, at: Date.now() };
    } catch {
      snapshot = { status: null, failed: true, at: Date.now() };
    }
    if (runtime !== state) return snapshot;
    const previous = state.status.get(key);
    state.status.set(key, snapshot);
    if (previous && (previous.status?.state !== snapshot.status?.state || previous.failed !== snapshot.failed))
      changed(ref.engineKey);
    const identity = displayIdentity(snapshot.status);
    if (snapshot.status?.state === 'signed-in' && identity) void rememberIdentity(ref.engineKey, accountId, identity);
    return snapshot;
  })();
  state.statusFlights.set(key, read);
  void read.finally(() => { if (state.statusFlights.get(key) === read) state.statusFlights.delete(key); }).catch(() => {});
  return read;
}

/** Bounded write: only when the confirmed identity actually changed. */
async function rememberIdentity(engineKey: string, accountId: string, identity: string): Promise<void> {
  // The original login of an engine that can add accounts keeps its identity before any account
  // setting was saved too: a later re-login of it is checked against it.
  const pool = readPluginEnginePool(engineKey)
    ?? (accountId === 'default' && liveEngine(engineKey)?.accounts?.methods.length ? effectivePluginEnginePool(engineKey) : null);
  const account = pool?.accounts.find(entry => entry.id === accountId);
  if (!account || account.lastConfirmedIdentity === identity) return;
  // A re-login still waiting for its own identity keeps the guard; a matching identity clears it.
  const relogin = account.reloginIdentity;
  try {
    await updatePluginEnginePool(engineKey, pool => ({
      ...pool,
      accounts: pool.accounts.map(entry => entry.id !== accountId ? entry : {
        ...entry,
        ...(relogin && relogin.toLowerCase() !== identity.toLowerCase() ? {} : { lastConfirmedIdentity: identity }),
        ...(relogin && relogin.toLowerCase() === identity.toLowerCase() ? { reloginIdentity: undefined } : {}),
      }),
    }));
  } catch (error) {
    log.warn('plugin engine accounts: saving identity failed', { error: error instanceof Error ? error.name : typeof error });
  }
}

async function readUsage(
  state: RuntimeState,
  ref: { engineKey: string; ghostId: string; harnessId: string },
  accountId: string,
  force = false,
): Promise<GhostHarnessUsage | null> {
  if (!liveEngine(ref.engineKey)?.reportsUsage) return null;
  const key = accountKey(ref.engineKey, accountId);
  const cached = state.usage.get(key);
  if (!force && cached && Date.now() - cached.at < USAGE_FRESH_MS) return cached.usage;
  const flight = state.usageFlights.get(key);
  if (flight) return flight;
  const read = (async () => {
    let usage: GhostHarnessUsage | null = null;
    try {
      const dir = dirOf(ref, accountId);
      usage = await (dir === undefined ? readPluginHarnessUsage(ref.engineKey) : readPluginHarnessUsage(ref.engineKey, dir));
    } catch {
      usage = cached?.usage ?? null;
    }
    if (runtime === state) {
      state.usage.set(key, { usage, at: Date.now() });
      if (JSON.stringify(cached?.usage ?? null) !== JSON.stringify(usage)) changed(ref.engineKey, 'usage');
    }
    return usage;
  })();
  state.usageFlights.set(key, read);
  void read.finally(() => { if (state.usageFlights.get(key) === read) state.usageFlights.delete(key); }).catch(() => {});
  return read;
}

/** Scheduling facts of an account's usage for one model (the windows that limit that model). */
export function pluginUsageState(usage: GhostHarnessUsage | null | undefined, model: string | undefined, now: number) {
  const windows = (usage?.windows ?? []).filter(window => !window.models || (!!model && window.models.includes(model)));
  const live = windows.filter(window => window.resetsAt === undefined || window.resetsAt > now);
  const full = live.filter(window => window.remainingPercent <= 0);
  const timed = live.filter(window => window.windowMinutes !== undefined).map(window => ({
    usedPercent: 100 - window.remainingPercent,
    resetAtMs: window.resetsAt ?? null,
    windowMs: window.windowMinutes! * 60_000,
  }));
  const schedule = timed.length ? quotaWindowsScheduleState(timed, now) : null;
  return {
    limited: full.length > 0,
    resetAtMs: full.length > 0 && full.every(window => window.resetsAt !== undefined)
      ? Math.max(...full.map(window => window.resetsAt!)) : null,
    urgency: schedule?.urgency ?? null,
    fiveHourTight: schedule?.fiveHourTight ?? false,
    headroom: schedule?.headroom ?? null,
  };
}

function accountCooling(state: RuntimeState, engineKey: string, accountId: string, model: string | undefined) {
  const scopes = currentCooling(state.cooling.get(accountKey(engineKey, accountId)), Date.now());
  const accountWide = scopes[''];
  const modelScope = model ? scopes[coolingScope(model)] : undefined;
  const until = Math.max(accountWide ?? 0, modelScope ?? 0);
  return until > 0 ? { until, modelLimited: modelScope !== undefined } : undefined;
}

function persistCooling(state: RuntimeState, engineKey: string, accountId: string): void {
  const scopes = state.cooling.get(accountKey(engineKey, accountId));
  if (!scopes) return;
  void writePluginEngineAccountCooling({ [engineKey]: { [accountId]: scopes } });
}

function signedInFor(snapshot: StatusSnapshot | undefined, account: PluginEngineAccountConfig): boolean {
  if (snapshot?.status?.state !== 'signed-in') return false;
  // A re-login that ended as someone else keeps the account out until its own identity returns.
  if (account.reloginIdentity) {
    const identity = displayIdentity(snapshot.status);
    return !!identity && identity.toLowerCase() === account.reloginIdentity.toLowerCase();
  }
  return true;
}

/**
 * Whether an account may take new tasks. The agent's original login started tasks before the plugin
 * reported accounts; when the plugin cannot say anything about it (no data, read failed) it keeps
 * doing so rather than stopping a setup that worked. Accounts Cindy added must be confirmed signed in.
 */
function admissibleFor(snapshot: StatusSnapshot | undefined, account: PluginEngineAccountConfig): boolean {
  if (signedInFor(snapshot, account)) return true;
  return account.id === 'default' && !account.reloginIdentity && (!snapshot || snapshot.failed);
}

/** `default` asks for whatever model the engine starts with, not for a model named so. */
function offersModel(snapshot: StatusSnapshot | undefined, model: string | undefined): boolean {
  const models = snapshot?.status?.models;
  return !model || model === PLUGIN_ENGINE_DEFAULT_MODEL || !models || models.includes(model);
}

/**
 * Whether the account cannot take this model right now: remembered failure, used-up quota or
 * signed out. Unknown (never read, read failed) is not blocked, like the built-in pool.
 */
export function readPluginEngineAccountBlocked(engineKey: string, accountId: string, model: string | undefined): boolean {
  const state = currentRuntime();
  const account = readPluginEnginePool(engineKey)?.accounts.find(entry => entry.id === accountId)
    ?? (accountId === 'default' ? DEFAULT_PLUGIN_ENGINE_ACCOUNT : undefined);
  if (!account) return true;
  if (accountCooling(state, engineKey, accountId, model)) return true;
  const snapshot = state.status.get(accountKey(engineKey, accountId));
  if (snapshot && !snapshot.failed && !signedInFor(snapshot, account)) return true;
  return pluginUsageState(state.usage.get(accountKey(engineKey, accountId))?.usage, model, Date.now()).limited;
}

/**
 * Before a send that could move to another account: re-read the task's account when its last
 * answer is older than the cache period (an idle task's sign-in may have lapsed since). Within the
 * period nothing is asked; a slow plugin answer finishes in the background and this send goes on
 * with what is known, like the selection reads.
 */
export async function refreshPluginEngineAccountForSend(engineKey: string, accountId: string): Promise<void> {
  const ref = parsePluginEngineProviderId(pluginEngineProviderId(engineKey));
  if (!ref) return;
  const state = currentRuntime();
  const read = Promise.all([readStatus(state, ref, accountId), readUsage(state, ref, accountId)]).catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([read, new Promise<void>(resolve => { timer = setTimeout(resolve, SELECTION_READ_BUDGET_MS); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  assertOwner(state);
}

/* ── Selection ─────────────────────────────────────────────────────────── */

export interface PluginEngineAccountLease {
  accountId: string;
  /** Directory for the endpoint; undefined for the agent's original login. */
  accountDir: string | undefined;
  /** Chosen from an existing task binding rather than by the pool policy. */
  pinned: boolean;
  assertDispatchable(): void;
  observeFailure(error: unknown, model: string | undefined, phase: 'start' | 'run'): boolean;
  /**
   * Records the account for these keys, through the provider the task is routed to (by default the
   * provider this lease was taken from).
   */
  bind(keys: string[], via?: string): Promise<void>;
  reserveForTask(taskId: string): void;
  running(active: boolean): void;
  release(): void;
}

function expirePendingStarts(state: RuntimeState): void {
  const now = Date.now();
  for (const [key, pending] of state.pendingStarts) {
    if (pending.until > now) continue;
    // Pending keys are `<engine key>|task:<id>`; running keys `<engine key>|<account id>`.
    state.running.get(accountKey(key.slice(0, key.indexOf('|')), pending.accountId))?.delete(pending.token);
    state.pendingStarts.delete(key);
  }
}

interface AcquireOptions {
  /** Resuming a native session: only its own account. */
  resuming?: boolean;
  /** Accounts already tried in this start (each at most once). */
  exclude?: ReadonlySet<string>;
  /** Check that the policy can select an account, reserving nothing. */
  dryRun?: boolean;
}

/**
 * Picks the account a task runs on: its bound account, or the provider's policy among usable
 * accounts (built-in pool semantics). Returns null when the engine has no account pool.
 */
export async function acquirePluginEngineAccount(
  providerId: string,
  model: string | undefined,
  keys: string[],
  options: AcquireOptions = {},
): Promise<PluginEngineAccountLease | null> {
  const ref = parsePluginEngineProviderId(providerId);
  if (!ref || !pluginEngineHasAccountPool(ref.engineKey)) return null;
  const state = currentRuntime();
  const { engineKey } = ref;
  const bindings = keys.map(key => readPluginEngineBinding(engineKey, key)).filter(Boolean);
  let binding = bindings[0];
  if (bindings.some(entry => entry?.accountId !== binding?.accountId)) throw new Error('The task subscription account changed');
  const pool = effectivePluginEnginePool(engineKey);
  // A task the user moved to another provider of this engine picks there (a resume stays put).
  if (binding && (binding.via ?? pluginEngineProviderId(engineKey)) !== providerId
    && pluginEngineProviderId(engineKey, accountSuffix(pool, binding.accountId)) !== providerId) {
    if (options.resuming !== false) throw new Error('The task subscription account changed');
    binding = undefined;
  }
  // A taken-out provider merged away keeps no accounts: only bound tasks still reach it.
  if (ref.suffix !== null && !pool.providers?.[ref.suffix] && !binding)
    throw new Error('[SUBSCRIPTION_ACCOUNT_UNAVAILABLE] The task subscription account is unavailable');
  const selectionSuffix = binding ? accountSuffix(pool, binding.accountId) : ref.suffix;
  const selectionProvider = pluginEngineProviderId(engineKey, selectionSuffix);
  const boundConfig = binding && pool.accounts.find(account => account.id === binding!.accountId);
  const rebind = options.resuming === false && !!binding
    && (!boundConfig || boundConfig.paused || readPluginEngineAccountBlocked(engineKey, binding.accountId, model));
  const pinnedTarget = binding && !rebind ? binding.accountId : undefined;

  // Each candidate completes its own sign-in read; one slow plugin call does not stop the others.
  const reads = (pinnedTarget ? [pinnedTarget] : providerAccounts(pool, selectionSuffix)
    .filter(account => !account.paused).map(account => account.id));
  const pending = new Set<Promise<unknown>>();
  for (const id of reads) {
    const read = Promise.all([readStatus(state, ref, id), readUsage(state, ref, id)]);
    pending.add(read);
    void read.finally(() => pending.delete(read)).catch(() => {});
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([...pending]),
      new Promise<void>(resolve => { timer = setTimeout(resolve, SELECTION_READ_BUDGET_MS); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  /** The weighted step of the latest pick; recorded only when that pick is actually used. */
  let weightStep: RouteWeightStep | undefined;
  const select = () => {
    assertOwner(state);
    const latest = effectivePluginEnginePool(engineKey);
    const group = providerAccounts(latest, selectionSuffix);
    expirePendingStarts(state);
    const pendingKey = keys.map(key => `${engineKey}|${key}`).find(key => state.pendingStarts.has(key));
    const reserved = pendingKey ? state.pendingStarts.get(pendingKey) : undefined;
    const now = Date.now();
    const exclude = rebind && binding
      ? new Set([...(options.exclude ?? []), binding.accountId]) : options.exclude;
    const members = group.map((account): SchedulableMember & { id: string; snapshot?: StatusSnapshot; fingerprint?: string; limited: boolean } => {
      const key = accountKey(engineKey, account.id);
      const snapshot = state.status.get(key);
      const usage = pluginUsageState(state.usage.get(key)?.usage, model, now);
      const loggingIn = [...state.logins.values()].some(login => login.engineKey === engineKey && login.accountId === account.id);
      const cooling = !pinnedTarget && group.length >= 2 ? accountCooling(state, engineKey, account.id, model) : undefined;
      return {
        id: account.id,
        key: account.id,
        snapshot,
        ...(snapshot?.status?.state === 'signed-in' && snapshot.status.fingerprint ? { fingerprint: snapshot.status.fingerprint } : {}),
        limited: usage.limited,
        usable: !loggingIn && admissibleFor(snapshot, account) && offersModel(snapshot, model) && !usage.limited && !cooling,
        paused: account.paused,
        running: state.running.get(key)?.size ?? 0,
        limit: effectiveConcurrencyLimit(account),
        weight: account.weight,
        urgency: usage.urgency,
        fiveHourTight: usage.fiveHourTight,
        headroom: usage.headroom,
      };
    });
    // The same account signed in twice (the plugin's fingerprint) counts once: the first of them that
    // can take this task stands for it and carries the others' load, so pausing one directory never
    // blocks another that is still on.
    const representatives = new Map<string, (typeof members)[number]>();
    for (const member of members) {
      if (member.fingerprint && member.usable && !member.paused && !exclude?.has(member.id) && !representatives.has(member.fingerprint))
        representatives.set(member.fingerprint, member);
    }
    for (const member of members) {
      const primary = member.fingerprint ? representatives.get(member.fingerprint) : undefined;
      if (!primary || primary === member) continue;
      member.usable = false;
      primary.running += member.running;
      if (!member.paused) primary.limit = Math.min(primary.limit, member.limit);
    }
    const strategy = providerStrategy(latest, selectionSuffix);
    const picked = pinnedTarget === undefined ? pickRouteMember(members, strategy, {
      exclude, lastPicked: state.lastPicked.get(selectionProvider),
      weightCounters: state.weightCounters.get(selectionProvider),
      quotaFirst: true,
    }) : null;
    weightStep = picked?.weightStep;
    let choice = pinnedTarget ?? picked?.key ?? null;
    if (!choice && pending.size) return null;
    let pinned = pinnedTarget !== undefined;
    // Every other account is blocked, full or tried: a fresh session stays on its bound account.
    if (!choice && rebind && binding && boundConfig && !boundConfig.paused) {
      choice = binding.accountId;
      pinned = true;
    }
    const member = members.find(entry => entry.id === choice);
    if (reserved && member && member.running - (reserved.accountId === choice ? 1 : 0) >= member.limit)
      throw new Error(PLUGIN_ENGINE_ACCOUNTS_FULL_ERROR);
    if (!choice && routeMembersFull(members, { exclude })) throw new Error(PLUGIN_ENGINE_ACCOUNTS_FULL_ERROR);
    if (!choice || !member) {
      if (!pinned) throw new Error('No subscription account is available');
      throw new Error('[SUBSCRIPTION_ACCOUNT_UNAVAILABLE] The task subscription account is unavailable');
    }
    if (pinned) {
      const account = group.find(entry => entry.id === choice)
        ?? latest.accounts.find(entry => entry.id === choice);
      if (!account) throw new Error('[SUBSCRIPTION_ACCOUNT_UNAVAILABLE] The task subscription account is unavailable');
      if ([...state.logins.values()].some(login => login.engineKey === engineKey && login.accountId === choice))
        throw new Error('[SUBSCRIPTION_ACCOUNT_SIGNING_IN] The task subscription account is signing in');
      if (member.snapshot && !member.snapshot.failed && !signedInFor(member.snapshot, account))
        throw new Error('[SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED] The task subscription account requires login');
    } else if (!member.usable || member.paused) {
      throw new Error('No subscription account is available');
    }
    return { selected: choice, pinned, reserved, pendingKey };
  };
  let selection = select();
  while (!selection) {
    await Promise.race(pending);
    selection = select();
  }
  if (options.dryRun) return null;
  const { selected, pinned, reserved, pendingKey } = selection;
  const token = randomUUID();
  const key = accountKey(engineKey, selected);
  const active = state.running.get(key) ?? new Set<string>();
  state.running.set(key, active);
  if (reserved && pendingKey) {
    state.running.get(accountKey(engineKey, reserved.accountId))?.delete(reserved.token);
    state.pendingStarts.delete(pendingKey);
  }
  active.add(token);
  state.lastPicked.set(selectionProvider, selected);
  if (weightStep?.pickedKey === selected)
    state.weightCounters.set(selectionProvider, applyRouteWeightStep(state.weightCounters.get(selectionProvider), weightStep));
  changed(engineKey, 'load');
  let released = false;
  let handedOff = false;
  const assertCurrent = () => {
    assertOwner(state);
    if (!effectivePluginEnginePool(engineKey).accounts.some(account => account.id === selected))
      throw new Error('Subscription account was disconnected');
  };
  const accountDir = dirOf(ref, selected);
  return {
    accountId: selected,
    accountDir,
    pinned,
    assertDispatchable() {
      assertCurrent();
      const account = effectivePluginEnginePool(engineKey).accounts.find(entry => entry.id === selected);
      if (account?.paused) throw new Error('The task subscription account is disabled; retry to switch accounts');
      if ([...state.logins.values()].some(login => login.engineKey === engineKey && login.accountId === selected))
        throw new Error('[SUBSCRIPTION_ACCOUNT_SIGNING_IN] The task subscription account is signing in');
      const snapshot = state.status.get(key);
      if (account?.reloginIdentity && !signedInFor(snapshot, account))
        throw new Error('[SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED] The task subscription account requires login');
    },
    observeFailure(error, failedModel, phase) {
      try { assertCurrent(); } catch { return false; }
      const signals = providerGroupFailureSignals(pluginEngineFailureCause(error));
      const decision = decideProviderGroupFailure(signals, phase);
      if (decision.action !== 'switch') return false;
      if (!decision.cool) return true;
      const now = Date.now();
      const usageLimit = decision.cause === 'usage-limit';
      const resetAt = usageLimit ? readTurnUsageResetAt(signals, now) : null;
      const scope = usageLimit ? coolingScope(failedModel) : '';
      const until = !usageLimit
        ? now + PROVIDER_GROUP_FAILURE_COOLDOWN_MS
        : resetAt !== null && resetAt > now ? resetAt : now + PROVIDER_GROUP_DEFAULT_COOLDOWN_MS;
      const scopes = currentCooling(state.cooling.get(key), now);
      const previous = scopes[scope] ?? 0;
      delete scopes[scope];
      scopes[scope] = Math.max(previous, until);
      state.cooling.set(key, Object.fromEntries(Object.entries(scopes).slice(-PROVIDER_GROUP_COOLING_SCOPE_CAP)));
      persistCooling(state, engineKey, selected);
      // A sign-in failure means the plugin's last status is stale.
      if (decision.cause === 'auth') state.status.delete(key);
      changed(engineKey);
      return true;
    },
    async bind(ids, via = providerId) {
      assertCurrent();
      await writePluginEngineBindings(engineKey, ids, selected, via);
      assertCurrent();
    },
    reserveForTask(taskId) {
      assertCurrent();
      if (released || readPluginEngineBinding(engineKey, `task:${taskId}`)?.accountId !== selected)
        throw new Error('Cannot transfer the subscription account reservation');
      const taskKey = `${engineKey}|task:${taskId}`;
      const previous = state.pendingStarts.get(taskKey);
      if (previous) state.running.get(accountKey(engineKey, previous.accountId))?.delete(previous.token);
      active.add(token);
      state.pendingStarts.set(taskKey, { accountId: selected, token, until: Date.now() + PROVIDER_GROUP_LOCAL_PROVISIONAL_MS });
      handedOff = true;
    },
    running(value) {
      const was = active.has(token);
      if (!released) {
        if (value) active.add(token);
        else active.delete(token);
      }
      if (was !== active.has(token)) changed(engineKey, 'load');
    },
    release() {
      released = true;
      if (!handedOff && active.delete(token)) changed(engineKey, 'load');
    },
  };
}

/**
 * The failure the failure policy should read. Startup errors arrive wrapped (stopped / cleanup
 * pending); the ACP engine's account errors carry structured signals on the inner error.
 */
export function pluginEngineFailureCause(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const signals = (current as { signals?: unknown }).signals;
    if (signals && typeof signals === 'object') return { message: current.message, ...(signals as object) };
    if (current.name === 'AcpAuthRequiredError') return { message: current.message, reason: 'acp-auth-required' };
    const cause = (current as { cause?: unknown }).cause;
    if (!(cause instanceof Error)) break;
    current = cause;
  }
  return error;
}

/**
 * Whether a task whose bound account cannot take its model right now can move to another account
 * of its provider (before-send switch and immediate continuation after a usage limit).
 */
export async function canSwitchPluginEngineAccount(providerId: string, sessionId: string, model: string | undefined): Promise<boolean> {
  const ref = parsePluginEngineProviderId(providerId);
  if (!ref || !pluginEngineHasAccountPool(ref.engineKey)) return false;
  const binding = readPluginEngineBinding(ref.engineKey, `task:${sessionId}`);
  if (!binding) return false;
  const pool = effectivePluginEnginePool(ref.engineKey);
  if (providerAccounts(pool, accountSuffix(pool, binding.accountId)).length < 2) return false;
  // A dry run selects exactly like a new assignment (limits, pauses, cooldowns) and reserves nothing.
  try {
    await acquirePluginEngineAccount(pluginEngineProviderId(ref.engineKey, accountSuffix(pool, binding.accountId)),
      model, [], { resuming: false, dryRun: true, exclude: new Set([binding.accountId]) });
    return true;
  } catch {
    return false;
  }
}

/** The task's bound account, for the task's own displays (composer, model picker). */
export function readPluginEngineTaskAccount(engineKey: string, sessionId: string | undefined, nativeSessionId?: string) {
  const keys = [sessionId ? `task:${sessionId}` : '', nativeSessionId ? `native:${nativeSessionId}` : ''].filter(Boolean);
  for (const key of keys) {
    const binding = readPluginEngineBinding(engineKey, key);
    if (binding) return binding;
  }
  return undefined;
}

/**
 * The usage of the account a local task runs on (composer usage chip). `key` may name a taken-out
 * provider (`<engine>~<suffix>`). A task not yet assigned shows nothing rather than another account.
 */
export async function readPluginEngineTaskUsage(
  key: string,
  sessionId: string,
  options: { fallbackToOriginal?: boolean } = {},
): Promise<GhostHarnessUsage | null> {
  const ref = parsePluginEngineProviderId(pluginEngineProviderId(key));
  if (!ref || !pluginEngineHasAccountPool(ref.engineKey)) return null;
  const binding = readPluginEngineTaskAccount(ref.engineKey, sessionId);
  // Another computer's id for a task whose Agent runs here is not known here: keep its old read.
  if (!binding) return options.fallbackToOriginal ? readPluginHarnessUsage(ref.engineKey) : null;
  const state = currentRuntime();
  const usage = await readUsage(state, ref, binding.accountId);
  assertOwner(state);
  return usage;
}

/* ── Views ─────────────────────────────────────────────────────────────── */

function accountStatus(
  state: RuntimeState,
  engineKey: string,
  account: PluginEngineAccountConfig,
): SubscriptionAccountView['status'] {
  const key = accountKey(engineKey, account.id);
  const snapshot = state.status.get(key);
  if (!snapshot || snapshot.failed) return 'unavailable';
  if (!signedInFor(snapshot, account)) return 'signed-out';
  const cooling = currentCooling(state.cooling.get(key), Date.now())[''];
  return cooling || pluginUsageState(state.usage.get(key)?.usage, undefined, Date.now()).limited ? 'limited' : 'ready';
}

function accountView(state: RuntimeState, ref: PluginEngineProviderRef, account: PluginEngineAccountConfig): SubscriptionAccountView {
  const key = accountKey(ref.engineKey, account.id);
  const snapshot = state.status.get(key);
  const identity = displayIdentity(snapshot?.status) ?? account.lastConfirmedIdentity;
  const usage = state.usage.get(key)?.usage;
  let directory = '';
  try { directory = dirOf(ref, account.id) ?? ''; } catch { /* another owner's id: shown without a folder */ }
  return {
    id: account.id,
    paused: account.paused,
    limit: account.limit,
    ...(account.limitSet ? { limitSet: true as const } : {}),
    weight: account.weight,
    ...(identity ? { identity } : {}),
    ...(snapshot?.status?.plan ? { plan: snapshot.status.plan } : {}),
    directory,
    status: accountStatus(state, ref.engineKey, account),
    ...(account.reloginIdentity && snapshot?.status?.state === 'signed-in' && !signedInFor(snapshot, account)
      ? { authIssue: 'account-mismatch' as const } : {}),
    running: state.running.get(key)?.size ?? 0,
    ...(usage ? { usage: { plugin: usage } } : {}),
  };
}

/** The pool of one provider of a plugin engine, in the built-in pool's view shape. */
export async function readPluginEnginePoolView(providerId: string, taskId?: string, force = false): Promise<SubscriptionPoolView> {
  const ref = resolvePluginEngineProvider(providerId);
  const engine = ref && liveEngine(ref.engineKey);
  if (!ref || !engine?.accounts) throw new Error('Account not found');
  const state = currentRuntime();
  const pool = effectivePluginEnginePool(ref.engineKey);
  // Identity-only engines (no methods) report just the original login.
  const accounts = engine.accounts.methods.length ? providerAccounts(pool, ref.suffix) : [DEFAULT_PLUGIN_ENGINE_ACCOUNT];
  await Promise.all(accounts.map(account => Promise.all([
    readStatus(state, ref, account.id, force),
    readUsage(state, ref, account.id, force),
  ]).catch(() => {})));
  assertOwner(state);
  const bound = taskId ? readPluginEngineBinding(ref.engineKey, `task:${taskId}`) : undefined;
  return {
    providerId,
    configured: true,
    strategy: providerStrategy(pool, ref.suffix),
    ...(taskId !== undefined ? { boundAccountId: bound?.accountId ?? null } : {}),
    accounts: accounts.map(account => accountView(state, ref, account)),
    pluginEngine: {
      engineKey: ref.engineKey,
      methods: engine.accounts.methods.map(method => ({ ...method })),
      ...(ref.suffix ? { separate: true as const } : {}),
    },
  };
}

/* ── Commands (settings, Helper) ───────────────────────────────────────── */

async function withPool(
  ref: PluginEngineProviderRef,
  edit: (pool: PluginEnginePoolConfig) => PluginEnginePoolConfig,
): Promise<void> {
  await updatePluginEnginePool(ref.engineKey, edit);
  changed(ref.engineKey);
}

function requireAccount(pool: PluginEnginePoolConfig, ref: PluginEngineProviderRef, accountId: string): PluginEngineAccountConfig {
  const account = pool.accounts.find(entry => entry.id === accountId);
  if (!account || accountSuffix(pool, accountId) !== ref.suffix) throw new Error('Account not found');
  return account;
}

async function runLogin(
  state: RuntimeState,
  ref: PluginEngineProviderRef,
  loginKey: string,
  accountId: string,
  created: boolean,
  methodId: string,
  secret: string | undefined,
): Promise<void> {
  const fullKey = `${ref.engineKey}|${loginKey}`;
  if (state.logins.has(fullKey) || [...state.logins.values()].some(login => login.engineKey === ref.engineKey && login.accountId === accountId))
    throw new Error('login_in_progress');
  const dir = dirOf(ref, accountId);
  state.logins.set(fullKey, { engineKey: ref.engineKey, accountId, dir, created });
  changed(ref.engineKey);
  try {
    if (dir) await ensurePluginEngineAccountDir(dir);
    const result = await loginPluginHarnessAccount(ref.engineKey, dir, methodId, secret);
    assertOwner(state);
    if (!result.ok) throw new Error(result.error === 'cancelled' ? 'login_cancelled' : 'login_failed');
    const confirmed = await readStatus(state, ref, accountId, true);
    assertOwner(state);
    // The plugin could not say whether the sign-in worked: not a failed login, not a success.
    if (confirmed.failed) throw new AccountServiceUnreachableError('plugin-unavailable');
    if (confirmed.status?.state !== 'signed-in') throw new Error('login_failed');
  } finally {
    if (state.logins.get(fullKey)?.accountId === accountId) state.logins.delete(fullKey);
    changed(ref.engineKey);
  }
}

/**
 * Same commands as the built-in pool, for one provider of a plugin engine. Detection, connecting
 * and creating providers belong to the add-provider wizard of built-in providers only.
 */
export async function runPluginEngineAccountCommand(
  command: SubscriptionAccountCommand & { methodId?: string; secret?: string },
): Promise<SubscriptionPoolView> {
  const ref = parsePluginEngineProviderId(command.providerId);
  if (!ref) throw new Error('Account not found');
  const state = currentRuntime();
  const engine = liveEngine(ref.engineKey);
  if (!engine?.accounts) throw new Error('Account not found');
  const multi = engine.accounts.methods.length > 0;
  const methodFor = (id: string | undefined) => {
    const method = engine.accounts!.methods.find(entry => entry.id === id) ?? (id === undefined ? engine.accounts!.methods[0] : undefined);
    if (!method) throw new Error('login_failed');
    return method;
  };
  switch (command.action) {
    // Views refresh on every load change: reads use the plugin's cached answers (one minute, five
    // seconds after a failed read), like the built-in pool, instead of calling the plugin each time.
    case 'read':
      return readPluginEnginePoolView(command.providerId, command.taskId);
    case 'add': {
      if (!multi) throw new Error('Account not found');
      const pool = effectivePluginEnginePool(ref.engineKey);
      if (ref.suffix !== null && !pool.providers?.[ref.suffix]) throw new Error('Account not found');
      if (pool.accounts.length >= MAX_SUBSCRIPTION_ACCOUNTS) throw new Error('Too many subscription accounts');
      const method = methodFor(command.methodId);
      const accountId = newPluginEngineAccountId();
      try {
        await runLogin(state, ref, command.loginKey, accountId, true, method.id, command.secret);
      } catch (error) {
        const dir = dirOf(ref, accountId);
        if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      const identity = displayIdentity(state.status.get(accountKey(ref.engineKey, accountId))?.status);
      await withPool(ref, current => {
        if (current.accounts.length >= MAX_SUBSCRIPTION_ACCOUNTS) throw new Error('Too many subscription accounts');
        return {
          ...current,
          accounts: [...current.accounts, { ...DEFAULT_PLUGIN_ENGINE_ACCOUNT, id: accountId, ...(identity ? { lastConfirmedIdentity: identity } : {}) }],
          ...(ref.suffix ? { placement: { ...current.placement, [accountId]: ref.suffix } } : {}),
        };
      });
      void clearPluginEngineAccountCooling(ref.engineKey, accountId);
      return readPluginEnginePoolView(command.providerId);
    }
    case 'login': {
      if (!multi) throw new Error('Account not found');
      const pool = effectivePluginEnginePool(ref.engineKey);
      const account = requireAccount(pool, ref, command.accountId);
      if ((state.running.get(accountKey(ref.engineKey, account.id))?.size ?? 0) > 0) throw new Error('Account is in use');
      const method = methodFor(command.methodId);
      // Signing in as someone else does not count: keep the account out until its identity returns.
      // The identity shown last stands in when its saving has not happened yet.
      const shown = state.status.get(accountKey(ref.engineKey, account.id))?.status;
      const original = account.lastConfirmedIdentity ?? (shown?.state === 'signed-in' ? displayIdentity(shown) : undefined);
      if (original) await withPool(ref, current => ({
        ...current,
        accounts: current.accounts.map(entry => entry.id === account.id ? { ...entry, reloginIdentity: original } : entry),
      }));
      await runLogin(state, ref, command.loginKey, account.id, false, method.id, command.secret);
      const identity = displayIdentity(state.status.get(accountKey(ref.engineKey, account.id))?.status);
      // No identity back cannot show it is the same account: the guard stays until it is.
      if (original && identity?.toLowerCase() !== original.toLowerCase()) throw new Error('account_mismatch');
      await withPool(ref, current => ({
        ...current,
        accounts: current.accounts.map(entry => entry.id !== account.id ? entry
          : { ...entry, reloginIdentity: undefined, ...(identity ? { lastConfirmedIdentity: identity } : {}) }),
      }));
      state.cooling.delete(accountKey(ref.engineKey, account.id));
      void clearPluginEngineAccountCooling(ref.engineKey, account.id);
      return readPluginEnginePoolView(command.providerId);
    }
    case 'cancel': {
      const login = state.logins.get(`${ref.engineKey}|${command.loginKey}`);
      if (login) await cancelPluginHarnessAccountLogin(ref.engineKey, login.dir).catch(() => {});
      return readPluginEnginePoolView(command.providerId);
    }
    case 'remove': {
      const pool = effectivePluginEnginePool(ref.engineKey);
      requireAccount(pool, ref, command.accountId);
      if ((state.running.get(accountKey(ref.engineKey, command.accountId))?.size ?? 0) > 0) throw new Error('Account is in use');
      // Only Cindy stops using it: the account's directory, sign-in and history stay for its old tasks.
      await withPool(ref, current => {
        const placement = { ...current.placement };
        delete placement[command.accountId];
        return { ...current, accounts: current.accounts.filter(entry => entry.id !== command.accountId), placement };
      });
      state.cooling.delete(accountKey(ref.engineKey, command.accountId));
      void clearPluginEngineAccountCooling(ref.engineKey, command.accountId);
      return readPluginEnginePoolView(command.providerId);
    }
    case 'reorder': {
      // 账号的先后(与订阅账号池同一个命令)：只在这些账号占着的位置里重排，别的账号原地不动。
      const pool = effectivePluginEnginePool(ref.engineKey);
      for (const id of command.accountIds) requireAccount(pool, ref, id);
      const order = command.accountIds;
      await withPool(ref, current => {
        const moving = new Set(order);
        const byId = new Map(current.accounts.map(entry => [entry.id, entry]));
        let next = 0;
        return { ...current, accounts: current.accounts.map(entry => (moving.has(entry.id) ? byId.get(order[next++]!) ?? entry : entry)) };
      });
      return readPluginEnginePoolView(command.providerId);
    }
    case 'configure': {
      const pool = effectivePluginEnginePool(ref.engineKey);
      if (command.accountId !== undefined) requireAccount(pool, ref, command.accountId);
      await withPool(ref, current => ({
        ...current,
        ...(command.strategy && ref.suffix === null ? { strategy: command.strategy } : {}),
        ...(command.strategy && ref.suffix !== null
          ? { providers: { ...current.providers, [ref.suffix]: { strategy: command.strategy } } } : {}),
        accounts: current.accounts.map(entry => entry.id !== command.accountId ? entry : {
          ...entry,
          ...(command.paused !== undefined ? { paused: command.paused } : {}),
          ...(command.limit !== undefined ? concurrencyLimitPatch(command.limit) : {}),
          ...(command.weight !== undefined ? { weight: command.weight } : {}),
        }),
      }));
      return readPluginEnginePoolView(command.providerId);
    }
    case 'place': {
      const pool = effectivePluginEnginePool(ref.engineKey);
      requireAccount(pool, ref, command.accountId);
      const target = command.target === null ? null : parsePluginEngineProviderId(command.target);
      if (command.target !== null && (!target || target.engineKey !== ref.engineKey
        || (target.suffix !== null && !pool.providers?.[target.suffix]))) throw new Error('Account not found');
      let createdSuffix: string | null = null;
      await withPool(ref, current => {
        const placement = { ...current.placement };
        let providers = current.providers ?? {};
        if (target === null) {
          createdSuffix = newPluginEngineProviderSuffix(new Set(Object.keys(providers)));
          providers = { ...providers, [createdSuffix]: { strategy: DEFAULT_ROUTE_STRATEGY } };
          placement[command.accountId] = createdSuffix;
        } else if (target.suffix === null) delete placement[command.accountId];
        else placement[command.accountId] = target.suffix;
        return { ...current, providers, placement };
      });
      return readPluginEnginePoolView(createdSuffix ? pluginEngineProviderId(ref.engineKey, createdSuffix) : command.providerId)
        .catch(() => readPluginEnginePoolView(pluginEngineProviderId(ref.engineKey)));
    }
    case 'merge': {
      const target = parsePluginEngineProviderId(command.target);
      const pool = effectivePluginEnginePool(ref.engineKey);
      if (ref.suffix === null || !target || target.engineKey !== ref.engineKey || target.providerId === ref.providerId
        || (target.suffix !== null && !pool.providers?.[target.suffix])) throw new Error('Account not found');
      // The taken-out provider stays as an empty alias so its old tasks keep following their accounts.
      await withPool(ref, current => {
        const placement = { ...current.placement };
        for (const account of providerAccounts(current, ref.suffix)) {
          if (target.suffix === null) delete placement[account.id];
          else placement[account.id] = target.suffix;
        }
        return { ...current, placement };
      });
      return readPluginEnginePoolView(command.target);
    }
    case 'remove-provider': {
      const pool = effectivePluginEnginePool(ref.engineKey);
      if (ref.suffix === null || !pool.providers?.[ref.suffix]) throw new Error('Account not found');
      const ids = new Set(providerAccounts(pool, ref.suffix).map(account => account.id));
      if ([...ids].some(id => (state.running.get(accountKey(ref.engineKey, id))?.size ?? 0) > 0)) throw new Error('Account is in use');
      await withPool(ref, current => {
        const placement = Object.fromEntries(Object.entries(current.placement ?? {}).filter(([id]) => !ids.has(id)));
        const providers = { ...current.providers };
        delete providers[ref.suffix!];
        return { ...current, accounts: current.accounts.filter(account => !ids.has(account.id)), placement, providers };
      });
      return readPluginEnginePoolView(pluginEngineProviderId(ref.engineKey));
    }
    default:
      throw new Error('Account not found');
  }
}

/** Test seam: forget runtime state (owner change does the same in production). */
export function resetPluginEngineAccountsRuntimeForTests(): void {
  runtime = null;
}
