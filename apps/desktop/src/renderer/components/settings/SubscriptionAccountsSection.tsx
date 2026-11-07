import { MoreHorizontal, Plus, UserRound } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/lib/toast';
import type {
  SubscriptionAccountCommand,
  SubscriptionPoolView,
  SubscriptionProvider,
} from '../../../shared/subscriptionAccounts';
import type { ProviderGroupStrategy } from '../../../shared/providerGroup';
import { providersSettings } from './ProvidersSection.settings-search';
import { useSettingDefinition } from './useSettingDefinition';

const strategies: ProviderGroupStrategy[] = ['least', 'round', 'order', 'weight'];
export function SubscriptionAccountsSection({ providerId }: { providerId: SubscriptionProvider }) {
  const { t, i18n } = useTranslation();
  const accountSetting = useSettingDefinition(providersSettings.subscriptionAccounts);
  const { confirm } = useConfirmDialog();
  const [view, setView] = useState<SubscriptionPoolView | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const login = useRef<string | null>(null);
  const inFlight = useRef(false);
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++epoch.current;
    try {
      const next = await window.electronAPI.subscriptionAccounts.command({
        action: 'read',
        providerId,
      });
      if (current === epoch.current) {
        setView(next);
        setFailed(false);
      }
    } catch {
      if (current === epoch.current) setFailed(true);
    }
  }, [providerId]);
  useEffect(() => {
    void refresh();
    const unsubscribe = window.electronAPI.subscriptionAccounts.onChanged((event) => {
      if (event.providerId === providerId) void refresh();
    });
    const focus = () => {
      void refresh();
    };
    window.addEventListener('focus', focus);
    return () => {
      ++epoch.current;
      unsubscribe();
      window.removeEventListener('focus', focus);
      if (login.current)
        void window.electronAPI.subscriptionAccounts
          .command({ action: 'cancel', providerId, loginKey: login.current })
          .catch(() => {});
    };
  }, [providerId, refresh]);
  const run = async (command: SubscriptionAccountCommand) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    if (command.action === 'add' || command.action === 'login') login.current = command.loginKey;
    try {
      await window.electronAPI.subscriptionAccounts.command(command);
      await refresh();
    } catch (error) {
      if (!String(error).includes('SUBSCRIPTION_LOGIN_CANCELLED'))
        toast.error(t('subscriptionAccounts.failed'));
      await refresh();
    } finally {
      inFlight.current = false;
      login.current = null;
      setBusy(false);
    }
  };
  return (
    <section
      {...accountSetting.anchorProps}
      className="border-t border-[var(--border-default)] px-5 py-5"
      data-testid="subscription-accounts"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-16 font-medium text-[var(--text-primary)]">
            {t('subscriptionAccounts.title')}
          </h3>
          {view && (
            <span className="text-12 text-[var(--text-tertiary)]">{view.accounts.length}</span>
          )}
        </div>
        <Button
          data-settings-search-action="Add a subscription account or cancel its pending sign-in"
          variant="secondary"
          size="sm"
          disabled={busy && !login.current}
          onClick={() => {
            if (login.current)
              void window.electronAPI.subscriptionAccounts
                .command({ action: 'cancel', providerId, loginKey: login.current })
                .catch(() => toast.error(t('subscriptionAccounts.failed')));
            else void run({ action: 'add', providerId, loginKey: crypto.randomUUID() });
          }}
        >
          {busy ? <Spinner size={13} /> : <Plus size={14} />}
          {login.current ? t('settings.providers.button.cancel') : t('subscriptionAccounts.add')}
        </Button>
      </div>
      <p className="mt-2 text-12 leading-relaxed text-[var(--text-secondary)]">
        {t('subscriptionAccounts.note')}
      </p>
      {failed && (
        <p role="alert" className="mt-3 text-12 text-[var(--text-danger)]">
          {t('subscriptionAccounts.failed')}
        </p>
      )}
      {!view && !failed && (
        <div className="py-6">
          <Spinner size={16} />
        </div>
      )}
      {view && (
        <>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <span className="text-13 font-medium text-[var(--text-secondary)]">
              {t('subscriptionAccounts.strategy')}
            </span>
            <Select
              {...accountSetting.controlProps}
              label={t('subscriptionAccounts.strategy')}
              value={view.strategy === 'usage' ? 'least' : view.strategy}
              disabled={busy}
              options={strategies.map((value) => ({
                value,
                label: t(`providerGroup.strategy.${value}`),
              }))}
              onValueChange={(value) =>
                void run({
                  action: 'configure',
                  providerId,
                  strategy: value as ProviderGroupStrategy,
                })
              }
            />
          </div>
          <div className="mt-3 divide-y divide-[var(--border-default)]">
            {view.accounts.map((account, index) => {
              const name =
                account.identity || t('providerGroup.member.accountFallback', { index: index + 1 });
              const status = account.paused
                ? t('providerGroup.member.status.paused')
                : t(
                    `subscriptionAccounts.${account.status === 'signed-out' ? 'signedOut' : account.status}`,
                  );
              return (
                <div key={account.id} className="py-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]">
                      <UserRound size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="break-all text-13 font-medium text-[var(--text-primary)]">
                          {name}
                        </span>
                        {account.id === 'default' && !account.legacy && (
                          <span className="text-11 text-[var(--text-tertiary)]">
                            {t('subscriptionAccounts.default')}
                          </span>
                        )}
                        {account.plan && (
                          <span className="text-11 text-[var(--text-tertiary)]">
                            {account.plan}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-12 text-[var(--text-secondary)]">
                        {status} ·{' '}
                        {t('providerGroup.member.runningCount', { count: account.running })}
                      </p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          data-settings-search-action="Open sign-in and removal actions for this subscription account"
                          variant="secondary"
                          tone="quiet"
                          size="sm"
                          compact
                          aria-label={t('providerGroup.member.moreAria', { name })}
                        >
                          <MoreHorizontal size={16} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          disabled={busy || account.running > 0}
                          onSelect={() =>
                            void run({
                              action: 'login',
                              providerId,
                              accountId: account.id,
                              loginKey: crypto.randomUUID(),
                            })
                          }
                        >
                          {t('subscriptionAccounts.login')}
                        </DropdownMenuItem>
                        {account.id !== 'default' && (
                          <DropdownMenuItem
                            disabled={busy || account.running > 0}
                            onSelect={() => {
                              void confirm({
                                title: t('subscriptionAccounts.removeTitle', { name }),
                                description: t('subscriptionAccounts.removeDescription'),
                                confirmText: t('subscriptionAccounts.remove'),
                                confirmVariant: 'destructive',
                              }).then((ok) => {
                                if (ok)
                                  void run({ action: 'remove', providerId, accountId: account.id });
                              });
                            }}
                          >
                            {t('subscriptionAccounts.remove')}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  {account.quota && (
                    <div className="mt-3">
                      <div className="mb-1 flex flex-wrap justify-between gap-x-3 gap-y-1 text-11 text-[var(--text-tertiary)]">
                        <span>
                          {t(
                            account.quota.windowMs >= 7 * 86_400_000
                              ? 'menubar.window.week'
                              : 'menubar.window.session',
                            { hours: account.quota.windowMs / 3_600_000 },
                          )}{' '}
                          ·{' '}
                          {t('subscriptionAccounts.used', {
                            percent: Math.round(account.quota.usedPercent),
                          })}
                        </span>
                        {account.quota.resetAtMs !== null && (
                          <span>
                            {t('providerShare.insights.resets', {
                              time: new Date(account.quota.resetAtMs).toLocaleString(
                                i18n.language,
                                {
                                  month: 'short',
                                  day: 'numeric',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                },
                              ),
                            })}
                          </span>
                        )}
                      </div>
                      <div
                        role="progressbar"
                        aria-label={name}
                        aria-valuenow={account.quota.usedPercent}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        className="h-1 overflow-hidden rounded-full bg-[var(--surface-chip)]"
                      >
                        <div
                          className="h-full rounded-full bg-[var(--text-secondary)]"
                          style={{ width: `${account.quota.usedPercent}%` }}
                        />
                      </div>
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                    <Select
                      {...accountSetting.controlProps}
                      label={t('providerGroup.member.limitAria', { name })}
                      value={String(account.limit)}
                      disabled={busy}
                      options={Array.from({ length: 16 }, (_, n) => ({
                        value: String(n + 1),
                        label: t('providerGroup.member.limitOption', { count: n + 1 }),
                      }))}
                      onValueChange={(value) =>
                        void run({
                          action: 'configure',
                          providerId,
                          accountId: account.id,
                          limit: Number(value),
                        })
                      }
                    />
                    {view.strategy === 'weight' && (
                      <Select
                        {...accountSetting.controlProps}
                        label={t('providerGroup.member.weightAria', { name })}
                        value={String(account.weight)}
                        disabled={busy}
                        options={[1, 2, 3, 5, 10, 20, 50, 100].map((weight) => ({
                          value: String(weight),
                          label: t('providerGroup.member.weightOption', { weight }),
                        }))}
                        onValueChange={(value) =>
                          void run({
                            action: 'configure',
                            providerId,
                            accountId: account.id,
                            weight: Number(value),
                          })
                        }
                      />
                    )}
                    <Switch
                      {...accountSetting.controlProps}
                      checked={!account.paused}
                      disabled={busy}
                      aria-label={t('providerGroup.member.assignAria', { name })}
                      onCheckedChange={(checked) =>
                        void run({
                          action: 'configure',
                          providerId,
                          accountId: account.id,
                          paused: !checked,
                        })
                      }
                    />
                  </div>
                  <details className="mt-2 text-11 text-[var(--text-tertiary)]">
                    <summary className="cursor-pointer">
                      {t('subscriptionAccounts.directory')}
                    </summary>
                    <p className="mt-1 break-all font-mono">{account.directory}</p>
                  </details>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
