// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleSubscriptionUsageChip, GOOGLE_QUOTA_GUIDE } from '../GoogleSubscriptionUsageChip';
import en from '@/i18n/locales/en/common.json';
import { registerStatusBarCard, resetStatusBarCardsForTest } from '@/lib/statusBarCards';

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}) }));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: [{ id: 'google-antigravity-subscription', access: { kind: 'subscription', product: 'Google AI Pro' } }] }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  i18n: { language: 'en', resolvedLanguage: 'en' },
  t: (key: string) => key.split('.').reduce((value: any, part) => value?.[part], en) ?? key,
}) }));

afterEach(() => { cleanup(); resetStatusBarCardsForTest(); vi.clearAllMocks(); });
describe('Google usage presentation', () => {
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
