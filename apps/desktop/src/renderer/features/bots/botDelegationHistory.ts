import { useCallback, useEffect, useState } from 'react';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { makerApiForSticky } from '@/lib/makerTransport';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import type { BotDelegationView } from '../../../shared/botDelegation';

/**
 * Read-only view of the V1 background tasks ("委派") a teammate chat started. Nothing creates or
 * updates these rows any more, so each parent session is read once and shared by its cards and the
 * glance; no push subscription. An older remote host may still run tasks: a reconnect re-reads.
 */
interface SessionEntry {
  rows: BotDelegationView[];
  /** The first read has landed (success or failure): a missing row is then a definite "unknown". */
  resolved: boolean;
  stale: boolean;
  listeners: Set<() => void>;
  unsubscribe: (() => void) | null;
  generation: number;
}

const sessions = new Map<string, SessionEntry>();

function emit(entry: SessionEntry): void {
  for (const listener of [...entry.listeners]) listener();
}

async function read(sessionId: string, entry: SessionEntry): Promise<void> {
  const owner = getDataOwnerGeneration();
  const generation = ++entry.generation;
  const current = () =>
    isDataOwnerGenerationCurrent(owner) && sessions.get(sessionId) === entry && entry.generation === generation;
  try {
    const result = await makerApiForSticky(sessionId).listBotDelegations(sessionId);
    if (!current()) return;
    // A failed read keeps what was already shown.
    if (result.ok) entry.rows = result.delegations;
    entry.stale = !result.ok;
  } catch {
    if (!current()) return;
    entry.stale = true;
  }
  entry.resolved = true;
  emit(entry);
}

function subscribe(sessionId: string, listener: () => void): () => void {
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = { rows: [], resolved: false, stale: false, listeners: new Set(), unsubscribe: null, generation: 0 };
    sessions.set(sessionId, entry);
    const created = entry;
    const deviceId = remoteProjectsStore.getSessionDeviceId(sessionId);
    created.unsubscribe = deviceId
      ? window.electronAPI.deviceLink.onStatusChanged((state) => {
          if (state.status === 'online') void read(sessionId, created);
        })
      : null;
    void read(sessionId, created);
  }
  entry.listeners.add(listener);
  const owned = entry;
  return () => {
    owned.listeners.delete(listener);
    if (owned.listeners.size > 0) return;
    owned.unsubscribe?.();
    if (sessions.get(sessionId) === owned) sessions.delete(sessionId);
  };
}

export interface BotDelegationRecord {
  /** The stored row; null until read, or when this card's row is not found. */
  row: BotDelegationView | null;
  /** `resolved && row === null` means the task cannot be verified. */
  resolved: boolean;
  stale: boolean;
}

/** One stored background task of a teammate chat, for its history card. */
export function useBotDelegationRecord(sessionId: string | null, delegationId: string): BotDelegationRecord {
  const [record, setRecord] = useState<BotDelegationRecord>({ row: null, resolved: false, stale: false });
  const snapshot = useCallback((): BotDelegationRecord => {
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    return {
      row: entry?.rows.find((item) => item.id === delegationId) ?? null,
      resolved: entry?.resolved ?? false,
      stale: entry?.stale ?? false,
    };
  }, [delegationId, sessionId]);
  useEffect(() => {
    if (!sessionId) {
      setRecord({ row: null, resolved: false, stale: false });
      return;
    }
    setRecord(snapshot());
    return subscribe(sessionId, () => setRecord(snapshot()));
  }, [snapshot, sessionId]);
  return record;
}

/** Every stored background task of a teammate chat (the glance's outputs). */
export function useBotDelegationRecords(sessionId: string | null): readonly BotDelegationView[] {
  const [rows, setRows] = useState<readonly BotDelegationView[]>([]);
  useEffect(() => {
    if (!sessionId) {
      setRows([]);
      return;
    }
    const update = () => setRows(sessions.get(sessionId)?.rows ?? []);
    update();
    return subscribe(sessionId, update);
  }, [sessionId]);
  return rows;
}
