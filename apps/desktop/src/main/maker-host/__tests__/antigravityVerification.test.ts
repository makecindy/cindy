import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoverGoogleAccount, type VerificationUi } from '../antigravityVerification.js';

// Tier 1: the November 27 access gate looked like a completed reply. Exercise the production
// recovery loop with synthetic provider responses; no identity or browser profile is required.
const landing = 'https://accounts.google.com/v3/signin/continue?plt=synthetic&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini';
const required = (url = landing) => ({ status: 'required', url });
function fixture() {
  const shown: string[] = [];
  const controller = new AbortController();
  let confirm = () => {};
  const verified = vi.fn();
  const ui: VerificationUi = {
    card: async (url, check, ended) => {
      shown.push(url); confirm = check;
      return { verified, cancel: ended, update: async url => { shown.push(url); } };
    },
  };
  const probe = vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue(required());
  return { ui, verified, confirm: () => confirm(),
    shown, probe, controller, start: () => recoverGoogleAccount(probe, controller.signal, ui) };
}
afterEach(() => vi.useRealTimers());
describe('Antigravity account verification', () => {
  it('updates the same card for a phone, refreshes an expired code and waits for provider confirmation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const done = f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.shown).toEqual([landing]);
    const renewed = landing.replace('synthetic', 'renewed');
    f.probe.mockResolvedValue(required(renewed));
    await vi.advanceTimersByTimeAsync(180000);
    expect(f.shown.at(-1)).toBe(renewed);
    expect(f.verified).not.toHaveBeenCalled();
    f.confirm();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.verified).not.toHaveBeenCalled();
    f.probe.mockResolvedValue({ status: 'ready' });
    await vi.advanceTimersByTimeAsync(30000);
    expect(await done).toBe('ready');
    expect(f.verified).toHaveBeenCalledOnce();
  });
  it('keeps the official sign-in link when no QR is available and drops a cancelled check', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const done = f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.shown).toEqual([landing]);
    f.controller.abort();
    expect(await done).toBe('cancelled');
    expect(f.verified).not.toHaveBeenCalled();
  });
  it.each([required(landing.replace('accounts.google.com', 'example.test')), required(landing + '&continue=https://example.test'), { status: 'quota' }])(
    'rejects unrelated provider results before opening any page', async report => {
      const f = fixture();
      f.probe.mockResolvedValue(report);
      expect(await f.start()).toBe('unconfirmed');
      expect(f.shown).toEqual([]);
    });
});
