import type { ProviderAccountUsageResult } from '../../shared/providerAccountUsage.js';
import { kimiUsageWindowMinutes } from '../../shared/kimiCodingUsage.js';
/**
 * Turns Cindy's existing usage readers into the menu bar builder's inputs.
 *
 * Every reader is injected so this stays a pure mapping: `service.ts` passes the real
 * cached-first readers (no credential reads happen here) and tests pass fixtures. A reader
 * that fails only drops its own source; the rest of the panel still renders.
 */

import { actualSourceIdForModel, type ProviderView } from '@cindy/model-providers';
import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import { matchCodexBucketForModel } from '@cindy/maker-shared/codex-usage-buckets';
import type {
  ClaudeSubscriptionUsageSnapshot,
  XaiSubscriptionUsageSnapshot,
} from '@cindy/maker-shared/subscription-usage';
import { isXaiWeeklyUsageCurrent } from '@cindy/maker-shared/subscription-usage';
import { isSessionActivityRunning, type SessionActivitySnapshot } from '@cindy/maker-shared/session-activity';

import type { MenubarModelUsage, MenubarUsageScope, MenubarUsageScopeData } from '../../shared/menubarQuota.js';
import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { providerWeeklyQuotaSource } from '../../shared/providerQuotaSource.js';
import { formatModelShort } from '../../shared/usageModelLabel.js';
import type { CodexAccountUsagePayload, RateLimitSnapshot, RateLimitWindow } from '../usageBroadcaster.js';
import type { UsageHistoryPayload } from '../usage/usageHistory.js';
import { familyLogo, MENUBAR_CINDY_LOGO, providerLogo } from './logos.js';
import {
  topModels,
  type MenubarBalanceInput,
  type MenubarHarness,
  type MenubarPaygInput,
  type MenubarQuotaPeriod,
  type MenubarResetCredits,
  type MenubarSourceInput,
  type MenubarSubscriptionInput,
  type MenubarTaskInput,
  type MenubarUsageInput,
  type MenubarModelSeries,
  type MenubarUsageScopeInput,
  type MenubarWalletPools,
  type MenubarWindowInput,
} from './snapshot.js';

export const MENUBAR_USAGE_DAYS = 90;
export const MENUBAR_BALANCE_SOURCE_ID = 'cindy';
const WEEK_MINUTES = 10_080;
const FIVE_HOUR_MINUTES = 300;
/** Tasks beyond this are summarized as "N more"; the list stays cheap to build. */
const MAX_TASK_ROWS = 30;
const HARNESSES: readonly MenubarHarness[] = ['claude-code', 'codex', 'pi'];

export interface MenubarBalanceReading {
  available: number;
  /** Sum of pool totals when the server reports them all. */
  fullAmount: number | null;
  burnPerDay: number | null;
  observedAtMs: number | null;
  currency: 'USD' | 'CNY';
  /** Set for a period quota (organization or gateway key) rather than a wallet. */
  quota: MenubarQuotaPeriod | null;
  pools?: MenubarWalletPools | null;
  promoExpiry?: { amount: number; expiresAtMs: number } | null;
}

export interface MenubarSessionRow {
  title: string | null;
  model: string | null;
  agentKind: string | null;
  source?: string | null;
  /** Provider the session sends to; marks the source a running task is drawing on. */
  providerId?: string | null;
}

export interface MenubarCollectDeps {
  nowMs: number;
  listProviders(): Promise<ProviderView[]>;
  readKimi?(providerId: string): Promise<ProviderAccountUsageResult>;
  readCodex(providerId: string): Promise<CodexAccountUsagePayload | RateLimitSnapshot | null>;
  readClaude(providerId: string): Promise<ClaudeSubscriptionUsageSnapshot | null>;
  readXai(providerId: string): Promise<XaiSubscriptionUsageSnapshot | null>;
  /** Codex resets left on a local account; absent in tests that do not cover them. */
  readCodexResets?(providerId: string): Promise<MenubarResetCredits | null>;
  /** Subscriptions on the user's other computers, already read and mapped. */
  readRemoteSubscriptions?(): Promise<MenubarSubscriptionInput[]>;
  /** Null when the account has no Cindy balance (organization accounts, signed out). */
  readBalance(): Promise<MenubarBalanceReading | null>;
  readUsage(scope: MenubarUsageScope): Promise<UsageHistoryPayload | null>;
  activities(): readonly SessionActivitySnapshot[];
  sessionRow(sessionId: string): Promise<MenubarSessionRow | null>;
  /** Display name of this computer for the usage footnote. */
  selfDeviceName: string;
  onError?(scope: string, error: unknown): void;
}

