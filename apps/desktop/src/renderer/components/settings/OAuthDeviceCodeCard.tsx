import { Copy, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import type { ProviderOAuthDeviceCode } from '@/hooks/useProviderOAuthDeviceCode';

/** Manual recovery only; the native CLI remains the sole automatic browser opener. */
export function OAuthBrowserLink({ url, onOpen }: { url: string; onOpen?: (url: string) => Promise<void> }) {
  const { t } = useTranslation();
  return (
    <Button data-settings-search-action="Reopen the sign-in page of the running authorization" variant="secondary" size="md" onClick={() => {
      if (onOpen) { void onOpen(url).catch(() => toast.error(t('settings.providers.wizard.verificationPageOpenFailed'))); return; }
      void window.electronAPI.openExternal(url).then((result) => {
        if (!result.success) toast.error(t('settings.providers.wizard.verificationPageOpenFailed'));
      }).catch(() => toast.error(t('settings.providers.wizard.verificationPageOpenFailed')));
    }}>
      {t('settings.providers.genericOAuth.reopenLoginPage')}
    </Button>
  );
}

export function OAuthDeviceCodeCard({
  deviceCode,
  onOpen,
}: {
  deviceCode?: ProviderOAuthDeviceCode | null;
  onOpen?: (url: string) => Promise<void>;
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
            <Button
              variant="secondary"
              size="md"
              compact
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
            >
              <Copy size={13} />
              {t('settings.providers.wizard.copyDeviceCode')}
            </Button>
            <Button
              data-settings-search-action="Open the verification page of the device-code sign-in"
              variant="secondary"
              size="md"
              compact
              type="button"
              onClick={() => {
                if (onOpen) { void onOpen(deviceCode.verificationUrl).catch(() => toast.error(t('settings.providers.wizard.verificationPageOpenFailed'))); return; }
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
            >
              <ExternalLink size={13} />
              {t('settings.providers.wizard.openVerificationPage')}
              {verificationHost && (
                <span className="font-normal" style={{ color: 'var(--text-tertiary)' }}>
                  · {verificationHost}
                </span>
              )}
            </Button>
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
