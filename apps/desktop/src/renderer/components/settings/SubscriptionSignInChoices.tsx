import { useEffect, useState } from 'react';
import { UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type {
  SubscriptionPoolView,
  SubscriptionProvider,
} from '../../../shared/subscriptionAccounts';

/** Read-only detection; only an explicit choice may connect a CLI account. */
export function SubscriptionSignInChoices({
  providerId,
  busy,
  onConnect,
  onCancel,
}: {
  providerId: SubscriptionProvider;
  busy: boolean;
  onConnect: (target: 'default' | 'new') => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<SubscriptionPoolView | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setView(null);
    setFailed(false);
    void window.electronAPI.subscriptionAccounts
      .command({ action: 'preview', providerId })
      .then((result) => {
        if (!current) return;
        setView(result);
        setFailed(
          !result.accounts.some(
            (account) => account.id === 'default' && account.status !== 'unavailable',
          ),
        );
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [providerId, attempt]);
  const account = view?.accounts.find((item) => item.id === 'default');
  const detected = account?.status === 'ready' || account?.status === 'limited';
  const hasOtherAccounts = view?.accounts.some((item) => item.id !== 'default');
  const loading = !view && !failed;
  return (
    <div className="flex flex-col gap-4" data-testid="subscription-sign-in">
      {loading && (
        <div role="status" className="flex items-center gap-2 text-12 text-[var(--text-tertiary)]">
          <Spinner size={13} />
          {t('subscriptionAccounts.signIn.checking')}
        </div>
      )}
      {detected && (
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--border-default)] p-4">
          <span className="text-12 text-[var(--text-secondary)]">
            {t('subscriptionAccounts.signIn.detected')}
          </span>
          <div className="flex items-center gap-3">
            <UserRound
              size={20}
              className="shrink-0 text-[var(--text-tertiary)]"
              aria-hidden="true"
            />
            <div className="flex min-w-0 flex-col gap-1">
              <span className="break-all text-14 font-medium text-[var(--text-primary)]">
                {account.identity || t('subscriptionAccounts.default')}
              </span>
              <span className="text-12 text-[var(--text-tertiary)]">
                {providerId === 'anthropic' ? 'Claude Code' : 'Codex'}
                {account.plan ? ` · ${account.plan}` : ''}
              </span>
            </div>
          </div>
        </div>
      )}
      {failed && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-12 text-[var(--text-secondary)]"
        >
          <span>{t('subscriptionAccounts.signIn.checkFailed')}</span>
          <Button
            data-settings-search-action="Retry detection of the default CLI subscription account"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => setAttempt((value) => value + 1)}
          >
            {t('subscriptionAccounts.signIn.retry')}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {busy ? (
          <Button
            data-settings-search-action="Cancel this wizard's pending subscription sign-in"
            variant="secondary"
            size="lg"
            type="button"
            onClick={onCancel}
          >
            <Spinner size={13} />
            {t('settings.providers.button.cancel')}
          </Button>
        ) : (
          <>
            {!loading && !failed && (
              <Button
                data-settings-search-action="Connect the detected default subscription account"
                variant="primary"
                size="lg"
                type="button"
                onClick={() => onConnect('default')}
              >
                {t(
                  detected
                    ? 'subscriptionAccounts.signIn.useAccount'
                    : providerId === 'anthropic'
                      ? 'settings.providers.localAccount.useClaude'
                      : 'subscriptionAccounts.signIn.useCodex',
                )}
              </Button>
            )}
            {(detected || hasOtherAccounts || loading || failed) && (
              <Button
                data-settings-search-action="Sign in to another account within this provider"
                variant="secondary"
                size="lg"
                type="button"
                onClick={() => onConnect('new')}
              >
                {t('subscriptionAccounts.signIn.anotherAccount')}
              </Button>
            )}
          </>
        )}
      </div>
      {(detected || hasOtherAccounts) && (
        <p className="text-12 text-[var(--text-tertiary)]">
          {t('subscriptionAccounts.signIn.keepExisting')}
        </p>
      )}
    </div>
  );
}
