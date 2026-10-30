import { readKimiCodingAccountUsage } from '../maker-host/provider-account-usage.js';
/**
 * macOS menu bar quota item: collects usage, builds the view and drives the native helper.
 *
 * Rebuilds are debounced and coalesced. They run on usage broadcasts, running-task
 * transitions, settings and locale changes and a slow timer. Opening the panel or pressing
 * refresh also asks every subscription reader to refresh, so values catch up while the
 * panel is on screen. Everything here reads caches Cindy already keeps; the only extra
 * network call is the Cindy balance, which is fetched at most once a minute.
 */

import { app, Notification } from 'electron';
import os from 'node:os';

import { isSessionActivityRunning } from '@cindy/maker-shared/session-activity';

import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';

import type { ModelAccessCreditUsage } from '../../shared/modelAccess.js';
import {
  isMenubarSupportedPlatform,
  type MenubarGate,
  type MenubarHelperMessage,
  type MenubarSettings,
  type MenubarSettingsPatch,
  type MenubarState,
  type MenubarUsageScope,
  type MenubarView,
} from '../../shared/menubarQuota.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { getAgentIslandService } from '../agent-island/service.js';
import { getAppCapabilities, requireAppCapability } from '../appCapabilities.js';
import { getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import * as authManager from '../authManager.js';
import { projectModelAccessBalance, projectModelAccessCreditUsage } from '../billing/projection.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import {
  focusMainWindow,
  openMainWindowBillingTopUp,
  openMainWindowSession,
  openMainWindowRemoteControlSettings,
  openMainWindowVoiceSettings,
} from '../deepLink.js';
import { remoteBackgroundInvoke } from '../device-link/index.js';
import { getActiveControllers } from '../device-link/dispatch.js';
import { handleListDevices, defaultDeps as deviceDirectoryDeps } from '../device-link/ipc.js';
import { deviceName } from '../device-link/deviceName.js';
import { getResolvedMainLocale, mainStringKeysUnder, rawMainString } from '../i18n.js';
import { getSessionRowSnapshot } from '../localDb/ipc/sessions.js';
import { createLogger } from '../logger.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { getSessionProvider, hasSessionProvider } from '../maker-host/session-provider-store.js';
import { inspectAppDefaultModel } from '../maker-ipc/appDefaultModelControl.js';
import { applyNewMakerDraftRoute } from '../maker-ipc/register.js';
import {
  readClaudeSubscriptionUsageSnapshotForDeviceLink,
  readCodexRateLimitsForHost,
  readXaiSubscriptionUsageSnapshotForDeviceLink,
  triggerClaudeSubscriptionUsageRefresh,
  triggerCodexAccountUsageRefresh,
  triggerXaiSubscriptionUsageRefresh,
} from '../maker-ipc/usage.js';
import { getDesktopNotificationsEnabled } from '../notificationService.js';
import { serverApiFetch } from '../serverApiClient.js';
import { observeClaudeAccountUsage, readClaudeAccountUsageRevision, readClaudeAccountUsageSnapshot, triggerClaudeAccountUsageRefresh } from '../usage/claudeAccountUsage.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';
import { readUsageHistory, type UsageHistoryPayload } from '../usage/usageHistory.js';
import { observeUsageChanges, readCodexAccountUsageSnapshot } from '../usageBroadcaster.js';
import { providerWeeklyQuotaSource } from '../../shared/providerQuotaSource.js';
import { CreditSampleStore, estimateDailyBurn, largestCreditSample } from './creditSamples.js';
import {
  collectMenubarInputs,
  emptyMenubarInputs,
  MENUBAR_USAGE_DAYS,
  type MenubarBalanceReading,
  type MenubarCollected,
} from './collect.js';
import { MacMenubarNativeHost } from './MacMenubarNativeHost.js';
import { MENUBAR_HARNESS_LOGOS } from './logos.js';
import { OwnedInFlight } from './ownedInFlight.js';
import { readRemoteSubscriptions } from './remoteSubscriptions.js';
import { readMenubarSettings, writeMenubarSettings } from './settingsStore.js';
import {
  buildMenubarView,
  isLowOnEverything,
  type MenubarBuildInput,
  type MenubarResetCredits,
  type MenubarSubscriptionInput,
} from './snapshot.js';
import { buildMenubarUiStrings, createMenubarTranslate } from './strings.js';
import { buildMenubarActivities } from './activity.js';

