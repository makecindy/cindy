// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@/lib/toast';
import type { SubscriptionPoolView } from '../../../../shared/subscriptionAccounts';

const confirmPlacement = vi.hoisted(() => vi.fn<(options: unknown) => Promise<boolean>>(async () => true));
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
  useConfirmDialog: () => ({ confirm: confirmPlacement }),
}));

import { SubscriptionAccountsSection, SubscriptionPoolViewCache } from '../SubscriptionAccountsSection';
import { ExistingSubscriptionLogins } from '../ExistingSubscriptionLogins';
import { MergeProviderButton } from '../SubscriptionPlacement';

/* 测试价值：多账号设置页曾给每个账号另画一条周用量条，又在底部重复原用量卡，且漏掉
 * 5 小时与分模型周窗口。经真实组件验证：默认账号行放原用量卡，其他账号用同一张卡显示
 * 自己的全部窗口。tier: unit；IPC 以 mock 注入，无外网/Agent。 */
const resetsAt = Date.now() / 1000 + 3600;
const view: SubscriptionPoolView = {
  providerId: 'anthropic',
  configured: true,
  strategy: 'expiring',
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
  confirmPlacement.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    subscriptionAccounts: {
      command: vi.fn(async () => view),
      onChanged: vi.fn(() => () => undefined),
    },
    // Providers an account may move to (2026-11-13); none of the same kind unless a test adds them.
    maker: { listProviders: vi.fn(async () => ({ providers: [] })) },
  };
});

// #12999, unit: leave settings and then the review dialog open past the host's ten-minute
// receipt lifetime. Other account tests never let a reviewed login change before confirmation.
it('reviews the current login again after idle time, without background scans or attaching an old receipt', async () => {
  vi.useFakeTimers();
  try {
    const result = (identity: string) => ({ computer: 'Fixture', candidates: [
      { identity, directory: '/fixture/.claude-person', receipt: identity },
    ] });
    const api = vi.fn().mockResolvedValueOnce(result('initial'))
      .mockResolvedValueOnce(result('on-open')).mockResolvedValueOnce(result('on-confirm'))
      .mockResolvedValue({ computer: 'Fixture', candidates: [] });
    window.electronAPI.subscriptionAccounts.existingLogins = api;
    await act(async () => { render(<ExistingSubscriptionLogins provider="anthropic" disabled={false}>Add</ExistingSubscriptionLogins>); });
    expect(screen.getByRole('button', { name: 'subscriptionAccounts.existing.found' })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(11 * 60_000); });
    expect(screen.queryByRole('button', { name: 'subscriptionAccounts.existing.found' })).toBeNull();
    expect(api).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'subscriptionAccounts.existing.menu' }), { button: 0, pointerType: 'mouse' });
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'subscriptionAccounts.existing.connect' })); });
    expect(screen.getByText('on-open')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(11 * 60_000); });
    expect(screen.queryByRole('button', { name: 'subscriptionAccounts.existing.attach' })).toBeNull();
    expect(api).toHaveBeenCalledTimes(2);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'subscriptionAccounts.existing.connect' })); });
    expect(screen.getByText('on-confirm')).toBeTruthy();
    expect(api.mock.calls.map(([request]) => request.action)).toEqual(Array(3).fill('discover-logins'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'subscriptionAccounts.existing.attach' })); });
    expect(api).toHaveBeenLastCalledWith({ action: 'attach-login', providerId: 'anthropic', receipt: 'on-confirm' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

// A folder picked outside the discovery roots can only be verified again through the picker.
it('keeps an expired custom folder selection on the explicit picker path', async () => {
  vi.useFakeTimers();
  try {
    const api = vi.fn().mockResolvedValueOnce({ computer: 'Fixture', candidates: [] })
      .mockResolvedValueOnce({ computer: 'Fixture', candidates: [{ identity: 'custom', directory: '/custom', receipt: 'old' }] })
      .mockResolvedValueOnce({ computer: 'Fixture', canceled: true, candidates: [] });
    window.electronAPI.subscriptionAccounts.existingLogins = api;
    await act(async () => { render(<ExistingSubscriptionLogins provider="openai" disabled={false}>Add</ExistingSubscriptionLogins>); });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'subscriptionAccounts.existing.menu' }), { button: 0, pointerType: 'mouse' });
    await act(async () => { fireEvent.click(screen.getByRole('menuitem')); });
    expect(screen.getByText('custom')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(11 * 60_000); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'subscriptionAccounts.existing.choose' })); });
    expect(api.mock.calls.map(([request]) => request.action)).toEqual(['discover-logins', 'pick-login', 'pick-login']);
    expect(screen.queryByRole('button', { name: 'subscriptionAccounts.existing.attach' })).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

