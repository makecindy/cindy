import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { GIT_REVIEW_REMOTE_OP_CHANNEL, isScopedPeer } from '@cindy/device-link';
import { isMobileAuthOwnerCurrent, type MobileAuthOwnerGeneration } from '@/auth/authOwnerGeneration';
import type { RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { decodeGzipBase64TextBounded } from '@/utils/gzipBase64';
import { parseMobileTurnChanges, type MobileTurnChanges } from './mobileTurnChanges';

export const TURN_CHANGES_UPDATED = 'maker:turn-change-set:updated';
const listeners = new Set<(deviceId: string, payload: unknown) => void>();
const EMPTY: readonly MobileTurnChanges[] = [];

export function applyMobileTurnChangesPush(deviceId: string, payload: unknown): void {
  if (isScopedPeer(deviceId)) return;
  for (const listener of listeners) listener(deviceId, payload);
}

export function useMobileTurnChanges({
  deviceId, sessionId, owner, syncKey, enabled, invoke,
}: {
  deviceId: string;
  sessionId: string;
  owner: MobileAuthOwnerGeneration;
  syncKey: string | null;
  enabled: boolean;
  invoke: RemoteInvoke;
}): readonly MobileTurnChanges[] {
  const [snapshot, setSnapshot] = useState<{
    key: string;
    summaries: readonly MobileTurnChanges[];
  }>();
  const key = enabled && syncKey && owner.accountKey && !isScopedPeer(deviceId)
    ? JSON.stringify([owner.accountKey, owner.generation, deviceId, sessionId, syncKey]) : null;

  useFocusEffect(useCallback(() => {
    if (!key) return;
    let active = true;
    let history: MobileTurnChanges[] = [];
    const updates = new Map<string, MobileTurnChanges>();
    const current = () => active && isMobileAuthOwnerCurrent(owner);
    const publish = () => {
      if (!current()) return;
      const merged = new Map(history.map((summary) => [summary.id, summary]));
      for (const [id, summary] of updates) merged.set(id, summary);
      setSnapshot({ key, summaries: [...merged.values()] });
    };
    const listen = (source: string, payload: unknown) => {
      if (!current() || source !== deviceId || !payload || typeof payload !== 'object') return;
      const pushed = payload as { sessionId?: unknown; summary?: unknown };
      if (pushed.sessionId !== sessionId) return;
      const summary = parseMobileTurnChanges(pushed.summary, sessionId);
      if (summary) {
        updates.set(summary.id, summary);
        publish();
      }
    };
    listeners.add(listen);
    void invoke<{ ok?: boolean; result?: unknown; resultGz?: string }>(
      deviceId, GIT_REVIEW_REMOTE_OP_CHANNEL, [{ op: 'turn-list', payload: { sessionId } }],
    ).then((response) => {
      if (!current() || !response?.ok) return;
      const result = typeof response.resultGz === 'string'
        ? JSON.parse(decodeGzipBase64TextBounded(response.resultGz, 16 * 1024 * 1024)) as unknown
        : response.result;
      if (!Array.isArray(result)) return;
      history = result.flatMap((value: unknown) => {
        const summary = parseMobileTurnChanges(value, sessionId);
        return summary ? [summary] : [];
      });
      publish();
    }).catch(() => {
      // Older hosts and disconnected peers keep the message timeline usable.
    });
    return () => {
      active = false;
      listeners.delete(listen);
    };
  }, [deviceId, invoke, key, owner, sessionId]));

  return key && snapshot?.key === key ? snapshot.summaries : EMPTY;
}
