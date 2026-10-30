import { describe, expect, it, beforeEach } from 'vitest';

import {
  clearOrcaMcpHydrated,
  isOrcaMcpHydrated,
  knownNonOrcaSessionIds,
  markKnownNonOrcaIfApplicable,
  markOrcaMcpHydratedIfNeeded,
} from '../orcaMcpHydrationCache';

describe('orca MCP hydration cache', () => {
  beforeEach(() => {
    knownNonOrcaSessionIds.clear();
    clearOrcaMcpHydrated('session-1');
  });

  it('marks direct non-Orca create-session calls as known non-Orca', () => {
    markKnownNonOrcaIfApplicable('session-1', {});
    expect(knownNonOrcaSessionIds.has('session-1')).toBe(true);
  });

  it('does not mark explicit Orca worker vendorOptions as non-Orca', () => {
    markKnownNonOrcaIfApplicable('session-1', {
      vendorOptions: { orcaRole: 'worker' },
    });
    expect(knownNonOrcaSessionIds.has('session-1')).toBe(false);
  });

  it('does not mark explicit Orca role create opts as non-Orca', () => {
    markKnownNonOrcaIfApplicable('session-1', { orcaRole: 'lead' });
    expect(knownNonOrcaSessionIds.has('session-1')).toBe(false);
  });

  it('tracks hydrated Orca handles and clears stale non-Orca cache state', () => {
    knownNonOrcaSessionIds.add('session-1');

    markOrcaMcpHydratedIfNeeded('session-1', {
      vendorOptions: { orcaRole: 'worker' },
    });

    expect(isOrcaMcpHydrated('session-1')).toBe(true);
    expect(knownNonOrcaSessionIds.has('session-1')).toBe(false);

    clearOrcaMcpHydrated('session-1');
    expect(isOrcaMcpHydrated('session-1')).toBe(false);
  });

  it('does not mark plain handles as Orca-hydrated', () => {
    markOrcaMcpHydratedIfNeeded('session-1', {});
    expect(isOrcaMcpHydrated('session-1')).toBe(false);
  });

  it('keeps execution-device handles hydrated without caching them as non-Orca', () => {
    const opts = { vendorOptions: { orcaRemoteWorker: true } };
    markKnownNonOrcaIfApplicable('session-1', opts);
    expect(knownNonOrcaSessionIds.has('session-1')).toBe(false);
    knownNonOrcaSessionIds.add('session-1');
    markOrcaMcpHydratedIfNeeded('session-1', opts);
    expect(isOrcaMcpHydrated('session-1')).toBe(true);
    expect(knownNonOrcaSessionIds.has('session-1')).toBe(false);
  });
});
