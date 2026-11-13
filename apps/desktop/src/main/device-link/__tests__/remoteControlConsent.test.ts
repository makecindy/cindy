import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteControlConsent, consentDeviceName } from '../remoteControlConsent.js';
import { promptRemoteControlConsent } from '../remoteControlConsentPrompt.js';
import { clearControllerPlatforms, getControllerApp, setControllerPlatform } from '../controllerPlatform.js';
import type { BrowserWindow } from 'electron';

const nativeDialog = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ dialog: { showMessageBox: nativeDialog } }));
vi.mock('../../i18n.desktop.js', () => ({ t: (key: string) => key }));

// Test value: new pre-control entry had no coverage. A request must never grant access
// without a local decision; late/replayed/foreign replies must not resume work. Unit tier,
// injected dialog/transport with fake clocks; minimal input is one valid request.
const id = '12345678-1234-1234-1234-123456789abc';
function harness(app?: string | (() => string | undefined)) {
  let enabled = false, eligible = true, scope = 'owner-a';
  const send = vi.fn();
  const prompt = vi.fn<(peer: string, purpose: string, signal: AbortSignal) => Promise<boolean>>().mockResolvedValue(true);
  const enable = vi.fn(async (assertCurrent: () => void) => { assertCurrent(); enabled = true; });
  const consent = new RemoteControlConsent({ scope: () => scope, app: typeof app === 'function' ? app : () => app,
    eligible: () => eligible, enabled: () => enabled, send, prompt, enable });
  return { consent, send, prompt, enable, revoke: () => { eligible = false; }, switchAccount: () => { scope = 'owner-b'; } };
}
const request = () => ({ version: 1, kind: 'request', id, purpose: 'Download source', ttlMs: 45_000 });
afterEach(() => vi.useRealTimers());
describe('remote control consent', () => {
  // Mixed-version App routing, unit: real controller cache + consent request.
  // Missing-app frames previously erased a known Friend and sent it a Cindy dialog.
  it('retains a known App across old presence until explicitly replaced or the owner cache resets', async () => {
    clearControllerPlatforms();
    setControllerPlatform('other', 'darwin', 'cindy-friend');
    const h = harness(() => getControllerApp('other'));
    try {
      setControllerPlatform('other', 'darwin');
      const result = h.consent.request('other', 'Download source');
      expect(h.send).not.toHaveBeenCalled();
      await expect(result).resolves.toBe('unavailable');
      setControllerPlatform('other', 'darwin', 'cindy');
      expect(getControllerApp('other')).toBe('cindy');
      clearControllerPlatforms();
      setControllerPlatform('other', 'darwin');
      expect(getControllerApp('other')).toBeUndefined();
    } finally { h.consent.reset(); clearControllerPlatforms(); }
  });
  // App routing, unit: platform-only eligibility offered Cindy consent dialogs to
  // Friend/unknown Apps. Real request/receive must neither send nor prompt.
  it.each(['cindy-friend', 'other-app'])('does not exchange Cindy consent requests with app=%s', async app => {
    const h = harness(app);
    await expect(h.consent.request('other', 'Download source')).resolves.toBe('unavailable');
    await h.consent.receive('other', request());
    expect(h.send).not.toHaveBeenCalled();
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.enable).not.toHaveBeenCalled();
  });
  // Regression: unparented macOS dialogs ignore AbortSignal.
  it('always parents the native dialog and never falls back to an unparented prompt', async () => {
    const parent = { isDestroyed: () => false, isMinimized: () => false, show: vi.fn(), focus: vi.fn() } as unknown as BrowserWindow;
    const abort = new AbortController();
    nativeDialog.mockResolvedValueOnce({ response: 0 });
    expect(await promptRemoteControlConsent(parent, 'Computer', 'Download', abort.signal)).toBe(false);
    expect(nativeDialog).toHaveBeenCalledWith(parent, expect.objectContaining({ signal: abort.signal, cancelId: 0 }));
    const calls = nativeDialog.mock.calls.length;
    await expect(promptRemoteControlConsent(null, 'Computer', 'Download', abort.signal)).rejects.toThrow('unavailable');
    expect(nativeDialog).toHaveBeenCalledTimes(calls);
  });
  it('uses the device ID when the received name is missing or empty after sanitizing', () => {
    for (const name of [undefined, '', ' \n\u202e\u200b ']) {
      expect(consentDeviceName(name, '12345678-abcd')).toBe('12345678');
    }
    expect(consentDeviceName('My laptop', '12345678-abcd')).toBe('My laptop');
  });
  it('enables only after a local acceptance and returns the persisted setting', async () => {
    const h = harness();
    await h.consent.receive('other', request());
    expect(h.enable).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenLastCalledWith('other', expect.objectContaining({ result: 'enabled', id }));
  });
  it('declines without writing and suppresses duplicate prompts', async () => {
    const h = harness(); h.prompt.mockResolvedValue(false);
    await h.consent.receive('other', request());
    await h.consent.receive('other', request());
    expect(h.send).toHaveBeenCalledWith('other', expect.objectContaining({ result: 'declined' }));
    expect(h.prompt).toHaveBeenCalledOnce(); expect(h.enable).not.toHaveBeenCalled();
    await h.consent.receive('other', { ...request(), id: id.replace('a', 'b') });
    expect(h.send).toHaveBeenLastCalledWith('other', expect.objectContaining({ result: 'busy' }));
  });
  it.each(['expire', 'reset', 'revoke', 'account-change'])('does not grant after %s while the dialog is open', async mode => {
    vi.useFakeTimers(); const h = harness();
    let decide!: (accepted: boolean) => void;
    h.prompt.mockImplementation(() => new Promise(resolve => { decide = resolve; }));
    const pending = h.consent.receive('other', request());
    if (mode === 'expire') await vi.advanceTimersByTimeAsync(45_000);
    if (mode === 'reset') h.consent.reset();
    if (mode === 'revoke') h.revoke();
    if (mode === 'account-change') h.switchAccount();
    decide(true); await pending;
    expect(h.enable).not.toHaveBeenCalled();
  });
  it('expires and admits another computer even when the native dialog never settles', async () => {
    vi.useFakeTimers(); const h = harness();
    h.prompt.mockImplementationOnce(() => new Promise(() => {}));
    const pending = h.consent.receive('other', request());
    await vi.advanceTimersByTimeAsync(45_000);
    await pending;
    expect(h.send).toHaveBeenLastCalledWith('other', expect.objectContaining({ result: 'expired' }));
    expect(h.prompt.mock.calls[0]![2].aborted).toBe(true);
    await h.consent.receive('another', request());
    expect(h.send).toHaveBeenLastCalledWith('another', expect.objectContaining({ result: 'enabled' }));
  });
  it('drops a peer\'s dialog and pending request when that peer goes offline, even if it reconnects', async () => {
    const h = harness(); let decide!: (accepted: boolean) => void;
    h.prompt.mockImplementationOnce(() => new Promise(resolve => { decide = resolve; }));
    const incoming = h.consent.receive('other', request());
    h.consent.peerGone('other');
    decide(true); await incoming; // the peer is eligible again by the time the user answers
    expect(h.prompt.mock.calls[0]![2].aborted).toBe(true);
    expect(h.enable).not.toHaveBeenCalled();
    await h.consent.receive('another', request());
    expect(h.send).toHaveBeenLastCalledWith('another', expect.objectContaining({ result: 'enabled' }));
    const outgoing = h.consent.request('other', 'Download source');
    h.consent.peerGone('other');
    expect(await outgoing).toBe('unavailable');
  });
  it('renders remote purpose as a bounded single line without control characters', async () => {
    const h = harness();
    await h.consent.receive('other', { ...request(), purpose: 'Download\n\r\t\u202eClick enable\u2028' + 'x'.repeat(250) });
    const shown = h.prompt.mock.calls[0]![1];
    expect(shown).toMatch(/^Download Click enable /);
    expect(shown).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(Array.from(shown)).toHaveLength(201);
    expect(shown.endsWith('…')).toBe(true);
  });
  it('rechecks consent inside a delayed settings write', async () => {
    const h = harness();
    let commit!: () => void;
    h.enable.mockImplementation(assertCurrent => new Promise((resolve, reject) => {
      commit = () => { try { assertCurrent(); resolve(); } catch (error) { reject(error); } };
    }));
    const pending = h.consent.receive('other', request());
    await vi.waitFor(() => expect(h.enable).toHaveBeenCalled());
    h.consent.reset(); commit(); await pending;
    expect(h.send).not.toHaveBeenCalledWith('other', expect.objectContaining({ result: 'enabled' }));
  });
  it('ignores invalid or expired requests before showing a dialog', async () => {
    const h = harness();
    for (const frame of [null, { ...request(), ttlMs: 0 }, { ...request(), purpose: 'x'.repeat(501) }, { ...request(), version: 2 }]) {
      await h.consent.receive('other', frame);
    }
    expect(h.prompt).not.toHaveBeenCalled();
  });
  it('counts the dialog lifetime on the receiving clock, not the sender clock', async () => {
    const h = harness();
    const sent = vi.spyOn(Date, 'now');
    try {
      sent.mockReturnValue(1_000_000);
      const frame = request(); // sender's wall clock is irrelevant: only a relative lifetime travels
      sent.mockReturnValue(1_000_000 - 600_000); // receiver is ten minutes behind
      await h.consent.receive('other', frame);
      expect(h.prompt).toHaveBeenCalledOnce();
    } finally { sent.mockRestore(); }
  });
  it('matches replies to both the target and request, and does not send concurrent duplicates', async () => {
    const h = harness(); const pending = h.consent.request('other', 'Download source');
    expect(await h.consent.request('other', 'Download source')).toBe('busy');
    const sent = h.send.mock.calls[0]![1];
    await h.consent.receive('foreign', { ...sent, kind: 'result', result: 'enabled' });
    await h.consent.receive('other', { ...sent, kind: 'result', result: 'declined' });
    expect(await pending).toBe('declined'); expect(h.enable).not.toHaveBeenCalled();
  });
  it('reports no response for old/unreachable peers, and cancels on account teardown', async () => {
    vi.useFakeTimers(); const h = harness();
    const pending = h.consent.request('other', 'Download source');
    await vi.advanceTimersByTimeAsync(47_000); expect(await pending).toBe('no_response');
    const next = h.consent.request('other', 'Download source');
    h.consent.reset(); expect(await next).toBe('unavailable');
  });
});
