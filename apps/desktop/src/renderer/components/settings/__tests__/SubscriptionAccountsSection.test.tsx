// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@/lib/toast';
import type { SubscriptionPoolView } from '../../../../shared/subscriptionAccounts';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string, options: Record<string, unknown> = {}) =>
      key === 'quotaCard.modelWeeklyLabel' ? `${String(options.model)} weekly`
        : key === 'subscriptionAccounts.loginExpiresInDays' ? `Expires in about ${options.days} days`
          : key === 'subscriptionAccounts.loginAccountAria' ? `Sign in again to ${options.name}` : key,
  }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }),
}));

import { SubscriptionAccountsSection, SubscriptionPoolViewCache } from '../SubscriptionAccountsSection';

/* 测试价值：多账号设置页曾给每个账号另画一条周用量条，又在底部重复原用量卡，且漏掉
 * 5 小时与分模型周窗口。经真实组件验证：默认账号行放原用量卡，其他账号用同一张卡显示
 * 自己的全部窗口。tier: unit；IPC 以 mock 注入，无外网/Agent。 */
const resetsAt = Date.now() / 1000 + 3600;
const view: SubscriptionPoolView = {
  providerId: 'anthropic',
  configured: true,
  strategy: 'least',
  accounts: [
    { id: 'default', paused: false, limit: 4, weight: 1, directory: '/home/.claude', status: 'ready', running: 0, identity: 'first@example.test',
      plan: 'max', planTier: 'max_20x', usage: { claude: { source: 'oauth-endpoint', updatedAt: Date.now(),
        fiveHour: { utilization: 10, resetsAt }, sevenDay: { utilization: 20, resetsAt }, scoped: [] } } },
    {
      id: 'cindy-owner-second',
      paused: false,
      limit: 4,
      limitSet: true,
      weight: 1,
      directory: '/home/.claude-second',
      status: 'ready',
      running: 0,
      identity: 'second@example.test',
      usage: {
        claude: {
          source: 'oauth-endpoint',
          updatedAt: Date.now(),
          fiveHour: { utilization: 30, resetsAt },
          sevenDay: { utilization: 40, resetsAt },
          scoped: [{ modelId: 'claude-fable', modelDisplayName: 'Fable', utilization: 16, resetsAt }],
        },
      },
    },
  ],
};

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    subscriptionAccounts: {
      command: vi.fn(async () => view),
      onChanged: vi.fn(() => () => undefined),
    },
    // Providers an account may move to (2026-11-13); none of the same kind unless a test adds them.
    maker: { listProviders: vi.fn(async () => ({ providers: [] })) },
  };
});