// Unit through the real placement controls with IPC fixtures. The mixed
// command must follow source → destination and retain the existing login and
// whole-subscription commands, which have different persistence effects.
it.each(['subscription', 'apiKey'] as const)('merges from %s through the existing provider menu', async kind => {
  const fromSubscription = kind === 'subscription';
  const subscriptionId = fromSubscription ? 'openai-sub-12345678' : 'openai';
  const source = fromSubscription ? subscriptionId : 'fixture-key';
  const target = fromSubscription ? 'fixture-key' : 'openai';
  const accounts = [
    { id: subscriptionId, name: 'Fixture subscription', kind: 'subscription', connected: true },
    { id: 'fixture-key', name: 'Fixture key', kind: 'apiKey', connected: true },
  ].map(account => ({ ...account, kind: account.kind as 'subscription' | 'apiKey', included: account.id === source,
    ...(account.id === target ? { mergeTarget: true as const } : {}) }));
  const command = vi.fn(async () => ({ ok: true }));
  Object.assign(window.electronAPI, { providerGroup: { command } });
  render(fromSubscription
    ? <SubscriptionAccountsSection providerId={source} openAiAccounts={accounts} />
    : <MergeProviderButton kind={null} providerId={source} providerName="Fixture key" openAiAccounts={accounts} />);
  if (fromSubscription) {
    fireEvent.click(screen.getByRole('button', { name: 'subscriptionAccounts.add' }));
    await waitFor(() => expect(window.electronAPI.subscriptionAccounts.command).toHaveBeenCalledWith({
      action: 'add', providerId: source, loginKey: expect.any(String),
    }));
    expect(command).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'subscriptionAccounts.add' })).toBeTruthy());
  } else {
    expect(screen.queryByRole('button', { name: 'subscriptionAccounts.add' })).toBeNull();
  }
  fireEvent.pointerDown(screen.getByRole('button', { name: 'subscriptionAccounts.placement.mergeInto' }),
    { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('menuitem', { name: fromSubscription ? 'Fixture key' : 'Fixture subscription' }));
  await waitFor(() => expect(command).toHaveBeenCalledWith({
    action: 'account-merge', providerId: source, targetProviderId: target,
  }));
  expect(confirmPlacement).toHaveBeenCalledWith(expect.objectContaining({ description: 'openAiAccountGroup.mergeDescription' }));
  expect(window.electronAPI.subscriptionAccounts.command).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'merge' }));
});

