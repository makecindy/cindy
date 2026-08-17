/**
 * useXaiSubscriptionUsage — SuperGrok 账号周用量推送。
 *
 * IPC: getXaiSubscription / onXaiSubscriptionChanged。
 * push 与 warm-start read 共用一份 epoch:push 先到时,迟到的旧 read 不得把
 * 已清除/已更新的 lastSnapshot 盖回去。
 */

import { useEffect, useState } from 'react';

import type { XaiSubscriptionUsageSnapshot } from '../../shared/xaiSubscriptionUsage';

export type { XaiSubscriptionUsageSnapshot };

let lastSnapshot: XaiSubscriptionUsageSnapshot | null = null;
let snapshotEpoch = 0;

function isSnapshot(v: unknown): v is XaiSubscriptionUsageSnapshot {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

export function reduceXaiSubscriptionPush(
  current: XaiSubscriptionUsageSnapshot | null,
  payload: unknown,
): XaiSubscriptionUsageSnapshot | null {
  if (payload === null) return null;
  if (isSnapshot(payload)) return payload;
  return current;
}

export function resolvePersistedXaiSubscriptionRead(
  persisted: unknown,
):
  | { action: 'clear' }
  | { action: 'apply'; snapshot: XaiSubscriptionUsageSnapshot }
  | { action: 'ignore' } {
  if (persisted === null) return { action: 'clear' };
  if (isSnapshot(persisted)) return { action: 'apply', snapshot: persisted };
  return { action: 'ignore' };
}

/** 迟到的 IPC read 是否还能落地:期间若已经有 push,就信 push。 */
export function shouldApplyXaiSubscriptionRead(
  epochAtStart: number,
  currentEpoch: number,
): boolean {
  return epochAtStart === currentEpoch;
}

function readUsageApi(): {
  getXaiSubscription?: () => Promise<unknown | null>;
  onXaiSubscriptionChanged?: (cb: (payload: unknown) => void) => () => void;
} | undefined {
  return (window as unknown as {
    electronAPI?: {
      maker?: {
        usage?: {
          getXaiSubscription?: () => Promise<unknown | null>;
          onXaiSubscriptionChanged?: (cb: (payload: unknown) => void) => () => void;
        };
      };
    };
  }).electronAPI?.maker?.usage;
}

function applyPush(payload: unknown): void {
  snapshotEpoch += 1;
  lastSnapshot = reduceXaiSubscriptionPush(lastSnapshot, payload);
}

let moduleSubscriptionInstalled = false;
function ensureModuleSubscription(): void {
  if (moduleSubscriptionInstalled) return;
  const api = readUsageApi();
  if (!api?.onXaiSubscriptionChanged) return;
  moduleSubscriptionInstalled = true;
  api.onXaiSubscriptionChanged((payload: unknown) => {
    applyPush(payload);
  });
}

export function requestXaiSubscriptionRefresh(): void {
  const api = readUsageApi();
  if (!api?.getXaiSubscription) return;
  void api.getXaiSubscription().catch(() => {
    /* Best-effort nudge */
  });
}

export function useXaiSubscriptionUsage(
  enabled: boolean,
): XaiSubscriptionUsageSnapshot | null {
  ensureModuleSubscription();
  const [snapshot, setSnapshot] = useState<XaiSubscriptionUsageSnapshot | null>(() =>
    enabled ? lastSnapshot : null,
  );

  useEffect(() => {
    setSnapshot(enabled ? lastSnapshot : null);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const api = readUsageApi();
    if (!api?.getXaiSubscription) return;

    let cancelled = false;
    const epochAtStart = snapshotEpoch;
    void api
      .getXaiSubscription()
      .then((persisted) => {
        if (cancelled) return;
        if (!shouldApplyXaiSubscriptionRead(epochAtStart, snapshotEpoch)) return;
        const resolved = resolvePersistedXaiSubscriptionRead(persisted);
        if (resolved.action === 'clear') {
          lastSnapshot = null;
          setSnapshot(null);
          return;
        }
        if (resolved.action === 'apply') {
          lastSnapshot = resolved.snapshot;
          setSnapshot(resolved.snapshot);
        }
      })
      .catch(() => {
        /* Best-effort warm start */
      });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const api = readUsageApi();
    if (!api?.onXaiSubscriptionChanged) return;

    let cancelled = false;
    const unsubscribe = api.onXaiSubscriptionChanged((payload: unknown) => {
      if (cancelled) return;
      applyPush(payload);
      setSnapshot(lastSnapshot);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled]);

  return snapshot;
}
