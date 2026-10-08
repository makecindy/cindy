import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/** Shared by signed-out recovery and the signed-in warning; never modifies credentials. */
export function CredentialStoreHelpDialog({
  open,
  onOpenChange,
  reason = 'credentials',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reason?: 'credentials' | 'rate-limit';
}) {
  const { t } = useTranslation();
  const [logsFailed, setLogsFailed] = useState(false);
  const platform = window.electronAPI?.platform;

  useEffect(() => {
    if (!open) setLogsFailed(false);
  }, [open]);

  const openLogs = async () => {
    try {
      const result = await window.electronAPI.openLogsDir();
      setLogsFailed(!result.success);
    } catch {
      setLogsFailed(true);
    }
  };

  const rateLimited = reason === 'rate-limit';
  const steps = rateLimited
    ? [t('login.rateLimit.guidance'), t('login.rateLimit.support')]
    : [
        ...(platform === 'darwin' ? [t('credentialStore.dialog.stepMacKeychain')] : []),
        ...(platform === 'linux' ? [t('credentialStore.dialog.stepLinuxKeyring')] : []),
        t(
          platform === 'darwin'
            ? 'credentialStore.dialog.stepRestartMac'
            : 'credentialStore.dialog.stepRestart',
        ),
        t('credentialStore.dialog.stepSupport'),
      ];

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(rateLimited ? 'login.errors.RATE_LIMITED' : 'credentialStore.dialog.title')}
      description={t(rateLimited ? 'login.rateLimit.intro' : 'credentialStore.dialog.intro')}
      contentSelectable
      content={
        <div className="space-y-3 text-13 leading-relaxed text-[var(--confirm-desc)]">
          <ol className="list-decimal space-y-2 pl-5">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {!rateLimited && <p>{t('credentialStore.dialog.preserveData')}</p>}
          <p className="break-words">
            {rateLimited ? 'RATE_LIMITED' : 'CREDENTIAL_STORE_UNAVAILABLE'}
          </p>
          {logsFailed && <p role="alert">{t('credentialStore.dialog.logsFailed')}</p>}
        </div>
      }
      confirmText={t('credentialStore.dialog.confirm')}
      showCancel={false}
      onConfirm={() => onOpenChange(false)}
      tertiaryText={t('credentialStore.dialog.openLogs')}
      onTertiary={() => void openLogs()}
    />
  );
}
