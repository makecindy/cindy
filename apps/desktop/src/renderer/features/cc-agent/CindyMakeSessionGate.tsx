import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { getSessionFor } from '@/lib/makerTransport';
import { sessionsStore } from '@/lib/sessionsStore';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { SessionEntryError, sessionEntryFailure } from './SessionEntryError';

/** Resolve old links before mounting a chat composer or file browser. */
export function CindyMakeSessionGate({ sessionId, children }: {
  sessionId?: string;
  children: ReactNode;
}) {
  const remoteSource = useSyncExternalStore(remoteProjectsStore.subscribe, () =>
    remoteProjectsStore.getMergedRemoteSessions().find(session => session.id === sessionId)?.source,
  );
  const localSource = useSyncExternalStore(sessionsStore.subscribe, () =>
    sessionId ? sessionsStore.findById(sessionId)?.source : undefined,
  );
  const listedSource = remoteSource !== undefined ? remoteSource : localSource;
  // 列表重拉、镜像重连时任务会短暂不在缓存里。同一任务的来源一经确认就沿用，
  // 不能因此卸载正在显示的对话再重新挂载（消息清空、滚动位置丢失）。
  const confirmedRef = useRef<{ id: string; source: string | null } | null>(null);
  if (sessionId && listedSource !== undefined) {
    confirmedRef.current = { id: sessionId, source: listedSource };
  }
  const confirmed = confirmedRef.current;
  const knownSource = listedSource !== undefined
    ? listedSource
    : confirmed && confirmed.id === sessionId ? confirmed.source : undefined;
  const [loaded, setLoaded] = useState<{ id: string; source: string | null } | null>(null);
  const [failure, setFailure] = useState<{ id: string; reason: ReturnType<typeof sessionEntryFailure> } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (CINDY_MAKE_ENABLED || !sessionId || knownSource !== undefined) return;
    let cancelled = false;
    const owner = getDataOwnerGeneration();
    setFailure(null);
    void getSessionFor(sessionId).then(session => {
      if (cancelled || !isDataOwnerGenerationCurrent(owner)) return;
      if (session?.id === sessionId) {
        setLoaded({ id: session.id, source: session.source ?? null });
      } else {
        setFailure({ id: sessionId, reason: 'missing' });
      }
    }).catch(error => {
      if (!cancelled && isDataOwnerGenerationCurrent(owner)) setFailure({ id: sessionId, reason: sessionEntryFailure(error) });
    });
    return () => { cancelled = true; };
  }, [sessionId, knownSource, retry]);

  const source = knownSource !== undefined ? knownSource : (loaded && loaded.id === sessionId ? loaded.source : undefined);
  if (!CINDY_MAKE_ENABLED && isCindyMakeSource(source)) {
    return <Navigate to="/cc-agent" replace />;
  }
  if (!CINDY_MAKE_ENABLED && sessionId && source === undefined) {
    return failure?.id === sessionId
      ? <SessionEntryError reason={failure.reason} onRetry={() => setRetry(value => value + 1)} />
      : null;
  }
  return children;
}