export interface MenubarCollected {
  sources: MenubarSourceInput[];
  tasks: MenubarTaskInput[];
  usage: MenubarUsageInput;
  updatedAtMs: number | null;
}

export async function collectMenubarInputs(deps: MenubarCollectDeps): Promise<MenubarCollected> {
  const safe = async <T>(scope: string, read: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      deps.onError?.(scope, error);
      return fallback;
    }
  };

  const [providers, balance, localUsage, allUsage, remote] = await Promise.all([
    safe('providers', () => deps.listProviders(), [] as ProviderView[]),
    safe('balance', () => deps.readBalance(), null),
    safe('usage:local', () => deps.readUsage('local'), null),
    safe('usage:all', () => deps.readUsage('all'), null),
    safe('remote', async () => (await deps.readRemoteSubscriptions?.()) ?? [], [] as MenubarSubscriptionInput[]),
  ]);

  const modelNames = modelDisplayNames(providers);
  const sources: MenubarSourceInput[] = [];
  if (balance) sources.push(balanceSource(balance));
  const subscriptionReads = providers.map(async (provider): Promise<MenubarSourceInput | null> => {
    if (!provider.connected || provider.suspended || provider.removed) return null;
    const kind = providerWeeklyQuotaSource(provider);
    // A Codex account waiting to be reconnected stays in the list without numbers instead
    // of falling into the hidden pay-as-you-go group.
    if (!kind && needsCodexReconnect(provider)) return codexSource(provider, null, deps.nowMs);
    if (kind === 'codex') {
      const [payload, resets] = await Promise.all([
        safe(`codex:${provider.id}`, () => deps.readCodex(provider.id), null),
        safe(`codex-resets:${provider.id}`, async () => (await deps.readCodexResets?.(provider.id)) ?? null, null),
      ]);
      return { ...codexSource(provider, payload, deps.nowMs), resetCredits: resets };
    }
    if (kind === 'claude') {
      const snapshot = await safe(`claude:${provider.id}`, () => deps.readClaude(provider.id), null);
      return claudeSource(provider, snapshot, deps.nowMs);
    }
    if (kind === 'kimi') {
      const result = await safe(`kimi:${provider.id}`, async () => await deps.readKimi?.(provider.id) ?? null, null);
      return kimiSource(provider, result, deps.nowMs);
    }
    if (kind === 'xai') {
      const snapshot = await safe(`xai:${provider.id}`, () => deps.readXai(provider.id), null);
      return xaiSource(provider, snapshot, deps.nowMs);
    }
    return paygSource(provider);
  });
  for (const source of await Promise.all(subscriptionReads)) {
    if (source) sources.push(source);
  }
  sources.push(...distinctRemoteSubscriptions(sources, remote));

  const today = (allUsage ?? localUsage)?.todayKey ?? localDayKey(deps.nowMs);
  const days = dayKeysEndingAt(today, MENUBAR_USAGE_DAYS);
  const usage: MenubarUsageInput = {
    days,
    scopes: {
      local: usageScope(localUsage, days, [{ name: deps.selfDeviceName, isSelf: true, syncedAtMs: null }], modelNames),
      all: usageScope(allUsage ?? localUsage, days, devicesOf(allUsage, deps.selfDeviceName), modelNames),
    },
  };

  const tasks = await collectTasks(deps, localUsage, today, safe);
  const consuming = consumingSourceIds(tasks, providers);
  for (const source of sources) {
    if (consuming.has(source.id)) source.consuming = true;
  }

  let updatedAtMs: number | null = null;
  for (const source of sources) {
    const at = source.kind === 'subscription' ? source.updatedAtMs : source.kind === 'balance' ? source.observedAtMs : null;
    if (at !== null && (updatedAtMs === null || at > updatedAtMs)) updatedAtMs = at;
  }

  return { sources, tasks, usage, updatedAtMs };
}

