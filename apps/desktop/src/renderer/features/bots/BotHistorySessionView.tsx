import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { CCAgentSessionView } from '@/features/cc-agent/CCAgentSessionView';

/** Historical Bot transcripts are reviewable but never writable from the history route. */
export function BotHistorySessionView() {
  const { t } = useTranslation();
  const { botId, sessionId } = useParams();
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!botId || !sessionId) {
      setAllowed(false);
      return () => {
        cancelled = true;
      };
    }
    void window.electronAPI.localDb.bots
      .history(botId)
      .then((rows) => {
        if (cancelled) return;
        const found = rows.some(
          (row) =>
            !!row &&
            typeof row === 'object' &&
            'id' in row &&
            typeof (row as { id?: unknown }).id === 'string' &&
            (row as { id: string }).id === sessionId,
        );
        setAllowed(found);
      })
      .catch(() => {
        if (!cancelled) setAllowed(false);
      });
    return () => {
      cancelled = true;
    };
  }, [botId, sessionId]);

  if (allowed === null) {
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)]">
        <p className="text-13 text-[var(--text-secondary)]">{t('ccAgent.common.loading')}</p>
      </main>
    );
  }
  if (!allowed || !sessionId) {
    return <Navigate to={botId ? `/bots/${botId}?settings=1` : '/bots'} replace />;
  }
  return <CCAgentSessionView readOnly />;
}