// Unit: the pool settings and the mixed-account directory can both report the
// same target after a key owns native accounts. One menu row must issue the mixed command.
it('offers a target only once and prefers the mixed merge command', async () => {
  const source = 'openai-sub-12345678';
  const target = 'fixture-key';
  vi.mocked(window.electronAPI.maker.listProviders).mockResolvedValue({ providers: [
    { id: target, name: 'OpenAI', connected: true, subscriptionAccountPool: 'openai' },
  ] } as Awaited<ReturnType<typeof window.electronAPI.maker.listProviders>>);
  // A billing refusal is a successful membership save, not a successful Key test.
  const command = vi.fn(async () => ({ ok: true, probe: { ok: false, code: 'QUOTA_EXCEEDED', billingCode: 'credit_balance_exhausted' } }));
  const onDone = vi.fn();
  Object.assign(window.electronAPI, { providerGroup: { command } });
  render(<MergeProviderButton kind="openai" providerId={source} providerName="Subscription" onDone={onDone} openAiAccounts={[
    { id: source, name: 'Subscription', kind: 'subscription', included: true, connected: true },
    { id: target, name: 'OpenAI', kind: 'apiKey', included: false, connected: true, mergeTarget: true },
  ]} />);
  await waitFor(() => expect(window.electronAPI.maker.listProviders).toHaveBeenCalled());
  await act(async () => { fireEvent.pointerDown(screen.getByRole('button', { name: 'subscriptionAccounts.placement.mergeInto' }), { button: 0, pointerType: 'mouse' }); });
  expect(screen.getAllByRole('menuitem', { name: 'OpenAI' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('menuitem', { name: 'OpenAI' }));
  await waitFor(() => expect(command).toHaveBeenCalledWith({ action: 'account-merge', providerId: source, targetProviderId: target }));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  expect(window.electronAPI.subscriptionAccounts.command).not.toHaveBeenCalled();
});

it('continues to use the subscription placement command for same-kind providers', async () => {
  vi.mocked(window.electronAPI.maker.listProviders).mockResolvedValue({ providers: [
    { id: 'openai', name: 'Existing subscription', connected: true },
  ] } as Awaited<ReturnType<typeof window.electronAPI.maker.listProviders>>);
  render(<SubscriptionAccountsSection providerId="other-openai" kind="openai" />);
  fireEvent.pointerDown(await screen.findByRole('button', { name: 'subscriptionAccounts.placement.mergeInto' }),
    { button: 0, ctrlKey: false, pointerType: 'mouse' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Existing subscription' }));
  await waitFor(() => expect(window.electronAPI.subscriptionAccounts.command).toHaveBeenCalledWith({
    action: 'merge', providerId: 'other-openai', target: 'openai',
  }));
  expect(confirmPlacement).toHaveBeenCalledWith(expect.objectContaining({ description: 'subscriptionAccounts.placement.mergeDescription' }));
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
  // Unit: a target's own API Key is a permanent part of this source. Only
  // another, merged connection should offer the remove command.
  it('keeps testing but hides the impossible remove action on the target Key', async () => {
    const providerId = 'target-key-fixture';
    const apiAccount = (id: string, connectionId: string) => ({
      ...view.accounts[0]!, id, identity: connectionId, usage: undefined,
      apiKey: { connectionId, checks: [{ agent: 'pi' as const, ...(connectionId === providerId ? {} : {
        result: { ok: false, code: 'QUOTA_EXCEEDED' as const, billingCode: 'credit_balance_exhausted' as const }, blocked: true as const,
      }) }] },
    });
    vi.mocked(window.electronAPI.subscriptionAccounts.command).mockResolvedValue({
      providerId, configured: true, strategy: 'expiring',
      accounts: [apiAccount('key-target', providerId), apiAccount('key-member', 'other-key-fixture')],
    });
    render(<SubscriptionAccountsSection providerId={providerId} kind="openai" />);
    const [own, merged] = await screen.findAllByTestId('subscription-account');
    expect(within(own).getByRole('button', { name: /settings.providers.custom.test.button/ })).toBeTruthy();
    expect(within(own).queryByRole('button', { name: 'providerGroup.member.moreAria' })).toBeNull();
    expect(within(merged).getByText('openAiAccountGroup.billingPaused')).toBeTruthy();
    fireEvent.pointerDown(within(merged).getByRole('button', { name: 'providerGroup.member.moreAria' }),
      { button: 0, ctrlKey: false, pointerType: 'mouse' });
    expect(await screen.findByRole('menuitem', { name: 'subscriptionAccounts.remove' })).toBeTruthy();
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
  // Unit, 2026-11-24 Claude long-lived token (subscription-account-pools.md「Claude 长期令牌」):
  // a row on a token must report the token, stop nagging about the ordinary sign-in it no longer
  // depends on, and send its own commands. The expiry cases above only know the ordinary sign-in.
  // Minimal failing input: an account view with `longLivedToken`.
  it('reports the token instead of the ordinary sign-in, and creates or stops it from the account menu', async () => {
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    let current: SubscriptionPoolView = { ...view, accounts: [
      { ...view.accounts[0], loginExpiresAt: soon },
      { ...view.accounts[1], loginExpiresAt: soon, longLivedToken: {
        expiresAt: new Date(Date.now() + 300 * 86_400_000).toISOString(), storedLogin: true, verification: 'pending',
      } },
    ] };
    const command = vi.mocked(window.electronAPI.subscriptionAccounts.command).mockImplementation(async request => {
      if (request.action === 'token-login') current = { ...current, accounts: current.accounts.map(account =>
        account.id === request.accountId ? { ...account, longLivedToken: { storedLogin: true, verification: 'pending' as const } } : account) };
      if (request.action === 'token-remove') current = { ...current, accounts: current.accounts.map(account =>
        account.id === request.accountId ? { ...account, longLivedToken: undefined } : account) };
      return current;
    });
    render(<SubscriptionAccountsSection providerId="anthropic" />);
    const rows = () => screen.getAllByTestId('subscription-account');
    await screen.findAllByTestId('subscription-account');
    const openMenu = (row: HTMLElement) => fireEvent.pointerDown(
      within(row).getByRole('button', { name: 'providerGroup.member.moreAria' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });

    expect(within(rows()[1]).getByText('subscriptionAccounts.longLivedToken.tag')).toBeTruthy();
    expect(within(rows()[1]).getByTestId('subscription-account-token-expiry').textContent)
      .toBe('subscriptionAccounts.longLivedToken.expiresInDays');
    // Both ordinary sign-ins end in three days; only the row without a token still asks to renew.
    expect(within(rows()[1]).queryByRole('button', { name: 'Sign in again to second@example.test' })).toBeNull();
    expect(within(rows()[0]).getByRole('button', { name: 'Sign in again to first@example.test' })).toBeTruthy();

    openMenu(rows()[0]);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'subscriptionAccounts.longLivedToken.use' }));
    await waitFor(() => expect(command).toHaveBeenCalledWith({
      action: 'token-login', providerId: 'anthropic', accountId: 'default', loginKey: expect.any(String),
    }));
    await waitFor(() => expect(within(rows()[0]).getByText('subscriptionAccounts.longLivedToken.active')).toBeTruthy());

    openMenu(rows()[1]);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'subscriptionAccounts.longLivedToken.remove' }));
    await waitFor(() => expect(command).toHaveBeenCalledWith({
      action: 'token-remove', providerId: 'anthropic', accountId: 'cindy-owner-second',
    }));
    await waitFor(() => expect(within(rows()[1]).queryByText('subscriptionAccounts.longLivedToken.tag')).toBeNull());
  });
  it('says so when a token belongs to another account, without offering a sign-in that would not fix it', async () => {
    vi.mocked(window.electronAPI.subscriptionAccounts.command).mockResolvedValue({ ...view, accounts: [view.accounts[0], {
      ...view.accounts[1], status: 'signed-out', usage: undefined, authIssue: 'claude-token-account-mismatch',
      longLivedToken: { storedLogin: true, verification: 'mismatch' },
    }] });
    render(<SubscriptionAccountsSection providerId="anthropic" />);
    const row = (await screen.findAllByTestId('subscription-account'))[1];
    expect(within(row).getByText('subscriptionAccounts.longLivedToken.mismatchStatus')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Sign in again to second@example.test' })).toBeNull();
    fireEvent.pointerDown(within(row).getByRole('button', { name: 'providerGroup.member.moreAria' }),
      { button: 0, ctrlKey: false, pointerType: 'mouse' });
    expect(await screen.findByRole('menuitem', { name: 'subscriptionAccounts.longLivedToken.renew' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'subscriptionAccounts.longLivedToken.remove' })).toBeTruthy();
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
    // 读到之后账号区收成一行：名字在那一行和收起的账号列表里各有一处。
    await screen.findAllByText('first@example.test');
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
  // 2026-11-24：几个账号是一条自动路由，选法只在「智能路由」里改；账号区只说明现状。
  it('states the strategy only when there are accounts to choose between, without a second control', async () => {
    vi.mocked(window.electronAPI.subscriptionAccounts.command).mockResolvedValue({
      ...view,
      strategy: 'weighted',
      accounts: [view.accounts[0]],
    });
    const { unmount } = render(<SubscriptionAccountsSection providerId="anthropic" />);
    expect(await screen.findAllByTestId('subscription-account')).toHaveLength(1);
    expect(screen.queryByTestId('route-strategy-note')).toBeNull();
    expect(screen.queryByLabelText('providerGroup.member.weightAria')).toBeNull();
    expect(screen.getByLabelText('providerGroup.member.limitAria')).toBeTruthy();
    unmount();
    vi.mocked(window.electronAPI.subscriptionAccounts.command).mockResolvedValue({ ...view, strategy: 'weighted' });
    render(<SubscriptionAccountsSection providerId="anthropic" />);
    expect((await screen.findByTestId('route-strategy-note')).textContent).toContain('modelGroups.auto.assignedBy');
    expect(screen.queryByRole('radiogroup')).toBeNull();
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

/*
 * 插件引擎的账号(subscription-account-pools.md 插件引擎的账号，2026-11-23)：同一个账号区组件。
 * 生产入口：SubscriptionAccountsSection 以插件引擎的 providerId 渲染。可观察结果：账号行显示插件报告的身份、
 * 套餐与用量；只有一种浏览器登录方式时「添加账号」直接带上这种方式；插件只报告原有登录(没有登录方式)时
 * 没有「添加账号」和账号设置。最小失败输入：插件引擎 providerId 的读回结果。tier：unit(jsdom，IPC mock)。
 */
describe('SubscriptionAccountsSection for plugin engines', () => {
  const providerId = 'acp-plugin:zcode-plugin:zcode';
  const pluginView = (methods: NonNullable<SubscriptionPoolView['pluginEngine']>['methods']): SubscriptionPoolView => ({
    providerId,
    configured: true,
    strategy: 'expiring',
    pluginEngine: { engineKey: 'zcode-plugin:zcode', methods },
    accounts: [{
      id: 'default', paused: false, limit: 4, weight: 1, directory: '', status: 'ready', running: 0,
      identity: 'me@z.ai', plan: 'GLM Coding Pro',
      usage: { plugin: { updatedAt: Date.now(), windows: [{ label: 'GLM · 5h', remainingPercent: 70, resetsAt: Date.now() + 3_600_000 }] } },
    }],
  });

  it('shows the identity, plan and usage the plugin reports, and adds an account with its sign-in method', async () => {
    const command = vi.fn(async () => pluginView([{ id: 'zai', label: 'Z.ai', kind: 'browser' }]));
    (window.electronAPI.subscriptionAccounts as { command: unknown }).command = command;
    render(<SubscriptionAccountsSection providerId={providerId} />);
    const row = await screen.findByTestId('subscription-account');
    expect(within(row).getByText('me@z.ai')).toBeTruthy();
    expect(within(row).getByText('GLM Coding Pro')).toBeTruthy();
    expect(within(row).getByText('GLM · quotaCard.fiveHourLabel')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'subscriptionAccounts.add' }));
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({
      action: 'add', providerId, methodId: 'zai',
    })));
  });

  it('offers neither adding nor account settings when the plugin only reports its one login', async () => {
    (window.electronAPI.subscriptionAccounts as { command: unknown }).command = vi.fn(async () => pluginView([]));
    render(<SubscriptionAccountsSection providerId={providerId} />);
    const row = await screen.findByTestId('subscription-account');
    expect(within(row).getByText('me@z.ai')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'subscriptionAccounts.add' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'providerGroup.member.moreAria' })).toBeNull();
  });
});
