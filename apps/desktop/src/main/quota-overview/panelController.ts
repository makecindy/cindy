/**
 * Logic of a quota panel, shared by every platform's presentation.
 *
 * The overview (`service.ts`) collects quota and usage; this controller turns it into the
 * complete panel view (task activity, remote-control indicator), raises the low-quota
 * notification and carries out what the user does in the panel. A presentation only draws
 * the view it is given and reports the user's commands: the macOS menu bar helper today
 * (`menubar/service.ts`), a tray panel on another platform later.
 */

import { app, Notification } from 'electron';
import { QUOTA_PANEL_DESIGN } from '../../shared/quotaPanelDesign.js';

import type {
  MenubarGate,
  MenubarHelperMessage,
  MenubarSettings,
  MenubarSettingsPatch,
  MenubarView,
} from '../../shared/menubarQuota.js';
import { getAgentIslandService } from '../agent-island/service.js';
import { getActiveAppSession, isAppSessionBoundaryPending, onAppSessionInvalidated } from '../appSessionState.js';
import { onAuthStateChange } from '../authManager.js';
import {
  focusMainWindow,
  openMainWindowBillingTopUp,
  openMainWindowSession,
  openMainWindowRemoteControlSettings,
  openMainWindowVoiceSettings,
} from '../deepLink.js';
import { getActiveControllers } from '../device-link/dispatch.desktop.js';
import { getResolvedMainLocale, mainStringKeysUnder, rawMainString } from '../i18n.desktop.js';
import { createLogger } from '../logger.js';
import { inspectAppDefaultModel } from '../maker-ipc/appDefaultModelControl.js';
import { applyNewMakerDraftRoute } from '../maker-ipc/register.js';
import { getDesktopNotificationsEnabled } from '../notificationService.js';
import { emptyMenubarInputs } from '../menubar/collect.js';
import { MENUBAR_HARNESS_LOGOS } from '../menubar/logos.js';
import { buildMenubarActivities } from '../menubar/activity.js';
import { buildMenubarView, isLowOnEverything, type MenubarBuildInput } from '../menubar/snapshot.js';
import { buildMenubarUiStrings, createMenubarTranslate } from '../menubar/strings.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';
import { getQuotaOverviewService, type QuotaOverviewBuild, type QuotaOverviewService } from './service.js';

const log = createLogger('quota-panel');

/**
 * A hover card keeps the overview this long after it starts or closes, so that sweeping the
 * pointer back over the icon reuses every reading instead of collecting from scratch. Nothing is
 * polled meanwhile: all sources were read within their closed cadences, which are longer.
 */
const HOVER_CARD_KEEP_WARM_MS = 3 * 60_000;
/** Opening by hover refreshes at most this often, the cadence of a card left open. */
const HOVER_CARD_REFRESH_MIN_MS = 60_000;

/** What the user does in a panel; the macOS helper sends these as messages. */
export type QuotaPanelCommand = Exclude<MenubarHelperMessage, { type: 'ready' } | { type: 'error' }>;

/** A platform's way of showing the panel. */
export interface QuotaPanelPresenter {
  /** Draws the complete view; called on every change. */
  publish(view: MenubarView): void;
  /** Brings the panel up, for the low-quota notification. */
  open(): void;
}

export interface QuotaPanelDeps {
  /**
   * The Windows tray card: it opens when the pointer merely rests on the icon and shows no quota
   * while closed, unlike the macOS status item. A hidden card is not a reader of the overview
   * (engineering-conventions §8.3), so it holds it only while it is on screen, briefly afterwards,
   * or while the low-quota alert needs the readings; and since pointer movement alone opens it,
   * opening refreshes at a bounded rate. The last view stays as the next opening's first frame
   * (§8.7): one view in memory, replaced on opening and dropped at an owner change.
   */
  hoverCard?: boolean;
  /** Opens a new task in the main window (the app menu's "New Task" command). */
  openNewTask(): void;
  /** Settings written from the panel; a presentation stops when it is switched off. */
  onSettingsChanged?(settings: MenubarSettings): void;
  /** Defaults to the app-wide overview. */
  overview?: QuotaOverviewService;
}

const running = new Set<QuotaPanelController>();

/** Remote-control activity changed; every running panel updates its indicator. */
export function refreshQuotaPanelsControlState(): void {
  for (const panel of running) panel.refreshControlState();
}

