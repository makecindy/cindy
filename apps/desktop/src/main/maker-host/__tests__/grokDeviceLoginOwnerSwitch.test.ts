import { expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({
  owner: 'owner-a',
  oauthSlotBusy: false,
  signals: [] as AbortSignal[],
}));

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => session.owner,
  isAppSessionBoundaryPending: () => false,
}));

vi.mock('../grok-oauth-login.js', () => ({
  hasGrokOAuthLogin: () => false,
  isGrokOAuthLoginInProgress: () => session.oauthSlotBusy,
  runGrokOAuthLogin: vi.fn(
    (opts: { cancellationSignal: AbortSignal; onDeviceCode: (code: object) => void }) => {
      if (session.oauthSlotBusy) throw new Error('OAuth slot still occupied');
      session.oauthSlotBusy = true;
      session.signals.push(opts.cancellationSignal);
      opts.onDeviceCode({
        verificationUrl: 'https://auth.x.ai/device',
        userCode: ['AAAA-1111', 'BBBB-2222', 'CCCC-3333'][session.signals.length - 1],
        expiresAt: Date.now() + 60_000,
      });
      return new Promise<{ ok: false; reason: string }>((resolve) => {
        opts.cancellationSignal.addEventListener('abort', () => {
          queueMicrotask(() => {
            session.oauthSlotBusy = false;
            resolve({ ok: false, reason: 'login_cancelled' });
          });
        });
      });
    },
  ),
}));

import {
  cancelGrokDeviceLogin,
  grokDeviceLoginStatus,
  startGrokDeviceLogin,
} from '../grok-device-login-service.js';
import { runGrokOAuthLogin } from '../grok-oauth-login.js';

it('releases the OAuth slot after an owner switch or cancellation before a new device login', async () => {
  expect(await startGrokDeviceLogin()).toMatchObject({ userCode: 'AAAA-1111' });

  session.owner = 'owner-b';
  const [first, second] = await Promise.all([startGrokDeviceLogin(), startGrokDeviceLogin()]);

  expect(session.signals[0]?.aborted).toBe(true);
  expect(first).toMatchObject({ userCode: 'BBBB-2222' });
  expect(second).toEqual(first);
  expect(grokDeviceLoginStatus()).toEqual(first);
  expect(runGrokOAuthLogin).toHaveBeenCalledTimes(2);

  expect(cancelGrokDeviceLogin()).toEqual({ status: 'failed', reason: 'cancelled' });
  const [retry, concurrentRetry] = await Promise.all([
    startGrokDeviceLogin(),
    startGrokDeviceLogin(),
  ]);
  expect(retry).toMatchObject({ userCode: 'CCCC-3333' });
  expect(concurrentRetry).toEqual(retry);
  expect(runGrokOAuthLogin).toHaveBeenCalledTimes(3);

  cancelGrokDeviceLogin();
});
