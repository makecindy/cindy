import { describe, expect, it } from 'vitest';
import { coalesceDictionaryLearningActions } from '../dictionaryLearningPolicy';
import {
  createEmptySyncState,
  createHlcClock,
  recordLearningEvent,
  materializeDictionary,
  mergeSyncStates,
  promoteEligibleDictionaryCandidates,
  deleteTerms,
} from '../dictionary-sync';

function candidates(node: string, aliases: string[]) {
  let state = createEmptySyncState();
  let clock = createHlcClock(node);
  for (const [i, alias] of aliases.entries()) {
    const next = recordLearningEvent(state, clock, {
      text: 'Slack',
      aliases: alias ? [alias] : [],
      stage: 'candidate',
      nowMs: 1000 + i,
    });
    state = next.state;
    clock = next.clock;
  }
  return { state, clock };
}

describe('candidate admission', () => {
  it('second observation admits without a model entry action and retains alias history', () => {
    const first = candidates('a', ['Slate']);
    expect(materializeDictionary(first.state).candidates[0].evidenceCount).toBe(1);
    const second = recordLearningEvent(first.state, first.clock, {
      text: 'Slack',
      aliases: ['Slak'],
      stage: 'candidate',
      nowMs: 2000,
    });
    const view = materializeDictionary(second.state);
    expect(view.candidates).toEqual([]);
    expect(view.entries[0]).toMatchObject({ text: 'Slack', frequency: 2 });
    expect(view.entries[0].aliases.map((a) => [a.text, a.count])).toEqual([
      ['Slak', 1],
      ['Slate', 1],
    ]);
    expect(Object.values(second.state.records.slack.incarnations)[0].stage).toBe('entry');
  });

  it('merged candidate evidence admits once without changing counts or merge algebra', () => {
    const a = candidates('a', ['Slate']);
    const b = candidates('b', ['Slak']);
    const merged = mergeSyncStates(a.state, b.state);
    expect(materializeDictionary(merged).candidates[0].evidenceCount).toBe(2);
    const promoted = promoteEligibleDictionaryCandidates(merged, a.clock, 3000);
    expect(materializeDictionary(promoted.state).entries[0].frequency).toBe(2);
    expect(promoteEligibleDictionaryCandidates(promoted.state, a.clock, 4000).changed).toBe(false);
    expect(materializeDictionary(mergeSyncStates(promoted.state, merged))).toEqual(
      materializeDictionary(promoted.state),
    );
  });

  it('also admits without aliases and respects deletion', () => {
    const a = candidates('a', ['', '']);
    expect(materializeDictionary(a.state).entries[0]).toMatchObject({ frequency: 2, aliases: [] });
    const deleted = deleteTerms(a.state, a.clock, { termKeys: ['slack'], nowMs: 3000 });
    const learned = recordLearningEvent(deleted.state, deleted.clock, {
      text: 'Slack',
      stage: 'candidate',
      nowMs: 4000,
    });
    expect(learned.changed).toBe(false);
    expect(promoteEligibleDictionaryCandidates(learned.state, learned.clock, 5000).changed).toBe(
      false,
    );
  });

  it('coalesces a result by word, keeps aliases once and prefers formal admission', () => {
    const base = { term: 'Slack', type: 'product_name' as const, confidence: 'medium' as const };
    const combined = coalesceDictionaryLearningActions([
      { ...base, action: 'add_candidate', aliases: ['Slate', 'Slate'] },
      { ...base, action: 'add_entry', aliases: ['Slak', 'slate'] },
      { ...base, action: 'update_entry', aliases: ['CPU'], confidence: 'low' },
    ]);
    expect(combined).toEqual([{ ...base, action: 'add_entry', aliases: ['Slate', 'Slak'] }]);
  });
});
