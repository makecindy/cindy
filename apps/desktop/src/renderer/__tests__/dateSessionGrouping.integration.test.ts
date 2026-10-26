import { expect, it } from 'vitest';

import { groupSessionsByActivityDate } from '@/features/cc-agent/lib/dateSessionGrouping';
import type { Session } from '@/lib/ccAgent.types';

// PR #7261: native Date must observe the real 23-hour day, which changing TZ in
// a worker thread cannot guarantee. Run this integration file with --pool=forks
// outside the unit shards; a one-file pool cannot be split into four shards.
it('keeps yesterday distinct across the 23-hour DST start day', () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    // Minimal regression: view March 8 activity on March 9 after the DST jump.
    // Keep this precondition so an ineffective timezone setup fails explicitly.
    expect(new Date(2026, 2, 9).getTime() - new Date(2026, 2, 8).getTime())
      .toBe(23 * 60 * 60 * 1000);
    const session = {
      id: 'dst-yesterday',
      lastActivityAt: '2026-03-08T12:00:00',
      userSendAt: null,
      updatedAt: '2026-03-08T12:00:00',
    } as Session;
    const groups = groupSessionsByActivityDate([session], new Date(2026, 2, 9, 12));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'yesterday', dayKey: '2026-03-08' });
    expect(groups[0].sessions).toEqual([session]);
  } finally {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});
