// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleSubscriptionUsageChip, GOOGLE_QUOTA_GUIDE } from '../GoogleSubscriptionUsageChip';
import en from '@/i18n/locales/en/common.json';
import { registerStatusBarCard, resetStatusBarCardsForTest } from '@/lib/statusBarCards';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { AntigravityAccountsView } from '../../../../shared/antigravityAccounts';

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}) }));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: [{ id: 'google-antigravity-subscription', access: { kind: 'subscription', product: 'Google AI Pro' } }] }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  i18n: { language: 'en', resolvedLanguage: 'en' },
  t: (key: string, values?: Record<string, string | number>) => {
    const text = key.split('.').reduce((value: any, part) => value?.[part], en) ?? key;
    return text.replace(/{{(\w+)}}/g, (_: string, name: string) => String(values?.[name] ?? ''));
  },
}) }));

afterEach(() => { cleanup(); setDataOwnerGeneration(null, 0); resetStatusBarCardsForTest(); vi.clearAllMocks(); });

const quota: AntigravityAccountsView = {
  configured: true,
  connected: true,
  activeId: 'profile',
  accounts: [{ id: 'profile', identity: 'owner@example.test' }],
  usage: [{
    limitId: 'gemini', limitName: 'Gemini', updatedAt: Date.now(),
    primary: { windowMinutes: 300, usedPercent: 25, resetsAt: null },
    secondary: { windowMinutes: 10080, usedPercent: 60, resetsAt: null },
  }, {
    limitId: 'claude', limitName: 'Claude', updatedAt: Date.now(),
    primary: { windowMinutes: 300, usedPercent: 90, resetsAt: null },
    secondary: { windowMinutes: 10080, usedPercent: 98, resetsAt: null },
  }],
};

describe('Google usage presentation', () => {
  // Renderer unit: the task chip previously showed only a label until clicked.
  // A more depleted Claude group must not replace the inline Gemini windows.
  it('shows the active Gemini quota before opening and keeps all groups in the details', async () => {
    setDataOwnerGeneration('owner', 3);
    const antigravityAccounts = vi.fn(async () => quota);
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { openExternal, antigravityAccounts } });
    render(<GoogleSubscriptionUsageChip />);
    const trigger = screen.getByRole('button', { name: 'Google usage' });
    await screen.findByText('5 hours 75% left');
    expect(trigger.textContent).toContain('Weekly 40% left');
    expect(trigger.textContent).not.toContain('2% left');
    expect(screen.queryByText('Gemini · 5 hours')).toBeNull();
    fireEvent.click(trigger);
    expect(await screen.findByText('Gemini · 5 hours')).toBeTruthy();
    expect(screen.getByText('Gemini · Weekly')).toBeTruthy();
    expect(screen.getByText('Claude · 5 hours')).toBeTruthy();
    expect(screen.getByText('owner@example.test')).toBeTruthy();
    expect(document.body.textContent).toContain('75%');
    expect(document.body.textContent).toContain('40%');
    expect(antigravityAccounts).toHaveBeenCalledExactlyOnceWith({ action: 'usage' }, { dataOwnerId: 'owner', ownerGeneration: 3 });
  });

  // An in-flight read from an invalidated owner must never appear for the next one.
  it('discards an old owner response and does not read a local account for a remote task', async () => {
    setDataOwnerGeneration('owner', 3);
    let resolveOld!: (value: AntigravityAccountsView) => void;
    const antigravityAccounts = vi.fn(async (): Promise<AntigravityAccountsView> => ({ ...quota, accounts: [], usage: [] }))
      .mockImplementationOnce(() => new Promise<AntigravityAccountsView>(resolve => { resolveOld = resolve; }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { openExternal, antigravityAccounts } });
    const view = render(<GoogleSubscriptionUsageChip />);
    await act(async () => setDataOwnerGeneration('another-owner', 4));
    await act(async () => resolveOld(quota));
    expect(screen.getByRole('button', { name: 'Google usage' }).textContent).toBe('Google usage');
    fireEvent.click(screen.getByRole('button', { name: 'Google usage' }));
    expect(screen.queryByText('owner@example.test')).toBeNull();
    expect(screen.queryByText('Gemini · 5 hours')).toBeNull();
    expect(antigravityAccounts).toHaveBeenLastCalledWith({ action: 'usage' }, { dataOwnerId: 'another-owner', ownerGeneration: 4 });
    view.unmount();
    setDataOwnerGeneration('remote-task-viewer', 5);
    render(<GoogleSubscriptionUsageChip readLocalQuota={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Google usage' }));
    expect(antigravityAccounts).toHaveBeenCalledTimes(2);
  });
  it('shows real context, separates unknown account quotas and cash, and opens only the official guide on click', () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { openExternal } });
    render(<GoogleSubscriptionUsageChip context={{ used: 12000, size: 1048576 }} turnTokens={1234} />);
    fireEvent.click(screen.getByRole('button', { name: 'Google usage' }));
    expect(screen.getByText('Account quota is currently unavailable')).toBeTruthy();
    expect(screen.getByText('Google AI Pro')).toBeTruthy();
    expect(screen.getByText('12.0k / 1.0M')).toBeTruthy();
    expect(document.body.textContent).toContain('Credits balance and cash charges are not reported');
    expect(document.body.textContent).not.toMatch(/\$0|100%|0%|Unlimited/);
    expect(openExternal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /How to view official quota/ }));
    expect(openExternal).toHaveBeenCalledWith(GOOGLE_QUOTA_GUIDE);
  });
  it('does not invent zero use when no native context or token receipt exists', () => {
    render(<GoogleSubscriptionUsageChip context={{ used: 0, size: 0 }} turnTokens={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Google usage' }));
    expect(screen.getAllByText('Unavailable')).toHaveLength(2);
    expect(document.body.textContent).not.toContain('0 /');
  });
  it('shares the existing single-card workflow with the context panel', () => {
    const other = registerStatusBarCard('context-window', () => {});
    render(<GoogleSubscriptionUsageChip />);
    fireEvent.click(screen.getByRole('button', { name: 'Google usage' }));
    expect(screen.getByText('Account quota is currently unavailable')).toBeTruthy();
    act(() => other.request());
    expect(screen.queryByText('Account quota is currently unavailable')).toBeNull();
    other.unregister();
  });
});
