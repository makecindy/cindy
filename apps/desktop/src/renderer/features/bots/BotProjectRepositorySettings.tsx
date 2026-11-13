import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Spinner } from '@/components/ui/spinner';
import type { BotProjectRepositoryStatus } from '../../../shared/botProjectMode';
import { useBotTranslation } from './botPronounContext';
import { useBotSettingsTarget } from './useBotSettingsTarget';

/** Reads only while this page is open; retry is an explicit write on the buddy's computer. */
export function BotProjectRepositorySettings({ botId }: { botId: string }) {
  const { t } = useBotTranslation();
  const { projectRepository } = useBotSettingsTarget();
  const [status, setStatus] = useState<BotProjectRepositoryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async (retry: boolean) => {
    if (!projectRepository) return;
    const request = ++generation.current;
    setBusy(true);
    try {
      const next = await projectRepository(botId, retry);
      if (generation.current === request) setStatus(next);
    } catch {
      if (generation.current === request) setStatus('failed');
    } finally {
      if (generation.current === request) setBusy(false);
    }
  }, [botId, projectRepository]);

  useEffect(() => {
    setStatus(null);
    void load(false);
    return () => { generation.current += 1; };
  }, [load]);

  if (!projectRepository) return null;
  if (!status) return <div role="status"><Spinner size={16} /></div>;
  if (status === 'ready') return <p role="status" className="text-13 text-[var(--text-secondary)]">{t('bots.homeFolder.repository.ready')}</p>;
  const description = {
    'needs-identity': 'needsIdentity',
    'not-ready': 'notReady',
    unavailable: 'unavailable',
    failed: 'failed',
  }[status];
  return (
    <ErrorNotice
      role="status"
      message={t('bots.homeFolder.repository.notReadyTitle')}
      description={<>{t(`bots.homeFolder.repository.${description}`)} <span>{t('bots.homeFolder.repository.keepUsing')}</span></>}
      actions={(
        <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void load(true)}>
          {busy ? <Spinner size={14} /> : null}
          {t('bots.retry')}
        </Button>
      )}
    />
  );
}
