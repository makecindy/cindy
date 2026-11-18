/**
 * Window-level progress of market installs and updates this window started, keyed by market
 * pluginId.
 *
 * Display only. Whoever runs one (the Plugin page's market flow and update button, or the
 * "update all" batch, which keeps running after the page unmounts) brackets it with begin / end
 * and marks success or failure; Main's `plugin-market:install-progress` pushes fill in the steps
 * between. Outcomes, toasts and the busy lease stay with the runner. Pushes for installs nobody
 * began here (Computer Use setup, in-place installs) are ignored.
 *
 * Every entry belongs to the data owner that started it. After an account, mode or owner
 * generation change its entries are hidden and dropped, and Main's pushes carry the owner stamp
 * of the install that sent them, so a late push from the previous owner never reaches the new one.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useSyncExternalStore } from 'react';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
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
  /** Why it failed, already translated; the same words the failure toast showed. */
  failure?: string;
}

interface Entry extends PluginInstallProgressState {
  owner: DataOwnerGeneration;
}

/** How long "Installed" / "Updated" stays in place before the surface returns to normal. */
export const PLUGIN_INSTALL_DONE_HOLD_MS = 900;

let entries: ReadonlyMap<string, Entry> = new Map();
const listeners = new Set<() => void>();
const doneHolds = new Map<string, ReturnType<typeof setTimeout>>();
let stopListening: (() => void) | null = null;

const isCurrent = (entry: Entry | undefined): entry is Entry =>
  entry !== undefined && isDataOwnerGenerationCurrent(entry.owner);

function cancelDoneHold(pluginId: string): void {
  const hold = doneHolds.get(pluginId);
  if (hold === undefined) return;
  clearTimeout(hold);
  doneHolds.delete(pluginId);
}

function commit(next: Map<string, Entry>): void {
  entries = next;
  // Listen only while an install or update is on screen.
  if (entries.size === 0) {
    stopListening?.();
    stopListening = null;
  }
  listeners.forEach((listener) => listener());
}

function write(pluginId: string, next: Entry | null): void {
  const copy = new Map(entries);
  if (next) copy.set(pluginId, next);
  else copy.delete(pluginId);
  commit(copy);
}

/** The entry for this plugin if it still belongs to the current owner; a stale one is dropped. */
function currentEntry(pluginId: string): Entry | undefined {
  const entry = entries.get(pluginId);
  if (entry && !isCurrent(entry)) {
    cancelDoneHold(pluginId);
    write(pluginId, null);
    return undefined;
  }
  return entry;
}

function onPush(event: PluginMarketInstallProgress, ownerStamp?: unknown): void {
  if (!isDataOwnerPushCurrent(ownerStamp)) return;
  const current = currentEntry(event.pluginId);
  if (!current) return;
  // Declining the permission confirmation is not an outcome to show.
  if (event.download.phase === 'cancelled') {
    write(event.pluginId, null);
    return;
  }
  const failed = event.download.phase === 'failed';
  write(event.pluginId, {
    owner: current.owner,
    intent: current.intent,
    download: event.download,
    awaitingConsent: event.awaitingConsent === true,
    // Main's failure push carries no words; keep the reason the runner may already have given.
    ...(failed && current.failure ? { failure: current.failure } : {}),
  });
}

/**
 * Drop entries left by a previous account, mode or owner generation. The Plugin page calls this
 * when the owner changes, so rings it still shows disappear at once.
 */
export function dropStalePluginInstallProgress(): void {
  const next = new Map(entries);
  for (const [pluginId, entry] of entries) {
    if (isCurrent(entry)) continue;
    cancelDoneHold(pluginId);
    next.delete(pluginId);
  }
  if (next.size !== entries.size) commit(next);
}

/** Call when the user (or the batch) starts installing or updating, before any request is made. */
export function beginPluginInstallProgress(
  pluginId: string,
  intent: PluginInstallIntent = 'update',
): void {
  dropStalePluginInstallProgress();
  cancelDoneHold(pluginId);
  stopListening ??= window.electronAPI.pluginMarket.onInstallProgress(onPush);
  write(pluginId, {
    owner: getDataOwnerGeneration(),
    intent,
    download: initialDownloadProgress('preparing'),
    awaitingConsent: false,
  });
}

/** It failed: keep the ring and the reason where it stopped until the next attempt. */
export function failPluginInstallProgress(pluginId: string, failure?: string): void {
  const current = currentEntry(pluginId);
  if (!current) return;
  write(pluginId, {
    owner: current.owner,
    intent: current.intent,
    download: { ...current.download, phase: 'failed', speedBps: 0, etaSeconds: null },
    awaitingConsent: false,
    ...(failure ? { failure } : {}),
  });
}

/**
 * It landed: show "Installed" / "Updated" briefly, then return to normal. The runner says so
 * itself rather than relying on Main's last push arriving before the install result.
 */
export function succeedPluginInstallProgress(pluginId: string): void {
  const current = currentEntry(pluginId);
  if (!current) return;
  const { total } = current.download;
  write(pluginId, {
    owner: current.owner,
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
 * Call once the install settled, whatever the outcome. Success and failure were already marked;
 * anything else (declined, superseded by an account switch) is dropped.
 */
export function endPluginInstallProgress(pluginId: string): void {
  const phase = currentEntry(pluginId)?.download.phase;
  if (phase === undefined || phase === 'failed' || doneHolds.has(pluginId)) return;
  write(pluginId, null);
}

/** Drop failures the user has already been told about, e.g. when leaving the Plugin page. */
export function clearFailedPluginInstallProgress(): void {
  const next = new Map(entries);
  for (const [pluginId, entry] of entries) {
    if (entry.download.phase === 'failed') next.delete(pluginId);
  }
  if (next.size !== entries.size) commit(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePluginInstallProgress(
  pluginId: string | null | undefined,
): PluginInstallProgressState | undefined {
  return useSyncExternalStore(subscribe, () => {
    const entry = pluginId ? entries.get(pluginId) : undefined;
    return isCurrent(entry) ? entry : undefined;
  });
}

let visible: { from: ReadonlyMap<string, Entry>; owner: DataOwnerGeneration; map: ReadonlyMap<string, PluginInstallProgressState> } | null = null;

/** Every running or failed install of the current owner, for surfaces that list several plugins. */
export function usePluginInstallProgressMap(): ReadonlyMap<string, PluginInstallProgressState> {
  return useSyncExternalStore(subscribe, () => {
    const owner = getDataOwnerGeneration();
    if (visible?.from !== entries || visible.owner !== owner) {
      const map = new Map<string, PluginInstallProgressState>();
      for (const [pluginId, entry] of entries) if (isCurrent(entry)) map.set(pluginId, entry);
      visible = { from: entries, owner, map };
    }
    return visible.map;
  });
}

export function __resetPluginInstallProgressForTest(): void {
  doneHolds.forEach((hold) => clearTimeout(hold));
  doneHolds.clear();
  stopListening?.();
  stopListening = null;
  entries = new Map();
  visible = null;
  listeners.forEach((listener) => listener());
}
