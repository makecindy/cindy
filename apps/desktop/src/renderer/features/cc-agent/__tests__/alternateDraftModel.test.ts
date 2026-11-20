import { describe, expect, it } from 'vitest';
import { alternateDraftModelFor, setAlternateDraftModel, type AlternateDraftModel } from '../alternateDraftModel';

// Unit regression: restore the same unfinished draft after its page is unmounted.
// The previous component-local state lost the selected alternate during navigation.
describe('alternate draft selection lifetime', () => {
  it('restores the selection for its owner and draft, and clears it on completion', () => {
    const alternate: AlternateDraftModel = {
      ownerGeneration: 12, vendor: 'pi', prefs: { model: 'auto', providerId: 'xd', effort: 'high' },
      fast: false, favoriteUid: null,
    };
    setAlternateDraftModel('draft-a', alternate);
    expect(alternateDraftModelFor('draft-a', 12)).toEqual(alternate);
    expect(alternateDraftModelFor('draft-b', 12)).toBeNull();
    expect(alternateDraftModelFor('draft-a', 13)).toBeNull();
    setAlternateDraftModel('draft-a', null);
    expect(alternateDraftModelFor('draft-a', 12)).toBeNull();
  });
});
