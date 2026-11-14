import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type {
  SubscriptionPoolView,
  SubscriptionProvider,
} from '../../../shared/subscriptionAccounts';
import { useLoadedSubscriptionPlacementTargets, type PlacementTarget } from './SubscriptionPlacement';

/**
 * Where a newly signed-in account goes: `null` is a separate provider (the default), otherwise the
 * id of a connected provider of the same kind (subscription-account-pools.md 合并与拿出由用户决定).
 */
export type SubscriptionSignInTarget = { target: 'default' } | { target: 'new'; into: string | null };

/** Read-only detection; only an explicit choice may connect a CLI account. */
export function SubscriptionSignInChoices({
  providerId,
  busy,
  onConnect,
  onCancel,
}: {
  providerId: SubscriptionProvider;
  busy: boolean;
  onConnect: (choice: SubscriptionSignInTarget) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<SubscriptionPoolView | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const targets = useLoadedSubscriptionPlacementTargets(providerId, '');
  const [placing, setPlacing] = useState(false);
  const signInAnother = () => setPlacing(true);
  // Without a connected provider of this kind there is nothing to choose: it becomes its own provider.
  useEffect(() => {
    if (!placing || !targets || targets.length) return;
    setPlacing(false);
    onConnect({ target: 'new', into: null });
  }, [placing, targets, onConnect]);
  useEffect(() => {
    let current = true;
    setView(null);
    setFailed(false);
    void window.electronAPI.subscriptionAccounts
      .command({ action: 'preview', providerId })
      .then((result) => {
        if (!current) return;
        setView(result);
        // Once the CLI login is in Cindy its state no longer matters here.
        setFailed(
          result.defaultAdded !== true &&
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
  // Only the CLI's own login can be connected without signing in, and only while it is not in
  // Cindy yet; accounts already added are not listed or counted here (2026-11-14 user decision).
  const added = view?.defaultAdded === true;
  const account = added ? undefined : view?.accounts.find((item) => item.id === 'default');
  const detected = account?.status === 'ready' || account?.status === 'limited';
  const providerManagedAuth = account?.authIssue === 'codex-provider-managed-auth';
  const hasOtherAccounts = view?.accounts.some((item) => item.id !== 'default');
  const loading = !view && !failed;
  const offerDefault = !loading && !failed && !providerManagedAuth && !added;
  const cli = providerId === 'anthropic' ? 'Claude Code' : 'Codex';
  if (placing && !busy && !targets?.length)
    return (
      <div role="status" className="flex items-center gap-2 text-12 text-[var(--text-tertiary)]">
        <Spinner size={13} />
        {t('subscriptionAccounts.signIn.checking')}
      </div>
    );
  if (placing && !busy && targets)
    return (
      <SignInPlacementChoice
        targets={targets}
        onBack={() => setPlacing(false)}
        onContinue={(into) => { setPlacing(false); onConnect({ target: 'new', into }); }}
      />
    );
  return (
    <div className="flex flex-col gap-4" data-testid="subscription-sign-in">
      {loading && (
        <div role="status" className="flex items-center gap-2 text-12 text-[var(--text-tertiary)]">
          <Spinner size={13} />
          {t('subscriptionAccounts.signIn.checking')}
        </div>
      )}
      {providerManagedAuth && (
        <p role="alert" className="text-12 text-[var(--text-secondary)]">
          {t('subscriptionAccounts.providerManagedAuth')}
        </p>
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
            {offerDefault && (
              <Button
                data-settings-search-action="Connect the detected default subscription account"
                variant="primary"
                size="lg"
                type="button"
                className="max-w-full"
                onClick={() => onConnect({ target: 'default' })}
              >
                {detected ? (
                  <>
                    <span className="shrink-0">
                      {t('subscriptionAccounts.signIn.useAccount', { cli })}
                    </span>
                    {account.identity && (
                      // Native title only reveals the truncated identity (DESIGN.md §14.6 exception).
                      <span
                        className="min-w-0 truncate font-normal text-[var(--text-secondary)]"
                        title={account.identity}
                      >
                        {account.identity}
                      </span>
                    )}
                  </>
                ) : (
                  t(
                    providerId === 'anthropic'
                      ? 'settings.providers.localAccount.useClaude'
                      : 'subscriptionAccounts.signIn.useCodex',
                  )
                )}
              </Button>
            )}
            {(detected || hasOtherAccounts || loading || failed || providerManagedAuth || added) && (
              <Button
                data-settings-search-action="Sign in to another subscription account"
                variant={offerDefault || loading ? 'secondary' : 'primary'}
                size="lg"
                type="button"
                onClick={signInAnother}
              >
                {t('subscriptionAccounts.signIn.anotherAccount')}
              </Button>
            )}
          </>
        )}
      </div>
      {(detected || hasOtherAccounts || added) && (
        <p className="text-12 text-[var(--text-tertiary)]">
          {t('subscriptionAccounts.signIn.keepExisting')}
        </p>
      )}
    </div>
  );
}

/** Chosen before the browser sign-in starts; cancelling sign-in changes no provider. */
function SignInPlacementChoice({
  targets,
  onBack,
  onContinue,
}: {
  targets: readonly PlacementTarget[];
  onBack: () => void;
  onContinue: (into: string | null) => void;
}) {
  const { t } = useTranslation();
  const [into, setInto] = useState<string | null>(null);
  const options: { id: string | null; label: string; hint?: string }[] = [
    {
      id: null,
      label: t('subscriptionAccounts.placement.signInSeparate'),
      hint: t('subscriptionAccounts.placement.signInSeparateHint'),
    },
    ...targets.map((target) => ({
      id: target.id,
      label: t('subscriptionAccounts.placement.signInInto', { name: target.name }),
    })),
  ];
  return (
    <div className="flex flex-col gap-3" data-testid="subscription-sign-in-placement">
      <span className="text-13 font-medium text-[var(--text-primary)]">
        {t('subscriptionAccounts.placement.signInQuestion')}
      </span>
      <div role="radiogroup" aria-label={t('subscriptionAccounts.placement.signInQuestion')} className="flex flex-col gap-2">
        {options.map((option) => {
          const selected = option.id === into;
          return (
            <button
              data-settings-search-action="Choose whether a new subscription account becomes its own provider or joins one"
              key={option.id ?? ''}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setInto(option.id)}
              className={cn(
                'flex min-h-11 w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                selected
                  ? 'border-[var(--settings-menu-border-selected)] bg-[var(--settings-menu-bg-selected)]'
                  : 'border-[var(--border-default)] hover:bg-[var(--settings-menu-bg-selected)]',
              )}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="break-words text-13 text-[var(--text-primary)]">{option.label}</span>
                {option.hint && <span className="text-12 text-[var(--text-tertiary)]">{option.hint}</span>}
              </span>
              <Check
                size={16}
                aria-hidden="true"
                className={cn('shrink-0 text-[var(--settings-menu-text-selected)]', !selected && 'invisible')}
              />
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-settings-search-action="Sign in with the chosen placement for the new subscription account"
          variant="primary"
          size="lg"
          type="button"
          onClick={() => onContinue(into)}
        >
          {t('subscriptionAccounts.placement.signInContinue')}
        </Button>
        <Button
          data-settings-search-action="Go back to the subscription sign-in choices without signing in"
          variant="secondary"
          size="lg"
          type="button"
          onClick={onBack}
        >
          {t('subscriptionAccounts.placement.signInBack')}
        </Button>
      </div>
    </div>
  );
}
