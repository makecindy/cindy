import { expect, it } from 'vitest';
import { areCompanionImportEntriesSelected, toggleCompanionImportEntries, type CompanionImportEntry } from '../companionImport.js';
const entries: CompanionImportEntry[] = [
  { id: 'work', name: 'Work', category: 'connections', selected: false, exclusiveWith: ['personal'] },
  { id: 'personal', name: 'Personal', category: 'connections', selected: false, exclusiveWith: ['work'] },
  { id: 'other', name: 'Other', category: 'connections', selected: true },
];
it('switches credentials in the existing selection and keeps bulk selection unambiguous', () => {
  const all = entries.map(entry => entry.id);
  expect(toggleCompanionImportEntries(entries, [], all, true)).toEqual(['other']);
  const work = toggleCompanionImportEntries(entries, ['other'], ['work'], true);
  expect(work).toEqual(['other', 'work']);
  expect(areCompanionImportEntriesSelected(entries, work)).toBe(true);
  expect(areCompanionImportEntriesSelected(entries, ['other'])).toBe(false);
  expect(toggleCompanionImportEntries(entries, work, all, true)).toEqual(work);
  const personal = toggleCompanionImportEntries(entries, work, ['personal'], true);
  expect(personal).toEqual(['other', 'personal']);
  expect(toggleCompanionImportEntries(entries, personal, ['personal'], false)).toEqual(['other']);
  expect(toggleCompanionImportEntries(entries, personal, all, false)).toEqual([]);
});
