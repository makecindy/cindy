import {
  ChartNoAxesColumn,
  CircleMinus,
  FolderOpen,
  LogIn,
  MoreHorizontal,
  Plus,
  UserRound,
} from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  formatClaudeSubscriptionPlanLabel,
  formatCodexPlanLabel,
} from '@/lib/subscriptionPlanLabel';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { cn } from '@/lib/utils';
import {
  QUOTA_WINDOW_COLUMNS,
  QuotaHoverCard,
  QuotaWindowSubgridContext,
} from '../status/QuotaHoverCard';
import { buildSubscriptionAccountUsageCard } from '../status/usageCardModel';
import {
  isUnusedDefaultAccount,
  type SubscriptionAccountCommand,
  type SubscriptionAccountView,
  type SubscriptionPoolView,
  type SubscriptionProvider,
} from '../../../shared/subscriptionAccounts';
import {
  CONCURRENCY_LIMIT_OPTIONS,
  CONCURRENCY_LIMIT_UNLIMITED,
  concurrencyLimitFromOption,
  concurrencyLimitOptionValue,
  type ProviderGroupStrategy,
} from '../../../shared/providerGroup';
import { shouldShowOpenPathError } from '../../../shared/openPathResult';
import { isClassicalLocale, modernLocaleOf } from '../../../shared/locale';
import { providersSettings } from './ProvidersSection.settings-search';
import { useSettingDefinition } from './useSettingDefinition';
import { codexResetScope } from '../../../shared/subscriptionAccounts';
import { useCodexRateLimits } from '@/hooks/useCodexRateLimits';
import { useCodexRateLimitReset } from '@/hooks/useCodexRateLimitReset';
import { CodexResetCredits } from '../status/CodexResetCredits';
import {
  MergeProviderButton,
  MoveAccountMenu,
  useMoveSubscriptionAccount,
  useSubscriptionPlacementTargets,
} from './SubscriptionPlacement';

function AccountResetCredits({ scope }: { scope: string }) {
  const { snapshot, refresh } = useCodexRateLimits(true, scope);
  const reset = useCodexRateLimitReset(snapshot, refresh, scope);
  return <CodexResetCredits variant="embedded" providerId={scope} snapshot={snapshot}
    onChanged={refresh} busy={reset.busy} canReset={reset.canReset} canRetry={reset.canRetry}
    onReset={credit => void reset.reset(credit)} />;
}

const strategies: ProviderGroupStrategy[] = ['least', 'round', 'order', 'weight'];
const statusDot: Record<SubscriptionAccountView['status'], string> = {
  ready: 'var(--remote-status-ready)',
  limited: 'var(--warning-fg)',
  'signed-out': 'var(--error-fg)',
  unavailable: 'var(--remote-status-disconnected)',
};

/** Alone, the unused default slot lists nothing: the provider header's sign-in (or Add) fills it. */
function isUnusedDefaultSlot(accounts: SubscriptionAccountView[]): boolean {
  return accounts.length === 1 && isUnusedDefaultAccount(accounts[0]);
}

/**
 * Account lists already read while the providers page stays open, by provider id. Switching back
 * shows the last list at once and the fresh read replaces it in place, instead of an empty list
 * that loads and then pushes the rest of the page down. The page owns it, per data owner.
 */
export const SubscriptionPoolViewCache = createContext<Map<string, SubscriptionPoolView> | null>(null);

// A read that lands sooner shows no placeholder at all (the same threshold as provider groups).
const LOADING_REVEAL_MS = 200;

/**
 * Stands in for one account row while the first read is pending. With `reserve`, it holds the
 * row's space from the first frame (invisible until the reveal), so a quick read changes only
 * the contents, not the page height; static, without shimmer.
 */
