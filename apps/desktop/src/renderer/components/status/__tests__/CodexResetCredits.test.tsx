// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import { CodexResetCredits } from '../CodexResetCredits';

const mocks = vi.hoisted(() => ({ snapshot: null as MobileCodexRateLimitsResult | null, reset: vi.fn(), canReset: true, busy: false }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  i18n: { language: 'en' },
  t: (key: string, values?: Record<string, unknown>) => `${key}${values?.count !== undefined ? ` ${values.count}` : ''}${values?.at ? ` ${values.at}` : ''}`,
}) }));

beforeEach(() => {
  mocks.canReset = true; mocks.busy = false; mocks.reset.mockReset();
  mocks.snapshot = {
    account: { email: null, accountId: null, planType: null }, rateLimits: {}, rateLimitsByLimitId: null, resetOffer: null,
    rateLimitResetCredits: { availableCount: 2, credits: [
      { status: 'available', resetType: 'codexRateLimits', grantedAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 100_000, title: 'Later reset', description: null, resetOffer: { idempotencyKey: 'later', expiresAt: null, validUntil: Date.now() + 60_000 } },
      { status: 'available', resetType: 'codexRateLimits', grantedAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 50_000, title: 'Earlier reset', description: null, resetOffer: { idempotencyKey: 'earlier', expiresAt: null, validUntil: Date.now() + 60_000 } },
    ] },
  };
});
afterEach(cleanup);

describe('available reset list', () => {
  it('persists the automatic toggle only after success and shows save errors', async () => {
    const state = { accountKey: 'account', settings: { enabled: false, lowQuota: true, minimumDays: 3, expiring: true, expiryMinutes: 60 }, customized: false, lastUsedAt: null };
    mocks.snapshot!.autoUse = state;
    const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ...mocks.snapshot, autoUse: { ...state, settings: { ...state.settings, enabled: true } } });
    Object.assign(window, { electronAPI: { maker: { usage: { setCodexResetAutoUse: save } } } });
    const refresh = vi.fn();
    render(<CodexResetCredits variant="dialog" snapshot={mocks.snapshot} busy={false} canReset onReset={mocks.reset} onChanged={refresh} providerId="openai-b" />);
    fireEvent.click(screen.getByRole('switch'));
    await screen.findByRole('alert');
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'));
    expect(save).toHaveBeenLastCalledWith({ enabled: true }, 'account', 'openai-b');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('sorts rows by expiry and passes the clicked row to its own action', () => {
    render(<CodexResetCredits variant="dialog" snapshot={mocks.snapshot} busy={mocks.busy} canReset={mocks.canReset} onReset={mocks.reset} />);
    expect(screen.getAllByRole('listitem').map(row => row.textContent)).toEqual([
      expect.stringContaining('Earlier reset'), expect.stringContaining('Later reset'),
    ]);
    expect(screen.getAllByRole('button')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'codexResets.useReset' })[1]);
    expect(mocks.reset).toHaveBeenCalledExactlyOnceWith(mocks.snapshot!.rateLimitResetCredits!.credits![0]);
  });

  it.each([true, false])('offers only the frozen retry even with remaining rows: %s', withRows => {
    mocks.snapshot!.resetOffer = { idempotencyKey: 'frozen', expiresAt: null, validUntil: Date.now() + 60_000, retryOnly: true };
    if (!withRows) mocks.snapshot!.rateLimitResetCredits = null;
    render(<CodexResetCredits variant="dialog" snapshot={mocks.snapshot} busy={false} canReset={false} canRetry onReset={mocks.reset} />);
    for (const button of screen.queryAllByRole('button', { name: 'codexResets.useReset' }) as HTMLButtonElement[]) {
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(mocks.reset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'codexResets.retryReset' }));
    expect(mocks.reset).toHaveBeenCalledExactlyOnceWith();
  });

  it('keeps provider settings collapsed until its header is opened', async () => {
    render(<CodexResetCredits variant="embedded" snapshot={mocks.snapshot} busy={false} canReset onReset={mocks.reset} />);
    const header = screen.getByRole('button', { name: /codexResets.title/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list')).toBeNull();
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(screen.queryByRole('list')).toBeNull());
  });

  it('shows a count-only response honestly without inventing rows', () => {
    mocks.snapshot!.rateLimitResetCredits!.credits = null;
    render(<CodexResetCredits variant="dialog" snapshot={mocks.snapshot} busy={mocks.busy} canReset={mocks.canReset} onReset={mocks.reset} />);
    expect(screen.getByText('codexResets.detailsUnavailable')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('does not substitute a different credit when an older host omits row offers', () => {
    for (const credit of mocks.snapshot!.rateLimitResetCredits!.credits!) delete credit.resetOffer;
    render(<CodexResetCredits variant="dialog" snapshot={mocks.snapshot} busy={false} canReset onReset={mocks.reset} />);
    for (const button of screen.getAllByRole('button') as HTMLButtonElement[]) {
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it('shows zero availability without a reset action', () => {
    mocks.snapshot!.rateLimitResetCredits = { availableCount: 0, credits: [] };
    render(<CodexResetCredits variant="dialog" snapshot={mocks.snapshot} busy={mocks.busy} canReset={mocks.canReset} onReset={mocks.reset} />);
    expect(screen.getByText('codexResets.noCredit')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('hides the section when reset availability was not returned', () => {
    mocks.snapshot!.rateLimitResetCredits = null;
    const view = render(<CodexResetCredits variant="dialog" snapshot={mocks.snapshot} busy={mocks.busy} canReset={mocks.canReset} onReset={mocks.reset} />);
    expect(view.container.textContent).toBe('');
  });

  it('disables reset until a limit is reached', () => {
    mocks.canReset = false;
    render(<CodexResetCredits variant="dialog" snapshot={mocks.snapshot} busy={mocks.busy} canReset={mocks.canReset} onReset={mocks.reset} />);
    for (const button of screen.getAllByRole('button') as HTMLButtonElement[]) {
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(mocks.reset).not.toHaveBeenCalled();
  });

  it('does not label already-used or expired credits as available', () => {
    mocks.snapshot!.rateLimitResetCredits!.credits![0].status = 'redeemed';
    mocks.snapshot!.rateLimitResetCredits!.credits![1].expiresAt = 1;
    render(<CodexResetCredits variant="dialog" snapshot={mocks.snapshot} busy={mocks.busy} canReset={mocks.canReset} onReset={mocks.reset} />);
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByText('codexResets.detailsUnavailable')).toBeTruthy();
  });
});
