// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  writeText: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  exitLocalMode: vi.fn(),
  handleLogout: vi.fn(),
  authState: {
    user: {
      id: 'user-123',
      name: 'Lizi',
      avatar: null,
      email: 'lizi@example.com',
      membershipKind: 'personal' as 'personal' | 'org',
      membershipRole: 'owner' as 'owner' | 'admin' | 'member',
      orgName: null as string | null,
      orgSlug: null as string | null,
    } as {
      id: string;
      name: string;
      avatar: string | null;
      email: string | null;
      membershipKind: 'personal' | 'org';
      membershipRole: 'owner' | 'admin' | 'member';
      orgName: string | null;
      orgSlug: string | null;
    } | null,
    mode: 'cloud' as 'cloud' | 'local',
    exitLocalMode: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // 带 id 插值的 key(copyUserId.display)拼上实际值,便于断言 ID 真的渲染了出来。
    t: (key: string, params?: Record<string, unknown>) =>
      params && 'id' in params ? `${key}:${String(params.id)}` : key,
  }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => mocks.authState,
}));

vi.mock('@/hooks/useLogout', () => ({
  useLogout: () => ({ handleLogout: mocks.handleLogout }),
}));

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: { getRunningSnapshot: () => new Map() },
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

vi.mock('@/components/settings/ProfileEditDialog', () => ({
  ProfileEditDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="profile-edit-dialog" /> : null,
}));

import { UserProfileCard } from '@/components/settings/UserProfileCard';

function renderCard() {
  return render(
    <MemoryRouter>
      <UserProfileCard />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}</div>;
}

