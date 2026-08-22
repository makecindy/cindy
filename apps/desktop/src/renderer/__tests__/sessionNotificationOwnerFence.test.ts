import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const sidebarSource = readFileSync(
  resolve(__dirname, '..', 'features', 'cc-agent', 'CCAgentSidebarUpper.tsx'),
  'utf8',
);

describe('session notification owner fence', () => {
  it('captures the account boundary before the sound await and drops stale events', () => {
    const capture = sidebarSource.indexOf('const dataOwnerAtNotification = getDataOwnerGeneration();');
    const soundAwait = sidebarSource.indexOf('await playSessionEventSound(kind);', capture);
    const fence = sidebarSource.indexOf(
      'if (!isDataOwnerGenerationCurrent(dataOwnerAtNotification)) return;',
      soundAwait,
    );
    const markAttention = sidebarSource.indexOf(
      'window.electronAPI.notificationMarkSessionAttention(sessionId)',
      fence,
    );

    expect(capture).toBeGreaterThan(-1);
    expect(soundAwait).toBeGreaterThan(capture);
    expect(fence).toBeGreaterThan(soundAwait);
    expect(markAttention).toBeGreaterThan(fence);
  });
});
