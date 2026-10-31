/**
 * Quota and usage overview: what every subscription has left, the Cindy balance and recent
 * usage, collected once and shared by every surface that shows it.
 *
 * Platform independent. The macOS menu bar panel holds it while it is enabled; the iPhone
 * widgets lease it for a while each time a phone asks (on any platform, panel or not); a
 * future tray panel on another platform holds it the same way. Nothing is read while nobody
 * holds it.
 *
 * Rebuilds are debounced and coalesced. They run on usage broadcasts, running-task
 * transitions, settings and locale changes and a slow timer. A panel on screen
 * (`setInteractive`) shortens every cadence and asks each subscription reader to refresh.
 * Everything here reads caches Cindy already keeps; the only extra network calls are the
 * Cindy balance (at most once a minute), other computers and Codex reset credits.
 */

import { isSessionActivityRunning } from '@cindy/maker-shared/session-activity';
import type {
  MobileCodexRateLimitsResult,
  MobileUsageWidgetSnapshotResult,
} from '@cindy/maker-shared/device-link-contract';

import type { ModelAccessCreditUsage } from '../../shared/modelAccess.js';
import type {
  MenubarGate,
  MenubarSettings,
  MenubarSettingsPatch,
  MenubarUsageScope,
  MenubarView,
} from '../../shared/menubarQuota.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { providerWeeklyQuotaSource } from '../../shared/providerQuotaSource.js';
import { getAgentIslandService } from '../agent-island/service.js';
import { getAppCapabilities, requireAppCapability } from '../appCapabilities.js';
import { getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import * as authManager from '../authManager.js';
import { projectModelAccessBalance, projectModelAccessCreditUsage } from '../billing/projection.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { remoteBackgroundInvoke } from '../device-link/index.js';
import { handleListDevices, defaultDeps as deviceDirectoryDeps } from '../device-link/ipc.js';
import { deviceName } from '../device-link/deviceName.js';
import { getResolvedMainLocale, mainStringKeysUnder, rawMainString } from '../i18n.js';
import { getSessionRowSnapshot } from '../localDb/ipc/sessions.js';
import { createLogger } from '../logger.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { readKimiCodingAccountUsage } from '../maker-host/provider-account-usage.js';
import { getSessionProvider, hasSessionProvider } from '../maker-host/session-provider-store.js';
import {
  readClaudeSubscriptionUsageSnapshotForDeviceLink,
  readCodexRateLimitsForHost,
  readXaiSubscriptionUsageSnapshotForDeviceLink,
  triggerClaudeSubscriptionUsageRefresh,
  triggerCodexAccountUsageRefresh,
  triggerXaiSubscriptionUsageRefresh,
} from '../maker-ipc/usage.js';
import { serverApiFetch } from '../serverApiClient.js';
import { observeClaudeAccountUsage, readClaudeAccountUsageRevision, readClaudeAccountUsageSnapshot, triggerClaudeAccountUsageRefresh } from '../usage/claudeAccountUsage.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';
import { readUsageHistory, type UsageHistoryPayload } from '../usage/usageHistory.js';
import { observeUsageChanges, readCodexAccountUsageSnapshot } from '../usageBroadcaster.js';
import { CreditSampleStore, estimateDailyBurn, largestCreditSample } from '../menubar/creditSamples.js';
import {
  collectMenubarInputs,
  emptyMenubarInputs,
  MENUBAR_USAGE_DAYS,
  type MenubarBalanceReading,
  type MenubarCollected,
} from '../menubar/collect.js';
import { MENUBAR_HARNESS_LOGOS } from '../menubar/logos.js';
import { OwnedInFlight } from '../menubar/ownedInFlight.js';
import { readRemoteSubscriptions, retainRemoteSubscriptions, type RemoteSeen } from '../menubar/remoteSubscriptions.js';
import { readMenubarSettings, writeMenubarSettings } from '../menubar/settingsStore.js';
import {
  buildMenubarView,
  type MenubarBuildInput,
  type MenubarResetCredits,
  type MenubarSubscriptionInput,
} from '../menubar/snapshot.js';
import { buildMenubarUiStrings, createMenubarTranslate } from '../menubar/strings.js';
import { buildUsageWidgetSnapshot } from './widgetSnapshot.js';

const log = createLogger('quota-overview');

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
/** After a failed read (a computer still connecting, a timeout) try again sooner. */
const REMOTE_RETRY_MS = 60_000;
const RESETS_FRESH_WHILE_OPEN_MS = 3 * 60_000;
const RESETS_FRESH_WHILE_CLOSED_MS = 30 * 60_000;
/** A build this recent answers a remote request without waiting for another. */
const FRESH_BUILD_MS = PERIODIC_REBUILD_MS + 30_000;
/** Phones refresh their widgets every few minutes while open; keep collecting in between. */
const WIDGET_LEASE_MS = 30 * 60_000;
/** Below the phone's invoke timeout, so a slow first build still answers with what it has. */
const WIDGET_WAIT_MS = 10_000;

/** One published overview. */
export interface QuotaOverviewBuild {
  /** Panel view without the panel's own parts (task activity, remote-control state). */
  view: MenubarView;
  input: MenubarBuildInput;
  usage: MenubarCollected['usage'];
  /** Usage history was still being aggregated; a follow-up build is on its way. */
  stale: boolean;
  builtAtMs: number;
  /** Data owner the build was read for; a build never outlives an account switch. */
  ownerId: string | null;
}

type BuildListener = (build: QuotaOverviewBuild) => void;

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

export class QuotaOverviewService {
  private readonly creditSamples = new CreditSampleStore();
  private currentSettings: MenubarSettings = readMenubarSettings();
  private started = false;
  private holders = 0;
  private leaseUntilMs = 0;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private interactive = false;
  private lastBuild: QuotaOverviewBuild | null = null;
  private readonly listeners = new Set<BuildListener>();
  private balance: BalanceCache | null = null;
  private readonly balanceInFlight = new OwnedInFlight<MenubarBalanceReading | null>();
  private readonly usageCache = new Map<MenubarUsageScope, UsageCacheEntry>();
  private usageOwnerId: string | null = null;
  /** Serializes history reads so the two ranges never recompute at the same time. */
  private usageChain: Promise<unknown> = Promise.resolve();
  private remote: (TimedCache<MenubarSubscriptionInput[]> & { incomplete: boolean }) | null = null;
  /** Last reading of every remote account, so an offline computer keeps showing it. */
  private remoteSeen: TimedCache<Map<string, RemoteSeen>> | null = null;
  private readonly remoteInFlight = new OwnedInFlight<MenubarSubscriptionInput[]>();
  private readonly resets = new Map<string, TimedCache<MenubarResetCredits | null>>();

  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private building = false;
  private rebuildQueued = false;
  private forceNext = false;
  private staleFollowUps = 0;
  private disposers: (() => void)[] = [];

  get settings(): MenubarSettings {
    return this.currentSettings;
  }

  updateSettings(patch: MenubarSettingsPatch): MenubarSettings {
    this.currentSettings = writeMenubarSettings(patch);
    this.scheduleRebuild(0);
    return this.currentSettings;
  }

  /** The latest build, or null while nobody holds the overview or nothing is built yet. */
  latest(): QuotaOverviewBuild | null {
    return this.currentBuild();
  }

  /** The last build, unless it belongs to a previous account or an account switch is under way. */
  private currentBuild(): QuotaOverviewBuild | null {
    const build = this.lastBuild;
    if (!build || isAppSessionBoundaryPending() || build.ownerId !== getActiveAppSession().dataOwnerId) return null;
    return build;
  }

  subscribe(listener: BuildListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Keeps collecting until the returned release is called. */
  acquire(): () => void {
    this.holders += 1;
    this.updateRunning();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders -= 1;
      this.updateRunning();
    };
  }

  /** Keeps collecting for at least `ms` from now. */
  lease(ms: number): void {
    const until = Date.now() + ms;
    if (until > this.leaseUntilMs) {
      this.leaseUntilMs = until;
      if (this.leaseTimer) clearTimeout(this.leaseTimer);
      this.leaseTimer = setTimeout(() => {
        this.leaseTimer = null;
        this.updateRunning();
      }, ms);
    }
    this.updateRunning();
  }

  /** A panel is on screen: shorter cadences, and opening it refreshes every source. */
  setInteractive(open: boolean): void {
    this.interactive = open;
    if (open) this.refresh(false);
  }

  /** Locale or presentation changed; rebuild from the caches. */
  rebuildSoon(): void {
    this.scheduleRebuild(0);
  }

  /** A recent settled build, building one if needed; resolves with whatever exists after `timeoutMs`. */
  async fresh(timeoutMs: number): Promise<QuotaOverviewBuild | null> {
    const build = this.currentBuild();
    if (build && !build.stale && Date.now() - build.builtAtMs < FRESH_BUILD_MS) return build;
    if (!this.started) return null;
    return await new Promise((resolve) => {
      const done = (value: QuotaOverviewBuild | null) => {
        clearTimeout(timer);
        off();
        resolve(value);
      };
      const timer = setTimeout(() => done(this.currentBuild()), timeoutMs);
      const off = this.subscribe((next) => {
        if (!next.stale && next.ownerId === getActiveAppSession().dataOwnerId) done(next);
      });
      this.scheduleRebuild(0);
    });
  }

  /** Asks every subscription reader to refresh; their broadcasts trigger the rebuild. */
  refresh(force: boolean): void {
    if (!this.started) return;
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
      .catch((error) => log.warn('quota refresh could not list providers', { error: errorMessage(error) }));
    this.scheduleRebuild(0, force);
  }

  private updateRunning(): void {
    const wanted = this.holders > 0 || this.leaseUntilMs > Date.now();
    if (wanted) this.start();
    else this.halt();
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.currentSettings = readMenubarSettings();
    this.usageOwnerId = getActiveAppSession().dataOwnerId;
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
          this.remoteSeen = null;
          this.resets.clear();
        }
        this.scheduleRebuild();
      }),
    );
    const island = getAgentIslandService();
    if (island) {
      this.disposers.push(
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
    if (this.remoteRetryTimer) clearTimeout(this.remoteRetryTimer);
    this.remoteRetryTimer = null;
    this.interactive = false;
    this.lastBuild = null;
    this.usageCache.clear();
    this.remote = null;
    this.resets.clear();
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
        this.publish(emptyMenubarInputs(nowMs, deviceName()), nowMs, false, 'sign-in');
      } else {
        await this.collectAndPublish(nowMs, force, () => {
          stale = true;
        });
      }
    } catch (error) {
      log.warn('quota overview rebuild failed', { error: errorMessage(error) });
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
    let stale = false;
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
        if (payload.stale) {
          stale = true;
          markStale();
        }
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
      onError: (scope, error) => log.warn('quota source failed', { scope, error: errorMessage(error) }),
    });
    // An owner switch that started during the reads makes them the old owner's data.
    const after = getActiveAppSession();
    if (!this.started || isAppSessionBoundaryPending() || after.generation !== generation) return;
    if (readClaudeAccountUsageRevision() !== quotaRevision) {
      this.scheduleRebuild(0);
      return;
    }
    this.publish(collected, nowMs, stale);
  }

  private publish(collected: MenubarCollected, nowMs: number, stale: boolean, gate?: MenubarGate): void {
    const locale = getResolvedMainLocale();
    const raw = (key: string) => rawMainString(key, locale);
    const input: MenubarBuildInput = {
      nowMs,
      locale,
      moneySymbol: currentLedgerCurrency() === 'CNY' ? '¥' : '$',
      settings: this.currentSettings,
      sources: collected.sources,
      tasks: collected.tasks,
      usage: collected.usage,
      updatedAtMs: collected.updatedAtMs,
      harnessLogos: MENUBAR_HARNESS_LOGOS,
      uiStrings: buildMenubarUiStrings(mainStringKeysUnder('menubar.ui'), raw, locale),
      t: createMenubarTranslate(locale, raw),
      ...(gate ? { gate } : {}),
    };
    const build: QuotaOverviewBuild = { view: buildMenubarView(input), input, usage: collected.usage, stale, builtAtMs: Date.now(), ownerId: getActiveAppSession().dataOwnerId };
    this.lastBuild = build;
    for (const listener of [...this.listeners]) {
      try {
        listener(build);
      } catch (error) {
        log.warn('quota overview listener failed', { error: errorMessage(error) });
      }
    }
  }

  /** Cached usage history; a stale payload is re-read on the next build. */
  private async readUsage(scope: MenubarUsageScope, force: boolean, nowMs: number): Promise<UsageHistoryPayload> {
    const ownerId = getActiveAppSession().dataOwnerId;
    const entry = this.usageCache.get(scope);
    const cached = entry?.ownerId === ownerId ? entry : null;
    const maxAge = this.interactive ? USAGE_FRESH_WHILE_OPEN_MS : USAGE_FRESH_WHILE_CLOSED_MS;
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
      this.remoteSeen = null;
      return [];
    }
    const ownerId = getActiveAppSession().dataOwnerId;
    const cached = this.remote?.ownerId === ownerId ? this.remote : null;
    const maxAge = cached?.incomplete ? REMOTE_RETRY_MS : this.interactive ? REMOTE_FRESH_WHILE_OPEN_MS : REMOTE_FRESH_WHILE_CLOSED_MS;
    if (cached && !force && nowMs - cached.readAtMs < maxAge) return cached.value;
    let incomplete = false;
    // Joined only by callers of the same account; after a switch the new account reads its own.
    const value = await this.remoteInFlight.run(ownerId, async () => {
      const read = await readRemoteSubscriptions({
        nowMs,
        listDevices: () => {
          requireAppCapability('canUseDeviceLink', 'Device Link requires a Cindy account.');
          return handleListDevices(deviceDirectoryDeps());
        },
        invoke: (deviceId, channel, args) => remoteBackgroundInvoke(deviceId, channel, args),
        onError: (scope, error) => log.info('quota remote source failed', { scope, error: errorMessage(error) }),
      });
      incomplete = read.incomplete;
      const previous = this.remoteSeen?.ownerId === ownerId ? this.remoteSeen.value : new Map<string, RemoteSeen>();
      const retained = retainRemoteSubscriptions(previous, read, Date.now());
      if (getActiveAppSession().dataOwnerId === ownerId) this.remoteSeen = { ownerId, value: retained.seen, readAtMs: Date.now() };
      return retained.sources;
    });
    if (getActiveAppSession().dataOwnerId !== ownerId) return [];
    this.remote = { ownerId, value, readAtMs: Date.now(), incomplete };
    if (incomplete && !this.remoteRetryTimer) {
      this.remoteRetryTimer = setTimeout(() => {
        this.remoteRetryTimer = null;
        this.scheduleRebuild();
      }, REMOTE_RETRY_MS);
    }
    return value;
  }

  /** Codex reset credits for one account; a failed read keeps the last known count. */
  private async readCodexResets(providerId: string, force: boolean, nowMs: number): Promise<MenubarResetCredits | null> {
    const ownerId = getActiveAppSession().dataOwnerId;
    const entry = this.resets.get(providerId);
    const cached = entry?.ownerId === ownerId ? entry : null;
    const maxAge = this.interactive ? RESETS_FRESH_WHILE_OPEN_MS : RESETS_FRESH_WHILE_CLOSED_MS;
    if (cached && !force && nowMs - cached.readAtMs < maxAge) return cached.value;
    try {
      const result = await readCodexRateLimitsForHost(providerId);
      const value = resetCreditsOf(result, nowMs);
      if (getActiveAppSession().dataOwnerId !== ownerId) return null;
      this.resets.set(providerId, { ownerId, value, readAtMs: Date.now() });
      return value;
    } catch (error) {
      log.info('quota codex resets unavailable', { providerId, error: errorMessage(error) });
      // Do not retry on every rebuild; the next window of the cadence tries again.
      this.resets.set(providerId, { ownerId, value: cached?.value ?? null, readAtMs: Date.now() });
      return cached?.value ?? null;
    }
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
    const maxAge = this.interactive ? BALANCE_FRESH_WHILE_OPEN_MS : BALANCE_FRESH_WHILE_CLOSED_MS;
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
      log.warn('quota balance read failed', { error: errorMessage(error) });
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
}

let service: QuotaOverviewService | null = null;

export function getQuotaOverviewService(): QuotaOverviewService {
  service ??= new QuotaOverviewService();
  return service;
}

/**
 * Read by device-link for the iPhone widgets, on every platform and whether or not a panel is
 * enabled: each request keeps the overview collecting for a while.
 */
export async function readUsageWidgetSnapshot(): Promise<MobileUsageWidgetSnapshotResult> {
  const overview = getQuotaOverviewService();
  overview.lease(WIDGET_LEASE_MS);
  const build = await overview.fresh(WIDGET_WAIT_MS);
  if (!build) return { ok: false, reason: 'unavailable' };
  const locale = getResolvedMainLocale();
  const series = build.usage.scopes[build.view.settings.scope]?.modelSeries;
  const snapshot = buildUsageWidgetSnapshot(build.view, Date.now(), key => rawMainString(key, locale), series);
  return snapshot ? { ok: true, snapshot } : { ok: false, reason: 'unavailable' };
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
