// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSessionScroll,
  markSessionAutomaticHistoryLoadCompleted,
  resetSessionAutomaticHistoryLoadCompletion,
} from '@/lib/sessionScrollStore';
import { useAutomaticHistoryLoadBudget } from '../useAutomaticHistoryLoadBudget';

const SESSION_ID = 'worker-mounted-budget';
const LOADED_WINDOW = {
  historyLoaded: true,
  messageCount: 10,
  firstMessageClientId: 'oldest-a',
};

afterEach(() => clearSessionScroll(SESSION_ID));

describe('useAutomaticHistoryLoadBudget', () => {
  it('resets both mounted budgets when the completed window is invalidated', () => {
    markSessionAutomaticHistoryLoadCompleted(SESSION_ID);
    const view = renderHook(() => useAutomaticHistoryLoadBudget(SESSION_ID, 5, 3, LOADED_WINDOW));

    expect(view.result.current.viewportAttemptsRef.current).toBe(5);
    expect(view.result.current.navRailRoundsRef.current).toBe(3);

    act(() => {
      resetSessionAutomaticHistoryLoadCompletion(SESSION_ID);
      view.rerender();
    });

    expect(view.result.current.viewportAttemptsRef.current).toBe(0);
    expect(view.result.current.navRailRoundsRef.current).toBe(0);
  });

  it('does not reset failed-load budgets while completion remains false', () => {
    const view = renderHook(() => useAutomaticHistoryLoadBudget(SESSION_ID, 5, 3, LOADED_WINDOW));
    view.result.current.viewportAttemptsRef.current = 5;
    view.result.current.navRailRoundsRef.current = 3;

    act(() => view.rerender());

    expect(view.result.current.viewportAttemptsRef.current).toBe(5);
    expect(view.result.current.navRailRoundsRef.current).toBe(3);
  });

  it('resets exhausted failed-load budgets when the mounted window reloads', () => {
    const view = renderHook(
      ({ historyLoaded }) =>
        useAutomaticHistoryLoadBudget(SESSION_ID, 5, 3, {
          ...LOADED_WINDOW,
          historyLoaded,
        }),
      { initialProps: { historyLoaded: true } },
    );
    view.result.current.viewportAttemptsRef.current = 5;
    view.result.current.navRailRoundsRef.current = 3;

    act(() => view.rerender({ historyLoaded: false }));

    expect(view.result.current.viewportAttemptsRef.current).toBe(0);
    expect(view.result.current.navRailRoundsRef.current).toBe(0);
  });

  it('resets exhausted budgets when reconciliation replaces the mounted window head', () => {
    const view = renderHook(
      ({ firstMessageClientId }) =>
        useAutomaticHistoryLoadBudget(SESSION_ID, 5, 3, {
          ...LOADED_WINDOW,
          firstMessageClientId,
        }),
      { initialProps: { firstMessageClientId: 'oldest-a' } },
    );
    view.result.current.viewportAttemptsRef.current = 5;
    view.result.current.navRailRoundsRef.current = 3;

    act(() => view.rerender({ firstMessageClientId: 'oldest-rebuilt' }));

    expect(view.result.current.viewportAttemptsRef.current).toBe(0);
    expect(view.result.current.navRailRoundsRef.current).toBe(0);
  });

  it('does not mistake an in-flight automatic prepend for a window rebuild', async () => {
    const view = renderHook(
      ({ firstMessageClientId }) =>
        useAutomaticHistoryLoadBudget(SESSION_ID, 5, 3, {
          ...LOADED_WINDOW,
          firstMessageClientId,
        }),
      { initialProps: { firstMessageClientId: 'oldest-a' } },
    );
    view.result.current.viewportAttemptsRef.current = 4;
    view.result.current.navRailRoundsRef.current = 2;
    let finishLoad!: (advanced: boolean) => void;
    const load = () =>
      new Promise<boolean>((resolve) => {
        finishLoad = resolve;
      });

    const pending = view.result.current.runAutomaticLoad(load);
    act(() => view.rerender({ firstMessageClientId: 'older-page' }));

    expect(view.result.current.viewportAttemptsRef.current).toBe(4);
    expect(view.result.current.navRailRoundsRef.current).toBe(2);

    finishLoad(true);
    await pending;
  });

  it('resets budgets after an in-flight automatic load is invalidated by a replacement', async () => {
    const view = renderHook(
      ({ firstMessageClientId }) =>
        useAutomaticHistoryLoadBudget(SESSION_ID, 5, 3, {
          ...LOADED_WINDOW,
          firstMessageClientId,
        }),
      { initialProps: { firstMessageClientId: 'oldest-a' } },
    );
    view.result.current.viewportAttemptsRef.current = 5;
    view.result.current.navRailRoundsRef.current = 3;
    let finishLoad!: (advanced: boolean) => void;
    const load = () =>
      new Promise<boolean>((resolve) => {
        finishLoad = resolve;
      });

    const pending = view.result.current.runAutomaticLoad(load);
    act(() => view.rerender({ firstMessageClientId: 'authoritative-head' }));

    finishLoad(false);
    await pending;

    expect(view.result.current.viewportAttemptsRef.current).toBe(0);
    expect(view.result.current.navRailRoundsRef.current).toBe(0);
  });
});
