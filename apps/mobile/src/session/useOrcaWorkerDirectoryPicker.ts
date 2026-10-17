import { useCallback, useEffect, useRef, useState } from 'react';
import type { MobileMakerTransport, RemoteDirectoryListResult } from '@/device-link/mobileMakerTransport';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { filterRemoteDirectoryEntries, normalizeRemoteDirectoryDrives, shouldRetryRemoteBrowseDrives } from './newSession';

/** Browse only the chosen Worker's host; dismissal/target changes invalidate pending reads. */
export function useOrcaWorkerDirectoryPicker(params: {
  deviceId?: string;
  maker: MobileMakerTransport;
  scope: string | null;
  formEpoch: number;
  workingDir: string;
  setSheetOpen(open: boolean): void;
  onChoose(path: string | null): void;
}) {
  const [page, setPage] = useState<'workspace' | 'directory' | null>(null);
  const [directory, setDirectory] = useState<RemoteDirectoryListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const live = useRef(params);
  live.current = params;
  const owner = useRef<typeof params | null>(null);
  const returnToForm = useRef<typeof params | null>(null);
  const seq = useRef(0);
  const mounted = useRef(true);
  const isCurrent = useCallback((snapshot: typeof params | null) => !!snapshot && mounted.current
    && snapshot.deviceId === live.current.deviceId && snapshot.maker === live.current.maker
    && snapshot.scope === live.current.scope && snapshot.formEpoch === live.current.formEpoch, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; seq.current += 1; };
  }, []);
  useEffect(() => {
    seq.current += 1;
    owner.current = null;
    returnToForm.current = null;
    setPage(null);
    setDirectory(null);
    setLoading(false);
    setError(null);
  }, [params.deviceId, params.maker, params.scope, params.formEpoch]);

  const openPicker = useCallback(() => {
    if (!live.current.deviceId) return;
    owner.current = live.current;
    returnToForm.current = null;
    seq.current += 1;
    setDirectory(null);
    setError(null);
    setLoading(false);
    setShowHidden(false);
    live.current.setSheetOpen(false);
    setPage('workspace');
  }, []);
  const close = useCallback(() => {
    returnToForm.current = owner.current;
    owner.current = null;
    seq.current += 1;
    setLoading(false);
    setPage(null);
  }, []);
  const closed = useCallback(() => {
    const snapshot = returnToForm.current;
    returnToForm.current = null;
    if (isCurrent(snapshot)) live.current.setSheetOpen(true);
  }, [isCurrent]);
  const choose = useCallback((path: string | null) => {
    if (!isCurrent(owner.current)) return;
    live.current.onChoose(path);
    close();
  }, [close, isCurrent]);
  const load = useCallback(async (path: string) => {
    const snapshot = owner.current;
    if (!snapshot || !isCurrent(snapshot)) return;
    const request = ++seq.current;
    const current = () => owner.current === snapshot && request === seq.current && isCurrent(snapshot);
    setLoading(true);
    setError(null);
    try {
      let result = await withTransientRemoteRetry(() => snapshot.maker.fs.listDir(path || '~'));
      if (!current()) return;
      setDirectory(result);
      setLoading(false);
      // Windows can deliver the folder list before its drive enumeration completes.
      for (let attempt = 0; shouldRetryRemoteBrowseDrives(result.drivesPending, attempt); attempt += 1) {
        try { result = await snapshot.maker.fs.listDir(result.resolvedPath); }
        catch { return; }
        if (!current()) return;
        setDirectory(result);
      }
    } catch (err) {
      if (!current()) return;
      setError(formatRemoteError(err));
      setLoading(false);
    }
  }, [isCurrent]);
  const browse = useCallback(() => {
    if (!isCurrent(owner.current)) return;
    setPage('directory');
    void load(live.current.workingDir || '~');
  }, [isCurrent, load]);
  return {
    page, openPicker, close, closed, choose, browse, load,
    back: () => { seq.current += 1; setLoading(false); setPage('workspace'); },
    path: directory?.resolvedPath ?? '', parent: directory?.parent ?? null,
    entries: filterRemoteDirectoryEntries((directory?.entries ?? []).filter(entry => entry.kind !== 'file'), showHidden),
    drives: normalizeRemoteDirectoryDrives(directory?.drives),
    loading, error, showHidden, setShowHidden,
  };
}
