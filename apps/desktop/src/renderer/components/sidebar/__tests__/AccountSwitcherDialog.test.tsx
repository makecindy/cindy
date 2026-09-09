// @vitest-environment jsdom

import { createRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { confirm, listAccounts, runningSnapshot, syncAccounts, switchAccount, translate } =
  vi.hoisted(() => ({
    confirm: vi.fn(),
    listAccounts: vi.fn(),
    runningSnapshot: new Map<string, { isRunning: boolean }>(),
    syncAccounts: vi.fn(),
    switchAccount: vi.fn(),
    translate: (key: string, values?: { name?: string }) =>
      values?.name ? `${key}:${values.name}` : key,
  }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ listAccounts, syncAccounts, switchAccount }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useOptionalConfirmDialog: () => ({ confirm }),
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: { getRunningSnapshot: () => runningSnapshot },
}));

import { AccountSwitcherDialog } from '../AccountSwitcherDialog';

const snapshot = {
  mutationAllowed: true,
  accounts: [
    {
      accountKey: 'personal-key',
      displayName: 'Personal Cindy',
      email: 'personal@example.com',
      avatarUrl: 'https://example.com/user-avatar.png',
      kind: 'personal' as const,
      orgName: null,
      orgLogoUrl: null,
      isCurrent: true,
    },
    {
      accountKey: 'org-key',
      displayName: 'Organization Cindy',
      email: 'org@example.com',
      avatarUrl: 'https://example.com/org-user-avatar.png',
      kind: 'org' as const,
      orgName: 'Example Corp',
      orgLogoUrl: 'https://example.com/org-logo.png',
      isCurrent: false,
    },
  ],
};

