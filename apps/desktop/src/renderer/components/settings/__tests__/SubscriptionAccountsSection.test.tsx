// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@/lib/toast';
import type { SubscriptionPoolView } from '../../../../shared/subscriptionAccounts';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string, options: Record<string, unknown> = {}) =>
      key === 'quotaCard.modelWeeklyLabel' ? `${String(options.model)} weekly` : key,
  }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));

import { SubscriptionAccountsSection } from '../SubscriptionAccountsSection';

/* 测试价值：多账号设置页曾给每个账号另画一条周用量条，又在底部重复原用量卡，且漏掉
 * 5 小时与分模型周窗口。经真实组件验证：默认账号行放原用量卡，其他账号用同一张卡显示
 * 自己的全部窗口。tier: unit；IPC 以 mock 注入，无外网/Agent。 */
const resetsAt = Date.now() / 1000 + 3600;
const view: SubscriptionPoolView = {
  providerId: 'anthropic',
  configured: true,
  strategy: 'least',
  accounts: [
    { id: 'default', paused: false, limit: 4, weight: 1, directory: '/home/.claude', status: 'ready', running: 0, identity: 'first@example.test' },
    {
      id: 'cindy-owner-second',
      paused: false,
      limit: 4,
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
  };
});

describe('SubscriptionAccountsSection usage', () => {
  it('keeps the provider card on the default account and shows every window of added accounts', async () => {
    render(
      <SubscriptionAccountsSection
        providerId="anthropic"
        defaultUsage={<div data-testid="original-card">original</div>}
      />,
    );
    const original = await screen.findByTestId('original-card');
    const rows = screen.getAllByTestId('subscription-account');
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByTestId('original-card')).toBe(original);
    expect(screen.getAllByTestId('original-card')).toHaveLength(1);
    const added = within(rows[1] as HTMLElement);
    for (const name of ['quotaCard.fiveHourLabel', 'quotaCard.weeklyLabel', 'Fable weekly'])
      expect(added.getByRole('progressbar', { name })).toBeTruthy();
    expect(within(rows[0] as HTMLElement).queryByRole('progressbar')).toBeNull();
  });
  // Regression: a failed refresh kept the list and also showed the provider card below it.
  it('shows the provider card once when a refresh fails after the list loaded', async () => {
    render(
      <SubscriptionAccountsSection
        providerId="anthropic"
        defaultUsage={<div data-testid="original-card">original</div>}
      />,
    );
    await screen.findByTestId('original-card');
    vi.mocked(window.electronAPI.subscriptionAccounts.command).mockRejectedValueOnce(new Error('offline'));
    fireEvent.focus(window);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getAllByTestId('original-card')).toHaveLength(1);
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
