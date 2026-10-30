import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';

/** Owned by the surface host so dismissing its dialog does not discard an upload or its code. */
export function useManualLogUpload() {
  const { t } = useTranslation();
  const [uploading, setUploading] = useState(false);
  const inFlight = useRef(false);
  const [uploadCode, setUploadCode] = useState<string | null>(null);

  const handleUpload = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setUploadCode(null);
    setUploading(true);
    try {
      const result = await window.electronAPI.uploadLogsNow();
      setUploadCode(result.uploadCode);
      toast.success(t('logSupport.uploaded', { code: result.uploadCode }));
      // 编号是这次上报唯一的可报凭据,顺手放进剪贴板,省得用户从 toast 里抄。
      try {
        await navigator.clipboard.writeText(result.uploadCode);
      } catch {
        // 剪贴板不可用不影响主流程 —— 编号保留在界面上，可手动选择复制。
      }
    } catch (err) {
      const code = extractIpcError(err)?.code;
      switch (code) {
        case 'LOG_UPLOAD_UNAVAILABLE':
          toast.error(t('settings.about.logUpload.errorUnavailable'));
          break;
        case 'PRIVACY_CONSENT_REQUIRED':
          toast.error(t('settings.about.logUpload.errorConsentRequired'));
          break;
        case 'LOG_UPLOAD_EMPTY':
          toast.error(t('settings.about.logUpload.errorEmpty'));
          break;
        case 'LOG_UPLOAD_BUSY':
          toast.error(t('settings.about.logUpload.errorBusy'));
          break;
        default:
          toast.error(t('settings.about.logUpload.errorFailed'));
      }
    } finally {
      inFlight.current = false;
      setUploading(false);
    }
  };

  return { uploading, uploadCode, handleUpload };
}