function AccountListPlaceholder({ reserve, label }: { reserve: boolean; label: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), LOADING_REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, []);
  if (!reserve && !visible) return null;
  const block = 'rounded-full bg-[var(--surface-chip)]';
  return (
    <div
      role="status"
      aria-label={label}
      data-testid="subscription-accounts-loading"
      // Spaced like a signed-in account with one usage window and its reset line.
      className="mt-4 border-t border-[var(--border-default)] pb-7 pt-4"
    >
      <div aria-hidden="true" className={visible ? 'animate-fade-in' : 'invisible'}>
        <div className="flex items-center gap-3">
          <span className={cn('size-8 shrink-0', block)} />
          <div className="min-w-0 flex-1">
            <div className={cn('h-3 w-44 max-w-full', block)} />
            <div className={cn('mt-2 h-2.5 w-20', block)} />
          </div>
          <span className={cn('h-7 w-28 shrink-0', block)} />
        </div>
        <div className="mt-6 flex items-center gap-4 [@container(min-width:440px)]:ml-11">
          <span className={cn('h-2.5 w-8 shrink-0', block)} />
          <span className={cn('h-1.5 flex-1', block)} />
          <span className={cn('h-2.5 w-16 shrink-0', block)} />
        </div>
        <div className={cn('mt-6 h-2.5 w-36 max-w-full [@container(min-width:440px)]:ml-11', block)} />
      </div>
    </div>
  );
}

function AccountTag({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-[18px] shrink-0 items-center rounded-full border border-[var(--settings-integration-avatar-border)] px-2 text-11 font-medium text-[var(--text-tertiary)]">
      {children}
    </span>
  );
}

/**
 * `defaultUsage` is the provider's existing usage card; it belongs to the CLI default account.
 * `dashboard` is the provider's usage page, shared by every account in the pool.
 */