/** Nothing read: the inputs behind the sign-in gate. */
export function emptyMenubarInputs(nowMs: number, selfDeviceName: string): MenubarCollected {
  const days = dayKeysEndingAt(localDayKey(nowMs), MENUBAR_USAGE_DAYS);
  const self = [{ name: selfDeviceName, isSelf: true, syncedAtMs: null }];
  return {
    sources: [],
    tasks: [],
    usage: { days, scopes: { local: emptyScope(days, self), all: emptyScope(days, self) } },
    updatedAtMs: null,
  };
}

// ── Sources ──────────────────────────────────────────────────────────────────

function balanceSource(balance: MenubarBalanceReading): MenubarBalanceInput {
  return {
    kind: 'balance',
    id: MENUBAR_BALANCE_SOURCE_ID,
    logoSvg: MENUBAR_CINDY_LOGO,
    available: balance.available,
    fullAmount: balance.fullAmount,
    burnPerDay: balance.burnPerDay,
    observedAtMs: balance.observedAtMs,
    currency: balance.currency,
    quota: balance.quota,
    pools: balance.pools ?? null,
    promoExpiry: balance.promoExpiry ?? null,
  };
}

// ── Accounts on other computers ──────────────────────────────────────────────

/** A reset this close (and usage this close) means two readings describe the same window. */
const SAME_RESET_TOLERANCE_MS = 2 * 60_000;
const SAME_USAGE_TOLERANCE = 3;

/** Key kind before the value: "codex:id", "claude:fp", "claude:identity". */
function keyKind(key: string): string {
  return key.split(':', 2).join(':');
}

function sameWindows(a: MenubarSubscriptionInput, b: MenubarSubscriptionInput): boolean {
  const limits = (source: MenubarSubscriptionInput) => source.windows.filter((window) => window.kind !== 'scoped');
  const left = limits(a);
  const right = limits(b);
  if (left.length === 0 || left.length !== right.length) return false;
  return left.every((window) =>
    right.some(
      (other) =>
        other.kind === window.kind &&
        window.resetsAtMs !== null &&
        other.resetsAtMs !== null &&
        Math.abs(other.resetsAtMs - window.resetsAtMs) <= SAME_RESET_TOLERANCE_MS &&
        Math.abs(other.usedPercent - window.usedPercent) <= SAME_USAGE_TOLERANCE,
    ),
  );
}

/**
 * Whether two readings are one account. The same kind of key with different values rules it out
 * (a ChatGPT workspace id can be shared by two people, their emails cannot); otherwise a shared
 * key decides it; with nothing to compare, identical reset times do, since the service sets a
 * window's reset per account.
 */
export function sameSubscriptionAccount(a: MenubarSubscriptionInput, b: MenubarSubscriptionInput): boolean {
  if (a.family !== b.family) return false;
  const left = a.accountKeys ?? [];
  const right = b.accountKeys ?? [];
  const valuesByKind = new Map<string, Set<string>>();
  for (const key of right) {
    const kind = keyKind(key);
    valuesByKind.set(kind, (valuesByKind.get(kind) ?? new Set()).add(key));
  }
  if (left.some((key) => valuesByKind.has(keyKind(key)) && !valuesByKind.get(keyKind(key))!.has(key))) return false;
  if (left.some((key) => right.includes(key))) return true;
  return sameWindows(a, b);
}

/**
 * Accounts on other computers that are not already listed. The same account signed in on this
 * computer and on others is one source: this computer's reading wins, then the freshest remote
 * one. Remote accounts without a reading add nothing and are left out.
 */
export function distinctRemoteSubscriptions(
  listed: readonly MenubarSourceInput[],
  remote: readonly MenubarSubscriptionInput[],
): MenubarSubscriptionInput[] {
  const kept: MenubarSubscriptionInput[] = listed.filter(
    (source): source is MenubarSubscriptionInput => source.kind === 'subscription',
  );
  const added: MenubarSubscriptionInput[] = [];
  const ordered = [...remote]
    .filter((source) => source.windows.length > 0)
    .sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0));
  for (const source of ordered) {
    if (kept.some((other) => sameSubscriptionAccount(source, other))) continue;
    kept.push(source);
    added.push(source);
  }
  return added;
}

