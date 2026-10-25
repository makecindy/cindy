// @vitest-environment jsdom
import { act, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useMessageEntrances, useRetainedMessageRows } from '@/session/CompanionEntering';

vi.mock('react-native', () => ({ Animated: {}, Easing: {} }));
vi.mock('@/theme', () => ({ motionDuration: {}, motionEasing: {} }));
vi.mock('@/session/AnimatedContentHeight', () => ({ AnimatedContentHeight: () => null }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => false }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Unit: LegendList can mount a new cell after another projection has committed.
// Losing its arrival marker at that commit skips the actual cell's entrance.
it('keeps an arrival through subsequent projections, but never marks restored history', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  let arrivals = new Map<string, number>();
  function Timeline({ keys, scope = 'task', ready = true }: { keys: string[]; scope?: string; ready?: boolean }) {
    arrivals = useMessageEntrances(keys, scope, ready);
    return null;
  }
  try {
    act(() => root.render(<Timeline keys={['history']} />));
    expect(arrivals.size).toBe(0);
    act(() => root.render(<Timeline keys={['history', 'reply']} />));
    const arrivedAt = arrivals.get('reply');
    expect(arrivedAt).toBeTypeOf('number');
    act(() => root.render(<Timeline keys={['history', 'reply']} />));
    expect(arrivals.get('reply')).toBe(arrivedAt);
    act(() => root.render(<Timeline keys={['history', 'reply', 'tool']} />));
    expect(arrivals.get('reply')).toBe(arrivedAt);
    expect(arrivals.has('tool')).toBe(true);
    act(() => root.render(<Timeline scope="other" keys={['reply']} />));
    expect(arrivals.size).toBe(0);
    act(() => root.render(<Timeline scope="other" keys={['reply']} ready={false} />));
    act(() => root.render(<Timeline scope="other" keys={['reply', 'restored']} />));
    expect(arrivals.size).toBe(0);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

// A completed turn absorbs the progress/tool rows into a summary. Their removal
// used to shrink the native scroll range in a single commit, before exit motion.
it('retains regrouped rows until collapse, without replaying or retaining another task history', () => {
  const root = createRoot(document.createElement('div'));
  let state: ReturnType<typeof useRetainedMessageRows<{ key: string }>>;
  function Timeline({ keys, scope = 'task', enabled = true }: { keys: string[]; scope?: string; enabled?: boolean }) {
    const items = useMemo(() => keys.map(key => ({ key })), [keys]);
    state = useRetainedMessageRows(items, scope, enabled);
    return null;
  }
  try {
    act(() => root.render(<Timeline keys={['user', 'thinking', 'progress', 'tools', 'answer']} />));
    act(() => root.render(<Timeline keys={['user', 'summary', 'answer']} />));
    expect(state!.rows.map(row => row.key)).toEqual(['user', 'thinking', 'progress', 'tools', 'summary', 'answer']);
    expect([...state!.exiting]).toEqual(['thinking', 'progress', 'tools']);
    act(() => state!.onExited('thinking'));
    expect(state!.rows.map(row => row.key)).not.toContain('thinking');
    act(() => root.render(<Timeline keys={['user', 'progress', 'summary', 'answer']} />));
    act(() => state!.onExited('progress'));
    expect(state!.rows.map(row => row.key)).toContain('progress');
    act(() => root.render(<Timeline scope="other" keys={['history']} />));
    expect(state!.rows.map(row => row.key)).toEqual(['history']);
    expect(state!.exiting.size).toBe(0);
    act(() => root.render(<Timeline scope="other" keys={['replacement-history']} />));
    expect(state!.rows.map(row => row.key)).toEqual(['replacement-history']);
    act(() => root.render(<Timeline scope="other" keys={[]} enabled={false} />));
    expect(state!.rows).toEqual([]);
  } finally { act(() => root.unmount()); }
});