const log = createLogger('menubar');

const REBUILD_DEBOUNCE_MS = 400;
const PERIODIC_REBUILD_MS = 5 * 60_000;
/** A usage payload marked stale is being re-aggregated; look again shortly. */
const STALE_FOLLOW_UP_MS = 3_000;
const STALE_FOLLOW_UP_MAX = 5;
const BALANCE_FRESH_WHILE_OPEN_MS = 60_000;
const BALANCE_FRESH_WHILE_CLOSED_MS = 10 * 60_000;
const BALANCE_TIMEOUT_MS = 20_000;
/**
 * Usage history keeps a single cache slot, and the two device ranges evict each other, so
 * every read recomputes the history. Re-read on this cadence instead of on every token tick.
 */
const USAGE_FRESH_WHILE_OPEN_MS = 30_000;
const USAGE_FRESH_WHILE_CLOSED_MS = 5 * 60_000;
/**
 * Other computers are read over a background device link, and Codex reset credits through the
 * Codex account RPC. Both are slower and costlier than the local caches, so they keep their own
 * longer cadence; opening the panel shortens it.
 */
const REMOTE_FRESH_WHILE_OPEN_MS = 60_000;
const REMOTE_FRESH_WHILE_CLOSED_MS = 10 * 60_000;
const RESETS_FRESH_WHILE_OPEN_MS = 3 * 60_000;
const RESETS_FRESH_WHILE_CLOSED_MS = 30 * 60_000;

export interface MenubarServiceDeps {
  /** Opens a new task in the main window (the app menu's "New Task" command). */
  openNewTask(): void;
}

interface UsageCacheEntry {
  /** Data owner the history belongs to; a read that outlives an account switch is dropped. */
  ownerId: string | null;
  payload: UsageHistoryPayload;
  readAtMs: number;
}

interface BalanceCache {
  /** Account the reading belongs to; a different signed-in user invalidates it. */
  accountKey: string;
  reading: MenubarBalanceReading | null;
  fetchedAtMs: number;
}

interface TimedCache<T> {
  /** Data owner the reading belongs to; another owner invalidates it. */
  ownerId: string | null;
  value: T;
  readAtMs: number;
}

export class MenubarService {
  private readonly host: MacMenubarNativeHost;
  private readonly creditSamples = new CreditSampleStore();
  private settings: MenubarSettings;
  private started = false;
  private panelOpen = false;
  private lastView: MenubarView | null = null;
  /** Null until the first build, so launching while low does not notify. */
  private wasLow: boolean | null = null;
  private lowNotification: Notification | null = null;
  private balance: BalanceCache | null = null;
  private readonly balanceInFlight = new OwnedInFlight<MenubarBalanceReading | null>();
  private readonly usageCache = new Map<MenubarUsageScope, UsageCacheEntry>();
  private usageOwnerId: string | null = null;
  /** Serializes history reads so the two ranges never recompute at the same time. */
  private usageChain: Promise<unknown> = Promise.resolve();
  private remote: TimedCache<MenubarSubscriptionInput[]> | null = null;
  private readonly remoteInFlight = new OwnedInFlight<MenubarSubscriptionInput[]>();
  private readonly resets = new Map<string, TimedCache<MenubarResetCredits | null>>();

  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private building = false;
  private rebuildQueued = false;
  private forceNext = false;
  private staleFollowUps = 0;
  private disposers: (() => void)[] = [];

  constructor(private readonly deps: MenubarServiceDeps) {
    this.settings = readMenubarSettings();
    this.host = new MacMenubarNativeHost({ onMessage: (message) => this.handleHelperMessage(message) });
  }

  get state(): MenubarState {
    return { available: true, enabled: this.settings.enabled };
  }

  init(): void {
    if (this.settings.enabled) this.start();
  }

  setEnabled(enabled: boolean): MenubarState {
    this.settings = writeMenubarSettings({ enabled });
    if (enabled) this.start();
    else this.halt();
    return this.state;
  }

  refreshLocalization(): void {
    if (this.started) this.scheduleRebuild(0);
  }

