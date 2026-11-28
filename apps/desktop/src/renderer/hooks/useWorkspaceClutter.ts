import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkspaceClutterSummary } from '../../shared/worktreeWorkspaceClutter';

const SNOOZE_STORAGE_PREFIX = 'cindy:worktree-clutter-snooze:v1:';
export const CLUTTER_RED_DOT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

function snoozeStorageKey(repoKey: string): string {
  return `${SNOOZE_STORAGE_PREFIX}${repoKey}`;
}

export function isWorkspaceClutterSnoozed(repoKey: string, now = Date.now()): boolean {
  try {
    const raw = window.localStorage.getItem(snoozeStorageKey(repoKey));
    if (!raw) return false;
    const until = Number(raw);
    if (!Number.isFinite(until) || until <= now) {
      window.localStorage.removeItem(snoozeStorageKey(repoKey));
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function snoozeWorkspaceClutterRedDot(repoKey: string, now = Date.now()): void {
  try {
    window.localStorage.setItem(snoozeStorageKey(repoKey), String(now + CLUTTER_RED_DOT_SNOOZE_MS));
  } catch {
    // Ignore storage quota or sandbox errors.
  }
}

/**
 * Lightweight zero-token workspace clutter probe for the branch/worktree single capsule.
 * Never throws or blocks task creation; gracefully returns null on remote/unsupported hosts.
 */
export function useWorkspaceClutter(
  baseRepo: string | undefined,
  deviceId?: string | null,
  enabled = true,
) {
  const key = enabled && baseRepo && !deviceId ? baseRepo : '';
  const currentKey = useRef(key);
  currentKey.current = key;
  const requestId = useRef(0);
  const [state, setState] = useState<{
    key: string;
    summary: WorkspaceClutterSummary | null;
    snoozed: boolean;
  }>({ key: '', summary: null, snoozed: false });

  const refresh = useCallback(async () => {
    if (!key) return;
    const api = window.electronAPI?.worktreeWorkspaceClutterSummary;
    if (!api) return;
    const id = ++requestId.current;
    try {
      const summary = await api({ baseRepo: key });
      if (currentKey.current !== key || id !== requestId.current) return;
      setState({
        key,
        summary,
        snoozed: isWorkspaceClutterSnoozed(key),
      });
    } catch {
      if (currentKey.current !== key || id !== requestId.current) return;
      setState({ key, summary: null, snoozed: false });
    }
  }, [key]);

  useEffect(() => {
    if (!key) {
      setState({ key: '', summary: null, snoozed: false });
      return;
    }
    setState({ key, summary: null, snoozed: isWorkspaceClutterSnoozed(key) });
    void refresh();
    return () => {
      ++requestId.current;
    };
  }, [key, refresh]);

  const snoozeRedDot = useCallback(() => {
    if (!key) return;
    snoozeWorkspaceClutterRedDot(key);
    setState((prev) => (prev.key === key ? { ...prev, snoozed: true } : prev));
  }, [key]);

  const active = state.key === key ? state : { key, summary: null, snoozed: false };
  const tier = active.summary?.tier ?? 'healthy';
  const showRedDot = tier === 'urgent' && !active.snoozed;

  return {
    summary: active.summary,
    tier,
    snoozed: active.snoozed,
    showRedDot,
    refresh,
    snoozeRedDot,
  };
}
