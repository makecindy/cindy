import { describe, expect, it } from 'vitest';
import {
  buildStateVersionVector,
  createEmptySyncState,
  createHlcClock,
  findMaxHlc,
  formatHlc,
  isValidSyncState,
  materializeDictionary,
  mergeSyncStates,
  observeHlc,
  promoteEligibleDictionaryCandidates,
  promoteTermToEntry,
  recordLearningEvent,
  renameTerm,
  replaceTermAliases,
  seedTerm,
  versionVectorDominates,
  type VoiceDictionarySyncState,
} from '../dictionary-sync';

function candidate() {
  return recordLearningEvent(createEmptySyncState(), createHlcClock('origin'), {
    text: 'slack',
    aliases: [],
    stage: 'candidate',
    nowMs: 1000,
  });
}

function expectNewer(next: VoiceDictionarySyncState, previous: VoiceDictionarySyncState) {
  expect(
    versionVectorDominates(buildStateVersionVector(next), buildStateVersionVector(previous)),
  ).toBe(true);
  expect(
    versionVectorDominates(buildStateVersionVector(previous), buildStateVersionVector(next)),
  ).toBe(false);
}

describe('dictionary mutation progress', () => {
  it('no-alias admission and subsequent counts advance the vector without rewriting spelling', () => {
    const first = candidate();
    const second = recordLearningEvent(first.state, first.clock, {
      text: 'slack',
      aliases: [],
      stage: 'candidate',
      nowMs: 2000,
    });
    const third = recordLearningEvent(second.state, second.clock, {
      text: 'slack',
      aliases: [],
      stage: 'entry',
      nowMs: 3000,
    });
    expectNewer(second.state, first.state);
    expectNewer(third.state, second.state);
    expect(materializeDictionary(third.state).entries[0]).toMatchObject({
      frequency: 3,
      aliases: [],
    });
    const original = Object.values(first.state.records.slack.incarnations)[0];
    expect(Object.values(third.state.records.slack.incarnations)[0].textStamp).toBe(
      original.textStamp,
    );
    expect(findMaxHlc(third.state)).toBe(formatHlc(third.clock));
  });

  it('promotion and unchanged-alias confirmation advance progress only once', () => {
    const first = candidate();
    const promoted = promoteTermToEntry(first.state, first.clock, {
      termKey: 'slack',
      nowMs: 2000,
    });
    expectNewer(promoted.state, first.state);
    expect(
      promoteTermToEntry(promoted.state, promoted.clock, {
        termKey: 'slack',
        nowMs: 3000,
      }),
    ).toEqual({ ...promoted, changed: false });
    const confirmed = replaceTermAliases(first.state, first.clock, {
      termKey: 'slack',
      aliases: [],
      nowMs: 2000,
    });
    expectNewer(confirmed.state, first.state);
    expect(materializeDictionary(confirmed.state).entries[0]).toMatchObject({
      source: 'manual',
      frequency: 1,
    });
    expect(
      replaceTermAliases(confirmed.state, confirmed.clock, {
        termKey: 'slack',
        aliases: [],
        nowMs: 3000,
      }),
    ).toEqual({ ...confirmed, changed: false });
  });

  it('threads the clock through several eligible promotions without adding evidence', () => {
    let seeded = seedTerm(createEmptySyncState(), createHlcClock('origin'), {
      text: 'Slack',
      source: 'automatic',
      stage: 'candidate',
      count: 2,
      nowMs: 1000,
    });
    seeded = seedTerm(seeded.state, seeded.clock, {
      text: 'Orca',
      source: 'automatic',
      stage: 'candidate',
      count: 2,
      nowMs: 1000,
    });
    const promoted = promoteEligibleDictionaryCandidates(seeded.state, seeded.clock, 1000);
    expect(promoted.clock.counter).toBe(seeded.clock.counter + 2);
    expect(findMaxHlc(promoted.state)).toBe(formatHlc(promoted.clock));
    expect(materializeDictionary(promoted.state).entries.map((e) => e.frequency)).toEqual([2, 2]);
    expect(promoteEligibleDictionaryCandidates(promoted.state, promoted.clock, 2000)).toEqual({
      ...promoted,
      changed: false,
    });
  });

  it('joins concurrent nodes without losing progress or a manual capitalization correction', () => {
    const first = candidate();
    const a = recordLearningEvent(first.state, createHlcClock('a', 1000), {
      text: 'slack',
      stage: 'candidate',
      nowMs: 3000,
    });
    const b = recordLearningEvent(first.state, createHlcClock('b', 1000), {
      text: 'slack',
      stage: 'candidate',
      nowMs: 4000,
    });
    const renamed = renameTerm(first.state, createHlcClock('user', 1000), {
      termKey: 'slack',
      nextText: 'Slack',
      nowMs: 2000,
    });
    const merged = mergeSyncStates(a.state, b.state);
    expect(merged.mutationVector).toEqual({
      a: formatHlc(a.clock),
      b: formatHlc(b.clock),
    });
    expectNewer(merged, a.state);
    expectNewer(merged, b.state);
    expect(mergeSyncStates(merged, merged)).toEqual(merged);
    expect(mergeSyncStates(b.state, a.state)).toEqual(merged);
    const final = mergeSyncStates(merged, renamed.state);
    expect(final).toEqual(mergeSyncStates(a.state, mergeSyncStates(b.state, renamed.state)));
    expect(materializeDictionary(final).entries[0]).toMatchObject({
      text: 'Slack',
      frequency: 3,
    });
    const clock = observeHlc(createHlcClock('receiver'), findMaxHlc(final)!, 1000);
    const updated = recordLearningEvent(final, clock, {
      text: 'Slack',
      stage: 'entry',
      nowMs: 1000,
    });
    expectNewer(updated.state, final);
  });

  it('accepts old states and preserves local progress when old peers omit the optional field', () => {
    const old = candidate();
    expect(old.state.mutationVector).toBeUndefined();
    expect(isValidSyncState(old.state)).toBe(true);
    expect(mergeSyncStates(old.state, old.state)).toEqual(old.state);
    const next = promoteTermToEntry(old.state, old.clock, {
      termKey: 'slack',
      nowMs: 2000,
    });
    const { mutationVector: _ignored, ...downgraded } = next.state;
    expect(mergeSyncStates(next.state, downgraded)).toEqual(next.state);
    expect(materializeDictionary(downgraded)).toEqual(materializeDictionary(next.state));
  });

  it.each(['__proto__', 'constructor'])(
    'preserves safe maps for node %s across JSON and merge',
    (nodeId) => {
      const first = candidate();
      const next = promoteTermToEntry(first.state, createHlcClock(nodeId), {
        termKey: 'slack',
        nowMs: 2000,
      });
      const decoded = JSON.parse(JSON.stringify(next.state));
      expect(isValidSyncState(decoded)).toBe(true);
      const merged = mergeSyncStates(decoded, first.state);
      expect(Object.getPrototypeOf(merged.mutationVector)).toBeNull();
      expect(buildStateVersionVector(merged)[nodeId]).toBe(formatHlc(next.clock));
    },
  );

  it.each([null, [], { a: 'bad' }, { a: '0000000001.0000.b' }])(
    'rejects malformed metadata %j',
    (mutationVector) => {
      expect(isValidSyncState({ ...candidate().state, mutationVector })).toBe(false);
    },
  );
});
