/**
 * Keeps scheduler-held session references synchronized with their main-process
 * lifecycle classification. Existing results stay visible while a new batch is
 * fetched, matching the scheduler page's no-empty-frame data policy.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import * as sessionService from '@/lib/sessionService';
import type { SessionReference } from '../../../../shared/sessionReference';

export function useSessionReferences(
  sessionIds: readonly string[],
): ReadonlyMap<string, SessionReference> {
  const key = useMemo(
    () =>
      Array.from(new Set(sessionIds.filter(Boolean)))
        .sort()
        .join('\u0000'),
    [sessionIds],
  );
  const ids = useMemo(() => (key ? key.split('\u0000') : []), [key]);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const requestRevisionRef = useRef(0);
  const [references, setReferences] = useState<ReadonlyMap<string, SessionReference>>(
    () => new Map(),
  );

  const refresh = useCallback(async () => {
    const requestedIds = idsRef.current;
    const revision = ++requestRevisionRef.current;
    if (requestedIds.length === 0) {
      setReferences(new Map());
      return;
    }
    try {
      const resolved = await sessionService.resolveReferences(requestedIds);
      if (requestRevisionRef.current !== revision) return;
      setReferences(new Map(resolved.map((reference) => [reference.sessionId, reference])));
    } catch {
      // Keep the previous snapshot. Navigation performs its own final preflight,
      // so a transient read failure cannot open a known-deleted session.
    }
  }, [key]);

  useEffect(() => {
    void refresh();
    if (ids.length === 0) return;
    const offPatched = window.electronAPI.localDb.sessionsPush.onPatched(
      ({ sessionId }, ownerStamp) => {
        if (!isDataOwnerPushCurrent(ownerStamp)) return;
        if (idsRef.current.includes(sessionId)) void refresh();
      },
    );
    const offCreated = window.electronAPI.localDb.sessionsPush.onCreated(
      ({ sessionId }, ownerStamp) => {
        if (!isDataOwnerPushCurrent(ownerStamp)) return;
        if (idsRef.current.includes(sessionId)) void refresh();
      },
    );
    return () => {
      requestRevisionRef.current += 1;
      offPatched();
      offCreated();
    };
  }, [refresh]);

  return references;
}
