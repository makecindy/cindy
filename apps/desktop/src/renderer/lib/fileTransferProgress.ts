import { i18n } from '@/i18n';
import { formatBytes } from '@/features/cc-agent/workdir-browse/lib/fileMeta';
import { addFileTransferToast, removeFileTransferToast, updateFileTransferToast } from './fileTransferToasts';

export type FileTransferProgress = {
  received: number;
  total: number;
  phase?: 'pack' | 'upload' | 'download' | 'extract';
};

/** One sampler per transfer, shared by toasts and previews. No synthetic progress. */
export function createFileTransferProgressValues() {
  let sample: { time: number; bytes: number; phase: string; speed: number | null } | undefined;
  let lastReceived = 0;
  return (e: FileTransferProgress) => {
    const phase = e.phase ?? 'download';
    const now = performance.now();
    const received = Math.max(0, e.received);
    if (!sample || sample.phase !== phase || received < lastReceived) {
      sample = { time: now, bytes: received, phase, speed: null };
    } else if (now - sample.time >= 800) {
      const speed = ((received - sample.bytes) * 1000) / (now - sample.time);
      sample = { time: now, bytes: received, phase, speed };
    }
    lastReceived = received;
    return {
      // Until bytes arrive, an unavailable peer may be preparing an OSS fallback.
      preparing: phase === 'download' && received === 0,
      percent: e.total > 0 ? Math.min(100, Math.floor((received / e.total) * 100)) : undefined,
      received: formatBytes(received),
      total: formatBytes(Math.max(0, e.total)),
      speed: sample.speed === null ? '—' : `${formatBytes(Math.round(sample.speed))}/s`,
    };
  };
}

export function createFileTransferProgressText(): (e: FileTransferProgress) => string {
  const sample = createFileTransferProgressValues();
  return (e) => {
    const values = sample(e);
    if (e.phase === 'pack')
      return i18n.t('chat.remoteFile.downloadPacking', { size: values.received });
    if (e.phase === 'extract') return i18n.t('chat.remoteFile.downloadExtracting');
    if (values.preparing) return i18n.t('chat.remoteFile.fetching');
    const key = e.phase === 'upload' ? 'uploadProgress' : 'downloadProgress';
    return i18n.t(`chat.remoteFile.${key}${e.total > 0 ? '' : 'Unknown'}`, values);
  };
}

/** Subscribe before starting IPC. Paths alone cannot distinguish devices or concurrent reads. */
export function observeFileTransferProgress(onProgress: (event: FileTransferProgress) => void) {
  const requestId = crypto.randomUUID();
  let disposed = false;
  const unsubscribe = window.electronAPI.fileBrowser.onTransferProgress((e) => {
    if (!disposed && e.requestId === requestId) onProgress(e);
  });
  return {
    requestId,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}

export function observeFileTransferProgressText(onProgress: (text: string) => void) {
  const format = createFileTransferProgressText();
  return observeFileTransferProgress((e) => onProgress(format(e)));
}

/**
 * Same delayed, persistent loading toast for open/reveal/copy and explicit downloads.
 * Its Cancel button aborts the chatFetch / chatDownload started with `requestId`;
 * callers check `cancelled` and skip the follow-up action and failure toast.
 */
export function createFileTransferToast(absPath: string) {
  let cancelled = false;
  let disposed = false;
  let text = i18n.t('chat.remoteFile.fetching');
  const progress = observeFileTransferProgressText((next) => {
    text = next;
    updateFileTransferToast(progress.requestId, text);
  });
  const delayed = setTimeout(() => {
    addFileTransferToast({
      id: progress.requestId,
      name: absPath.split(/[\\/]/).filter(Boolean).at(-1) ?? absPath,
      message: text,
      variant: 'loading',
      duration: 0,
      createdAt: Date.now(),
      exiting: false,
      action: {
        label: i18n.t('chat.remoteFile.cancelTransfer'),
        onClick: () => {
          if (cancelled || disposed) return;
          cancelled = true;
          progress.dispose();
          removeFileTransferToast(progress.requestId);
          void window.electronAPI.fileBrowser.chatCancel(progress.requestId).catch(() => {});
        },
      },
    });
  }, 600);
  return {
    requestId: progress.requestId,
    get cancelled() {
      return cancelled;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(delayed);
      progress.dispose();
      removeFileTransferToast(progress.requestId);
    },
  };
}
