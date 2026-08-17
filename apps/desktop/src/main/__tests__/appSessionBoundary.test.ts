import { describe, expect, it, vi } from 'vitest';

const ghostBoundary = vi.hoisted(() => ({ stable: false }));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => `C:/tmp/cindy-${name}`,
  },
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn() }),
}));

vi.mock('../maker-host/override-settings-file.js', () => ({
  createOverrideSettingsFile: () => ({
    read: () => ({ activeMode: 'signed-out' }),
    writePatch: vi.fn(),
  }),
}));

vi.mock('../authBoundaryQuarantine.js', () => ({
  isGhostSkillProjectionBoundaryStableForOwner: () => ghostBoundary.stable,
}));

import {
  beginAppSessionBoundary,
  isAppSessionBoundaryPending,
} from '../appSessionState.js';

describe('application session boundary isolation', () => {
  it('does not treat a different durable Ghost projection owner as an App transition', () => {
    ghostBoundary.stable = false;
    expect(isAppSessionBoundaryPending()).toBe(false);
  });

  it('still fails closed during a real process-local App owner transition', () => {
    const release = beginAppSessionBoundary();
    expect(isAppSessionBoundaryPending()).toBe(true);
    release();
    expect(isAppSessionBoundaryPending()).toBe(false);
  });
});
