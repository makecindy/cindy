import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { extractIpcError } from '@/utils/ipcError';

export function sessionEntryFailure(error: unknown): 'missing' | 'denied' | 'failed' {
  const code = extractIpcError(error)?.code;
  if (code === 'NOT_FOUND') return 'missing';
  if (code === 'PERMISSION_DENIED' || code === 'DEVICE_LINK_ACCESS_REVOKED'
    || code === 'DEVICE_LINK_REMOTE_DISABLED' || code === 'DEVICE_LINK_CONTROL_DISABLED'
    || code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED') return 'denied';
  return 'failed';
}

/** Keep the original address on failure; returning to the list is an explicit action. */
export function SessionEntryError({ reason, onRetry }: {
  reason: 'missing' | 'denied' | 'failed';
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return <main className="flex h-full items-center justify-center bg-[var(--surface)] p-6">
    <section role="alert" className="w-full max-w-md text-center">
      <p className="text-14 leading-6 text-[var(--text-primary)]">{t(`ccAgent.sessionEntry.${reason}`)}</p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Button variant="secondary" onClick={() => navigate('/cc-agent')}>{t('ccAgent.sessionEntry.back')}</Button>
        {reason === 'failed' && onRetry ? <Button variant="secondary" onClick={onRetry}>{t('ccAgent.sessionEntry.retry')}</Button> : null}
      </div>
    </section>
  </main>;
}
