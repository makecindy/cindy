// @vitest-environment jsdom
import { Suspense, startTransition, useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useViewedPriorityHold } from '../useViewedPriorityHold';
import { holdViewedPriorityRank, type ViewedPriorityHoldState } from '../../lib/mainListModel';
import { LIVE_TASK_PRIORITY } from '../../../../../shared/liveTaskPriority';

afterEach(cleanup);

it('retains click-time unread priority across an interrupted route render until leaving', async () => {
  const state: ViewedPriorityHoldState = {
    heldPriorityRanks: new Map(),
    recentlyViewedAtMs: new Map(),
  };
  const readContext = {
    runningSessionIds: new Set<string>(),
    attentionSessionIds: new Set<string>(),
  };
  let resolveRoute!: () => void;
  let ready = false;
  const route = new Promise<void>((resolve) => {
    resolveRoute = resolve;
  });
  let navigate!: (id: string) => void;
  let refresh!: () => void;
  const rendered: string[] = [];
  function List({ viewed, revision }: { viewed: string; revision: number }) {
    const hold = useViewedPriorityHold(state, viewed, { ...readContext });
    rendered.push(`${viewed}:${revision}`);
    return (
      <div data-testid="rank">
        {viewed}:{hold.heldPriorityRanks.get(viewed)}
      </div>
    );
  }
  function Route({ viewed }: { viewed: string }) {
    if (viewed === 'B' && !ready) throw route;
    return null;
  }
  function App() {
    const [viewed, setViewed] = useState('A');
    const [revision, setRevision] = useState(0);
    navigate = setViewed;
    refresh = () => setRevision((value) => value + 1);
    return (
      <Suspense fallback="loading">
        <List viewed={viewed} revision={revision} />
        <Route viewed={viewed} />
      </Suspense>
    );
  }
  render(<App />);
  act(() => {
    holdViewedPriorityRank(state, 'B', { ...readContext, attentionSessionIds: new Set(['B']) });
    startTransition(() => navigate('B'));
  });
  expect(rendered).toContain('B:0');
  expect(screen.getByTestId('rank').textContent).toBe('A:3');
  act(refresh);
  expect(rendered).toContain('A:1');
  expect(state.heldPriorityRanks.get('B')).toBe(LIVE_TASK_PRIORITY.unread);
  await act(async () => {
    ready = true;
    resolveRoute();
    await route;
  });
  expect(screen.getByTestId('rank').textContent).toBe('B:1');
  act(() => navigate('C'));
  expect(state.heldPriorityRanks.has('B')).toBe(false);
  expect(state.recentlyViewedAtMs.has('B')).toBe(true);
});
