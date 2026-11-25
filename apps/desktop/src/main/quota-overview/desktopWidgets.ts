/**
 * macOS desktop widgets (subscription quota, daily usage): the phone's widgets, fed by this Mac.
 *
 * The widget extension (`native/desktop-widgets`) cannot reach the app, so the app writes the
 * phone's widget store (`UsageWidgetStore` in apps/mobile) with this Mac as its only computer
 * into the one folder the extension's sandbox may read, and asks WidgetKit to reload.
 *
 * The overview is only held while a widget is on the desktop, like the menu bar panel holds it
 * while enabled. WidgetKit grants each widget a limited number of reloads a day, so a change is
 * reloaded at most every few minutes (the latest one always lands), and an unchanged reading
 * often enough that the widget never calls current data stale.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { app } from 'electron';
import type { MobileUsageWidgetSnapshot } from '@cindy/maker-shared/device-link-contract';

import { onAppSessionInvalidated } from '../appSessionState.js';
import { deviceName } from '../device-link/deviceName.js';
import { getResolvedMainLocale, rawMainString } from '../i18n.desktop.js';
import { createLogger } from '../logger.js';
import { atomicWriteFileSync } from '../utils/atomicWriteFile.js';
import type { QuotaOverviewBuild, QuotaOverviewService } from './service.js';
import { buildUsageWidgetSnapshot } from './widgetSnapshot.js';

const log = createLogger('quota-overview:desktop-widgets');
const requireNative = createRequire(__filename);

/** Matches `DESKTOP_WIDGETS_ADDON_RELATIVE_PATH` in native/desktop-widgets/build.mjs. */
const ADDON_RELATIVE_PATH = 'tools/desktop-widgets/cindy-desktop-widgets.node';
/** Same file name the extension reads (`WidgetStore.fileURL` in MacWidgetSupport.swift). */
const STORE_FILE = 'usage-widget-snapshot.json';
const LOCAL_ID = 'local';
/** How often the app asks WidgetKit whether a widget was added or removed. */
export const DESKTOP_WIDGETS_POLL_MS = 60_000;
/** Changes reach the widget at most this often. */
export const DESKTOP_WIDGETS_MIN_RELOAD_MS = 10 * 60_000;
/** Below the widget's one-hour stale mark, so an unchanged reading still shows as current. */
export const DESKTOP_WIDGETS_FRESHNESS_RELOAD_MS = 45 * 60_000;

interface NativeDesktopWidgets {
  apply(json: string): string;
}

interface NativeStatus {
  ok?: boolean;
  /** Home-relative folder of the store, or null when the app was built without the extension. */
  dataPath?: string | null;
  /** Cindy widgets on the desktop, or null before WidgetKit first answered. */
  widgets?: number | null;
}

/** `UsageWidgetStore` (apps/mobile/src/widgets/usageWidgetSync.ts) with one computer, this Mac. */
export interface DesktopWidgetStore {
  version: 2;
  autoDeviceId: string;
  computers: { id: string; name: string }[];
  states: Record<string, { kind: 'snapshot'; receivedAtMs: number; deviceName: string; snapshot: MobileUsageWidgetSnapshot }>;
}

export interface DesktopWidgetsDeps {
  onSessionInvalidated: (listener: () => void) => () => void;
  overview: Pick<QuotaOverviewService, 'subscribe' | 'acquire' | 'latest'>;
  native: NativeDesktopWidgets;
  /** Absolute folder the store is written to. */
  dataDir: string;
  snapshot: (build: QuotaOverviewBuild, nowMs: number) => MobileUsageWidgetSnapshot | null;
  deviceName: () => string;
  write: (file: string, contents: string) => void;
  now: () => number;
}

/** The store for one build; signed out (or another gate) leaves no computer state to show. */
export function buildDesktopWidgetStore(
  snapshot: MobileUsageWidgetSnapshot | null,
  name: string,
  nowMs: number,
): DesktopWidgetStore {
  return {
    version: 2,
    autoDeviceId: LOCAL_ID,
    computers: [{ id: LOCAL_ID, name }],
    states: snapshot ? { [LOCAL_ID]: { kind: 'snapshot', receivedAtMs: nowMs, deviceName: name, snapshot } } : {},
  };
}

/** What the widget draws, without the times every build renews (the widget ages them itself). */
function contentKey(store: DesktopWidgetStore): string {
  const state = store.states[LOCAL_ID];
  if (!state) return 'empty';
  const { generatedAtMs: _generated, updatedAtMs: _updated, ...snapshot } = state.snapshot;
  return JSON.stringify({
    name: state.deviceName,
    ...snapshot,
    sources: snapshot.sources.map(({ when: _when, ...source }) => source),
  });
}