  /** Remote activity updates the icon immediately, independently of usage collection. */
  refreshControlState(): void {
    if (!this.started || !this.lastView || this.lastView.gate) return;
    const control = this.controlState();
    if (
      this.lastView.remotelyControlled === control.remotelyControlled
      && JSON.stringify(this.lastView.remoteControllerNames) === JSON.stringify(control.remoteControllerNames)
    ) return;
    this.lastView = { ...this.lastView, ...control };
    this.host.publish(this.lastView);
  }

  private controlState(gate?: MenubarGate): Pick<MenubarView, 'remotelyControlled' | 'remoteControllerNames'> {
    const controllers = gate ? [] : getActiveControllers();
    return {
      remotelyControlled: controllers.length > 0,
      remoteControllerNames: controllers.map(controller => controller.name),
    };
  }

  /** Opens the panel under the status item. */
  openPanel(): void {
    if (!this.started) return;
    this.host.open();
  }

  stop(): void {
    this.halt();
    this.host.stop();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.wasLow = null;
    this.usageOwnerId = getActiveAppSession().dataOwnerId;
    this.host.resetFailure();
    this.host.prepare();
    this.disposers.push(
      observeUsageChanges(() => this.scheduleRebuild()),
      observeClaudeAccountUsage(() => {
        if (!this.balanceAccountKey()?.startsWith('quota:')) return;
        this.balance = null;
        this.scheduleRebuild(0);
      }),
      authManager.onAuthStateChange((state) => {
        if (!state.isAuthenticated) this.balance = null;
        // Usage history belongs to the data owner; token refreshes keep the cache.
        const ownerId = getActiveAppSession().dataOwnerId;
        if (ownerId !== this.usageOwnerId) {
          this.usageOwnerId = ownerId;
          this.usageCache.clear();
          this.remote = null;
          this.resets.clear();
        }
        this.scheduleRebuild();
      }),
    );
    const island = getAgentIslandService();
    if (island) {
      this.disposers.push(
        island.subscribeTaskOverview(() => this.publishTaskOverview()),
        island.subscribeSessionActivity(({ previous, current }) => {
          const wasRunning = previous ? isSessionActivityRunning(previous) : false;
          const isRunning = current ? isSessionActivityRunning(current) : false;
          if (wasRunning !== isRunning) this.scheduleRebuild();
        }),
      );
    }
    this.periodicTimer = setInterval(() => this.scheduleRebuild(), PERIODIC_REBUILD_MS);
    this.scheduleRebuild(0);
  }

