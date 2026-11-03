// @vitest-environment jsdom
/**
 * Unit, "Go through the list" order (docs/product-rules/new-device-setup-migration.md §1): the
 * walkthrough starts at the first pending item and moves past items that were finished meanwhile
 * (a key saved on its page counts as done). New behavior: no existing coverage. Minimal input: three
 * items, the second finished while the first was open.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { SetupMigrationChecklistItem } from '../../../../shared/setupMigration';
import { startChecklistWalkthrough } from '../SetupMigrationChecklist';
import { SetupMigrationWalkthroughBar, nextWalkthroughItem } from '../SetupMigrationWalkthroughBar';
import { getSetupMigrationWalkthrough, stopSetupMigrationWalkthrough } from '../setupMigrationStore';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../checklistTargets', () => ({ BUILTIN_KEY_NAMES: {}, openChecklistRoute: vi.fn() }));

const item = (id: string, done = false): SetupMigrationChecklistItem => ({ id, kind: 'provider-sign-in', label: id, ...(done ? { done } : {}) });

afterEach(() => {
  act(() => stopSetupMigrationWalkthrough());
  cleanup();
  vi.unstubAllGlobals();
});

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

// Missing coverage from the two-device run: it clicked Skip, not Done/next.
// Render the production bar and persist one manual completion through its IPC API (unit).
it('persists Done/next and advances through the real button without marking skipped items', async () => {
  let checklist = [item('a'), item('b')];
  const dismiss = vi.fn(async ({ id }: { id: string }) => {
    checklist = checklist.map((entry) => entry.id === id ? { ...entry, done: true } : entry);
    return { ok: true };
  });
  const oldApi = window.electronAPI;
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    setupMigration: { state: async () => ({ lastRun: { checklist } }), dismiss },
  } });
  try {
    startChecklistWalkthrough(checklist, vi.fn());
    await act(async () => { render(createElement(SetupMigrationWalkthroughBar)); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'setupMigration.walkthrough.next' })); });
    expect(dismiss).toHaveBeenCalledWith({ kind: 'checklist-item', id: 'a' });
    expect(checklist.map((entry) => !!entry.done)).toEqual([true, false]);
    expect(getSetupMigrationWalkthrough()?.index).toBe(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'setupMigration.walkthrough.skip' })); });
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(checklist[1].done).toBeUndefined();
    expect(screen.getByText('setupMigration.walkthrough.allDone')).toBeTruthy();
  } finally {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: oldApi });
  }
});
