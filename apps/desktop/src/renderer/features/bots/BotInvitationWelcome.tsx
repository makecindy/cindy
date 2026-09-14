import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { BotAvatar } from './BotAvatar';
import { retryBotInvitation, type BotProfile } from './botStore';
import { useBotTranslation } from './botPronounContext';

/** The same welcome appears while inviting and when returning to a pending companion. */
export function BotInvitationWelcome({ bot }: { bot: BotProfile }) {
  const { t } = useBotTranslation();
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const stage = bot.invitation?.stage ?? 'profile';
  const visibleStep = stage === 'avatar' && !bot.invitation?.avatarRequested ? 'welcome' : stage;
  return (
    <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-5 py-6 text-center">
      <div className={`rounded-full p-2 ${stage !== 'failed' ? 'motion-safe:animate-pulse' : ''}`}>
        <BotAvatar bot={bot} size="xl" />
      </div>
      <div>
        <p className="text-18 font-medium text-[var(--text-primary)]">
          {t('bots.invitation.waiting', { name: bot.name })}
        </p>
        <p className="mt-2 text-13 leading-6 text-[var(--text-secondary)]">
          {t(stage === 'failed' ? 'bots.invitation.failed' : 'bots.invitation.background')}
        </p>
      </div>
      {stage === 'failed' ? (
        <button
          type="button"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            setRetryFailed(false);
            void retryBotInvitation(bot.id)
              .catch(() => setRetryFailed(true))
              .finally(() => setRetrying(false));
          }}
          className="inline-flex h-9 items-center gap-2 rounded-full border border-[var(--border-default)] px-4 text-13 text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
        >
          <RefreshCw size={14} />
          {t('commonUi.retry')}
        </button>
      ) : (
        <p
          className="flex items-center gap-2 text-13 text-[var(--text-primary)]"
          role="status"
          aria-live="polite"
        >
          <Spinner size={15} />
          {t(`bots.invitation.${visibleStep === 'ready' ? 'welcome' : visibleStep}`, {
            name: bot.name,
          })}
        </p>
      )}
      {retryFailed ? (
        <p role="alert" className="text-12 text-[var(--text-danger)]">
          {t('bots.invitation.retryFailed')}
        </p>
      ) : null}
    </div>
  );
}
