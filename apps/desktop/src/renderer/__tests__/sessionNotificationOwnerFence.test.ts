import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sidebarSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSidebarUpper.tsx'),
  'utf8',
);

describe('session notification owner fence', () => {
  it('rechecks focus and account ownership after the sound await before any notification side effect', () => {
    const capture = sidebarSource.indexOf('const dataOwnerAtNotification = getDataOwnerGeneration();');
    const focusListener = sidebarSource.indexOf(
      "window.addEventListener('focus', abortPendingSound, { once: true });",
      capture,
    );
    const soundAwait = sidebarSource.indexOf(
      'await playSessionEventSound(kind, focusAbortController.signal);',
      focusListener,
    );
    const focusFence = sidebarSource.indexOf(
      "if (typeof document !== 'undefined' && document.hasFocus()) return;",
      soundAwait,
    );
    const ownerFence = sidebarSource.indexOf(
      'if (!isDataOwnerGenerationCurrent(dataOwnerAtNotification)) return;',
      focusFence,
    );
    const markAttention = sidebarSource.indexOf(
      'window.electronAPI.notificationMarkSessionAttention(sessionId)',
      ownerFence,
    );
    const showNotification = sidebarSource.indexOf(
      'window.electronAPI.notificationShowSessionEvent({',
      markAttention,
    );

    expect(capture).toBeGreaterThan(-1);
    expect(focusListener).toBeGreaterThan(capture);
    expect(soundAwait).toBeGreaterThan(focusListener);
    expect(focusFence).toBeGreaterThan(soundAwait);
    expect(ownerFence).toBeGreaterThan(focusFence);
    expect(markAttention).toBeGreaterThan(ownerFence);
    expect(showNotification).toBeGreaterThan(markAttention);
  });
});
