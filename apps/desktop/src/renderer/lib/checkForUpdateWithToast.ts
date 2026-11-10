import { toast } from '@/lib/toast';

type Translate = (key: string) => string;

// Menu entries share one in-flight check and one progress notification.
let pendingCheck: Promise<void> | undefined;

export function checkForUpdateWithToast(t: Translate): Promise<void> {
  if (pendingCheck) return pendingCheck;
  pendingCheck = runCheck(t).finally(() => { pendingCheck = undefined; });
  return pendingCheck;
}

async function runCheck(t: Translate): Promise<void> {
  const id = toast.loading(t('splash.tips.checkingUpdate'));
  let unsubscribe: (() => void) | undefined;
  try {
    // Subscribe before invoking: the first IPC response can wait for the whole download.
    let downloading = false;
    unsubscribe = window.electronAPI.onUpdateStatus((payload) => {
      if (!downloading && (payload.status === 'downloading' || payload.status === 'superseding')) {
        downloading = true;
        toast.update(id, t('titleBar.updateCheckToast.downloading'));
      }
    });
    const { result } = await window.electronAPI.checkForUpdate();
    switch (result) {
      case 'idle':
        toast.success(t('titleBar.updateCheckToast.alreadyLatest'));
        break;
      case 'downloading':
        toast.warning(t('titleBar.updateCheckToast.downloading'));
        break;
      case 'ready':
        toast.success(t('titleBar.updateCheckToast.ready'));
        break;
      case 'manifest_failed':
        toast.error(t('titleBar.updateCheckToast.manifestFailed'));
        break;
      case 'download_failed':
        toast.error(t('titleBar.updateCheckToast.downloadFailed'));
        break;
      case 'manual_download':
        toast.warning(t('titleBar.updateCheckToast.manualDownload'));
        break;
    }
  } catch {
    toast.error(t('titleBar.updateCheckToast.manifestFailed'));
  } finally {
    unsubscribe?.();
    toast.dismiss(id);
  }
}