  private halt(): void {
    if (!this.started) return;
    this.started = false;
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // Listener already gone.
      }
    }
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.periodicTimer = null;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    this.panelOpen = false;
    this.lastView = null;
    this.usageCache.clear();
    this.remote = null;
    this.resets.clear();
    this.lowNotification?.close();
    this.lowNotification = null;
    this.host.suspend();
  }

  private scheduleRebuild(delayMs = REBUILD_DEBOUNCE_MS, force = false): void {
    if (!this.started) return;
    if (force) this.forceNext = true;
    if (this.building) {
      this.rebuildQueued = true;
      return;
    }
    if (this.rebuildTimer) {
      if (delayMs > 0) return;
      clearTimeout(this.rebuildTimer);
    }
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      void this.rebuild();
    }, delayMs);
  }

  private async rebuild(): Promise<void> {
    if (!this.started || this.building) return;
    this.building = true;
    const force = this.forceNext;
    this.forceNext = false;
    let stale = false;
    try {
      const nowMs = Date.now();
      // Until the user signs in or skips sign-in there is no data owner: read nothing and
      // show the prompt. A pending owner switch keeps the last view; its commit rebuilds.
      if (isAppSessionBoundaryPending()) {
        // Nothing to publish yet.
      } else if (!hasDataOwner()) {
        this.publish(emptyMenubarInputs(nowMs, deviceName()), nowMs, 'sign-in');
      } else {
        await this.collectAndPublish(nowMs, force, () => {
          stale = true;
        });
      }
    } catch (error) {
      log.warn('menu bar rebuild failed', { error: errorMessage(error) });
    } finally {
      this.building = false;
    }
    if (stale && this.staleFollowUps < STALE_FOLLOW_UP_MAX) {
      this.staleFollowUps += 1;
      this.scheduleRebuild(STALE_FOLLOW_UP_MS);
    } else if (!stale) {
      this.staleFollowUps = 0;
    }
    if (this.rebuildQueued) {
      this.rebuildQueued = false;
      this.scheduleRebuild();
    }
  }

  private async collectAndPublish(nowMs: number, force: boolean, markStale: () => void): Promise<void> {
    const generation = getActiveAppSession().generation;
    const quotaRevision = readClaudeAccountUsageRevision();
    const collected = await collectMenubarInputs({
      nowMs,
      listProviders: () => getDesktopProviderService().listProviders({ allowSideEffects: false }),
      readKimi: (providerId) => readKimiCodingAccountUsage({ providerId, forceRefresh: force }),
      readCodex: (providerId) => readCodexAccountUsageSnapshot(providerId),
      readClaude: (providerId) => readClaudeSubscriptionUsageSnapshotForDeviceLink(providerId),
      readXai: (providerId) => readXaiSubscriptionUsageSnapshotForDeviceLink(providerId),
      readCodexResets: (providerId) => this.readCodexResets(providerId, force, nowMs),
      readRemoteSubscriptions: () => this.readRemote(force, nowMs),
      readBalance: () => this.readBalance(force, nowMs),
      readUsage: async (scope: MenubarUsageScope) => {
        const payload = await this.readUsage(scope, force, nowMs);
        if (payload.stale) markStale();
        return payload;
      },
      activities: () => getAgentIslandService()?.getSessionActivitySnapshots() ?? [],
      sessionRow: async (sessionId) => {
        const row = await getSessionRowSnapshot(sessionId);
        return row
          ? {
              title: row.title,
              model: row.model ?? null,
              agentKind: row.agentKind ?? null,
              source: row.source ?? null,
              // The in-memory route is newer than the row (a provider switched this turn).
              providerId: hasSessionProvider(sessionId) ? getSessionProvider(sessionId) : (row.providerId ?? null),
            }
          : null;
      },
      selfDeviceName: deviceName(),
      onError: (scope, error) => log.warn('menu bar source failed', { scope, error: errorMessage(error) }),
    });
    // An owner switch that started during the reads makes them the old owner's data.
    const after = getActiveAppSession();
    if (!this.started || isAppSessionBoundaryPending() || after.generation !== generation) return;
    if (readClaudeAccountUsageRevision() !== quotaRevision) {
      this.scheduleRebuild(0);
      return;
    }
    this.publish(collected, nowMs);
  }

  /** Cached usage history; a stale payload is re-read on the next build. */
  private async readUsage(scope: MenubarUsageScope, force: boolean, nowMs: number): Promise<UsageHistoryPayload> {
    const ownerId = getActiveAppSession().dataOwnerId;
    const entry = this.usageCache.get(scope);
    const cached = entry?.ownerId === ownerId ? entry : null;
    const maxAge = this.panelOpen ? USAGE_FRESH_WHILE_OPEN_MS : USAGE_FRESH_WHILE_CLOSED_MS;
    if (cached && !force && !cached.payload.stale && nowMs - cached.readAtMs < maxAge) return cached.payload;
    const read = this.usageChain.then(() =>
      readUsageHistory({
        days: MENUBAR_USAGE_DAYS,
        modelDays: MENUBAR_USAGE_DAYS,
        device: scope,
        includeTasks: scope === 'local',
        ...(force ? { forceRefresh: true } : {}),
      }),
    );
    this.usageChain = read.catch(() => undefined);
    const payload = await read;
    if (getActiveAppSession().dataOwnerId === ownerId) this.usageCache.set(scope, { ownerId, payload, readAtMs: Date.now() });
    return payload;
  }

  // ── Other computers and Codex resets ───────────────────────────────────────

  /** Subscription accounts on the user's other computers; deduplicated later against local ones. */
  private async readRemote(force: boolean, nowMs: number): Promise<MenubarSubscriptionInput[]> {
    // Same gate as the device-link IPC: no device directory or peer link without an account.
    if (!getAppCapabilities().canUseDeviceLink) {
      this.remote = null;
      return [];
    }
    const ownerId = getActiveAppSession().dataOwnerId;
    const cached = this.remote?.ownerId === ownerId ? this.remote : null;
    const maxAge = this.panelOpen ? REMOTE_FRESH_WHILE_OPEN_MS : REMOTE_FRESH_WHILE_CLOSED_MS;
    if (cached && !force && nowMs - cached.readAtMs < maxAge) return cached.value;
    // Joined only by callers of the same account; after a switch the new account reads its own.
    const value = await this.remoteInFlight.run(ownerId, () =>
      readRemoteSubscriptions({
        nowMs,
        listDevices: () => {
          requireAppCapability('canUseDeviceLink', 'Device Link requires a Cindy account.');
          return handleListDevices(deviceDirectoryDeps());
        },
        invoke: (deviceId, channel, args) => remoteBackgroundInvoke(deviceId, channel, args),
        onError: (scope, error) => log.info('menu bar remote source failed', { scope, error: errorMessage(error) }),
      }),
    );
    if (getActiveAppSession().dataOwnerId !== ownerId) return [];
    this.remote = { ownerId, value, readAtMs: Date.now() };
    return value;
  }

  /** Codex reset credits for one account; a failed read keeps the last known count. */
  private async readCodexResets(providerId: string, force: boolean, nowMs: number): Promise<MenubarResetCredits | null> {
    const ownerId = getActiveAppSession().dataOwnerId;
    const entry = this.resets.get(providerId);
    const cached = entry?.ownerId === ownerId ? entry : null;
    const maxAge = this.panelOpen ? RESETS_FRESH_WHILE_OPEN_MS : RESETS_FRESH_WHILE_CLOSED_MS;
    if (cached && !force && nowMs - cached.readAtMs < maxAge) return cached.value;
    try {
      const result = await readCodexRateLimitsForHost(providerId);
      const value = resetCreditsOf(result, nowMs);
      if (getActiveAppSession().dataOwnerId !== ownerId) return null;
      this.resets.set(providerId, { ownerId, value, readAtMs: Date.now() });
      return value;
    } catch (error) {
      log.info('menu bar codex resets unavailable', { providerId, error: errorMessage(error) });
      // Do not retry on every rebuild; the next window of the cadence tries again.
      this.resets.set(providerId, { ownerId, value: cached?.value ?? null, readAtMs: Date.now() });
      return cached?.value ?? null;
    }
  }

  private publish(collected: MenubarCollected, nowMs: number, gate?: MenubarGate): void {
    const locale = getResolvedMainLocale();
    const raw = (key: string) => rawMainString(key, locale);
    const input: MenubarBuildInput = {
      nowMs,
      locale,
      moneySymbol: currentLedgerCurrency() === 'CNY' ? '¥' : '$',
      settings: this.settings,
      sources: collected.sources,
      tasks: collected.tasks,
      usage: collected.usage,
      updatedAtMs: collected.updatedAtMs,
      harnessLogos: MENUBAR_HARNESS_LOGOS,
      uiStrings: buildMenubarUiStrings(mainStringKeysUnder('menubar.ui'), raw, locale),
      t: createMenubarTranslate(locale, raw),
      ...(gate ? { gate } : {}),
    };
    const view = buildMenubarView(input);
    Object.assign(view, this.taskOverview(gate));
    Object.assign(view, this.controlState(gate));
    this.lastView = view;
    this.host.publish(view);
    if (gate) {
      // The first real build after signing in counts as a first build again.
      this.wasLow = null;
      return;
    }
    this.updateLowAlert(isLowOnEverything(input), input);
  }

  /** Unread changes must not wait for quota/history/network reads to finish. */
  private taskOverview(gate?: MenubarGate): Pick<MenubarView, 'activities' | 'attentionCount'> {
    const locale = getResolvedMainLocale();
    const activities = gate ? [] : buildMenubarActivities(
      getAgentIslandService()?.getTaskOverview() ?? [], this.settings.privacy,
      createMenubarTranslate(locale, key => rawMainString(key, locale)),
    );
    return { activities, attentionCount: activities.filter(row => row.attention).length };
  }

  private publishTaskOverview(): void {
    if (!this.started || !this.lastView || this.lastView.gate || isAppSessionBoundaryPending() || !hasDataOwner()) return;
    const overview = this.taskOverview();
    if (JSON.stringify(this.lastView.activities) === JSON.stringify(overview.activities)) return;
    this.lastView = { ...this.lastView, ...overview };
    this.host.publish(this.lastView);
  }

  // ── Low alert ──────────────────────────────────────────────────────────────

  /** Notifies once when everything usable drops to nearly empty; never on the first build. */
  private updateLowAlert(low: boolean, input: MenubarBuildInput): void {
    const previous = this.wasLow;
    this.wasLow = low;
    if (!low) {
      this.lowNotification?.close();
      this.lowNotification = null;
      return;
    }
    if (previous !== false || !this.settings.lowAlert || !getDesktopNotificationsEnabled()) return;
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: input.t('notify.lowTitle'),
      body: input.t('notify.lowBody'),
    });
    this.lowNotification = notification;
    const release = () => {
      if (this.lowNotification === notification) this.lowNotification = null;
    };
    notification.on('click', () => {
      release();
      this.openPanel();
    });
    notification.on('close', release);
    notification.on('failed', (_event, error) => {
      log.warn('menu bar low alert failed', { error: String(error) });
      release();
    });
    notification.show();
  }

  // ── Cindy balance ──────────────────────────────────────────────────────────

  /**
   * Personal accounts have a wallet; organization accounts and a hand-entered gateway key have a
   * period quota instead (what Settings shows as "本期剩余额度"). Null when there is neither.
   */
  private balanceAccountKey(): string | null {
    const auth = authManager.getAuthState();
    if (auth.mode === 'local') return auth.dataOwnerId ? `quota:local:${auth.dataOwnerId}:${auth.ownerGeneration}:${readClaudeAccountUsageRevision()}` : null;
    if (!getAppCapabilities().canUseCindyAccountServices) return null;
    const user = auth.user;
    if (!user) return null;
    if (user.membershipKind === 'org') return auth.dataOwnerId ? `quota:cloud:${auth.dataOwnerId}:${auth.ownerGeneration}:${readClaudeAccountUsageRevision()}` : null;
    if (user.membershipKind !== 'personal') return null;
    return `${user.id}:${CURRENT_CINDY_REGION}`;
  }

  private async readBalance(force: boolean, nowMs: number): Promise<MenubarBalanceReading | null> {
    const accountKey = this.balanceAccountKey();
    if (!accountKey) {
      this.balance = null;
      return null;
    }
    const cached = this.balance?.accountKey === accountKey ? this.balance : null;
    const maxAge = this.panelOpen ? BALANCE_FRESH_WHILE_OPEN_MS : BALANCE_FRESH_WHILE_CLOSED_MS;
    if (cached && !force && nowMs - cached.fetchedAtMs < maxAge) return cached.reading;
    // A read still out for the previous account cannot answer for this one.
    const read = this.balanceInFlight.run(accountKey, () =>
      accountKey.startsWith('quota:') ? this.fetchQuota(accountKey, force) : this.fetchBalance(accountKey),
    );
    try {
      const reading = await read;
      // A sign-out or account switch while the request was out drops the result.
      if (this.balanceAccountKey() !== accountKey) return null;
      this.balance = { accountKey, reading, fetchedAtMs: Date.now() };
      return reading;
    } catch (error) {
      if (this.balanceAccountKey() !== accountKey) return null;
      log.warn('menu bar balance read failed', { error: errorMessage(error) });
      // Keep showing the last known amount; its "updated" time tells the age.
      return cached?.reading ?? null;
    }
  }

  /** The gateway's period quota; the same reading Settings shows, refreshed through its throttle. */
  private async fetchQuota(accountKey: string, force: boolean): Promise<MenubarBalanceReading | null> {
    await triggerClaudeAccountUsageRefresh(force);
    // Samples go to the signed-in account's folder; a switch mid-read must not file them there.
    if (this.balanceAccountKey() !== accountKey) return null;
    const quota = readClaudeAccountUsageSnapshot();
    if (!quota || !(quota.maxBudget > 0)) return null;
    const available = Math.max(0, quota.maxBudget - quota.spend);
    const samples = this.creditSamples.record(`quota:${CURRENT_CINDY_REGION}:${quota.currency}`, available, quota.fetchedAt);
    const resetsAtMs = quota.budgetResetAt ? Date.parse(quota.budgetResetAt) : NaN;
    return {
      available,
      fullAmount: quota.maxBudget,
      burnPerDay: estimateDailyBurn(samples, quota.fetchedAt),
      observedAtMs: quota.fetchedAt,
      currency: quota.currency,
      quota: {
        resetsAtMs: Number.isFinite(resetsAtMs) ? resetsAtMs : null,
        todaySpend: Number.isFinite(quota.todaySpend) ? quota.todaySpend : null,
        dailyLimitEnabled: quota.dailyLimitEnabled,
      },
    };
  }

  private async fetchBalance(accountKey: string): Promise<MenubarBalanceReading | null> {
    const baseUrl = () => getClientEndpoint('modelAccessApiBaseUrl');
    const options = { timeoutMs: BALANCE_TIMEOUT_MS, redactErrorDetails: true, baseUrl };
    let available: number;
    let pools: number | null = null;
    let usage: ModelAccessCreditUsage | null = null;
    let observedAt: string;
    try {
      usage = projectModelAccessCreditUsage(
        await serverApiFetch<unknown>('/api/model-access/credit-usage', options),
      );
      available = Number(usage.available);
      observedAt = usage.observedAt;
      const totals = [usage.plan.total, usage.purchased.total, usage.promotional.total];
      if (totals.every((total) => total !== null)) {
        pools = totals.reduce((sum, total) => sum + Number(total), 0);
      }
    } catch (error) {
      log.info('credit usage unavailable, falling back to balance', { error: errorMessage(error) });
      const balance = projectModelAccessBalance(await serverApiFetch<unknown>('/api/model-access/balance', options));
      available = Number(balance.available);
      observedAt = balance.observedAt;
    }
    if (!Number.isFinite(available)) return null;
    // The request used the old account's token; its amount must not land in the new account's samples.
    if (this.balanceAccountKey() !== accountKey) return null;
    const observedAtMs = Date.parse(observedAt);
    const atMs = Number.isFinite(observedAtMs) ? observedAtMs : Date.now();
    const currency = CURRENT_CINDY_REGION === 'global' ? 'USD' : 'CNY';
    const samples = this.creditSamples.record(`${CURRENT_CINDY_REGION}:${currency}`, available, atMs);
    const largest = largestCreditSample(samples);
    const fullAmount = pools !== null && Number.isFinite(pools) && pools > 0 ? pools : largest;
    return {
      available,
      fullAmount: fullAmount !== null && fullAmount >= available ? fullAmount : available,
      burnPerDay: estimateDailyBurn(samples, atMs),
      observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : null,
      currency,
      quota: null,
      pools: usage ? walletPools(usage) : null,
      promoExpiry: usage ? nearestPromoExpiry(usage, atMs) : null,
    };
  }

  // ── Helper messages ────────────────────────────────────────────────────────

  private handleHelperMessage(message: MenubarHelperMessage): void {
    switch (message.type) {
      case 'ready':
      case 'error':
        return;
      case 'panel':
        this.panelOpen = message.open;
        if (message.open) this.refreshSources(false);
        return;
      case 'refresh':
        this.refreshSources(true);
        return;
      case 'open-app':
        this.showMainWindow();
        return;
      case 'open-session':
        if (this.lastView?.activities?.some(row => row.sessionId === message.sessionId)) {
          getAgentIslandService()?.openTaskOverviewSession(message.sessionId);
        } else {
          openMainWindowSession(message.sessionId);
        }
        return;
      case 'detail-action':
        void this.runDetailAction(message.sourceId);
        return;
      case 'open-provider-settings':
        openMainWindowVoiceSettings('providers');
        return;
      case 'open-remote-control-settings':
        openMainWindowRemoteControlSettings();
        return;
      case 'settings':
        this.applySettingsPatch(message.patch);
        return;
    }
  }

  private applySettingsPatch(patch: MenubarSettingsPatch): void {
    this.settings = writeMenubarSettings(patch);
    if (!this.settings.enabled) {
      this.halt();
      return;
    }
    this.scheduleRebuild(0);
  }

  /** Asks every subscription reader to refresh; their broadcasts trigger the rebuild. */
  private refreshSources(force: boolean): void {
    // Behind the sign-in gate nothing is read, so there is nothing to refresh either.
    if (!hasDataOwner()) {
      this.scheduleRebuild(0, force);
      return;
    }
    void getDesktopProviderService()
      .listProviders({ allowSideEffects: false })
      .then((providers) => {
        for (const provider of providers) {
          if (!provider.connected || provider.suspended || provider.removed) continue;
          const kind = providerWeeklyQuotaSource(provider);
          if (kind === 'codex') triggerCodexAccountUsageRefresh(provider.id);
          else if (kind === 'claude') triggerClaudeSubscriptionUsageRefresh(provider.id);
          else if (kind === 'xai') triggerXaiSubscriptionUsageRefresh(provider.id);
        }
      })
      .catch((error) => log.warn('menu bar refresh could not list providers', { error: errorMessage(error) }));
    this.scheduleRebuild(0, force);
  }

  private showMainWindow(): void {
    if (!focusMainWindow()) app.focus({ steal: true });
  }

  private async runDetailAction(sourceId: string): Promise<void> {
    const action = this.lastView?.details[sourceId]?.action;
    if (!action) return;
    switch (action.kind) {
      case 'new-task':
        await this.openTaskWith(action.providerId);
        return;
      case 'open-billing':
        openMainWindowBillingTopUp();
        return;
      case 'open-settings':
        openMainWindowVoiceSettings('providers');
        return;
      case 'open-app':
        this.showMainWindow();
        return;
      case 'none':
        return;
    }
  }

  /** New task preselected on this account: the default model when it already uses it. */
  private async openTaskWith(providerId: string): Promise<void> {
    try {
      const { current, available } = await inspectAppDefaultModel();
      const route = current && current.providerId === providerId
        ? current
        : available.find((option) => option.route.providerId === providerId)?.route ?? null;
      if (route) applyNewMakerDraftRoute(route);
      else log.info('no model available for menu bar task', { providerId });
    } catch (error) {
      log.warn('menu bar could not preselect a model', { error: errorMessage(error) });
    }
    this.deps.openNewTask();
  }
}