describe('SubscriptionAccountsSection usage', () => {
  // Unit: the CLI-origin row hid Remove even though it must be an ordinary pool member.
  it('allows removing the first CLI-origin account through the same menu and command', async () => {
    render(<SubscriptionAccountsSection providerId="anthropic" />);
    const rows = await screen.findAllByTestId('subscription-account');
    fireEvent.pointerDown(within(rows[0]).getByRole('button', { name: 'providerGroup.member.moreAria' }),
      { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'subscriptionAccounts.remove' }));
    await waitFor(() => expect(window.electronAPI.subscriptionAccounts.command).toHaveBeenCalledWith({
      action: 'remove', providerId: 'anthropic', accountId: 'default',
    }));
  });
  // Unit regression: the real second-account row must expose the shared reset UI
  // and send its own scope/key. Previously only the supplied default card had it.
  it.each([true, false])('shows and saves second-account reset preferences with quota present=%s', async hasQuota => {
    const scope = 'openai-account:cindy-owner-second';
    const autoUse = { accountKey: 'second-account-key', settings: {
      enabled: false, lowQuota: true, minimumDays: 3, expiring: true, expiryMinutes: 60,
    }, customized: false, lastUsedAt: null };
    const snapshot = { providerId: scope, account: { email: 'se***@example.test', accountId: '…second', planType: 'pro' },
      rateLimits: {}, rateLimitsByLimitId: null, rateLimitResetCredits: { availableCount: 1, credits: null }, resetOffer: null, autoUse };
    const getCodexRateLimits = vi.fn(async () => snapshot);
    const setCodexResetAutoUse = vi.fn(async () => ({ ...snapshot, autoUse: {
      ...autoUse, settings: { ...autoUse.settings, enabled: true }, customized: true,
    } }));
    Object.assign(window.electronAPI.maker, { usage: { getCodexRateLimits, setCodexResetAutoUse } });
    vi.mocked(window.electronAPI.subscriptionAccounts.command).mockResolvedValue({ ...view, providerId: 'openai', accounts: [
      view.accounts[0], { ...view.accounts[1], codexResetProviderId: scope, usage: hasQuota ? { codex: { credits: null, buckets: {
        codex: { limitId: 'codex', limitName: null, updatedAt: Date.now(), primary: null,
          secondary: { usedPercent: 20, windowMinutes: 10080, resetsAt } },
      } } } : undefined },
    ] });
    render(<SubscriptionAccountsSection providerId="openai" defaultUsage={<div>Default quota</div>} />);
    const rows = await screen.findAllByTestId('subscription-account');
    const toggle = await within(rows[1]).findByRole('switch', { name: 'codexResets.autoUse.label' });
    expect(screen.queryByText('Default quota')).toBeNull();
    expect(within(rows[1]).getByText('codexResets.title')).toBeTruthy();
    expect(getCodexRateLimits).toHaveBeenCalledWith(scope);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    fireEvent.click(toggle);
    await waitFor(() => expect(setCodexResetAutoUse).toHaveBeenCalledWith({ enabled: true }, 'second-account-key', scope));
  });
  // Unit: independent expiry dates and the inline renewal target are observable
  // through the real component; existing tests only exercised the overflow menu.
  it('shows each account expiry and renews only the account clicked', async () => {
    let current = { ...view, accounts: view.accounts.map((account, i) => ({
      ...account, loginExpiresAt: new Date(Date.now() + (i === 0 ? 18 : 3) * 86_400_000).toISOString(),
    })) };
    const command = vi.mocked(window.electronAPI.subscriptionAccounts.command).mockImplementation(async request => {
      if (request.action === 'login') current = { ...current, accounts: current.accounts.map(account =>
        account.id === request.accountId ? { ...account, loginExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() } : account) };
      return current;
    });
    render(<SubscriptionAccountsSection providerId="anthropic" />);
    const rows = await screen.findAllByTestId('subscription-account');
    expect(within(rows[0]).getByText('Expires in about 18 days')).toBeTruthy();
    expect(within(rows[1]).getByText('Expires in about 3 days')).toBeTruthy();
    expect(within(rows[0]).queryByRole('button', { name: 'Sign in again to first@example.test' })).toBeNull();
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Sign in again to second@example.test' }));
    await screen.findByText('Expires in about 30 days');
    expect(command).toHaveBeenCalledWith({ action: 'login', providerId: 'anthropic', accountId: 'cindy-owner-second', loginKey: expect.any(String) });
    expect(within(rows[0]).getByText('Expires in about 18 days')).toBeTruthy();
  });
  it('keeps a past estimate connected, disables renewal while busy, and tolerates older hosts', async () => {
    vi.mocked(window.electronAPI.subscriptionAccounts.command).mockResolvedValue({
      ...view, accounts: [{ ...view.accounts[0], loginExpiresAt: '2020-01-01T00:00:00Z', running: 1 }, view.accounts[1]],
    });
    render(<SubscriptionAccountsSection providerId="anthropic" />);
    await screen.findByText('subscriptionAccounts.loginMayHaveExpired');
    expect(screen.queryByText('subscriptionAccounts.signedOut')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in again to first@example.test' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('subscriptionAccounts.loginExpiryUnknown')).toBeTruthy();
  });
  it.each([
    ['SUBSCRIPTION_CLAUDE_ACCOUNT_MISMATCH', 'loginIdentityMismatch'],
    ['SUBSCRIPTION_CLAUDE_IDENTITY_UNKNOWN', 'loginIdentityUnknown'],
  ])('explains %s instead of claiming renewal succeeded', async (code, message) => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
    vi.mocked(window.electronAPI.subscriptionAccounts.command).mockImplementation(async request => {
      if (request.action === 'login') throw new Error(`[${code}] Sign in again`);
      return { ...view, accounts: [{ ...view.accounts[0], status: 'signed-out', authIssue: 'claude-account-mismatch' }] };
    });
    render(<SubscriptionAccountsSection providerId="anthropic" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in again to first@example.test' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(`subscriptionAccounts.${message}`));
    expect(screen.getByText('subscriptionAccounts.loginIdentityMismatchStatus')).toBeTruthy();
  });
  // #9517, unit: existing settings tests never exercised an account operation
  // failure. A serialized provider-auth error must show the recovery instruction.
  it('explains provider-managed authentication when account login fails', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
    vi.mocked(window.electronAPI.subscriptionAccounts.command).mockImplementation(async command => {
      if (command.action === 'add') throw new Error('[SUBSCRIPTION_CODEX_PROVIDER_AUTH] Account unavailable');
      return { ...view, providerId: 'openai' };
    });
    render(<SubscriptionAccountsSection providerId="openai" />);
    fireEvent.click(await screen.findByRole('button', { name: 'subscriptionAccounts.add' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('subscriptionAccounts.providerManagedAuth'));
  });

  it('shows each account quota and tier without a privileged default card', async () => {
    render(
      <SubscriptionAccountsSection
        providerId="anthropic"
        defaultUsage={<div data-testid="original-card">original</div>}
      />,
    );
    const rows = await screen.findAllByTestId('subscription-account');
    expect(rows).toHaveLength(2);
    expect(screen.queryByTestId('original-card')).toBeNull();
    expect(within(rows[0]).getByText('Max 20×')).toBeTruthy();
    expect(screen.queryByText('subscriptionAccounts.defaultTag')).toBeNull();
    const added = within(rows[1] as HTMLElement);
    for (const name of ['quotaCard.fiveHourLabel', 'quotaCard.weeklyLabel', 'Fable weekly'])
      expect(added.getByRole('progressbar', { name })).toBeTruthy();
    expect(within(rows[0]).getByRole('progressbar', { name: 'quotaCard.fiveHourLabel' })).toBeTruthy();
  });
  // Regression: a failed refresh kept the list and also showed the provider card below it.
  it('keeps account quotas without adding a legacy card when refresh fails', async () => {
    render(
      <SubscriptionAccountsSection
        providerId="anthropic"
        defaultUsage={<div data-testid="original-card">original</div>}
      />,
    );
    await screen.findAllByTestId('subscription-account');
    vi.mocked(window.electronAPI.subscriptionAccounts.command).mockRejectedValueOnce(new Error('offline'));
    fireEvent.focus(window);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('original-card')).toBeNull();
    expect(screen.getAllByTestId('subscription-account-usage')).toHaveLength(2);
  });
  // Unit regression: a first failed account read had no in-place recovery action.
  // Unlike the refresh-failure case above, no cached account rows exist yet.
  it('retries a failed initial read in place without creating or replacing accounts', async () => {
    const command = vi.mocked(window.electronAPI.subscriptionAccounts.command);
    command.mockRejectedValueOnce(new Error('unavailable'));
    render(<SubscriptionAccountsSection providerId="anthropic" locationLabel="This computer" />);
    await screen.findByRole('alert');
    expect(screen.getByText('This computer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'commonUi.retry' }));
    await screen.findByText('first@example.test');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(command.mock.calls.every(([request]) => request.action === 'read')).toBe(true);
    expect(screen.getAllByTestId('subscription-account')).toHaveLength(2);
  });

  // Unit: a disconnected OpenAI account had no inline recovery, and a transient
  // status-read failure must retry reads instead of starting a new login.
  it.each(['signed-out', 'unavailable'] as const)('recovers an OpenAI %s account from its own row', async status => {
    const command = vi.mocked(window.electronAPI.subscriptionAccounts.command);
    command.mockResolvedValue({ ...view, providerId: 'openai', accounts: [{ ...view.accounts[1], status }] });
    render(<SubscriptionAccountsSection providerId="openai" />);
    const row = await screen.findByTestId('subscription-account');
    command.mockClear();
    const name = status === 'signed-out' ? 'Sign in again to second@example.test' : 'commonUi.retry';
    fireEvent.click(within(row).getByRole('button', { name }));
    if (status === 'signed-out') await waitFor(() => expect(command).toHaveBeenCalledWith({
      action: 'login', providerId: 'openai', accountId: 'cindy-owner-second', loginKey: expect.any(String),
    }));
    else await waitFor(() => expect(command).toHaveBeenCalledWith({ action: 'read', providerId: 'openai' }));
    expect(command.mock.calls.every(([request]) => request.action === 'read' || request.action === 'login')).toBe(true);
    if (status === 'unavailable') expect(command.mock.calls.every(([request]) => request.action === 'read')).toBe(true);
  });

  // Regression: a connected account's menu offered plain "Sign in", reading as if it were signed out.
  it.each([
    ['ready', 'subscriptionAccounts.loginAgain'],
    ['signed-out', 'subscriptionAccounts.login'],
  ] as const)('labels sign-in for a %s account by its state', async (status, label) => {
    vi.mocked(window.electronAPI.subscriptionAccounts.command).mockResolvedValue({
      ...view,
      accounts: [{ ...view.accounts[0], status }],
    });
    render(<SubscriptionAccountsSection providerId="anthropic" />);
    const trigger = await screen.findByRole('button', { name: 'providerGroup.member.moreAria' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    expect(await screen.findByRole('menuitem', { name: label })).toBeTruthy();
  });
  // Regression: with nothing signed in, the CLI default slot showed as "Account 1 · Needs sign-in"
  // with a strategy picker, limit and switch, as if an account existed.
  it('lists no account and no strategy before anything signs in', async () => {
    vi.mocked(window.electronAPI.subscriptionAccounts.command).mockResolvedValue({
      ...view,
      configured: false,
      accounts: [{ ...view.accounts[0], identity: undefined, status: 'signed-out' }],
    });
    render(<SubscriptionAccountsSection providerId="anthropic" />);
    // The loading placeholder goes once the read lands.
    await vi.waitFor(() => expect(screen.queryByTestId('subscription-accounts-loading')).toBeNull());
    expect(screen.queryAllByTestId('subscription-account')).toHaveLength(0);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText('1')).toBeNull();
    expect(screen.getByRole('button', { name: 'subscriptionAccounts.add' })).toBeTruthy();
  });
  // Regression (2026-11-14): switching back to a subscription provider emptied its list into a
  // spinner, then pushed the page down again when the read landed. Within one providers page the
  // last list stays on screen while the fresh read replaces it. Minimal input: remount with the
  // read still pending (before the fix: no rows, only the spinner).
  it('shows the last list at once when the providers page switches back to it', async () => {
    const page = (
      <SubscriptionPoolViewCache.Provider value={new Map()}>
        <SubscriptionAccountsSection providerId="anthropic" />
      </SubscriptionPoolViewCache.Provider>
    );
    const { unmount } = render(page);
    expect(await screen.findAllByTestId('subscription-account')).toHaveLength(2);
    unmount();
    let land: (next: SubscriptionPoolView) => void = () => {};
    vi.mocked(window.electronAPI.subscriptionAccounts.command).mockImplementation(
      () => new Promise<SubscriptionPoolView>((resolve) => { land = resolve; }),
    );
    render(page);
    expect(screen.getAllByTestId('subscription-account')).toHaveLength(2);
    expect(screen.queryByTestId('subscription-accounts-loading')).toBeNull();
    await act(async () => { land({ ...view, accounts: [view.accounts[1]] }); });
    expect(screen.getAllByTestId('subscription-account')).toHaveLength(1);
  });
  // An account that needs signing in again is still an account: known, busy, or beside another.
  const unknown = { ...view.accounts[0], identity: undefined, status: 'signed-out' as const };
  it.each([
    ['its identity is known', [{ ...unknown, identity: 'first@example.test' }]],
    ['another account exists', [unknown, view.accounts[1]]],
    ['a task still runs on it', [{ ...unknown, running: 1 }]],
  ])('keeps a signed-out default account when %s', async (_, accounts) => {
    vi.mocked(window.electronAPI.subscriptionAccounts.command).mockResolvedValue({ ...view, accounts });
    render(<SubscriptionAccountsSection providerId="anthropic" />);
    expect(await screen.findAllByTestId('subscription-account')).toHaveLength(accounts.length);
  });
  it('shows the strategy only when there are accounts to choose between', async () => {
    vi.mocked(window.electronAPI.subscriptionAccounts.command).mockResolvedValue({
      ...view,
      strategy: 'weight',
      accounts: [view.accounts[0]],
    });
    const { unmount } = render(<SubscriptionAccountsSection providerId="anthropic" />);
    expect(await screen.findAllByTestId('subscription-account')).toHaveLength(1);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByLabelText('providerGroup.member.weightAria')).toBeNull();
    expect(screen.getByLabelText('providerGroup.member.limitAria')).toBeTruthy();
    unmount();
    vi.mocked(window.electronAPI.subscriptionAccounts.command).mockResolvedValue({ ...view, strategy: 'weight' });
    render(<SubscriptionAccountsSection providerId="anthropic" />);
    expect(await screen.findByRole('radiogroup', { name: 'subscriptionAccounts.strategy' })).toBeTruthy();
    expect(screen.getAllByLabelText('providerGroup.member.weightAria')).toHaveLength(2);
    // 2026-11-11: an unset (legacy default 4) limit reads as unlimited; a chosen limit shows its number.
    const [first, second] = screen.getAllByTestId('subscription-account');
    expect(within(first).getByText('providerGroup.member.limitUnlimited')).toBeTruthy();
    expect(within(second).getByText('providerGroup.member.limitOption')).toBeTruthy();
    expect(within(second).queryByText('providerGroup.member.limitUnlimited')).toBeNull();
  });
  // The folder path used to be an always-visible disclosure under every account; it is now a menu action.
  it('opens the account folder from the account menu and reports a failure', async () => {
    const openPath = vi.fn(async () => ({ success: false, error: 'missing' }));
    Object.assign(window.electronAPI, { openPath });
    const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
    render(<SubscriptionAccountsSection providerId="anthropic" />);
    const [, second] = await screen.findAllByRole('button', { name: 'providerGroup.member.moreAria' });
    fireEvent.pointerDown(second, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'subscriptionAccounts.openDirectory' }));
    await vi.waitFor(() => expect(openPath).toHaveBeenCalledWith('/home/.claude-second'));
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('subscriptionAccounts.openDirectoryFailed'));
    expect(screen.queryByText('/home/.claude-second')).toBeNull();
  });
});
