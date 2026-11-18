/**
 * Window-level progress of market installs and updates this window started, keyed by market
 * pluginId.
 *
 * Display only. Whoever runs one (the Plugin page's market flow and update button, or the
 * "update all" batch, which keeps running after the page unmounts) brackets it with begin / end
 * and marks success or failure; Main's `plugin-market:install-progress` pushes fill in the steps
 * between. Outcomes, toasts and the busy lease stay with the runner. Pushes for installs nobody
 * began here (Computer Use setup, in-place installs) are ignored.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useSyncExternalStore } from 'react';

import {
  initialDownloadProgress,
  type DownloadProgress,
} from '../../../../shared/downloadProgress';
import type { PluginMarketInstallProgress } from '../../../../shared/pluginMarket';

/** A first install says "Installed" when done; an update or replacement says "Updated". */
export type PluginInstallIntent = 'install' | 'update';

export interface PluginInstallProgressState {
  intent: PluginInstallIntent;
  download: DownloadProgress;
  /** The downloaded package is waiting for the user to confirm its permissions. */
  awaitingConsent: boolean;
}

/** How long "Installed" / "Updated" stays in place before the surface returns to normal. */
export const PLUGIN_INSTALL_DONE_HOLD_MS = 900;

let entries: ReadonlyMap<string, PluginInstallProgressState> = new Map();
const listeners = new Set<() => void>();
const doneHolds = new Map<string, ReturnType<typeof setTimeout>>();
let stopListening: (() => void) | null = null;

function write(pluginId: string, next: PluginInstallProgressState | null): void {
  const copy = new Map(entries);
  if (next) copy.set(pluginId, next);
  else copy.delete(pluginId);
  entries = copy;
  // Listen only while an install or update is on screen.
  if (entries.size === 0) {
    stopListening?.();
    stopListening = null;
  }
  listeners.forEach((listener) => listener());
}

function cancelDoneHold(pluginId: string): void {
  const hold = doneHolds.get(pluginId);
  if (hold === undefined) return;
  clearTimeout(hold);
  doneHolds.delete(pluginId);
}

function onPush(event: PluginMarketInstallProgress): void {
  const current = entries.get(event.pluginId);
  if (!current) return;
  // Declining the permission confirmation is not an outcome to show.
  if (event.download.phase === 'cancelled') {
    write(event.pluginId, null);
    return;
  }
  write(event.pluginId, {
    intent: current.intent,
    download: event.download,
    awaitingConsent: event.awaitingConsent === true,
  });
}

/** Call when the user (or the batch) starts installing or updating, before any request is made. */
export function beginPluginInstallProgress(
  pluginId: string,
  intent: PluginInstallIntent = 'update',
): void {
  cancelDoneHold(pluginId);
  stopListening ??= window.electronAPI.pluginMarket.onInstallProgress(onPush);
  write(pluginId, { intent, download: initialDownloadProgress('preparing'), awaitingConsent: false });
}

/** It failed: keep the ring where it stopped until the next attempt. */
export function failPluginInstallProgress(pluginId: string): void {
  const current = entries.get(pluginId);
  if (!current) return;
  write(pluginId, {
    intent: current.intent,
    download: { ...current.download, phase: 'failed', speedBps: 0, etaSeconds: null },
    awaitingConsent: false,
  });
}

/**
 * It landed: show "Installed" / "Updated" briefly, then return to normal. The runner says so
 * itself rather than relying on Main's last push arriving before the install result.
 */
export function succeedPluginInstallProgress(pluginId: string): void {
  const current = entries.get(pluginId);
  if (!current) return;
  const { total } = current.download;
  write(pluginId, {
    intent: current.intent,
    download: {
      ...current.download,
      phase: 'completed',
      speedBps: 0,
      etaSeconds: null,
      ...(total !== null ? { loaded: total, percent: 100 } : {}),
    },
    awaitingConsent: false,
  });
  cancelDoneHold(pluginId);
  doneHolds.set(
    pluginId,
    setTimeout(() => {
      doneHolds.delete(pluginId);
      write(pluginId, null);
    }, PLUGIN_INSTALL_DONE_HOLD_MS),
  );
}

/**
 * Call once the update settled, whatever the outcome. Success and failure were already marked;
 * anything else (declined, superseded by an account switch) is dropped.
 */
export function endPluginInstallProgress(pluginId: string): void {
  const phase = entries.get(pluginId)?.download.phase;
  if (phase === undefined || phase === 'failed' || doneHolds.has(pluginId)) return;
  write(pluginId, null);
}

/** Drop failures the user has already been told about, e.g. when leaving the Plugin page. */
export function clearFailedPluginInstallProgress(): void {
  for (const [pluginId, entry] of entries) {
    if (entry.download.phase === 'failed') write(pluginId, null);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePluginInstallProgress(
  pluginId: string | null | undefined,
): PluginInstallProgressState | undefined {
  return useSyncExternalStore(subscribe, () => (pluginId ? entries.get(pluginId) : undefined));
}

/** Every running or failed install, for surfaces that list several plugins at once. */
export function usePluginInstallProgressMap(): ReadonlyMap<string, PluginInstallProgressState> {
  return useSyncExternalStore(subscribe, () => entries);
}

export function __resetPluginInstallProgressForTest(): void {
  doneHolds.forEach((hold) => clearTimeout(hold));
  doneHolds.clear();
  stopListening?.();
  stopListening = null;
  entries = new Map();
  listeners.forEach((listener) => listener());
}