export class QuotaPanelController {
  private readonly overview: QuotaOverviewService;
  private started = false;
  private lastView: MenubarView | null = null;
  /** Null until the first build, so launching while low does not notify. */
  private wasLow: boolean | null = null;
  private lowNotification: Notification | null = null;
  private disposers: (() => void)[] = [];
  private panelOpen = false;
  private warmUntilMs = 0;
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
  private openRefreshedAtMs = -Infinity;
  private releaseOverview: (() => void) | null = null;
  /** Owner of the last view; without a hold there is no build to tell an owner change by. */
  private viewOwnerId: string | null = null;

  constructor(private readonly presenter: QuotaPanelPresenter, private readonly deps: QuotaPanelDeps) {
    this.overview = deps.overview ?? getQuotaOverviewService();
  }

  get settings(): MenubarSettings {
    return this.overview.settings;
  }

  updateSettings(patch: MenubarSettingsPatch): MenubarSettings {
    const settings = this.overview.updateSettings(patch);
    this.syncHold();
    this.deps.onSettingsChanged?.(settings);
    return settings;
  }

  /** The view last handed to the presentation. */
  get view(): MenubarView | null {
    return this.lastView;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.wasLow = null;
    running.add(this);
    this.disposers.push(this.overview.subscribe((build) => this.publish(build)));
    const island = getAgentIslandService();
    if (island) this.disposers.push(island.subscribeTaskOverview(() => this.publishTaskOverview()));
    // The last view belongs to the old owner (received shares included): clear it at the account
    // boundary or sign-out instead of waiting for the next owner's first build.
    this.disposers.push(
      onAppSessionInvalidated(() => this.publishUnavailableOverview()),
      onAuthStateChange(() => {
        // A panel that released the overview has no build by design; a token refresh must not
        // blank its first frame, only a different owner does.
        if (this.overview.latest()) return;
        if (this.releaseOverview || getActiveAppSession().dataOwnerId !== this.viewOwnerId) this.publishUnavailableOverview();
      }),
    );
    // Subscribed first, so the first build after acquiring reaches the presentation.
    // A hover card reads once now for its first frame.
    if (this.deps.hoverCard) this.keepWarm();
    else this.syncHold();
    const current = this.overview.latest();
    if (current) this.publish(current);
  }