let service: MenubarService | null = null;

export function initMenubarService(deps: MenubarServiceDeps): void {
  if (service || !isMenubarSupportedPlatform(process.platform, os.release())) return;
  service = new MenubarService(deps);
  service.init();
}

export function getMenubarState(): MenubarState {
  return service?.state ?? { available: false, enabled: false };
}

export function setMenubarEnabled(enabled: boolean): MenubarState {
  return service ? service.setEnabled(enabled) : { available: false, enabled: false };
}

export function refreshMenubarLocalization(): void {
  service?.refreshLocalization();
}

export function refreshMenubarControlState(): void {
  service?.refreshControlState();
}

export function stopMenubarService(): void {
  service?.stop();
}

/** Signed in or sign-in skipped: there is an owner whose data may be read. */
function hasDataOwner(): boolean {
  const session = getActiveAppSession();
  return session.mode !== 'signed-out' && session.dataOwnerId !== null;
}

function resetCreditsOf(result: MobileCodexRateLimitsResult | null, nowMs: number): MenubarResetCredits | null {
  const credits = result?.rateLimitResetCredits;
  if (!credits) return null;
  const count = Number.isFinite(credits.availableCount) ? Math.max(0, Math.floor(credits.availableCount)) : 0;
  let earliestExpiryMs: number | null = null;
  for (const credit of credits.credits ?? []) {
    if (credit.status !== 'available' || credit.expiresAt === null) continue;
    const expiresAtMs = credit.expiresAt * 1000;
    if (expiresAtMs <= nowMs) continue;
    if (earliestExpiryMs === null || expiresAtMs < earliestExpiryMs) earliestExpiryMs = expiresAtMs;
  }
  return { count, earliestExpiryMs };
}

function walletPools(usage: ModelAccessCreditUsage): MenubarBalanceReading['pools'] {
  const plan = Number(usage.plan.remaining);
  const purchased = Number(usage.purchased.remaining);
  const promotional = Number(usage.promotional.remaining);
  if (![plan, purchased, promotional].every(Number.isFinite)) return null;
  return { plan, purchased, promotional };
}

/** The active gift that runs out first while it still has money left. */
function nearestPromoExpiry(usage: ModelAccessCreditUsage, nowMs: number): MenubarBalanceReading['promoExpiry'] {
  let nearest: { amount: number; expiresAtMs: number } | null = null;
  for (const grant of usage.promotionalGrants) {
    if (grant.state !== 'active') continue;
    const amount = Number(grant.remainingAmount);
    const expiresAtMs = Date.parse(grant.expiresAt);
    if (!(amount > 0) || !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) continue;
    if (!nearest || expiresAtMs < nearest.expiresAtMs) nearest = { amount, expiresAtMs };
  }
  return nearest;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