function identityKeys(family: string, provider: ProviderView, ...ids: [string, unknown][]): string[] {
  const keys: string[] = [];
  for (const [kind, value] of ids) {
    if (typeof value === 'string' && value.trim()) keys.push(`${family}:${kind}:${value.trim()}`);
  }
  const identity = accountIdentity(provider);
  if (identity) keys.push(`${family}:identity:${identity.toLowerCase()}`);
  return keys;
}

function accountIdentity(provider: ProviderView): string | null {
  const identity = provider.openAiAccount?.identity ?? provider.subscriptionAccount?.identity ?? null;
  return identity && identity.trim() ? identity.trim() : null;
}

/** "pro" → "Pro", "max_20x" → "Max 20x"; product names stay as the service writes them. */
export function planLabel(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  return raw
    .trim()
    .split(/[_\s-]+/)
    .map((word) => (/^[a-z]/.test(word) ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** A window whose reset already passed has unknown usage until the next read. */
function liveResetMs(resetsAtSeconds: number | null | undefined, nowMs: number): number | null | undefined {
  if (typeof resetsAtSeconds !== 'number' || !Number.isFinite(resetsAtSeconds) || resetsAtSeconds <= 0) return null;
  const ms = resetsAtSeconds * 1000;
  return ms <= nowMs ? undefined : ms;
}

function windowFromCodex(window: RateLimitWindow | null | undefined, nowMs: number): MenubarWindowInput | null {
  if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return null;
  const resetsAtMs = liveResetMs(window.resetsAt, nowMs);
  if (resetsAtMs === undefined) return null;
  const minutes = typeof window.windowMinutes === 'number' && window.windowMinutes > 0 ? window.windowMinutes : WEEK_MINUTES;
  return {
    kind: minutes >= WEEK_MINUTES ? 'week' : 'session',
    usedPercent: clampPercent(window.usedPercent),
    resetsAtMs,
    windowMinutes: minutes,
  };
}

export function codexSource(
  provider: ProviderView,
  payload: CodexAccountUsagePayload | RateLimitSnapshot | null,
  nowMs: number,
): MenubarSubscriptionInput {
  const full = payload as CodexAccountUsagePayload | null;
  const appBuckets =
    full?.appServerBuckets && Object.keys(full.appServerBuckets).length > 0
      ? full.appServerBuckets
      : full && (full.primary || full.secondary) && full.source !== 'openai-web'
        ? { [full.limitId ?? 'codex']: full }
        : null;
  // Only the account's generic bucket describes the account; model promotions never stand in.
  const bucket = matchCodexBucketForModel(appBuckets, undefined, nowMs) ?? full?.webSnapshot ?? null;
  const windows = [bucket?.primary, bucket?.secondary]
    .map((window) => windowFromCodex(window, nowMs))
    .filter((window): window is MenubarWindowInput => window !== null)
    .sort((a, b) => a.windowMinutes - b.windowMinutes);
  const credits = bucket?.credits ?? full?.credits ?? null;
  const balance = credits?.balance != null ? Number(credits.balance) : NaN;
  const creditAmount = !credits || credits.unlimited
    ? null
    : !credits.hasCredits
      ? 0
      : Number.isFinite(balance) ? balance : null;
  return {
    kind: 'subscription',
    id: provider.id,
    providerId: provider.id,
    family: 'codex',
    logoSvg: familyLogo('codex'),
    brand: 'Codex',
    account: accountIdentity(provider),
    plan: planLabel(bucket?.planType ?? full?.planType),
    windows,
    credits: creditAmount,
    creditsUnlimited: credits?.unlimited === true,
    prepaidUsd: null,
    updatedAtMs: bucket?.updatedAt ?? full?.updatedAt ?? null,
    accountKeys: identityKeys('codex', provider, ['id', (full as { accountId?: unknown } | null)?.accountId]),
  };
}

export function claudeSource(
  provider: ProviderView,
  snapshot: ClaudeSubscriptionUsageSnapshot | null,
  nowMs: number,
): MenubarSubscriptionInput {
  const windows: MenubarWindowInput[] = [];
  const add = (kind: MenubarWindowInput['kind'], minutes: number, utilization: unknown, resetsAt: unknown, label?: string) => {
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return;
    const resetsAtMs = liveResetMs(resetsAt as number | null | undefined, nowMs);
    if (resetsAtMs === undefined) return;
    windows.push({ kind, label: label ?? null, usedPercent: clampPercent(utilization), resetsAtMs, windowMinutes: minutes });
  };
  add('session', FIVE_HOUR_MINUTES, snapshot?.fiveHour?.utilization, snapshot?.fiveHour?.resetsAt);
  add('week', WEEK_MINUTES, snapshot?.sevenDay?.utilization, snapshot?.sevenDay?.resetsAt);
  for (const scoped of snapshot?.scoped ?? []) {
    add('scoped', WEEK_MINUTES, scoped.utilization, scoped.resetsAt, scoped.modelDisplayName);
  }
  return {
    kind: 'subscription',
    id: provider.id,
    providerId: provider.id,
    family: 'claude',
    logoSvg: familyLogo('claude'),
    brand: 'Claude',
    account: provider.id === 'anthropic' ? null : accountIdentity(provider),
    plan: planLabel(snapshot?.subscriptionType),
    windows,
    credits: null,
    creditsUnlimited: false,
    prepaidUsd: null,
    updatedAtMs: snapshot?.updatedAt ?? null,
    accountKeys: identityKeys('claude', provider, ['fp', snapshot?.accountFingerprint]),
  };
}

export function xaiSource(
  provider: ProviderView,
  snapshot: XaiSubscriptionUsageSnapshot | null,
  nowMs: number,
): MenubarSubscriptionInput {
  const current = snapshot && isXaiWeeklyUsageCurrent(snapshot, nowMs) ? snapshot : null;
  const windows: MenubarWindowInput[] = [];
  if (current && typeof current.creditUsagePercent === 'number') {
    const resetsAtMs = liveResetMs(current.resetsAt, nowMs);
    if (resetsAtMs !== undefined) {
      windows.push({ kind: 'week', usedPercent: clampPercent(current.creditUsagePercent), resetsAtMs, windowMinutes: WEEK_MINUTES });
    }
  }
  const prepaid = snapshot?.prepaidBalance;
  return {
    kind: 'subscription',
    id: provider.id,
    providerId: provider.id,
    family: 'grok',
    logoSvg: familyLogo('grok'),
    brand: 'Grok',
    account: provider.id === 'xai' ? null : accountIdentity(provider),
    plan: snapshot?.planLabel?.trim() || null,
    windows,
    credits: null,
    creditsUnlimited: false,
    prepaidUsd: typeof prepaid === 'number' && Number.isFinite(prepaid) ? prepaid : null,
    updatedAtMs: snapshot?.updatedAt ?? null,
    accountKeys: identityKeys('xai', provider, ['fp', snapshot?.accountFingerprint]),
  };
}

/**
 * Connections whose remaining amount Cindy cannot read. Local runtimes (auth "none") and the
 * Cindy gateway (shown as the balance) are not billed this way and stay out.
 */
function needsCodexReconnect(provider: ProviderView): boolean {
  return (
    provider.openAiAccount?.reconnectRequired === true &&
    provider.auth.method === 'oauth' &&
    (provider.id === 'openai' || provider.auth.native === 'codex')
  );
}

export function paygSource(provider: ProviderView): MenubarPaygInput | null {
  if (provider.auth.method === 'none' || provider.auth.method === 'managed') return null;
  if (provider.access?.kind === 'managed' || provider.id === 'xd') return null;
  return {
    kind: 'payg',
    id: provider.id,
    providerId: provider.id,
    logoSvg: providerLogo(provider.id, provider.name, provider.routing as never),
    name: provider.name,
    billing: provider.access?.kind === 'subscription' ? 'subscription' : 'api',
  };
}

/**
 * Sources a running task on this computer is drawing on: the subscription or provider it
 * sends to, or the Cindy balance for Cindy-managed providers (the ones `paygSource` hides
 * because they bill the balance). A session without an explicit provider runs on the
 * implicit default route; it is resolved the way the running route is (`actualSourceIdForModel`),
 * so that tube ripples too.
 */
export function consumingSourceIds(tasks: readonly MenubarTaskInput[], providers: readonly ProviderView[]): Set<string> {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task.running) continue;
    const explicit = task.providerId?.trim() || null;
    let resolved: string | null = null;
    if (task.routeModel) {
      try {
        resolved = actualSourceIdForModel(
          providers as ProviderView[],
          explicit,
          task.routeModel,
          dbToMakerAgentKind(task.routeAgentKind),
        );
      } catch {
        // A provider view missing its runtime map only costs the ripple, never the whole read.
        resolved = null;
      }
    }
    // An explicit provider the catalog no longer offers this model on is still what the
    // session sends to; keep marking it.
    const sourceId = resolved ?? explicit;
    if (!sourceId) continue;
    const provider = providers.find((candidate) => candidate.id === sourceId);
    if (!provider) continue;
    const managed = provider.auth.method === 'managed' || provider.access?.kind === 'managed' || provider.id === 'xd';
    ids.add(managed ? MENUBAR_BALANCE_SOURCE_ID : provider.id);
  }
  return ids;
}

// ── Usage ────────────────────────────────────────────────────────────────────

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function localDayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `count` local calendar days ending at `todayKey`, oldest first. */
export function dayKeysEndingAt(todayKey: string, count: number): string[] {
  const [year, month, day] = todayKey.split('-').map(Number);
  const keys: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(year, month - 1, day - offset, 12);
    keys.push(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`);
  }
  return keys;
}

function harnessOf(kind: string | null | undefined): MenubarHarness {
  return HARNESSES.includes(kind as MenubarHarness) ? (kind as MenubarHarness) : 'claude-code';
}

function emptyScope(days: readonly string[], devices: MenubarUsageScopeInput['devices']): MenubarUsageScopeInput {
  return {
    daily: days.map(() => ({ money: [0, 0, 0], paid: 0, tokens: [0, 0, 0] })),
    models: { '7': [], '30': [], '90': [] },
    devices,
  };
}

/** Usage rows store wire ids; one model reached through different routes shares a key. */
export function usageModelKey(id: string): string {
  return id.trim().toLowerCase()
    .replace(/\[[^\]]*\]\s*$/, '') // SDK route suffix such as [1m]
    .replace(/-\d{6,8}$/, '') // trailing release date
    .replace(/^.*\//, ''); // provider namespace: anthropic/, xai/, codex/, openai-codex/ …
}

/** Catalog display names by usage key, so usage reads "GPT-6 Astra" rather than a wire id. */
export function modelDisplayNames(providers: readonly ProviderView[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const provider of providers) {
    for (const models of Object.values(provider.models ?? {})) {
      for (const model of models ?? []) {
        const key = usageModelKey(model.id);
        const name = model.name?.trim();
        // Providers may brand the same model ("Codex GPT-6.1 Sol"); the plainest name wins.
        const current = names.get(key);
        if (name && usageModelKey(name) !== key && (!current || name.length < current.length)) names.set(key, name);
      }
    }
  }
  return names;
}

export function usageScope(
  payload: UsageHistoryPayload | null,
  days: readonly string[],
  devices: MenubarUsageScopeInput['devices'],
  modelNames: ReadonlyMap<string, string> = new Map(),
): MenubarUsageScopeInput {
  const label = (model: string) => modelNames.get(usageModelKey(model)) ?? formatModelShort(model);
  const scope = emptyScope(days, devices);
  if (!payload) return scope;
  const indexOfDay = new Map(days.map((day, index) => [day, index]));
  const windows: Array<keyof MenubarUsageScopeData['models']> = ['7', '30', '90'];
  const modelRows: Record<string, MenubarModelUsage[]> = { '7': [], '30': [], '90': [] };
  for (const row of payload.modelDaily) {
    const index = indexOfDay.get(row.day);
    if (index === undefined) continue;
    const harness = harnessOf(row.agentKind);
    const slot = HARNESSES.indexOf(harness);
    const money = finite(row.money?.amount);
    const daily = scope.daily[index];
    daily.money[slot] += money;
    daily.tokens[slot] += finite(row.tokens);
    daily.paid += finite(row.apiMoney?.amount);
    const age = days.length - 1 - index;
    for (const window of windows) {
      if (age < Number(window)) {
        modelRows[window].push({ name: label(row.model), harness, money, tokens: finite(row.tokens) });
      }
    }
  }
  for (const window of windows) scope.models[window] = topModels(modelRows[window]);
  scope.modelSeries = modelSeries(payload, indexOfDay, days.length, label);
  return scope;
}

const SERIES_MODELS = 5;
const SERIES_DAYS = 30;

/** Per-model daily value and tokens: the top models by tokens over the last 30 days, the rest summed last. */
function modelSeries(
  payload: UsageHistoryPayload,
  indexOfDay: Map<string, number>,
  dayCount: number,
  label: (model: string) => string,
): MenubarModelSeries {
  type Entry = { harness: MenubarHarness; money: number[]; tokens: number[]; recent: number };
  const byModel = new Map<string, Entry>();
  for (const row of payload.modelDaily) {
    const index = indexOfDay.get(row.day);
    if (index === undefined) continue;
    const name = label(row.model);
    const entry = byModel.get(name)
      ?? { harness: harnessOf(row.agentKind), money: new Array<number>(dayCount).fill(0), tokens: new Array<number>(dayCount).fill(0), recent: 0 };
    const tokens = finite(row.tokens);
    entry.money[index] += finite(row.money?.amount);
    entry.tokens[index] += tokens;
    if (dayCount - 1 - index < SERIES_DAYS) entry.recent += tokens;
    byModel.set(name, entry);
  }
  const ranked = [...byModel.entries()].filter(([, entry]) => entry.recent > 0).sort((a, b) => b[1].recent - a[1].recent);
  const top = ranked.slice(0, SERIES_MODELS).map(([, entry]) => entry);
  const rest = ranked.slice(SERIES_MODELS).map(([, entry]) => entry);
  const split = (pick: (entry: Entry) => number[]) => Array.from({ length: dayCount }, (_, day) => [
    ...top.map((entry) => pick(entry)[day]),
    rest.reduce((sum, entry) => sum + pick(entry)[day], 0),
  ]);
  return {
    models: ranked.slice(0, SERIES_MODELS).map(([name, entry]) => ({ name, harness: entry.harness })),
    daily: split((entry) => entry.money),
    tokens: split((entry) => entry.tokens),
  };
}

function devicesOf(payload: UsageHistoryPayload | null, selfName: string): MenubarUsageScopeInput['devices'] {
  const devices = payload?.devices ?? [];
  if (devices.length === 0) return [{ name: selfName, isSelf: true, syncedAtMs: null }];
  return devices.map((device) => ({
    name: device.isSelf ? selfName || device.name : device.name,
    isSelf: device.isSelf,
    syncedAtMs: device.syncedAt,
  }));
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// ── Tasks ────────────────────────────────────────────────────────────────────

type Safe = <T>(scope: string, read: () => Promise<T>, fallback: T) => Promise<T>;

/**
 * Today's tasks on this computer: everything with usage today plus anything running now.
 * Value is the task's tokens priced at today's average rate for its model, the same
 * subscription-equivalent basis as the usage chart.
 */
async function collectTasks(
  deps: MenubarCollectDeps,
  usage: UsageHistoryPayload | null,
  today: string,
  safe: Safe,
): Promise<MenubarTaskInput[]> {
  const tokensBySession = new Map<string, number>();
  for (const row of usage?.taskDaily ?? []) {
    if (row.day !== today) continue;
    const [device, ...rest] = row.taskKey.split(':');
    if (device !== 'local') continue;
    const sessionId = rest.join(':');
    tokensBySession.set(sessionId, (tokensBySession.get(sessionId) ?? 0) + finite(row.tokens));
  }
  const meta = new Map((usage?.tasks ?? []).filter((task) => task.deviceId === 'local').map((task) => [task.sessionId, task]));
  const rates = new Map<string, { money: number; tokens: number; harness: MenubarHarness }>();
  for (const row of usage?.modelDaily ?? []) {
    if (row.day !== today) continue;
    const rate = rates.get(row.model) ?? { money: 0, tokens: 0, harness: harnessOf(row.agentKind) };
    rate.money += finite(row.money?.amount);
    rate.tokens += finite(row.tokens);
    rates.set(row.model, rate);
  }

  const activities = new Map(deps.activities().map((activity) => [activity.sessionId, activity]));
  const ids = new Set(tokensBySession.keys());
  for (const [sessionId, activity] of activities) {
    if (isSessionActivityRunning(activity)) ids.add(sessionId);
  }
  const ranked = [...ids]
    .filter((sessionId) => CINDY_MAKE_ENABLED || !isCindyMakeSource(meta.get(sessionId)?.source))
    .sort((a, b) => {
      const runningA = activities.get(a) && isSessionActivityRunning(activities.get(a)!) ? 1 : 0;
      const runningB = activities.get(b) && isSessionActivityRunning(activities.get(b)!) ? 1 : 0;
      return runningB - runningA || (tokensBySession.get(b) ?? 0) - (tokensBySession.get(a) ?? 0);
    });

  const rows: MenubarTaskInput[] = [];
  for (let offset = 0; offset < ranked.length && rows.length < MAX_TASK_ROWS; offset += MAX_TASK_ROWS) {
    const batch = await Promise.all(
      ranked.slice(offset, offset + MAX_TASK_ROWS).map(async (sessionId): Promise<MenubarTaskInput | null> => {
        const row = await safe(`session:${sessionId}`, () => deps.sessionRow(sessionId), null);
        if (!CINDY_MAKE_ENABLED && isCindyMakeSource(row?.source)) return null;
        const info = meta.get(sessionId);
        const activity = activities.get(sessionId);
        const model = info?.model || row?.model || '';
        const title = row?.title?.trim() || info?.title?.trim() || '';
        if (!title && !model) return null;
        const tokens = tokensBySession.get(sessionId) ?? 0;
        const rate = rates.get(model);
        const running = activity ? isSessionActivityRunning(activity) : false;
        return {
          sessionId,
          title,
          harness: harnessOf(row?.agentKind ?? rate?.harness),
          model: model ? formatModelShort(model) : '',
          tokensToday: tokens,
          valueToday: rate && rate.tokens > 0 ? (tokens * rate.money) / rate.tokens : 0,
          contextPercent: info && info.contextWindow > 0 ? clampPercent((info.contextTokens / info.contextWindow) * 100) : null,
          running,
          startedAtMs: running ? (activity?.startedAtMs ?? null) : null,
          lastActiveAtMs: activity?.lastActivityAtMs ?? info?.lastActiveAt ?? deps.nowMs,
          providerId: row?.providerId ?? null,
          routeModel: model || null,
          routeAgentKind: row?.agentKind ?? null,
        };
      }),
    );
    rows.push(...batch.filter((row): row is MenubarTaskInput => row !== null));
  }
  return rows.slice(0, MAX_TASK_ROWS);
}

export function kimiSource(provider: ProviderView, result: ProviderAccountUsageResult | null, nowMs: number): MenubarSubscriptionInput {
  const snapshot = result?.status === 'ready' && !result.stale && result.snapshot.kind === 'kimi-coding-quota' ? result.snapshot : null;
  return {
    kind: 'subscription', id: provider.id, providerId: provider.id, family: 'kimi',
    logoSvg: providerLogo(provider.id, provider.name, provider.routing), brand: provider.name || 'Kimi Code', account: null, plan: null,
    windows: snapshot?.windows.filter(w => w.resetsAt === null || w.resetsAt > nowMs).map(w => ({
      kind: w.id === 'limit_5h' ? 'session' : w.id === 'limit_7d' ? 'week' : 'period',
      label: w.id, usedPercent: w.usedPercent, resetsAtMs: w.resetsAt,
      windowMinutes: kimiUsageWindowMinutes(w.id) ?? 0,
    })) ?? [],
    credits: null, creditsUnlimited: false, prepaidUsd: null, updatedAtMs: snapshot?.fetchedAt ?? null,
  };
}
