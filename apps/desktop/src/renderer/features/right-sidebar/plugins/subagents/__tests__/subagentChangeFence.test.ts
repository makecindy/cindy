import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __testing,
  getDataOwnerGeneration,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import {
  isCurrentSubagentReadOwner,
  isCurrentSubagentRunsChange,
  subagentReadScopeKey,
} from '../subagentChangeFence';

const payload = {
  sessionId: 'session-1',
  runId: 'run-1',
  created: true,
  firstForSession: true,
};

describe('isCurrentSubagentRunsChange', () => {
  beforeEach(() => {
    __testing.reset();
    setDataOwnerGeneration('owner-new', 2);
  });

  afterEach(() => {
    __testing.reset();
  });

  it('accepts only the current owner and session', () => {
    expect(
      isCurrentSubagentRunsChange(
        payload,
        { dataOwnerId: 'owner-new', ownerGeneration: 2 },
        'session-1',
      ),
    ).toBe(true);
    expect(
      isCurrentSubagentRunsChange(
        payload,
        { dataOwnerId: 'owner-old', ownerGeneration: 1 },
        'session-1',
      ),
    ).toBe(false);
    expect(
      isCurrentSubagentRunsChange(
        payload,
        { dataOwnerId: 'owner-new', ownerGeneration: 2 },
        'session-2',
      ),
    ).toBe(false);
  });

  it('invalidates in-flight reads and mounted state across owner or task switches', () => {
    setDataOwnerGeneration('owner-old', 1);
    const captured = getDataOwnerGeneration();
    const oldKey = subagentReadScopeKey(captured, 'session-1', null, null);

    setDataOwnerGeneration('owner-new', 2);
    const current = getDataOwnerGeneration();
    expect(isCurrentSubagentReadOwner(captured)).toBe(false);
    expect(isCurrentSubagentReadOwner(current)).toBe(true);
    expect(subagentReadScopeKey(current, 'session-1', null, null)).not.toBe(oldKey);
    expect(subagentReadScopeKey(current, 'session-2', null, null)).not.toBe(
      subagentReadScopeKey(current, 'session-1', null, null),
    );
    expect(subagentReadScopeKey(current, 'session-1', undefined, null)).not.toBe(
      subagentReadScopeKey(current, 'session-1', null, null),
    );
  });
});
