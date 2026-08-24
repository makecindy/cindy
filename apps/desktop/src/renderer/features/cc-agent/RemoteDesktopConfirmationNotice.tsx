import { MonitorSmartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Read-only projection for confirmations that can only be resolved on the Host Desktop. */
export function RemoteDesktopConfirmationNotice() {
  const { t } = useTranslation();

  return (
    <div
      className="flex w-full max-w-[914px] items-start gap-3 rounded-[12px] border border-[var(--chat-input-border)] bg-[var(--chat-input-bg)] px-4 py-3"
      data-testid="remote-desktop-confirmation-notice"
      role="status"
    >
      <MonitorSmartphone
        aria-hidden="true"
        className="mt-0.5 shrink-0 text-[var(--status-bar-meta)]"
        size={18}
      />
      <div className="min-w-0">
        <p className="text-14 font-semibold leading-tight text-[var(--chat-input-text)]">
          {t('ccAgent.remoteDesktopConfirmation.title')}
        </p>
        <p className="mt-1 text-12 leading-relaxed text-[var(--status-bar-meta)]">
          {t('ccAgent.remoteDesktopConfirmation.description')}
        </p>
      </div>
    </div>
  );
}
