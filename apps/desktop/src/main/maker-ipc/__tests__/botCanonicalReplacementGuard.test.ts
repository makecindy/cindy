import { describe, expect, it } from 'vitest';

import { isBotCanonicalReplacementBusy } from '../botCanonicalReplacementGuard';

const idle = {
  turnRunning: false,
  backgroundTaskCount: 0,
  trackedTurn: false,
  leasedTurn: false,
  pendingInteraction: false,
};

describe('Bot canonical replacement guard', () => {
  it('allows Renew only when every runtime owner is idle', () => {
    expect(isBotCanonicalReplacementBusy(idle)).toBe(false);
  });

  it.each([
    ['live turn', { turnRunning: true }],
    ['background task', { backgroundTaskCount: 1 }],
    ['tracked turn', { trackedTurn: true }],
    ['leased IM turn', { leasedTurn: true }],
    ['pending interaction', { pendingInteraction: true }],
  ])('blocks Renew for %s', (_label, patch) => {
    expect(isBotCanonicalReplacementBusy({ ...idle, ...patch })).toBe(true);
  });
});
