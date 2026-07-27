import { Copy, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import type { ProviderOAuthDeviceCode } from '@/hooks/useProviderOAuthDeviceCode';

export function OAuthDeviceCodeCard({
  deviceCode,
}: {
  deviceCode?: ProviderOAuthDeviceCode | null;
}) {
  const { t } = useTranslation();
  const verificationHost = (() => {
    if (!deviceCode) return '';
    try {
      return new URL(deviceCode.verificationUrl).hostname;
    } catch {
      return '';
    }
  })();

  return (
    <div
      aria-live="polite"
      className="flex flex-col gap-3 rounded-xl border p-3"
      style={{
        backgroundColor: 'var(--surface-card-ivory)',
        borderColor: 'var(--border-default)',
      }}
    >
      {deviceCode ? (
        <>
          <span className="text-12" style={{ color: 'var(--text-secondary)' }}>
            {t('settings.providers.wizard.deviceCodePrompt')}
          </span>
          <code
            className="select-all text-20 font-semibold tracking-[0.16em]"
            style={{ color: 'var(--text-primary)' }}
          >
            {deviceCode.userCode}
          </code>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void Promise.resolve()
                  .then(() => navigator.clipboard.writeText(deviceCode.userCode))
                  .then(() =>
                    toast.success(t('settings.providers.wizard.deviceCodeCopied')),
                  )
                  .catch(() =>
                    toast.error(t('settings.providers.wizard.deviceCodeCopyFailed')),
                  );
              }}
              className="flex h-8 items-center gap-1.5 rounded-full border px-3 text-12 font-medium transition-colors hover:bg-[var(--surface-hover)]"
              style={{
                borderColor: 'var(--settings-btn-secondary-border)',
                color: 'var(--settings-btn-secondary-text)',
              }}
            >
              <Copy size={13} />
              {t('settings.providers.wizard.copyDeviceCode')}
            </button>
            <button
              type="button"
              onClick={() => {
                void window.electronAPI
                  .openExternal(deviceCode.verificationUrl)
                  .then((result) => {
                    if (!result.success) {
                      toast.error(t('settings.providers.wizard.verificationPageOpenFailed'));
                    }
                  })
                  .catch(() =>
                    toast.error(t('settings.providers.wizard.verificationPageOpenFailed')),
                  );
              }}
              className="flex h-8 items-center gap-1.5 rounded-full border px-3 text-12 font-medium transition-colors hover:bg-[var(--surface-hover)]"
              style={{
                borderColor: 'var(--settings-btn-secondary-border)',
                color: 'var(--settings-btn-secondary-text)',
              }}
            >
              <ExternalLink size={13} />
              {t('settings.providers.wizard.openVerificationPage')}
              {verificationHost && (
                <span className="font-normal" style={{ color: 'var(--text-tertiary)' }}>
                  · {verificationHost}
                </span>
              )}
            </button>
          </div>
          <span className="text-11" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.providers.wizard.deviceCodeWaiting')}
          </span>
        </>
      ) : (
        <span className="text-12" style={{ color: 'var(--text-secondary)' }}>
          {t('settings.providers.wizard.preparingDeviceCode')}
        </span>
      )}
    </div>
  );
}
