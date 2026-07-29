// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetSidebarBrandFigurePreferenceForTests,
  getSidebarBrandFigureVisible,
  useSidebarBrandFigurePreference,
} from '../useSidebarBrandFigurePreference';

const STORAGE_KEY = 'sidebar.brandFigure.visible';

describe('useSidebarBrandFigurePreference', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetSidebarBrandFigurePreferenceForTests();
  });

  it('hides the artwork by default without persisting a copied default', () => {
    const { result } = renderHook(() => useSidebarBrandFigurePreference());

    expect(result.current.visible).toBe(false);
    expect(getSidebarBrandFigureVisible()).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('persists only the visible override and removes it when restored', () => {
    const { result } = renderHook(() => useSidebarBrandFigurePreference());

    act(() => result.current.setVisible(true));
    expect(result.current.visible).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');

    act(() => result.current.setVisible(false));
    expect(result.current.visible).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('updates other hook instances in the same window immediately', () => {
    const first = renderHook(() => useSidebarBrandFigurePreference());
    const second = renderHook(() => useSidebarBrandFigurePreference());

    act(() => first.result.current.setVisible(true));

    expect(second.result.current.visible).toBe(true);
  });
});