  private keepWarm(): void {
    this.warmUntilMs = Date.now() + HOVER_CARD_KEEP_WARM_MS;
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => {
      this.warmTimer = null;
      this.syncHold();
    }, HOVER_CARD_KEEP_WARM_MS);
    this.syncHold();
  }

  /** Holds the overview exactly while this panel needs its readings. */
  private syncHold(): void {
    const wanted = this.started && (
      !this.deps.hoverCard || this.panelOpen || Date.now() < this.warmUntilMs
      // The alert is raised from builds made while the panel is closed, so it is a reader too.
      || this.overview.settings.lowAlert
    );
    if (wanted === (this.releaseOverview !== null)) return;
    if (wanted) {
      // The first build after a gap is a first build again: it must not notify.
      this.wasLow = null;
      this.releaseOverview = this.overview.acquire();
    } else {
      this.releaseOverview?.();
      this.releaseOverview = null;
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.panelOpen = false;
    this.warmUntilMs = 0;
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = null;
    running.delete(this);
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // Listener already gone.
      }
    }
    this.syncHold();
    this.overview.setInteractive(false);
    this.lastView = null;
    this.viewOwnerId = null;
    this.lowNotification?.close();
    this.lowNotification = null;
  }

  /** Remote activity updates the indicator immediately, independently of usage collection. */
  refreshControlState(): void {
    if (!this.started || !this.lastView || this.lastView.gate) return;
    const control = controlState();
    if (
      this.lastView.remotelyControlled === control.remotelyControlled
      && JSON.stringify(this.lastView.remoteControllerNames) === JSON.stringify(control.remoteControllerNames)
    ) return;
    this.show({ ...this.lastView, ...control });
  }

  handle(command: QuotaPanelCommand): void {
    switch (command.type) {
      case 'panel':
        if (!this.started) return;
        this.panelOpen = command.open;
        if (command.open) {
          // Held before going interactive, so that opening can refresh.
          this.syncHold();
          const now = Date.now();
          const refresh = !this.deps.hoverCard || now - this.openRefreshedAtMs >= HOVER_CARD_REFRESH_MIN_MS;
          if (refresh) this.openRefreshedAtMs = now;
          this.overview.setInteractive(true, refresh);
        } else {
          this.overview.setInteractive(false);
          if (this.deps.hoverCard) this.keepWarm();
        }
        return;
      case 'refresh':
        this.overview.refresh(true);
        return;
      case 'open-app':
        showMainWindow();
        return;
      case 'open-session':
        if (this.lastView?.activities?.some(row => row.sessionId === command.sessionId)) {
          getAgentIslandService()?.openTaskOverviewSession(command.sessionId);
        } else {
          openMainWindowSession(command.sessionId);
        }
        return;
      case 'detail-action':
        void this.runDetailAction(command.sourceId);
        return;
      case 'open-provider-settings':
        openMainWindowVoiceSettings('providers');
        return;
      case 'open-remote-control-settings':
        openMainWindowRemoteControlSettings();
        return;
      case 'settings':
        this.updateSettings(command.patch);
        return;
    }
  }

  private show(view: MenubarView): void {
    this.lastView = { ...view, presentation: QUOTA_PANEL_DESIGN };
    this.presenter.publish(this.lastView);
  }

  private publish(build: QuotaOverviewBuild): void {
    const gate = build.view.gate ?? undefined;
    this.viewOwnerId = build.ownerId;
    this.show({ ...build.view, ...this.taskOverview(gate), ...controlState(gate) });
    if (gate) {
      // The first real build after signing in counts as a first build again.
      this.wasLow = null;
      return;
    }
    this.updateLowAlert(isLowOnEverything(build.input), build.input);
  }

  /** Identity invalidation cannot wait for an overview still collecting the old owner's data. */
  private publishUnavailableOverview(): void {
    if (!this.started) return;
    const nowMs = Date.now();
    const locale = getResolvedMainLocale();
    const raw = (key: string) => rawMainString(key, locale);
    const view = buildMenubarView({
      ...emptyMenubarInputs(nowMs, ''), nowMs, locale,
      moneySymbol: currentLedgerCurrency() === 'CNY' ? '¥' : '$', settings: this.settings,
      harnessLogos: MENUBAR_HARNESS_LOGOS,
      uiStrings: buildMenubarUiStrings(mainStringKeysUnder('menubar.ui'), raw, locale),
      t: createMenubarTranslate(locale, raw),
      ...(!getActiveAppSession().dataOwnerId ? { gate: 'sign-in' as const } : {}),
    });
    this.wasLow = null;
    this.viewOwnerId = getActiveAppSession().dataOwnerId;
    this.show({ ...view, ...this.taskOverview('sign-in'), ...controlState('sign-in') });
  }

  /** Unread changes must not wait for quota/history/network reads to finish. */
  private taskOverview(gate?: MenubarGate): Pick<MenubarView, 'activities' | 'attentionCount'> {
    const locale = getResolvedMainLocale();
    const activities = gate ? [] : buildMenubarActivities(
      getAgentIslandService()?.getTaskOverview() ?? [], this.overview.settings.privacy,
      createMenubarTranslate(locale, key => rawMainString(key, locale)),
    );
    return { activities, attentionCount: activities.filter(row => row.attention).length };
  }

  private publishTaskOverview(): void {
    if (!this.started || !this.lastView || this.lastView.gate || isAppSessionBoundaryPending()) return;
    const overview = this.taskOverview();
    if (JSON.stringify(this.lastView.activities) === JSON.stringify(overview.activities)) return;
    this.show({ ...this.lastView, ...overview });
  }

  /** Notifies once when everything usable drops to nearly empty; never on the first build. */
  private updateLowAlert(low: boolean, input: MenubarBuildInput): void {
    const previous = this.wasLow;
    this.wasLow = low;
    if (!low) {
      this.lowNotification?.close();
      this.lowNotification = null;
      return;
    }
    if (previous !== false || !this.overview.settings.lowAlert || !getDesktopNotificationsEnabled()) return;
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
      if (this.started) this.presenter.open();
    });
    notification.on('close', release);
    notification.on('failed', (_event, error) => {
      log.warn('quota low alert failed', { error: String(error) });
      release();
    });
    notification.show();
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
        showMainWindow();
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
      else log.info('no model available for quota panel task', { providerId });
    } catch (error) {
      log.warn('quota panel could not preselect a model', { error: errorMessage(error) });
    }
    this.deps.openNewTask();
  }
}

function controlState(gate?: MenubarGate): Pick<MenubarView, 'remotelyControlled' | 'remoteControllerNames'> {
  const controllers = gate ? [] : getActiveControllers();
  return {
    remotelyControlled: controllers.length > 0,
    remoteControllerNames: controllers.map(controller => controller.name),
  };
}

function showMainWindow(): void {
  if (!focusMainWindow()) app.focus({ steal: true });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
