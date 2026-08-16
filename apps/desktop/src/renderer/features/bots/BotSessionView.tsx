import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { CCAgentSessionView } from '@/features/cc-agent/CCAgentSessionView';

/**
 * A Bot URL is a navigation projection, not authority to adopt an arbitrary
 * Cindy task. Check the durable Bot link before mounting the writable chat.
 */
export function BotSessionView() {
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
      .get(botId)
      .then((bot) => {
        if (cancelled) return;
        if (!bot || typeof bot !== 'object') {
          setAllowed(false);
          return;
        }
        const sessions = (bot as { sessions?: unknown }).sessions;
        const profileStatus = (bot as { status?: unknown }).status;
        const found =
          profileStatus === 'active' &&
          Array.isArray(sessions) &&
          sessions.some((row) => {
            if (!row || typeof row !== 'object') return false;
            const projection = row as { id?: unknown; kind?: unknown; status?: unknown };
            return (
              projection.id === sessionId &&
              (projection.kind === 'chat' || projection.kind === 'route') &&
              projection.status === 'active'
            );
          });
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
    return <Navigate to={botId ? `/bots/${botId}` : '/bots'} replace />;
  }
  return <CCAgentSessionView />;
}
