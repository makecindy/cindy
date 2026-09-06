// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HomeSuggestionList } from '../HomeSuggestionList';
import { HOME_SUGGESTION_CATALOG, HOME_SUGGESTION_IDS } from '../homeSuggestions';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('HomeSuggestionList', () => {
  it.each([false, true])(
    'shows distinct categories and reaches every topic through shuffle (narrow=%s)',
    (narrow) => {
      const onSelect = vi.fn();
      render(<HomeSuggestionList narrow={narrow} onSelect={onSelect} />);
      const seen = new Set<string>();
      let previousIds: string[] = [];
      // A full catalog-length run is an upper bound even if only one new topic fits per batch.
      for (let index = 0; index < HOME_SUGGESTION_IDS.length; index++) {
        const rows = screen.getAllByTestId(/^home-suggestion-/);
        expect(rows).toHaveLength(narrow ? 2 : 4);
        const ids = rows.map((row) =>
          row.getAttribute('data-testid')!.replace('home-suggestion-', ''),
        );
        expect(ids.some((id) => previousIds.includes(id))).toBe(false);
        previousIds = ids;
        ids.forEach((id) => seen.add(id));
        const categories = ids.map(
          (id) => HOME_SUGGESTION_CATALOG.find((entry) => entry.id === id)!.category,
        );
        expect(new Set(categories).size).toBe(rows.length);
        fireEvent.click(rows[0]);
        expect(onSelect).toHaveBeenLastCalledWith(ids[0]);
        fireEvent.click(screen.getByTestId('home-suggestions-shuffle'));
      }
      expect(seen).toEqual(new Set(HOME_SUGGESTION_IDS));
    },
  );

  it('keeps the visible batch stable through rerenders and width changes', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<HomeSuggestionList narrow={false} onSelect={onSelect} />);
    const ids = () =>
      screen.getAllByTestId(/^home-suggestion-/).map((row) => row.getAttribute('data-testid'));
    const wide = ids();
    rerender(<HomeSuggestionList narrow={false} onSelect={vi.fn()} />);
    expect(ids()).toEqual(wide);
    rerender(<HomeSuggestionList narrow onSelect={onSelect} />);
    expect(ids()).toEqual(wide.slice(0, 2));
    rerender(<HomeSuggestionList narrow={false} onSelect={onSelect} />);
    expect(ids()).toEqual(wide);
  });

  it('does not forget topics exposed by expanding and then shrinking the window', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const onSelect = vi.fn();
    const { rerender } = render(<HomeSuggestionList narrow onSelect={onSelect} />);
    const ids = () =>
      screen.getAllByTestId(/^home-suggestion-/).map((row) => row.getAttribute('data-testid'));
    rerender(<HomeSuggestionList narrow={false} onSelect={onSelect} />);
    const seen = ids();
    rerender(<HomeSuggestionList narrow onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('home-suggestions-shuffle'));
    rerender(<HomeSuggestionList narrow={false} onSelect={onSelect} />);
    expect(ids().some((id) => seen.includes(id))).toBe(false);
  });
});
