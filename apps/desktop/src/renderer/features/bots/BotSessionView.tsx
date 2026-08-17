import { useEffect, useState } from 'react';
import { ArrowLeft, CircleAlert, RefreshCcw } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { CCAgentSessionView } from '@/features/cc-agent/CCAgentSessionView';
import type { ComposerBotMention } from '@/lib/fileTypes';

type BotSessionGate =
  | { kind: 'loading' }
  | { kind: 'ready'; mentions: ComposerBotMention[] }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

function readBotMention(value: unknown, currentBotId: string): ComposerBotMention | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    enabled?: unknown;
    status?: unknown;
  };
  if (
    typeof candidate.id !== 'string'
    || candidate.id === currentBotId
    || typeof candidate.name !== 'string'
    || candidate.enabled === false
    || (candidate.status !== undefined && candidate.status !== 'active')
  ) {
    return null;
  }
  return {
    id: candidate.id,
    name: candidate.name,
    ...(typeof candidate.description === 'string' && candidate.description.trim()
      ? { description: candidate.description }
      : {}),
  };
}

/**
 * A Bot URL is a navigation projection, not authority to adopt an arbitrary
 * Cindy task. Check the durable Bot link before mounting the writable chat.
 */
export function BotSessionView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { botId, sessionId } = useParams();
  const [reloadVersion, setReloadVersion] = useState(0);
  const [gate, setGate] = useState<BotSessionGate>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    if (!botId || !sessionId) {
      setGate({ kind: 'unavailable' });
      return () => {
        cancelled = true;
      };
    }
    setGate({ kind: 'loading' });
    void Promise.all([
      window.electronAPI.localDb.bots.get(botId),
      window.electronAPI.localDb.bots.list(),
    ])
      .then(([bot, bots]) => {
        if (cancelled) return;
        if (!bot || typeof bot !== 'object') {
          setGate({ kind: 'unavailable' });
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
        if (!found) {
          setGate({ kind: 'unavailable' });
          return;
        }
        setGate({
          kind: 'ready',
          mentions: Array.isArray(bots)
            ? bots
                .map((candidate) => readBotMention(candidate, botId))
                .filter((candidate): candidate is ComposerBotMention => candidate !== null)
            : [],
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setGate({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [botId, reloadVersion, sessionId]);

  if (gate.kind === 'loading') {
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)]">
        <p className="text-13 text-[var(--text-secondary)]">{t('ccAgent.common.loading')}</p>
      </main>
    );
  }
  if (gate.kind !== 'ready' || !sessionId) {
    const failed = gate.kind === 'error';
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)] p-6">
        <section className="w-full max-w-md rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 text-center">
          <CircleAlert
            size={24}
            className="mx-auto text-[var(--text-danger)]"
            aria-hidden
          />
          <h1 className="mt-3 text-16 font-medium text-[var(--text-primary)]">
            {t(failed ? 'bots.sessionLoadFailedTitle' : 'bots.sessionUnavailableTitle')}
          </h1>
          <p className="mt-2 break-words text-12 leading-5 text-[var(--text-secondary)] [overflow-wrap:anywhere]">
            {failed ? t('bots.sessionLoadFailedDescription') : t('bots.sessionUnavailableDescription')}
          </p>
          {failed && gate.message ? (
            <p className="mt-3 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--surface)] px-3 py-2 text-left text-11 text-[var(--text-danger)] [overflow-wrap:anywhere]">
              {gate.message}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => navigate(botId ? `/bots/${botId}` : '/bots')}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
            >
              <ArrowLeft size={14} />
              {t('bots.backToBot')}
            </button>
            {failed ? (
              <button
                type="button"
                onClick={() => setReloadVersion((value) => value + 1)}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--accent-cta-bg)] px-3 text-12 font-medium text-[var(--accent-pure-cta-fg)]"
              >
                <RefreshCcw size={14} />
                {t('bots.retry')}
              </button>
            ) : null}
          </div>
        </section>
      </main>
    );
  }
  return <CCAgentSessionView botMentions={gate.mentions} />;
}
