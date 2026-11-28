import {
  ArrowDown,
  ArrowUp,
  ChartNoAxesColumn,
  ChevronRight,
  CircleMinus,
  CircleSlash,
  FolderOpen,
  KeyRound,
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
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
import { subscriptionAccountErrorKey } from './subscriptionAccountErrors';
import { cn } from '@/lib/utils';
import {
  QUOTA_WINDOW_COLUMNS,
  QuotaHoverCard,
  QuotaWindowSubgridContext,
} from '../status/QuotaHoverCard';
import { buildSubscriptionAccountUsageCard } from '../status/usageCardModel';
import { QUOTA_TEXT_COLOR_CLASSES, quotaSeverity } from '../status/QuotaBar';
import {
  isPluginEngineProviderIdShape,
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
} from '../../../shared/providerGroup';
import { shouldShowOpenPathError } from '../../../shared/openPathResult';
import { isClassicalLocale, modernLocaleOf } from '../../../shared/locale';
import { providersSettings } from './ProvidersSection.settings-search';
import { RouteStrategyNote } from './RouteStrategyNote';
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
import type { OpenAiGroupAccount } from '../../../shared/openAiAccountGroup';
import { openAiGroupFailureKey } from './OpenAiAccountGroupSection';
import { pluginEngineUsageAccount } from '../status/pluginEngineUsageAccount';
import { usePluginEngines } from '@/hooks/usePluginEngines';
import { ExistingSubscriptionLogins } from './ExistingSubscriptionLogins';
import { usePluginEngineSignIn } from './PluginEngineSignIn';

/** `acp-plugin:<plugin>:<engine>[~<suffix>]` → `<plugin>:<engine>`. */
function pluginEngineKeyOf(providerId: string): string {
  return providerId.slice('acp-plugin:'.length).replace(/~[a-z0-9]{8}$/, '');
}

function AccountResetCredits({ scope }: { scope: string }) {
  const { snapshot, refresh } = useCodexRateLimits(true, scope);
  const reset = useCodexRateLimitReset(snapshot, refresh, scope);
  return <CodexResetCredits variant="embedded" providerId={scope} snapshot={snapshot}
    onChanged={refresh} busy={reset.busy} canReset={reset.canReset} canRetry={reset.canRetry}
    onReset={credit => void reset.reset(credit)} />;
}

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
function AccountListPlaceholder({ reserve, label, compact = false }: {
  reserve: boolean;
  label: string;
  /** 账号区收起时：占摘要那一行，读完换成摘要，高度不变。 */
  compact?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), LOADING_REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, []);
  if (!reserve && !visible) return null;
  const block = 'rounded-full bg-[var(--surface-chip)]';
  if (compact) {
    return (
      <div role="status" aria-label={label} data-testid="subscription-accounts-loading" className="mt-1.5 flex h-[17px] items-center">
        <div aria-hidden="true" className={cn('flex items-center gap-4', visible ? 'animate-fade-in' : 'invisible')}>
          <span className={cn('h-2.5 w-36', block)} />
          <span className={cn('h-2.5 w-14', block)} />
        </div>
      </div>
    );
  }
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
    <Badge tone="outline">
      {children}
    </Badge>
  );
}

/**
 * `defaultUsage` is a compatibility fallback only when the account endpoint is unavailable.
 * `dashboard` is the provider's usage page, shared by every account in the pool.
 */
