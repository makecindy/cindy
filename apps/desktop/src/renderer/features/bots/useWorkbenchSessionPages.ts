import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@/lib/ccAgent.types';
import * as sessionService from '@/lib/sessionService';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { onRefresh } from '@/lib/sessionsBus';
import { sessionsStore } from '@/lib/sessionsStore';

const PAGE_SIZE = 200;
type Cursor = { updatedAt: number; id: string };
type Mutation = { patch: Partial<Session>; row: Session | null };
/** Bounded local reads; a full page never means all history has loaded. */
export function useWorkbenchSessionPages(
  scope: string,
  status: 'active' | 'archived',
  enabled: boolean,
) {
  const [rows, setRows] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const cursor = useRef<Cursor | undefined>(undefined);
  const pageCount = useRef(0);
  const busy = useRef(false);
  const refreshPending = useRef(false);
  const mutations = useRef(new Map<string, Mutation>());
  const generation = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const started = useRef(false);
  const applyMutations = useCallback(
    (values: Session[], changes = mutations.current) => {
      const next = new Map(values.map((row) => [row.id, row]));
      for (const [id, { patch, row }] of changes) {
        const current = next.get(id) ?? row;
        if (current)
          next.set(id, {
            ...current,
            ...patch,
            ...(patch._count ? { _count: { ...current._count, ...patch._count } } : {}),
          });
      }
      return [...next.values()].filter((row) => row.status === status);
    },
    [status],
  );
  const load = useCallback(
    async function readPages(refresh = false): Promise<void> {
      if (busy.current) {
        if (refresh) refreshPending.current = true;
        return;
      }
      started.current = true;
      busy.current = true;
      mutations.current.clear();
      setLoading(true);
      setError(false);
      const version = generation.current;
      const owner = getDataOwnerGeneration();
      try {
        let before = refresh ? undefined : cursor.current;
        const pages = refresh ? Math.max(1, pageCount.current) : 1;
        const collected: Session[] = [];
        let fetched = 0;
        let more = false;
        // Reconcile the already loaded window, not just its head: missing rows may
        // have been deleted or moved while disconnected. Never scan unseen history.
        for (; fetched < pages;) {
          const page = await sessionService.list(PAGE_SIZE, status, { fresh: true, before });
          if (version !== generation.current || !isDataOwnerGenerationCurrent(owner)) return;
          collected.push(...page);
          fetched++;
          more = page.length === PAGE_SIZE;
          const tail = page.at(-1);
          if (tail) before = { updatedAt: Date.parse(tail.updatedAt), id: tail.id };
          if (!more) break;
        }
        const changes = new Map(mutations.current);
        setRows((previous) =>
          applyMutations(
            [
              ...new Map(
                [...(refresh ? [] : previous), ...collected].map((row) => [row.id, row]),
              ).values(),
            ],
            changes,
          ),
        );
        setHasMore(more);
        cursor.current = before;
        pageCount.current = refresh ? fetched : pageCount.current + fetched;
      } catch {
        if (version === generation.current && isDataOwnerGenerationCurrent(owner)) setError(true);
      } finally {
        if (version === generation.current) {
          busy.current = false;
          mutations.current.clear();
          setLoading(false);
          if (refreshPending.current && enabledRef.current) {
            refreshPending.current = false;
            void readPages(true);
          }
        }
      }
    },
    [status, applyMutations],
  );
  useEffect(() => {
    const reset = () => {
      generation.current++;
      started.current = false;
      cursor.current = undefined;
      pageCount.current = 0;
      busy.current = false;
      refreshPending.current = false;
      mutations.current.clear();
      setRows([]);
      setHasMore(true);
      setError(false);
      setLoading(false);
      if (enabledRef.current) void load();
    };
    reset();
    const offPatch = sessionsStore.subscribePatches((id, patch, row) => {
      const prior = busy.current ? mutations.current.get(id) : undefined;
      const mutation = { patch: { ...prior?.patch, ...patch }, row: row ?? prior?.row ?? null };
      if (busy.current) mutations.current.set(id, mutation);
      const changes = new Map([[id, mutation]]);
      setRows((previous) => applyMutations(previous, changes));
    });
    const unsubscribe = sessionsStore.subscribe((change) => {
      if (change === 'reset') {
        reset();
        return;
      }
      // Share original list snapshots (including newly created rows), without
      // interpreting absence from its bounded cache as deletion of older pages.
      const latest = sessionsStore.getByFilter(status) ?? [];
      const changes = new Map(mutations.current);
      setRows((previous) => {
        const current = new Map(latest.map((row) => [row.id, row]));
        const ids = new Set(previous.map((row) => row.id));
        return applyMutations([
          ...latest.filter((row) => !ids.has(row.id)),
          ...previous.map((row) => current.get(row.id) ?? row),
        ], changes);
      });
    });
    const offRefresh = onRefresh(() => {
      if (enabledRef.current) void load(true);
      else refreshPending.current = true;
    });
    return () => {
      offRefresh();
      generation.current++;
      unsubscribe();
      offPatch();
    };
  }, [scope, status, load, applyMutations]);
  useEffect(() => {
    if (enabled && (!started.current || refreshPending.current)) {
      const refresh = refreshPending.current;
      refreshPending.current = false;
      void load(refresh);
    }
  }, [enabled, load]);
  return { rows, loading, error, hasMore, load };
}
