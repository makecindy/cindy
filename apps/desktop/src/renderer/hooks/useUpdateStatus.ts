import { useEffect, useState } from 'react';

/**
 * useUpdateStatus — listens to the main-process `update-status` IPC channel
 * and exposes the current update state to the renderer.
 *
 * On mount, queries the current status from main process to catch any status
 * set before this hook subscribed (e.g. update downloaded during splash).
 * The sidebar displays check/download progress before offering relaunch at ready.
 */
export function useUpdateStatus() {
  const [status, setStatus] = useState<UpdateStatusPayload['status']>('idle');
  const [version, setVersion] = useState<string | undefined>();
  const [errorCode, setErrorCode] = useState<string | undefined>();
  // 下载进度（0-100）。downloading 的推送带它；invoke 的初始
  // 快照不含 progress，错过的进度由下一条推送补上即可。
  const [progress, setProgress] = useState<number | undefined>();

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getUpdateStatus || !api.onUpdateStatus) return undefined;
    let cancelled = false;
    let receivedEvent = false;
    const apply = (payload: UpdateStatusPayload) => {
      setStatus(payload.status);
      setVersion(payload.version);
      setErrorCode(payload.errorCode);
      setProgress(typeof payload.progress === 'number' ? payload.progress : undefined);
    };
    // A delayed initial snapshot must not roll a newer pushed state back to idle.
    const unsubscribe = api.onUpdateStatus((payload) => {
      if (!cancelled && payload && typeof payload.status === 'string') {
        receivedEvent = true;
        apply(payload);
      }
    });
    api.getUpdateStatus().then((initial) => {
      if (!cancelled && !receivedEvent && initial && typeof initial.status === 'string') {
        apply({ ...initial, status: initial.status as UpdateStatusPayload['status'] });
      }
    }).catch(() => {});

    return () => { cancelled = true; unsubscribe(); };
  }, []);

  return { status, version, errorCode, progress };
}