export function SubscriptionAccountsSection({
  providerId,
  kind = providerId as SubscriptionProvider,
  providerName,
  locationLabel,
  defaultUsage,
  dashboard,
  expectAccounts = true,
  openAiAccounts,
}: {
  /** The provider whose accounts are listed: built-in, created or a legacy Codex connection. */
  providerId: string;
  /** The account pool it uses (2026-11-13); defaults to the built-in provider id. */
  kind?: SubscriptionProvider;
  providerName?: string;
  /** Clarify which computer owns these accounts when models run elsewhere. */
  locationLabel?: string;
  defaultUsage?: ReactNode;
  dashboard?: { label: string; onOpen: () => void };
  /** Whether the first read is likely to list an account, so its row's space is held meanwhile. */
  expectAccounts?: boolean;
  openAiAccounts?: readonly OpenAiGroupAccount[];
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n?.resolvedLanguage ?? i18n?.language;
  const accountSetting = useSettingDefinition(providersSettings.subscriptionAccounts);
  const { confirm } = useConfirmDialog();
  const cache = useContext(SubscriptionPoolViewCache);
  const [view, setView] = useState<SubscriptionPoolView | null>(() => cache?.get(providerId) ?? null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<ReadonlySet<string>>(() => new Set());
  const activeTests = useRef(new Set<string>());
  const login = useRef<string | null>(null);
  const inFlight = useRef(false);
  // A plugin engine provider (2026-11-23): accounts sign in through the plugin's own methods.
  const plugin = isPluginEngineProviderIdShape(providerId);
  const engineKey = plugin ? pluginEngineKeyOf(providerId) : null;
  const engines = usePluginEngines(plugin);
  const pluginSignIn = usePluginEngineSignIn();
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++epoch.current;
    setRefreshing(true);
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
    } finally {
      if (current === epoch.current) setRefreshing(false);
    }
  }, [providerId, cache]);
  useEffect(() => {
    void refresh();
    // Change notifications name the account pool (kind), shared by every provider of that kind.
    const unsubscribe = window.electronAPI.subscriptionAccounts.onChanged((event) => {
      if (engineKey ? pluginEngineKeyOf(event.providerId) === engineKey && event.providerId.startsWith('acp-plugin:')
        : event.providerId === kind) void refresh();
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
  }, [providerId, kind, engineKey, refresh]);
  const builtinTargets = useSubscriptionPlacementTargets(plugin ? null : kind, providerId);
  // A plugin engine's accounts move only between the providers of that engine.
  const placementTargets = engineKey
    ? engines.filter((engine) => (engine.accountProviderOf ?? engine.key) === engineKey && engine.providerId !== providerId)
      .map((engine) => ({ id: engine.providerId, name: engine.name }))
    : builtinTargets;
  const pluginInfo = view?.pluginEngine;
  const pluginMethods = pluginInfo?.methods ?? [];
  /** Plugin engines ask the plugin's method (and a key) first; null = cancelled. */
  const signInFields = async (title: string): Promise<{ methodId?: string; secret?: string } | null> =>
    plugin ? pluginSignIn(pluginMethods, title) : {};
  const moveAccount = useMoveSubscriptionAccount(providerId, () => void refresh());
  const run = async (command: SubscriptionAccountCommand) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    if (command.action === 'add' || command.action === 'login' || command.action === 'token-login')
      login.current = command.loginKey;
    try {
      await window.electronAPI.subscriptionAccounts.command(command);
      await refresh();
    } catch (error) {
      const key = subscriptionAccountErrorKey(error);
      if (key) toast.error(t(key));
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
  const testKey = async (connectionId: string, agent: 'codex' | 'pi') => {
    const key = `${connectionId}:${agent}`;
    if (activeTests.current.has(key)) return;
    activeTests.current.add(key);
    setTesting(new Set(activeTests.current));
    try {
      const result = await window.electronAPI.providerGroup.command({ action: 'account-test', providerId, accountId: connectionId, agent });
      if (!result.ok) toast.error(t(openAiGroupFailureKey(result.code)));
    } catch {
      toast.error(t('subscriptionAccounts.failed'));
    } finally {
      activeTests.current.delete(key);
      setTesting(new Set(activeTests.current));
      await refresh();
    }
  };
  const addButton = (
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
        else void signInFields(t('subscriptionAccounts.add')).then((fields) => {
          if (fields) void run({ action: 'add', providerId, loginKey: crypto.randomUUID(), ...fields });
        });
      }}
    >
      {busy ? <Spinner size={13} /> : <Plus size={14} />}
      {login.current ? t('settings.providers.button.cancel') : t('subscriptionAccounts.add')}
    </Button>
  );
  const accounts = view && !isUnusedDefaultSlot(view.accounts) ? view.accounts : [];
  const mixed = accounts.some(account => account.apiKey);
  const moveInOrder = (index: number, offset: number) => {
    const ids = accounts.map(account => account.id);
    const next = index + offset;
    if (next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    void run({ action: 'reorder', providerId, accountIds: ids });
  };
  // Strategy and weights only choose between accounts; a single account has nothing to balance.
  const balancing = accounts.length > 1;
  // 账号区默认收成一行（2026-11-24 用户裁决：用量不占大块篇幅，模型列表才是这页的主体）：每个账号的余量写在这一行，
  // 点开才是账号列表、额度窗口、额度重置与分配设置，功能一样不少。有账号要登录、读取失败、正在登录或还没有账号时
  // 自动展开，不把需要处理的事藏起来；用户自己点过之后按用户的。
  const [openChoice, setOpenChoice] = useState<boolean | null>(null);
  // 只看读到的结果：读取中、正在登录、后台刷新偶尔失败都不算(否则先展开再自己收起，页面跳一下，2026-11-26 排查)。
  // 第一次就没读到才算要处理。
  const needsAttention = (failed && !view) || (!!view && (accounts.length === 0
    || accounts.some((account) => account.status === 'signed-out' || account.status === 'unavailable' || !!account.authIssue)));
  // 自动展开过就留着：登录完成后不在用户眼前自己收起，由用户来收。
  const [autoOpened, setAutoOpened] = useState(false);
  if (needsAttention && !autoOpened) setAutoOpened(true);
  const expanded = openChoice ?? autoOpened;
  const summaryNow = Date.now();
  const summary = accounts.map((account, index) => {
    const card = plugin ? null : buildSubscriptionAccountUsageCard(account.usage, t, summaryNow, locale);
    // 最紧的那个额度窗口代表这个账号：剩余 = 100 - 已用。
    const remaining = card && card.windows.length > 0
      ? Math.round(Math.max(0, Math.min(...card.windows.map((item) => 100 - item.window.utilization))))
      : null;
    return {
      id: account.id,
      name: account.identity || t('providerGroup.member.accountFallback', { index: index + 1 }),
      remaining,
    };
  });
  return (
    <section
      {...accountSetting.anchorProps}
      className={cn('border-t border-[var(--border-default)] px-5 [container-type:inline-size]', expanded ? 'py-5' : 'py-3.5')}
      data-testid="subscription-accounts"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-16 font-medium text-[var(--text-primary)]">
            <button
              type="button"
              data-settings-search-action="Expand or collapse the subscription accounts, usage and resets of this provider"
              aria-expanded={expanded}
              onClick={() => setOpenChoice(!expanded)}
              className="-ml-1.5 flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
            >
              <ChevronRight size={14} aria-hidden className={cn('shrink-0 text-[var(--text-tertiary)] transition-transform motion-reduce:transition-none', expanded && 'rotate-90')} />
              {t('subscriptionAccounts.title')}
              {accounts.length > 0 && (
                <span className="ml-1 text-12 font-normal tabular-nums text-[var(--text-tertiary)]">{accounts.length}</span>
              )}
            </button>
          </h3>
          {locationLabel && <span className="text-12 text-[var(--text-secondary)]">{locationLabel}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {/* A built-in provider holds the CLI default login and is never merged away as a whole. */}
          {(openAiAccounts || ((plugin ? !!pluginInfo?.separate : providerId !== kind) && accounts.length > 0)) && (
            <MergeProviderButton
              {...(plugin ? { targets: placementTargets } : { kind: providerId !== kind && accounts.length > 0 ? kind : null })}
              providerId={providerId}
              providerName={providerName ?? providerId}
              disabled={busy}
              onDone={() => void refresh()}
              openAiAccounts={openAiAccounts}
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
          {(providerId === 'anthropic' || providerId === 'openai') ? (
            <ExistingSubscriptionLogins key={providerId} provider={providerId} disabled={busy}>{addButton}</ExistingSubscriptionLogins>
          ) : (!plugin || pluginMethods.length > 0) && addButton}
        </div>
      </div>
      {/* 收起时第一次读取还没回来：在摘要的位置占一行，不让这一块只剩标题、看不出在读。 */}
      {!expanded && !view && !failed && (
        <AccountListPlaceholder compact reserve={expectAccounts} label={t('ccAgent.common.loading')} />
      )}
      {!expanded && summary.length > 0 && (
        <button
          type="button"
          data-testid="subscription-accounts-summary"
          data-settings-search-action="Expand the subscription accounts of this provider"
          aria-expanded={false}
          onClick={() => setOpenChoice(true)}
          className="mt-1.5 flex w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-lg text-left text-12 leading-[1.4] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]"
        >
          {summary.map((item) => (
            <span key={item.id} className="flex min-w-0 items-center gap-1.5 text-[var(--text-secondary)]">
              <span className="min-w-0 [overflow-wrap:anywhere]">{item.name}</span>
              {item.remaining !== null && (
                <span className={cn('shrink-0 tabular-nums', QUOTA_TEXT_COLOR_CLASSES[quotaSeverity(100 - item.remaining)] ?? 'text-[var(--text-tertiary)]')}>
                  {t('quotaCard.remainingPercent', { percent: item.remaining })}
                </span>
              )}
            </span>
          ))}
        </button>
      )}
      <div data-testid="subscription-accounts-body" className={expanded ? undefined : 'hidden'}>
      {failed && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p role="alert" className="text-12 text-[var(--text-danger)]">
            {t('subscriptionAccounts.failed')}
          </p>
          <Button data-settings-search-action="Retry reading local subscription accounts" variant="secondary" size="sm" disabled={refreshing || busy} onClick={() => void refresh()}>
            {t('commonUi.retry')}
          </Button>
        </div>
      )}
      {expanded && !view && !failed && (
        <AccountListPlaceholder reserve={expectAccounts} label={t('ccAgent.common.loading')} />
      )}
      {/* A failed refresh keeps the loaded list, whose default row already holds the card. */}
      {defaultUsage && !view && failed && (
        <div data-testid="provider-usage-module" className="-mx-4 mt-3">
          {defaultUsage}
        </div>
      )}
      {view && accounts.length > 0 && (
        <>
          {/* 几个账号就是一条自动路由：选法只在「智能路由」里改，这里说明现状并给出入口。 */}
          {balancing && <RouteStrategyNote strategy={view.strategy} providerId={providerId} />}
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
                const plan = account.apiKey ? t('settings.providers.custom.fields.apiKey') : plugin ? account.plan :
                  kind === 'openai'
                    ? formatCodexPlanLabel(account.planType ?? account.plan)
                    : formatClaudeSubscriptionPlanLabel(account.plan, account.planTier, account.planDisplayName);
                const usage = plugin
                  ? account.usage?.plugin
                    ? pluginEngineUsageAccount(account.usage.plugin, {
                      title: t('quotaCard.usageTitle'), now: Date.now(), language: locale ?? 'en', t,
                    })
                    : null
                  : buildSubscriptionAccountUsageCard(
                    account.usage,
                    t,
                    Date.now(),
                    locale,
                  );
                // As in provider groups, a usable account reports its load; other states add it.
                const running = t('providerGroup.member.runningCount', { count: account.running });
                const state = account.authIssue === 'claude-account-mismatch' || account.authIssue === 'account-mismatch'
                  ? t('subscriptionAccounts.loginIdentityMismatchStatus')
                  : account.authIssue === 'claude-token-account-mismatch'
                  ? t('subscriptionAccounts.longLivedToken.mismatchStatus')
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
                // A long-lived token keeps tasks running after the ordinary sign-in ends, so that
                // sign-in's own expiry is no longer urgent: the row reports the token instead.
                const token = !plugin && kind === 'anthropic' ? account.longLivedToken : undefined;
                const tokenExpiresAt = token?.expiresAt ? Date.parse(token.expiresAt) : NaN;
                const tokenRemaining = tokenExpiresAt - Date.now();
                const tokenExpiryKnown = Number.isFinite(tokenExpiresAt);
                const formatDate = (value: number) => new Intl.DateTimeFormat(
                  isClassicalLocale(locale) ? modernLocaleOf(locale) : locale, { dateStyle: 'medium', timeStyle: 'short' },
                ).format(value);
                const tokenText = !token ? '' : !tokenExpiryKnown
                  ? t('subscriptionAccounts.longLivedToken.active')
                  : tokenRemaining <= 0
                    ? t('subscriptionAccounts.longLivedToken.mayHaveExpired')
                    : t('subscriptionAccounts.longLivedToken.expiresInDays', { days: Math.ceil(tokenRemaining / 86_400_000) });
                const tokenDetail = !token ? '' : [
                  tokenExpiryKnown ? t('subscriptionAccounts.longLivedToken.detailExpiry', { date: formatDate(tokenExpiresAt) }) : '',
                  t(token.storedLogin ? 'subscriptionAccounts.longLivedToken.detailLoginActive'
                    : 'subscriptionAccounts.longLivedToken.detailLoginEnded'),
                  token.verification === 'pending' ? t('subscriptionAccounts.longLivedToken.detailPending') : '',
                  token.settingsOnly ? t('subscriptionAccounts.longLivedToken.detailSettingsOnly') : '',
                ].filter(Boolean).join(' ');
                const tokenExpiring = tokenExpiryKnown && tokenRemaining <= 30 * 86_400_000;
                const changeToken = (action: 'token-login' | 'token-remove') => {
                  const creating = action === 'token-login';
                  void confirm({
                    title: t(creating ? 'subscriptionAccounts.longLivedToken.confirmTitle'
                      : 'subscriptionAccounts.longLivedToken.removeTitle', { name }),
                    description: t(creating ? 'subscriptionAccounts.longLivedToken.confirmDescription'
                      : 'subscriptionAccounts.longLivedToken.removeDescription'),
                    confirmText: t(creating ? 'subscriptionAccounts.longLivedToken.confirmAction'
                      : 'subscriptionAccounts.longLivedToken.removeAction'),
                    ...(creating ? {} : { confirmVariant: 'destructive' as const }),
                  }).then((ok) => {
                    if (!ok) return;
                    void run(creating
                      ? { action, providerId, accountId: account.id, loginKey: crypto.randomUUID() }
                      : { action, providerId, accountId: account.id });
                  });
                };
                // The CLI supplies an estimate; passing it never changes the auth status.
                const expiring = !token && expiryKnown && remaining <= 7 * 86_400_000;
                const expiryText = !expiryKnown
                  ? t('subscriptionAccounts.loginExpiryUnknown')
                  : remaining <= 0
                    ? t('subscriptionAccounts.loginMayHaveExpired')
                    : remaining <= 86_400_000
                      ? t('subscriptionAccounts.loginExpiresSoon')
                      : t('subscriptionAccounts.loginExpiresInDays', { days: Math.ceil(remaining / 86_400_000) });
                const expiryDetail = expiryKnown ? t('subscriptionAccounts.loginExpiryDetail', {
                  date: formatDate(expiresAt),
                }) : expiryText;
                const signIn = () => void signInFields(t('subscriptionAccounts.loginAccountAria', { name })).then((fields) => {
                  if (fields) void run({
                    action: 'login', providerId, accountId: account.id, loginKey: crypto.randomUUID(), ...fields,
                  });
                });
                // An engine whose plugin only reports its one login has nothing to configure here.
                const identityOnly = plugin && pluginMethods.length === 0;
                const resetScope = account.codexResetProviderId ?? codexResetScope(account.id);
                // Reset settings do not depend on a successful usage read. A replaced
                // identity remounts the reader; ordinary running-count changes do not.
                const resetNode = !plugin && kind === 'openai' && connected && !account.apiKey ? (
                  <AccountResetCredits key={`${resetScope}:${account.identity ?? ''}`} scope={resetScope} />
                ) : null;
                const usageNode =
                  usage ? (
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
                          'flex min-w-[min(180px,100%)] flex-1 items-center gap-3',
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
                            {token && <AccountTag>{t('subscriptionAccounts.longLivedToken.tag')}</AccountTag>}
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
                            {!plugin && kind === 'anthropic' && connected && (
                              <Tip text={token ? tokenDetail : expiryDetail}>
                                <span
                                  data-testid={token ? 'subscription-account-token-expiry' : undefined}
                                  className={cn('min-w-0', (token ? tokenExpiring : expiring) && 'text-[var(--warning-fg)]')}
                                >
                                  {token ? tokenText : expiryText}
                                </span>
                              </Tip>
                            )}
                            {!identityOnly && account.authIssue !== 'claude-token-account-mismatch'
                              && (account.status === 'signed-out' || (!plugin && kind === 'anthropic' && connected && expiring)) && (
                              <Button
                                data-settings-search-action="Sign in again to this subscription account"
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
                            {account.status === 'unavailable' && !account.apiKey && (
                              <Button data-settings-search-action="Retry reading this unavailable subscription account" variant="secondary" tone="quiet" size="sm"
                                disabled={refreshing || busy} onClick={() => void refresh()}>
                                {t('commonUi.retry')}
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                      {!identityOnly && <div className="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
                        {mixed && view.strategy === 'order' && <div className="flex items-center gap-1">
                          <Button {...accountSetting.controlProps} variant="secondary" tone="quiet" compact size="sm" aria-label={t('modelGroups.settings.moveUp')}
                            disabled={busy || index === 0} onClick={() => moveInOrder(index, -1)}><ArrowUp size={14} /></Button>
                          <Button {...accountSetting.controlProps} variant="secondary" tone="quiet" compact size="sm" aria-label={t('modelGroups.settings.moveDown')}
                            disabled={busy || index === accounts.length - 1} onClick={() => moveInOrder(index, 1)}><ArrowDown size={14} /></Button>
                        </div>}
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
                        {balancing && view.strategy === 'weighted' && (
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
                        {account.apiKey?.checks.map(check => {
                          const connectionId = account.apiKey!.connectionId;
                          const pending = testing.has(`${connectionId}:${check.agent}`);
                          const test = t('settings.providers.custom.test.button');
                          const engine = check.agent === 'pi' ? 'Pi' : 'Codex';
                          const label = account.apiKey!.checks.length > 1 ? `${test} · ${engine}` : test;
                          return <Button key={check.agent} data-settings-search-action="Test this pool API key on the selected engine" variant="secondary" tone="quiet" size="sm" loading={pending}
                            aria-label={`${label} · ${name}`} disabled={pending || busy}
                            onClick={() => void testKey(connectionId, check.agent)}>
                            {label}
                          </Button>;
                        })}
                        {account.apiKey?.connectionId !== providerId && <DropdownMenu>
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
                            {!account.apiKey && <><DropdownMenuItem
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
                            {!plugin && kind === 'anthropic' && (connected || token) && (
                              <DropdownMenuItem disabled={busy} onSelect={() => changeToken('token-login')}>
                                <KeyRound size={18} className="mr-2.5" />
                                {t(token ? 'subscriptionAccounts.longLivedToken.renew' : 'subscriptionAccounts.longLivedToken.use')}
                              </DropdownMenuItem>
                            )}
                            {token && (
                              <DropdownMenuItem disabled={busy} onSelect={() => changeToken('token-remove')}>
                                <CircleSlash size={18} className="mr-2.5" />
                                {t('subscriptionAccounts.longLivedToken.remove')}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              title={account.directory}
                              onSelect={() => void openDirectory(account.directory)}
                            >
                              <FolderOpen size={18} className="mr-2.5" />
                              {t('subscriptionAccounts.openDirectory')}
                            </DropdownMenuItem>
                            <MoveAccountMenu
                              targets={placementTargets}
                              canTakeOut={plugin ? !pluginInfo?.separate || accounts.length > 1 : providerId === kind || accounts.length > 1}
                              disabled={busy}
                              onMove={(target) => void moveAccount({ id: account.id, name }, target)}
                            />
                            <DropdownMenuSeparator /></>}
                            <DropdownMenuItem
                              variant="danger"
                              disabled={busy || account.running > 0}
                              onSelect={() => {
                                void confirm({
                                  title: t('subscriptionAccounts.removeTitle', { name }),
                                  description: t(account.apiKey ? 'openAiAccountGroup.removeDescription' : 'subscriptionAccounts.removeDescription'),
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
                          </DropdownMenuContent>
                        </DropdownMenu>}
                      </div>}
                    </div>
                    {account.apiKey?.checks.flatMap(check => check.result ? [
                      <p key={check.agent} role="status" className="mt-1 text-12 text-[var(--text-secondary)]">
                        {check.result.ok ? t('openAiAccountGroup.testPassed')
                          : check.blocked && check.result.billingCode ? t('openAiAccountGroup.billingPaused') : t(openAiGroupFailureKey(check.result.code))}
                      </p>,
                    ] : [])}
                    {/* Usage sits under the account name (from the avatar edge when narrow, so the
                        labels keep their column); the right edge meets the row controls. */}
                    {usageNode && (
                      <div
                        data-testid="subscription-account-usage"
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
      </div>
    </section>
  );
}
