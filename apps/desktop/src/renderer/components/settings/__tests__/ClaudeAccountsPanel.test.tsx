// @vitest-environment jsdom
/**
 * Settings → Providers → Claude Code → Claude accounts panel.
 *
 * 测试价值
 * - 生产入口与可观察结果：ClaudeAccountsPanel 渲染的账号行、徽标与操作按钮；点击后发出的
 *   electronAPI 调用、提示与列表刷新。
 * - 规则依据：docs/dev-rules/claude-multi-account.md §4（主账号不可移除、切换无需登录、
 *   添加可取消、失败原因可见）。
 * - 现有覆盖缺口：新面板，无既有覆盖。
 * - 最小失败输入：切换到已登出账号；取消进行中的添加；移除前确认被拒。
 * - tier：unit（jsdom，electronAPI 假实现）。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeAccountSwitchResult, ClaudeAccountsListView } from '../../../../shared/claudeAccounts';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${Object.values(values).join(',')}` : key,
  }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast }));
const dialogs = vi.hoisted(() => ({ confirm: vi.fn(async () => true) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => dialogs }));

import { ClaudeAccountsPanel } from '../ClaudeAccountsPanel';

const LIST: ClaudeAccountsListView = {
  activeAccountId: 'master',
  accounts: [
    { id: 'master', kind: 'master', label: 'Master', email: 'me@example.com', subscriptionType: 'pro', active: true },
    { id: 'acct_work0001', kind: 'extra', label: 'Work', email: 'w@example.com', active: false },
  ],
};

const api = {
  claudeAccountsList: vi.fn(async () => LIST),
  claudeAccountsAdd: vi.fn(),
  claudeAccountsCancelAdd: vi.fn(async () => undefined),
  claudeAccountsSwitch: vi.fn(async (): Promise<ClaudeAccountSwitchResult> => ({ ok: true })),
  claudeAccountsRemove: vi.fn(async () => ({ ok: true })),
  claudeAccountsHealth: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  dialogs.confirm.mockResolvedValue(true);
  api.claudeAccountsList.mockResolvedValue(LIST);
  (window as unknown as { electronAPI: unknown }).electronAPI = { maker: api };
});
afterEach(cleanup);

async function rowFor(label: string) {
  return (await screen.findByText(label)).closest('li') as HTMLElement;
}

describe('ClaudeAccountsPanel', () => {
  it('shows every account with master/active badges and only the allowed actions', async () => {
    render(<ClaudeAccountsPanel />);
    const master = await rowFor('Master');
    expect(within(master).getByText('claudeAccounts.settings.master')).toBeTruthy();
    expect(within(master).getByText('claudeAccounts.settings.active')).toBeTruthy();
    expect(within(master).getByText(/me@example.com/)).toBeTruthy();
    expect(within(master).queryByRole('button', { name: 'claudeAccounts.settings.switch' })).toBeNull();
    // The master is never removable.
    expect(within(master).queryByRole('button', { name: 'claudeAccounts.settings.remove' })).toBeNull();
    const work = await rowFor('Work');
    expect(within(work).getByRole('button', { name: 'claudeAccounts.settings.switch' })).toBeTruthy();
    expect(within(work).getByRole('button', { name: 'claudeAccounts.settings.remove' })).toBeTruthy();
    expect(screen.getByText('claudeAccounts.settings.ownership')).toBeTruthy();
  });

  it('switches without signing in and refreshes the list', async () => {
    render(<ClaudeAccountsPanel />);
    fireEvent.click(within(await rowFor('Work')).getByRole('button', { name: 'claudeAccounts.settings.switch' }));
    await waitFor(() => expect(api.claudeAccountsSwitch).toHaveBeenCalledWith('acct_work0001'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('claudeAccounts.settings.toast.switched Work'));
    expect(api.claudeAccountsAdd).not.toHaveBeenCalled();
    expect(api.claudeAccountsList).toHaveBeenCalledTimes(2);
  });

  it('explains why a switch was refused', async () => {
    api.claudeAccountsSwitch.mockResolvedValueOnce({ ok: false, reason: 'not_logged_in' });
    render(<ClaudeAccountsPanel />);
    fireEvent.click(within(await rowFor('Work')).getByRole('button', { name: 'claudeAccounts.settings.switch' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('claudeAccounts.settings.error.not_logged_in'));
  });

  it('adds an account with one sign-in, and the same attempt can be cancelled', async () => {
    let finish!: (value: unknown) => void;
    api.claudeAccountsAdd.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<ClaudeAccountsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'claudeAccounts.settings.add' }));
    fireEvent.change(screen.getByLabelText('claudeAccounts.settings.nameLabel'), { target: { value: 'Second' } });
    fireEvent.click(screen.getByRole('button', { name: 'claudeAccounts.settings.signIn' }));
    expect(await screen.findByText('claudeAccounts.settings.signingIn')).toBeTruthy();
    const [label, loginKey] = api.claudeAccountsAdd.mock.calls[0] as [string, string];
    expect(label).toBe('Second');
    fireEvent.click(screen.getByRole('button', { name: 'claudeAccounts.settings.cancel' }));
    await waitFor(() => expect(api.claudeAccountsCancelAdd).toHaveBeenCalledWith(loginKey));
    finish({ ok: false, reason: 'login_cancelled' });
    await waitFor(() => expect(screen.queryByText('claudeAccounts.settings.signingIn')).toBeNull());
    // A cancelled sign-in is not an error.
    expect(toast.error).not.toHaveBeenCalled();

    api.claudeAccountsAdd.mockResolvedValueOnce({
      ok: true,
      account: { id: 'acct_new00001', kind: 'extra', label: 'Second', active: false },
    });
    fireEvent.click(screen.getByRole('button', { name: 'claudeAccounts.settings.signIn' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('claudeAccounts.settings.toast.added Second'));
  });

  it('shows the reason when adding fails', async () => {
    api.claudeAccountsAdd.mockResolvedValueOnce({ ok: false, reason: 'duplicate_identity' });
    render(<ClaudeAccountsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'claudeAccounts.settings.add' }));
    fireEvent.change(screen.getByLabelText('claudeAccounts.settings.nameLabel'), { target: { value: 'Again' } });
    fireEvent.click(screen.getByRole('button', { name: 'claudeAccounts.settings.signIn' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('claudeAccounts.settings.error.duplicate_identity'));
  });

  it('removes only after confirmation', async () => {
    dialogs.confirm.mockResolvedValueOnce(false);
    render(<ClaudeAccountsPanel />);
    const remove = within(await rowFor('Work')).getByRole('button', { name: 'claudeAccounts.settings.remove' });
    fireEvent.click(remove);
    await waitFor(() => expect(dialogs.confirm).toHaveBeenCalledTimes(1));
    expect(api.claudeAccountsRemove).not.toHaveBeenCalled();
    fireEvent.click(remove);
    await waitFor(() => expect(api.claudeAccountsRemove).toHaveBeenCalledWith('acct_work0001'));
    expect(dialogs.confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmVariant: 'destructive', title: 'claudeAccounts.settings.removeConfirm.title Work' }),
    );
  });

  it('checks every account and shows what needs repair', async () => {
    api.claudeAccountsHealth.mockResolvedValueOnce([
      { accountId: 'master', label: 'Master', loggedIn: true, email: 'me@example.com' },
      {
        accountId: 'acct_work0001',
        label: 'Work',
        loggedIn: true,
        profile: { healthy: false, mode: 'linked', problems: [{ name: 'skills', state: 'missing' }] },
      },
    ]);
    render(<ClaudeAccountsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'claudeAccounts.settings.check' }));
    expect(within(await rowFor('Master')).getByText('claudeAccounts.settings.health.ok')).toBeTruthy();
    expect(within(await rowFor('Work')).getByText('claudeAccounts.settings.health.needsRepair skills')).toBeTruthy();
  });
});
