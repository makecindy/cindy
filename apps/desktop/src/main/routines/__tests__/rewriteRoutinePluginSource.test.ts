import { describe, expect, it } from 'vitest';

import {
  matchesRoutineEvent,
  rewriteRoutinePluginSource,
  type Routine,
  type RoutineEvent,
} from '@cindy/maker-scheduler';

describe('rewriteRoutinePluginSource', () => {
  it('does not deliver the replacement plugin events to routines of the archived source', () => {
    const archive = 'arch_' + 'b'.repeat(32);
    const routine = {
      id: 'r1',
      enabled: true,
      triggers: [{
        id: 't1', kind: 'event', sourceId: 'plugin:helper', eventType: 'mail', filters: [],
      }],
    } as unknown as Routine;
    const event: RoutineEvent = { id: 'e1', type: 'mail', occurredAt: 1, data: {} };
    const receiptKey = JSON.stringify(['plugin:helper', 'e1']);
    const state = rewriteRoutinePluginSource({
      version: 1,
      routines: [routine],
      runs: [],
      receipts: { [receiptKey]: 5 },
      next: {},
    }, 'helper', archive);
    expect(matchesRoutineEvent(state.routines[0]!, 'plugin:helper', event)).toEqual([]);
    expect(matchesRoutineEvent(state.routines[0]!, `plugin:${archive}`, event)).toEqual(['t1']);
    expect(state.receipts[JSON.stringify([`plugin:${archive}`, 'e1'])]).toBe(5);
    expect(state.receipts[receiptKey]).toBeUndefined();
  });
});