beforeEach(() => {
  confirm.mockReset().mockResolvedValue(true);
  listAccounts.mockReset().mockResolvedValue(snapshot);
  runningSnapshot.clear();
  syncAccounts.mockReset().mockResolvedValue(snapshot);
  switchAccount.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('AccountSwitcherDialog', () => {
  it('focuses the dialog surface on open instead of triggering the close tooltip', async () => {
    render(
      <AccountSwitcherDialog
        open
        onOpenChange={vi.fn()}
        onAddAccount={vi.fn()}
        triggerRef={createRef<HTMLButtonElement>()}
      />,
    );

    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(document.activeElement).toBe(dialog));
    expect(screen.getByRole('button', { name: 'sidebar.accountSwitcher.close' })).not.toBe(
      document.activeElement,
    );
  });

  it('shows organization name above the username, uses its logo, and switches by saved key', async () => {
    const onOpenChange = vi.fn();
    render(
      <AccountSwitcherDialog
        open
        onOpenChange={onOpenChange}
        onAddAccount={vi.fn()}
        triggerRef={createRef<HTMLButtonElement>()}
      />,
    );

    expect(await screen.findByText('Personal Cindy')).toBeTruthy();
    expect(screen.getByText('personal@example.com')).toBeTruthy();
    expect(screen.getByText('Example Corp')).toBeTruthy();
    expect(screen.getByText('Organization Cindy')).toBeTruthy();
    expect(document.querySelector('img[src="https://example.com/org-logo.png"]')).toBeTruthy();
    expect(document.querySelector('img[src="https://example.com/org-user-avatar.png"]')).toBeNull();
    expect(screen.queryByText(/组织账号|Organization account/)).toBeNull();
    expect(screen.queryByText('sidebar.accountSwitcher.current')).toBeNull();
    await waitFor(() => expect(syncAccounts).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: /Example CorpOrganization Cindy/ }));
    await waitFor(() => expect(switchAccount).toHaveBeenCalledWith('org-key'));
    expect(confirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('starts the full sign-in flow from the add-account action', async () => {
    const onAddAccount = vi.fn();
    render(
      <AccountSwitcherDialog
        open
        onOpenChange={vi.fn()}
        onAddAccount={onAddAccount}
        triggerRef={createRef<HTMLButtonElement>()}
      />,
    );

    await waitFor(() => expect(syncAccounts).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.accountSwitcher.addAccount' }));
    await waitFor(() => expect(onAddAccount).toHaveBeenCalledOnce());
  });

  it('keeps switching and add-account actions available during background sync', async () => {
    syncAccounts.mockReturnValueOnce(new Promise(() => {}));
    const onAddAccount = vi.fn();
    render(
      <AccountSwitcherDialog
        open
        onOpenChange={vi.fn()}
        onAddAccount={onAddAccount}
        triggerRef={createRef<HTMLButtonElement>()}
      />,
    );

    const switchButton = await screen.findByRole('button', {
      name: /Example CorpOrganization Cindy/,
    });
    const addButton = screen.getByRole('button', {
      name: 'sidebar.accountSwitcher.addAccount',
    });
    expect((switchButton as HTMLButtonElement).disabled).toBe(false);
    expect((addButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(addButton);
    await waitFor(() => expect(onAddAccount).toHaveBeenCalledOnce());
  });

  it('asks before adding an account when a task is running and stays put on cancel', async () => {
    const onAddAccount = vi.fn();
    runningSnapshot.set('running-session', { isRunning: true });
    confirm.mockResolvedValue(false);
    render(
      <AccountSwitcherDialog
        open
        onOpenChange={vi.fn()}
        onAddAccount={onAddAccount}
        triggerRef={createRef<HTMLButtonElement>()}
      />,
    );

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'sidebar.accountSwitcher.addAccount',
      }),
    );

    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(onAddAccount).not.toHaveBeenCalled();
  });

  it('starts adding an account only after confirming interruption of running tasks', async () => {
    const onAddAccount = vi.fn();
    runningSnapshot.set('running-session', { isRunning: true });
    render(
      <AccountSwitcherDialog
        open
        onOpenChange={vi.fn()}
        onAddAccount={onAddAccount}
        triggerRef={createRef<HTMLButtonElement>()}
      />,
    );

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'sidebar.accountSwitcher.addAccount',
      }),
    );

    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    await waitFor(() => expect(onAddAccount).toHaveBeenCalledOnce());
  });

  it('asks before switching when a task is running and keeps the account dialog open on cancel', async () => {
    const onOpenChange = vi.fn();
    runningSnapshot.set('running-session', { isRunning: true });
    confirm.mockResolvedValue(false);
    render(
      <AccountSwitcherDialog
        open
        onOpenChange={onOpenChange}
        onAddAccount={vi.fn()}
        triggerRef={createRef<HTMLButtonElement>()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Example CorpOrganization Cindy/ }));

    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith({
        title: 'sidebar.accountSwitcher.runningTaskTitle',
        description: 'sidebar.accountSwitcher.runningTaskDescription',
        confirmText: 'sidebar.accountSwitcher.runningTaskConfirm',
        cancelText: 'logic.confirm.cancel',
        confirmVariant: 'destructive',
      }),
    );
    expect(switchAccount).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('switches only after the user confirms interruption of running tasks', async () => {
    const onOpenChange = vi.fn();
    runningSnapshot.set('running-session', { isRunning: true });
    render(
      <AccountSwitcherDialog
        open
        onOpenChange={onOpenChange}
        onAddAccount={vi.fn()}
        triggerRef={createRef<HTMLButtonElement>()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Example CorpOrganization Cindy/ }));

    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    await waitFor(() => expect(switchAccount).toHaveBeenCalledWith('org-key'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('releases the switching state after success so the dialog can be used again', async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            reopen
          </button>
          <AccountSwitcherDialog
            open={open}
            onOpenChange={setOpen}
            onAddAccount={vi.fn()}
            triggerRef={createRef<HTMLButtonElement>()}
          />
        </>
      );
    }

    render(<Harness />);

    fireEvent.click(await screen.findByRole('button', { name: /Example CorpOrganization Cindy/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'reopen' }));

    const switchButton = await screen.findByRole('button', {
      name: /Example CorpOrganization Cindy/,
    });
    expect((switchButton as HTMLButtonElement).disabled).toBe(false);
    expect(
      (screen.getByRole('button', {
        name: 'sidebar.accountSwitcher.addAccount',
      }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
