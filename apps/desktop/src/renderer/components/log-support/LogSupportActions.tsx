import { useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { FolderOpen, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useLogUploadSettings } from '@/hooks/useLogUploadSettings';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { LEGAL_LINKS } from '../../../shared/legalLinks';
import { LEGAL_TERMS_VERSION } from '../../../shared/legalTermsVersion';
import { useManualLogUpload } from './useManualLogUpload';

interface LogSupportRowProps {
  presentation?: 'settings' | 'dialog';
}

const inlineConsentAction =
  'rounded-sm underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

// Shared by Settings and the startup/login recovery surface. Neither action needs a login.
export function OpenLogsRow({ presentation = 'settings' }: LogSupportRowProps) {
  const { t } = useTranslation();
  const inDialog = presentation === 'dialog';
  const handleOpen = async () => {
    try {
      const res = await window.electronAPI.openLogsDir();
      if (!res.success) toast.error(t('settings.about.openLogsDirError'));
    } catch {
      toast.error(t('settings.about.openLogsDirError'));
    }
  };

  return (
    // Settings rows use the shared px-4 py-4 gutter (DESIGN.md §4); dialogs supply their own panel padding.
    <div
      className={cn(
        'flex justify-between gap-3',
        inDialog ? 'items-start' : 'items-center px-4 py-4',
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span
          className={cn(
            'text-13',
            inDialog
              ? 'text-[var(--confirm-title)]'
              : 'font-medium text-[var(--settings-section-sublabel)]',
          )}
        >
          {t('settings.about.logsDirLabel')}
        </span>
        {inDialog && (
          <p className="text-12 leading-normal text-[var(--confirm-desc)]">
            {t('logSupport.localFiles')}
          </p>
        )}
      </div>
      <Button
        variant="secondary"
        size="sm"
        type="button"
        onClick={handleOpen}
        palette={inDialog ? 'confirmation' : 'default'}
        className={inDialog ? 'px-3' : '-mr-1 px-2.5'}
        title={t('settings.about.openLogsDirTooltip')}
      >
        {!inDialog && <FolderOpen size={13} />}
        {t('settings.about.openLogsDir')}
      </Button>
    </div>
  );
}

/**
 * 「上传日志」按钮。
 *
 * 成功后必须给出上传编号(用户报障时口述给我们),所以保留可选择的编号并尝试复制到剪贴板。
 * 四种失败按 IPC 错误码给可区分的文案:未配置目标 / 未同意隐私政策 / 采到 0 条 / 上传失败。
 */
export function UploadLogsRow() {
  const upload = useManualLogUpload();
  return <UploadLogsActionRow upload={upload} />;
}

export function UploadLogsActionRow({
  presentation = 'settings',
  upload,
}: LogSupportRowProps & { upload: ReturnType<typeof useManualLogUpload> }) {
  const { t } = useTranslation();
  const inDialog = presentation === 'dialog';
  const { state, acceptManualConsent } = useLogUploadSettings();
  const { uploading, uploadCode, handleUpload } = upload;
  const [accepting, setAccepting] = useState(false);
  const focusUploadOnConsent = useRef(false);
  const uploadButtonRef = useRef<HTMLButtonElement>(null);

  const uploadAvailable = inDialog
    ? state.targetConfigured && state.privacyConsentAccepted
    : state.manualUploadAvailable;
  const showConsentAction = !inDialog && state.manualUploadConsentRequired;
  const unavailableReason = !state.targetConfigured
    ? t('settings.about.logUpload.unavailableNotConfigured')
    : !uploadAvailable && !showConsentAction
      ? t('settings.about.logUpload.unavailableNoConsent')
      : null;

  useEffect(() => {
    if (focusUploadOnConsent.current && state.manualUploadAvailable) {
      focusUploadOnConsent.current = false;
      uploadButtonRef.current?.focus();
    }
  }, [state.manualUploadAvailable]);

  const handleAccept = async () => {
    focusUploadOnConsent.current = true;
    setAccepting(true);
    try {
      await acceptManualConsent(LEGAL_TERMS_VERSION);
    } catch {
      focusUploadOnConsent.current = false;
      toast.error(t('settings.about.logUpload.saveFailed'));
    } finally {
      setAccepting(false);
    }
  };

  const openPrivacyPolicy = async () => {
    try {
      const result = await window.electronAPI.openExternal(LEGAL_LINKS.privacyPolicy);
      if (result.success) return;
    } catch {
      // Use the same localized feedback as the legal links in About.
    }
    toast.error(t('settings.about.legal.openFailed'));
  };
  const descriptionClassName = inDialog
    ? 'text-12 leading-normal text-[var(--confirm-desc)]'
    : 'text-12 leading-[1.4] text-[var(--text-secondary)]';

  return (
    // Same inherited Settings row gutter as OpenLogsRow; not an additional dialog inset.
    <div className={cn('flex flex-col gap-1.5', !inDialog && 'px-4 py-4')}>
      {/* items-start:本行的说明有三段(用途 / 上传内容边界 / 不可用原因),按钮若垂直居中会浮在
          文字块中间;与标签对齐才和同页其它「标签 + 按钮」行(日志目录 / 服务条款)读起来一致。 */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span
            className={cn(
              'text-13',
              inDialog
                ? 'text-[var(--confirm-title)]'
                : 'font-medium text-[var(--settings-section-sublabel)]',
            )}
          >
            {t('settings.about.logUpload.uploadLabel')}
          </span>
          <p className={descriptionClassName}>
            {t(
              inDialog
                ? 'logSupport.uploadDescription'
                : 'settings.about.logUpload.uploadDescription',
            )}
          </p>
          {inDialog ? (
            <details className={descriptionClassName}>
              <summary className="w-fit cursor-pointer underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
                {t('logSupport.uploadDetails')}
              </summary>
              <p className="mt-2">{t('settings.about.logUpload.scopeDescription')}</p>
            </details>
          ) : (
            <p className={descriptionClassName}>{t('settings.about.logUpload.scopeDescription')}</p>
          )}
          {uploadCode && (
            <p
              role="status"
              className="select-text break-words text-13 leading-normal text-[var(--text-primary)]"
            >
              {t('logSupport.uploaded', { code: uploadCode })}
            </p>
          )}
          {unavailableReason !== null && (
            <p className={descriptionClassName}>
              {unavailableReason}
            </p>
          )}
          {showConsentAction && (
            <p className={descriptionClassName}>
              <Trans
                i18nKey="settings.about.logUpload.consentPrompt"
                components={{
                  policy: (
                    <a
                      href={LEGAL_LINKS.privacyPolicy}
                      className={inlineConsentAction}
                      onClick={(event) => {
                        event.preventDefault();
                        void openPrivacyPolicy();
                      }}
                    />
                  ),
                  accept: (
                    <button
                      type="button"
                      className={cn(inlineConsentAction, 'cursor-pointer disabled:opacity-60')}
                      disabled={accepting}
                      onClick={() => void handleAccept()}
                    />
                  ),
                }}
              />
            </p>
          )}
        </div>
        <Button
          ref={uploadButtonRef}
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => void handleUpload()}
          disabled={!uploadAvailable || uploading || state.loading}
          loading={uploading}
          palette={inDialog ? 'confirmation' : 'default'}
          className={inDialog ? 'px-3' : '-mr-1 px-2.5'}
          title={t('settings.about.logUpload.uploadTooltip')}
        >
          {!inDialog && <Upload size={13} />}
          {t('settings.about.logUpload.uploadButton')}
        </Button>
      </div>
    </div>
  );
}
