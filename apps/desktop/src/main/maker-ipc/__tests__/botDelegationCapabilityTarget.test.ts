import { describe, expect, it } from 'vitest';

import { isBotRuntimeSnapshotForCapabilityTarget } from '../botDelegationService';

describe('Bot delegation capability target runtime', () => {
  it('uses only the canonical task for ordinary roster capability claims', () => {
    expect(isBotRuntimeSnapshotForCapabilityTarget({
      runtimeSessionId: 'canonical-1',
      runtimeWorkingDir: '/repo/main',
      canonicalSessionId: 'canonical-1',
    })).toBe(true);
    expect(isBotRuntimeSnapshotForCapabilityTarget({
      runtimeSessionId: 'telegram-route-1',
      runtimeWorkingDir: '/repo/other',
      canonicalSessionId: 'canonical-1',
    })).toBe(false);
  });

  it('uses the frozen Automation workspace instead of an unrelated canonical or Route task', () => {
    expect(isBotRuntimeSnapshotForCapabilityTarget({
      runtimeSessionId: 'automation-child',
      runtimeWorkingDir: '/repo/frozen',
      canonicalSessionId: 'canonical-1',
      automationWorkingDir: '/repo/frozen',
    })).toBe(true);
    expect(isBotRuntimeSnapshotForCapabilityTarget({
      runtimeSessionId: 'canonical-1',
      runtimeWorkingDir: '/repo/main',
      canonicalSessionId: 'canonical-1',
      automationWorkingDir: '/repo/frozen',
    })).toBe(false);
  });
});