export function SubscriptionAccountsSection({
  providerId,
  kind = providerId as SubscriptionProvider,
  providerName,
  defaultUsage,
  dashboard,
  expectAccounts = true,
}: {
  /** The provider whose accounts are listed: built-in, created or a legacy Codex connection. */
  providerId: string;
  /** The account pool it uses (2026-11-13); defaults to the built-in provider id. */
  kind?: SubscriptionProvider;
  providerName?: string;
  defaultUsage?: ReactNode;
  dashboard?: { label: string; onOpen: () => void };
  /** Whether the first read is likely to list an account, so its row's space is held meanwhile. */
  expectAccounts?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n?.resolvedLanguage ?? i18n?.language;
  const accountSetting = useSettingDefinition(providersSettings.subscriptionAccounts);
  const { confirm } = useConfirmDialog();
  const cache = useContext(SubscriptionPoolViewCache);
  const [view, setView] = useState<SubscriptionPoolView | null>(() => cache?.get(providerId) ?? null);
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
        cache?.set(providerId, next);
        setView(next);
        setFailed(false);
      }
    } catch {
      if (current === epoch.current) setFailed(true);
    }
  }, [providerId, cache]);
  useEffect(() => {
    void refresh();
    // Change notifications name the account pool (kind), shared by every provider of that kind.
    const unsubscribe = window.electronAPI.subscriptionAccounts.onChanged((event) => {
      if (event.providerId === kind) void refresh();
    });
    const focus = () => {
      void refresh();
    };
    window.addEventListener('focus', focus);
    // Account usage refreshes behind a short host cache; keep windows and reset times current.
    const timer = window.setInterval(focus, 60_000);
    return () => {
      ++epoch.current;
      unsubscribe();
      window.removeEventListener('focus', focus);
      window.clearInterval(timer);
      if (login.current)
        void window.electronAPI.subscriptionAccounts
          .command({ action: 'cancel', providerId, loginKey: login.current })
          .catch(() => {});
    };
  }, [providerId, kind, refresh]);
  const placementTargets = useSubscriptionPlacementTargets(kind, providerId);
  const moveAccount = useMoveSubscriptionAccount(providerId, () => void refresh());
  const run = async (command: SubscriptionAccountCommand) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    if (command.action === 'add' || command.action === 'login') login.current = command.loginKey;
    try {
      await window.electronAPI.subscriptionAccounts.command(command);
      await refresh();
    } catch (error) {
      const code = extractIpcError(error)?.code;
      if (code !== 'SUBSCRIPTION_LOGIN_CANCELLED')
        toast.error(t(
          code === 'SUBSCRIPTION_CODEX_PROVIDER_AUTH'
            ? 'subscriptionAccounts.providerManagedAuth'
            : code === 'SUBSCRIPTION_CLAUDE_ACCOUNT_MISMATCH'
              ? 'subscriptionAccounts.loginIdentityMismatch'
              : code === 'SUBSCRIPTION_CLAUDE_IDENTITY_UNKNOWN'
                ? 'subscriptionAccounts.loginIdentityUnknown'
                : 'subscriptionAccounts.failed',
        ));
      await refresh();
    } finally {
      inFlight.current = false;
      login.current = null;
      setBusy(false);
    }
  };
  const openDirectory = async (directory: string) => {
    const result = await window.electronAPI.openPath(directory);
    if (shouldShowOpenPathError(result)) toast.error(t('subscriptionAccounts.openDirectoryFailed'));
  };
  const accounts = view && !isUnusedDefaultSlot(view.accounts) ? view.accounts : [];
  // Strategy and weights only choose between accounts; a single account has nothing to balance.
  const balancing = accounts.length > 1;
  return (
    <section
      {...accountSetting.anchorProps}
      className="border-t border-[var(--border-default)] px-5 py-5 [container-type:inline-size]"
      data-testid="subscription-accounts"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-16 font-medium text-[var(--text-primary)]">
            {t('subscriptionAccounts.title')}
          </h3>
          {accounts.length > 0 && (
            <span className="text-12 text-[var(--text-tertiary)]">{accounts.length}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {/* A built-in provider holds the CLI default login and is never merged away as a whole. */}
          {providerId !== kind && accounts.length > 0 && (
            <MergeProviderButton
              kind={kind}
              providerId={providerId}
              providerName={providerName ?? providerId}
              disabled={busy}
              onDone={() => void refresh()}
            />
          )}
          {dashboard && (
            <Button
              data-settings-search-action="Open the provider usage page"
              variant="secondary"
              tone="quiet"
              size="sm"
              onClick={dashboard.onOpen}
            >
              <ChartNoAxesColumn size={14} />
              {dashboard.label}
            </Button>
          )}
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
      </div>
      {failed && (
        <p role="alert" className="mt-3 text-12 text-[var(--text-danger)]">
          {t('subscriptionAccounts.failed')}
        </p>
      )}
      {!view && !failed && (
        <AccountListPlaceholder reserve={expectAccounts} label={t('ccAgent.common.loading')} />
      )}
      {/* A failed refresh keeps the loaded list, whose default row already holds the card. */}
      {defaultUsage && (view ? accounts.every((account) => account.id !== 'default') : failed) && (
        <div data-testid="provider-usage-module" className="-mx-4 mt-3">
          {defaultUsage}
        </div>
      )}
      {view && accounts.length > 0 && (
        <>
          {balancing && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <span className="text-13 font-medium text-[var(--text-secondary)]">
                {t('subscriptionAccounts.strategy')}
              </span>
              {/* Same control and option order as the provider group strategy (ProviderGroupSection). */}
              <SegmentedControl
                {...accountSetting.controlProps}
                aria-label={t('subscriptionAccounts.strategy')}
                value={view.strategy === 'usage' ? 'least' : view.strategy}
                disabled={busy}
                options={strategies.map((value) => ({
                  value,
                  label: t(`providerGroup.strategy.${value}`),
                }))}
                onValueChange={(value) => {
                  // Only a changed strategy is saved, as with the previous picker.
                  if (value === (view.strategy === 'usage' ? 'least' : view.strategy)) return;
                  void run({
                    action: 'configure',
                    providerId,
                    strategy: value,
                  });
                }}
              />
            </div>
          )}
          {/* One grid for every account: each usage card joins it as a subgrid, so the bars of all
              accounts start and end at the same columns. */}
          <QuotaWindowSubgridContext.Provider value={true}>
            <div
              className={cn(
                'mt-4 grid gap-x-4 divide-y divide-[var(--border-default)] border-t border-[var(--border-default)]',
                QUOTA_WINDOW_COLUMNS,
              )}
            >
              {accounts.map((account, index) => {
                const name =
                  account.identity ||
                  t('providerGroup.member.accountFallback', { index: index + 1 });
                const plan =
                  kind === 'openai'
                    ? formatCodexPlanLabel(account.plan)
                    : formatClaudeSubscriptionPlanLabel(account.plan);
                const usage = buildSubscriptionAccountUsageCard(
                  account.usage,
                  t,
                  Date.now(),
                  locale,
                );
                // As in provider groups, a usable account reports its load; other states add it.
                const running = t('providerGroup.member.runningCount', { count: account.running });
                const state = account.authIssue === 'claude-account-mismatch'
                  ? t('subscriptionAccounts.loginIdentityMismatchStatus')
                  : account.paused
                  ? t('providerGroup.member.status.paused')
                  : account.status === 'ready'
                    ? account.running > 0
                      ? running
                      : t('providerGroup.member.status.idle')
                    : t(
                        `subscriptionAccounts.${account.status === 'signed-out' ? 'signedOut' : account.status}`,
                      );
                const status =
                  account.running > 0 && (account.paused || account.status !== 'ready')
                    ? `${state} · ${running}`
                    : state;
                const connected = account.status === 'ready' || account.status === 'limited';
                const expiresAt = account.loginExpiresAt ? Date.parse(account.loginExpiresAt) : NaN;
                const remaining = expiresAt - Date.now();
                const expiryKnown = Number.isFinite(expiresAt);
                // The CLI supplies an estimate; passing it never changes the auth status.
                const expiring = expiryKnown && remaining <= 7 * 86_400_000;
                const expiryText = !expiryKnown
                  ? t('subscriptionAccounts.loginExpiryUnknown')
                  : remaining <= 0
                    ? t('subscriptionAccounts.loginMayHaveExpired')
                    : remaining <= 86_400_000
                      ? t('subscriptionAccounts.loginExpiresSoon')
                      : t('subscriptionAccounts.loginExpiresInDays', { days: Math.ceil(remaining / 86_400_000) });
                const expiryDetail = expiryKnown ? t('subscriptionAccounts.loginExpiryDetail', {
                  date: new Intl.DateTimeFormat(isClassicalLocale(locale) ? modernLocaleOf(locale) : locale,
                    { dateStyle: 'medium', timeStyle: 'short' }).format(expiresAt),
                }) : expiryText;
                const signIn = () => void run({
                  action: 'login', providerId, accountId: account.id, loginKey: crypto.randomUUID(),
                });
                const resetScope = account.codexResetProviderId ?? codexResetScope(account.id);
                // Reset settings do not depend on a successful usage read. A replaced
                // identity remounts the reader; ordinary running-count changes do not.
                const resetNode = kind === 'openai' && connected ? (
                  <AccountResetCredits key={`${resetScope}:${account.identity ?? ''}`} scope={resetScope} />
                ) : null;
                const usageNode =
                  account.id === 'default' && defaultUsage ? (
                    defaultUsage
                  ) : usage ? (
                    <QuotaHoverCard variant="embedded" hideIdentity account={usage}>
                      {resetNode}
                    </QuotaHoverCard>
                  ) : resetNode;
                return (
                  <div
                    key={account.id}
                    data-testid="subscription-account"
                    // The usage card ends with its own bottom space.
                    className={cn(
                      'col-span-full grid grid-cols-subgrid pt-4 [&>*]:col-span-full',
                      usageNode ? 'pb-1' : 'pb-4',
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <div
                        className={cn(
                          'flex min-w-[180px] flex-1 items-center gap-3',
                          account.paused && 'opacity-60',
                        )}
                      >
                        <span
                          aria-hidden="true"
                          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]"
                        >
                          <UserRound size={16} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span
                              title={name}
                              className="min-w-0 truncate text-13 font-medium text-[var(--text-primary)]"
                            >
                              {name}
                            </span>
                            {plan && <AccountTag>{plan}</AccountTag>}
                            {account.id === 'default' && !account.legacy && (
                              <AccountTag>{t('subscriptionAccounts.defaultTag')}</AccountTag>
                            )}
                          </div>
                          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-12 text-[var(--text-secondary)]">
                            <span className="inline-flex min-w-0 items-center gap-1.5">
                              <span
                                aria-hidden="true"
                                className="size-1.5 shrink-0 rounded-full"
                                style={{
                                  background: account.paused
                                    ? 'var(--remote-status-disconnected)'
                                    : statusDot[account.status],
                                }}
                              />
                              <span title={status} className="min-w-0 truncate">{status}</span>
                            </span>
                            {kind === 'anthropic' && connected && (
                              <Tip text={expiryDetail}>
                                <span className={cn('min-w-0', expiring && 'text-[var(--warning-fg)]')}>
                                  {expiryText}
                                </span>
                              </Tip>
                            )}
                            {kind === 'anthropic' && ((connected && expiring) || account.status === 'signed-out') && (
                              <Button
                                data-settings-search-action="Sign in again to this Claude account"
                                variant="secondary"
                                tone="quiet"
                                size="sm"
                                disabled={busy || account.running > 0}
                                aria-label={t('subscriptionAccounts.loginAccountAria', { name })}
                                onClick={signIn}
                              >
                                {t('subscriptionAccounts.loginAgain')}
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
                        <Select
                          {...accountSetting.controlProps}
                          label={t('providerGroup.member.limitAria', { name })}
                          value={concurrencyLimitOptionValue(account)}
                          disabled={busy}
                          size="compact"
                          width="xs"
                          options={CONCURRENCY_LIMIT_OPTIONS.map((value) => ({
                            value,
                            label:
                              value === CONCURRENCY_LIMIT_UNLIMITED
                                ? t('providerGroup.member.limitUnlimited')
                                : t('providerGroup.member.limitOption', { count: Number(value) }),
                          }))}
                          onValueChange={(value) =>
                            void run({
                              action: 'configure',
                              providerId,
                              accountId: account.id,
                              limit: concurrencyLimitFromOption(value),
                            })
                          }
                        />
                        {balancing && view.strategy === 'weight' && (
                          <Select
                            {...accountSetting.controlProps}
                            label={t('providerGroup.member.weightAria', { name })}
                            value={String(account.weight)}
                            disabled={busy}
                            size="compact"
                            width="xs"
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
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            {/* Below the button, so the tip shown on keyboard focus (e.g. after Esc
                                closes the menu) never covers the controls wrapped above it. */}
                            <Tip side="bottom" text={t('providerGroup.member.moreAria', { name })}>
                              {/* The negative margins cancel the round face's padding: the dots keep
                                  the same 8px gap as the other controls and end on the row's right
                                  edge, in line with the reset times below. */}
                              <Button
                                data-settings-search-action="Open sign-in, folder and removal actions for this subscription account"
                                variant="secondary"
                                tone="quiet"
                                size="sm"
                                className="-mx-2 w-7 px-0"
                                aria-label={t('providerGroup.member.moreAria', { name })}
                              >
                                <MoreHorizontal size={16} />
                              </Button>
                            </Tip>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              disabled={busy || account.running > 0}
                              onSelect={signIn}
                            >
                              <LogIn size={18} className="mr-2.5" />
                              {/* Signing in replaces this folder's own login; say so when it is already connected. */}
                              {t(
                                account.status === 'ready' || account.status === 'limited'
                                  ? 'subscriptionAccounts.loginAgain'
                                  : 'subscriptionAccounts.login',
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              title={account.directory}
                              onSelect={() => void openDirectory(account.directory)}
                            >
                              <FolderOpen size={18} className="mr-2.5" />
                              {t('subscriptionAccounts.openDirectory')}
                            </DropdownMenuItem>
                            {/* The CLI default login always stays with the built-in provider. */}
                            {account.id !== 'default' && (
                              <MoveAccountMenu
                                targets={placementTargets}
                                canTakeOut={providerId === kind || accounts.length > 1}
                                disabled={busy}
                                onMove={(target) => void moveAccount({ id: account.id, name }, target)}
                              />
                            )}
                            {account.id !== 'default' && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  variant="danger"
                                  disabled={busy || account.running > 0}
                                  onSelect={() => {
                                    void confirm({
                                      title: t('subscriptionAccounts.removeTitle', { name }),
                                      description: t('subscriptionAccounts.removeDescription'),
                                      confirmText: t('subscriptionAccounts.remove'),
                                      confirmVariant: 'destructive',
                                    }).then((ok) => {
                                      if (ok)
                                        void run({
                                          action: 'remove',
                                          providerId,
                                          accountId: account.id,
                                        });
                                    });
                                  }}
                                >
                                  <CircleMinus size={18} className="mr-2.5" />
                                  {t('subscriptionAccounts.remove')}
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                    {/* Usage sits under the account name (from the avatar edge when narrow, so the
                        labels keep their column); the right edge meets the row controls. */}
                    {usageNode && (
                      <div
                        data-testid={
                          account.id === 'default' && defaultUsage
                            ? 'provider-usage-module'
                            : undefined
                        }
                        className={cn(
                          '-mx-4 mt-1 grid grid-cols-subgrid [@container(min-width:440px)]:ml-7 [&>*]:col-span-full',
                          account.paused && 'opacity-60',
                        )}
                      >
                        {usageNode}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </QuotaWindowSubgridContext.Provider>
        </>
      )}
    </section>
  );
}