describe('UserProfileCard copy user ID', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: mocks.writeText },
    });
    mocks.writeText.mockResolvedValue(undefined);
    mocks.authState.user = {
      id: 'user-123',
      name: 'Lizi',
      avatar: null,
      email: 'lizi@example.com',
      membershipKind: 'personal',
      membershipRole: 'owner',
      orgName: null,
      orgSlug: null,
    };
    mocks.authState.mode = 'cloud';
    mocks.authState.exitLocalMode.mockReset();
    mocks.handleLogout.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the email prominently and keeps a compact copyable user ID', async () => {
    renderCard();

    expect(screen.getByText('lizi@example.com')).toBeTruthy();
    expect(screen.getByTitle('lizi@example.com')).toBeTruthy();
    expect(screen.getByText('settings.userProfile.copyUserId.display:…-123')).toBeTruthy();
    expect(screen.getByText('Lizi').closest('button')).toBeNull();

    const email = screen.getByText('lizi@example.com');
    const idButton = screen.getByRole('button', {
      name: 'settings.userProfile.copyUserId.action',
    });
    expect(email.parentElement).toBe(idButton.parentElement);
    expect(email.nextElementSibling).toBe(idButton);
    expect(email.className).not.toContain('flex-1');
    expect(idButton.className).toContain('cursor-pointer');
    expect(idButton.className).toContain('hover:bg-[var(--settings-profile-avatar-bg)]');
    // 交互件圆角走 pill 档(DESIGN.md Border Radius Scale,无 6px 档)。
    expect(idButton.className).toContain('rounded-full');
    // 可见 ID 经 aria-describedby 暴露给辅助技术(aria-label 只承载动作名)。
    const describedById = idButton.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.getElementById(describedById!)?.textContent).toBe(
      'settings.userProfile.copyUserId.display:…-123',
    );

    fireEvent.click(idButton);

    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith('user-123'));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('settings.userProfile.copyUserId.success');
  });

  it('shows only the final four ID characters while copying the full value', async () => {
    mocks.authState.user!.id = 'mem_0123456789abcdef0123456789abcdef';
    renderCard();

    expect(screen.getByText('settings.userProfile.copyUserId.display:…cdef')).toBeTruthy();
    expect(
      screen.queryByText(
        'settings.userProfile.copyUserId.display:mem_0123456789abcdef0123456789abcdef',
      ),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.copyUserId.action' }));

    await waitFor(() =>
      expect(mocks.writeText).toHaveBeenCalledWith('mem_0123456789abcdef0123456789abcdef'),
    );
  });

  it('keeps the compact ID available when an account has no email', () => {
    mocks.authState.user!.email = null;
    renderCard();

    expect(screen.queryByText('lizi@example.com')).toBeNull();
    expect(screen.getByText('settings.userProfile.copyUserId.display:…-123')).toBeTruthy();
  });

  it('opens the profile edit dialog when the avatar is clicked', () => {
    renderCard();

    expect(screen.queryByTestId('profile-edit-dialog')).toBeNull();

    // 头像与铅笔共用 edit.open 标签;取第一个(头像)点击。
    const [avatarButton] = screen.getAllByRole('button', {
      name: 'settings.userProfile.edit.open',
    });
    expect(avatarButton.className).toContain('cursor-pointer');

    fireEvent.click(avatarButton);

    expect(screen.getByTestId('profile-edit-dialog')).toBeTruthy();
    expect(mocks.writeText).not.toHaveBeenCalled();
  });

  it('keeps cloud account actions on the right side of the profile card', async () => {
    renderCard();

    const logoutButton = screen.getByRole('button', { name: 'settings.logout.aria' });
    const addAccountButton = screen.getByRole('button', {
      name: 'sidebar.user.menuAddAccount',
    });
    expect(logoutButton).toBeTruthy();
    expect(addAccountButton).toBeTruthy();

    fireEvent.click(logoutButton);
    expect(mocks.handleLogout).toHaveBeenCalledOnce();

    fireEvent.click(addAccountButton);
    await waitFor(() =>
      expect(screen.getByTestId('location-probe').textContent).toBe('/add-account'),
    );
    expect(screen.queryByTestId('account-switcher-dialog')).toBeNull();
    expect(addAccountButton.parentElement?.className).toContain('flex-col');
  });

  it('does not show cloud account actions in the not-signed-in card', () => {
    mocks.authState.user = null;
    mocks.authState.mode = 'local';
    renderCard();

    expect(screen.queryByRole('button', { name: 'settings.logout.aria' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'sidebar.user.menuAddAccount' })).toBeNull();
  });

  it('shows an error toast when clipboard access fails', async () => {
    mocks.writeText.mockRejectedValueOnce(new Error('clipboard denied'));
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'settings.userProfile.copyUserId.action' }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('settings.userProfile.copyUserId.failed'),
    );
  });

  it('offers sign-in without exposing a logout action in local mode', () => {
    mocks.authState.user = null;
    mocks.authState.mode = 'local';
    renderCard();

    const signInButton = screen.getByRole('button', {
      name: 'settings.userProfile.local.signIn',
    });
    expect(signInButton).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'settings.userProfile.local.exit' })).toBeNull();
    expect(mocks.authState.exitLocalMode).not.toHaveBeenCalled();

    fireEvent.click(signInButton);

    return waitFor(() => expect(mocks.authState.exitLocalMode).toHaveBeenCalledOnce());
  });

  it('shows the organization name and role only for an organization membership', () => {
    renderCard();
    expect(screen.queryByText('settings.userProfile.organization.roles.owner')).toBeNull();

    cleanup();
    mocks.authState.user!.membershipKind = 'org';
    mocks.authState.user!.membershipRole = 'admin';
    mocks.authState.user!.orgName = 'Acme';
    mocks.authState.user!.orgSlug = 'acme';
    renderCard();

    expect(screen.getByTitle('Acme')).toBeTruthy();
    expect(screen.getByText('settings.userProfile.organization.roles.admin')).toBeTruthy();
  });

  it('falls back from the organization name to its slug and localized default', () => {
    mocks.authState.user!.membershipKind = 'org';
    mocks.authState.user!.membershipRole = 'member';
    mocks.authState.user!.orgName = null;
    mocks.authState.user!.orgSlug = 'acme';
    renderCard();

    expect(screen.getByTitle('acme')).toBeTruthy();

    cleanup();
    mocks.authState.user!.orgSlug = null;
    renderCard();

    expect(screen.getByTitle('settings.userProfile.organization.fallbackName')).toBeTruthy();
  });

  it('falls back to the localized member role for an unknown runtime role', () => {
    mocks.authState.user!.membershipKind = 'org';
    mocks.authState.user!.orgName = 'Acme';
    (mocks.authState.user! as { membershipRole: string }).membershipRole = 'billing_admin';
    renderCard();

    expect(screen.getByText('settings.userProfile.organization.roles.member')).toBeTruthy();
    expect(screen.queryByText('settings.userProfile.organization.roles.billing_admin')).toBeNull();
  });
});
