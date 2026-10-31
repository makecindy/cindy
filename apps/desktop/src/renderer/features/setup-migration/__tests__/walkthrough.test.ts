/**
 * Unit, "Go through the list" order (docs/product-rules/new-device-setup-migration.md §1): the
 * walkthrough starts at the first pending item and moves past items that were finished meanwhile
 * (a key saved on its page counts as done). New behavior: no existing coverage. Minimal input: three
 * items, the second finished while the first was open.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SetupMigrationChecklistItem } from '../../../../shared/setupMigration';
import { startChecklistWalkthrough } from '../SetupMigrationChecklist';
import { nextWalkthroughItem } from '../SetupMigrationWalkthroughBar';
import { getSetupMigrationWalkthrough, stopSetupMigrationWalkthrough } from '../setupMigrationStore';

const item = (id: string, done = false): SetupMigrationChecklistItem => ({ id, kind: 'provider-sign-in', label: id, ...(done ? { done } : {}) });

afterEach(() => stopSetupMigrationWalkthrough());

describe('setup checklist walkthrough', () => {
  it('opens the first pending item and skips items finished meanwhile', () => {
    const open = vi.fn();
    startChecklistWalkthrough([item('done-before', true), item('a'), item('b'), item('c')], open);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    expect(getSetupMigrationWalkthrough()).toEqual({ ids: ['a', 'b', 'c'], index: 0 });

    expect(nextWalkthroughItem([item('a', true), item('b', true), item('c')])?.id).toBe('c');
    expect(nextWalkthroughItem([item('a', true), item('b', true), item('c', true)])).toBeNull();
    expect(getSetupMigrationWalkthrough()?.index).toBe(3);
  });
});