export class DesktopWidgets {
  private release: (() => void) | null = null;
  private offSession: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private written: string | null = null;
  private shownKey: string | null = null;
  private latestKey: string | null = null;
  private reloadedAtMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: DesktopWidgetsDeps) {}

  start(): void {
    if (this.pollTimer) return;
    this.offSession = this.deps.onSessionInvalidated(() => this.clear());
    this.clear();
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), DESKTOP_WIDGETS_POLL_MS);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.setHeld(false);
    this.offSession?.();
    this.offSession = null;
  }

  private poll(): void {
    const widgets = this.status()?.widgets;
    // Unknown (WidgetKit has not answered yet, or the call failed) keeps the current state.
    if (typeof widgets === 'number') this.setHeld(widgets > 0);
  }

  private status(): NativeStatus | null {
    try {
      return JSON.parse(this.deps.native.apply(JSON.stringify({ action: 'status' }))) as NativeStatus;
    } catch (error) {
      log.warn('desktop widget status failed', { error: errorMessage(error) });
      return null;
    }
  }

  private setHeld(held: boolean): void {
    if (held && !this.release) {
      // Subscribed first, so the first build after acquiring reaches the widgets.
      this.unsubscribe = this.deps.overview.subscribe((build) => this.publish(build));
      this.release = this.deps.overview.acquire();
      const latest = this.deps.overview.latest();
      if (latest) this.publish(latest);
    } else if (!held && this.release) {
      this.release();
      this.unsubscribe?.();
      this.release = null;
      this.unsubscribe = null;
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  private publish(build: QuotaOverviewBuild): void {
    this.publishSnapshot(this.deps.snapshot(build, this.deps.now()));
  }

  private clear(): void {
    // Account invalidation must remove the old reading immediately, outside the reload throttle.
    this.reloadedAtMs = Number.NEGATIVE_INFINITY;
    this.publishSnapshot(null);
    // The first reading of the next owner must not wait behind the empty-state reload.
    this.reloadedAtMs = Number.NEGATIVE_INFINITY;
  }

  private publishSnapshot(snapshot: MobileUsageWidgetSnapshot | null): void {
    const now = this.deps.now();
    const store = buildDesktopWidgetStore(snapshot, this.deps.deviceName(), now);
    const contents = JSON.stringify(store);
    if (contents !== this.written) {
      try {
        this.deps.write(path.join(this.deps.dataDir, STORE_FILE), contents);
        this.written = contents;
      } catch (error) {
        log.warn('desktop widget store write failed', { error: errorMessage(error) });
        return;
      }
    }
    this.latestKey = contentKey(store);
    this.scheduleReload(now);
  }

  private scheduleReload(now: number): void {
    const changed = this.latestKey !== this.shownKey;
    const since = now - this.reloadedAtMs;
    if (!changed && since < DESKTOP_WIDGETS_FRESHNESS_RELOAD_MS) return;
    if (since >= DESKTOP_WIDGETS_MIN_RELOAD_MS) {
      this.reload(now);
      return;
    }
    // Trailing reload: whatever was written last is what the widget shows then.
    this.reloadTimer ??= setTimeout(() => {
      this.reloadTimer = null;
      if (this.release) this.reload(this.deps.now());
    }, DESKTOP_WIDGETS_MIN_RELOAD_MS - since);
  }

  private reload(now: number): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
    try {
      this.deps.native.apply(JSON.stringify({ action: 'reload' }));
      this.reloadedAtMs = now;
      this.shownKey = this.latestKey;
    } catch (error) {
      log.warn('desktop widget reload failed', { error: errorMessage(error) });
    }
  }
}

function loadNative(): NativeDesktopWidgets | null {
  const base = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
  const addon = path.join(base, ADDON_RELATIVE_PATH);
  if (!fs.existsSync(addon)) return null;
  try {
    return requireNative(addon) as NativeDesktopWidgets;
  } catch (error) {
    log.warn('desktop widget addon failed to load', { error: errorMessage(error) });
    return null;
  }
}

/**
 * Feeds the desktop widgets when this app was built with them (macOS only). Returns the stop
 * function, or null when there is nothing to feed.
 */
export function startDesktopWidgets(overview: DesktopWidgetsDeps['overview']): (() => void) | null {
  if (process.platform !== 'darwin') return null;
  // The Swift addon targets macOS 14 (Darwin 23). An unavailable symbol aborts the
  // main process, so check before loading it, even when no widgets have been placed.
  const darwinMajor = Number(os.release().split('.')[0]);
  if (!Number.isInteger(darwinMajor) || darwinMajor < 23) return null;
  const native = loadNative();
  if (!native) return null;
  let dataPath: string | null | undefined;
  try {
    dataPath = (JSON.parse(native.apply(JSON.stringify({ action: 'status' }))) as NativeStatus).dataPath;
  } catch (error) {
    log.warn('desktop widget status failed', { error: errorMessage(error) });
    return null;
  }
  if (!dataPath) return null;
  const widgets = new DesktopWidgets({
    overview,
    onSessionInvalidated: onAppSessionInvalidated,
    native,
    dataDir: path.join(os.homedir(), dataPath),
    snapshot: (build, nowMs) => {
      const series = build.usage.scopes[build.view.settings.scope]?.modelSeries;
      const locale = getResolvedMainLocale();
      return buildUsageWidgetSnapshot(build.view, nowMs, (key) => rawMainString(key, locale), series);
    },
    deviceName,
    write: atomicWriteFileSync,
    now: Date.now,
  });
  widgets.start();
  return () => widgets.stop();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
