import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const notificationSource = readFileSync(
  resolve(__dirname, '..', 'lib', 'sessionEventNotification.ts'),
  'utf8',
);

describe('shared session notification owner fence', () => {
  it('rechecks focus and account ownership after the sound await before any notification side effect', () => {
    const capture = notificationSource.indexOf(
      'ownerAtNotification: DataOwnerGeneration = getDataOwnerGeneration(),',
    );
    const deliveryClaim = notificationSource.indexOf(
      'window.electronAPI.notificationClaimSessionEvent?.(',
      capture,
    );
    const focusListener = notificationSource.indexOf(
      "window.addEventListener('focus', abortPendingSound, { once: true });",
      deliveryClaim,
    );
    const soundAwait = notificationSource.indexOf(
      'suppressSystemSound = await playSessionEventSound(',
      focusListener,
    );
    const preSoundOwnerFence = notificationSource.indexOf(
      'if (!isDataOwnerGenerationCurrent(ownerAtNotification)) return;',
      focusListener,
    );
    const ownerSubscription = notificationSource.indexOf(
      'subscribeDataOwnerGeneration(abortPendingSound)',
      focusListener,
    );
    const focusFence = notificationSource.indexOf(
      "if (typeof document !== 'undefined' && document.hasFocus()) return;",
      soundAwait,
    );
    const ownerFence = notificationSource.indexOf(
      'if (!isDataOwnerGenerationCurrent(ownerAtNotification)) return;',
      focusFence,
    );
    const showNotification = notificationSource.indexOf(
      'window.electronAPI.notificationShowSessionEvent({',
      ownerFence,
    );

    expect(capture).toBeGreaterThan(-1);
    expect(deliveryClaim).toBeGreaterThan(capture);
    expect(focusListener).toBeGreaterThan(deliveryClaim);
    expect(preSoundOwnerFence).toBeGreaterThan(focusListener);
    expect(preSoundOwnerFence).toBeLessThan(soundAwait);
    expect(ownerSubscription).toBeGreaterThan(focusListener);
    expect(ownerSubscription).toBeLessThan(soundAwait);
    expect(soundAwait).toBeGreaterThan(focusListener);
    expect(focusFence).toBeGreaterThan(soundAwait);
    expect(ownerFence).toBeGreaterThan(focusFence);
    expect(showNotification).toBeGreaterThan(ownerFence);
  });
});
