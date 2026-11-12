// @vitest-environment jsdom

import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SectionCollapse,
  SECTION_COLLAPSE_DURATION_MS,
} from '../features/cc-agent/sidebar/SectionCollapse';
import { useCollapsibleShowAll } from '../features/cc-agent/sidebar/hooks/useCollapsibleShowAll';

function renderShowAll(initialCollapsed = false) {
  const rendered = renderHook(
    ({ sectionCollapsed }) => {
      const [showAll, setShowAll] = useCollapsibleShowAll(sectionCollapsed);
      return { showAll, setShowAll };
    },
    { initialProps: { sectionCollapsed: initialCollapsed } },
  );
  // 模拟用户点过「显示全部」——复位逻辑只在 showAll=true 时有意义。
  act(() => {
    rendered.result.current.setShowAll(true);
  });
  return rendered;
}

describe('useCollapsibleShowAll', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('keeps showAll during the collapse animation and resets after it ends', () => {
    const { result, rerender } = renderShowAll();

    expect(result.current.showAll).toBe(true);

    rerender({ sectionCollapsed: true });
    expect(result.current.showAll).toBe(true);

    act(() => {
      vi.advanceTimersByTime(SECTION_COLLAPSE_DURATION_MS - 1);
    });
    expect(result.current.showAll).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.showAll).toBe(false);
  });

  it('cancels the pending reset if the section reopens before the animation ends', () => {
    const { result, rerender } = renderShowAll();

    rerender({ sectionCollapsed: true });
    act(() => {
      vi.advanceTimersByTime(SECTION_COLLAPSE_DURATION_MS / 2);
    });
    rerender({ sectionCollapsed: false });
    act(() => {
      vi.advanceTimersByTime(SECTION_COLLAPSE_DURATION_MS);
    });

    expect(result.current.showAll).toBe(true);
  });

  it('does not reset while the section itself never collapses', () => {
    const { result } = renderShowAll();

    act(() => {
      vi.advanceTimersByTime(SECTION_COLLAPSE_DURATION_MS * 2);
    });

    expect(result.current.showAll).toBe(true);
  });
});

describe('SectionCollapse unmount after animation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('does not mount children when first rendered collapsed', () => {
    const { queryByText } = render(<SectionCollapse collapsed>hidden</SectionCollapse>);
    expect(queryByText('hidden')).toBeNull();
  });

  it('keeps children during collapse and unmounts after the animation ends', () => {
    const { rerender, queryByText } = render(
      <SectionCollapse collapsed={false}>visible</SectionCollapse>,
    );
    expect(queryByText('visible')).not.toBeNull();

    rerender(<SectionCollapse collapsed>visible</SectionCollapse>);
    expect(queryByText('visible')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(SECTION_COLLAPSE_DURATION_MS - 1);
    });
    expect(queryByText('visible')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(queryByText('visible')).toBeNull();
  });

  it('remounts immediately when re-expanded before the animation ends', () => {
    const { rerender, queryByText } = render(
      <SectionCollapse collapsed={false}>visible</SectionCollapse>,
    );
    rerender(<SectionCollapse collapsed>visible</SectionCollapse>);
    act(() => {
      vi.advanceTimersByTime(SECTION_COLLAPSE_DURATION_MS / 2);
    });
    rerender(<SectionCollapse collapsed={false}>visible</SectionCollapse>);
    expect(queryByText('visible')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(SECTION_COLLAPSE_DURATION_MS);
    });
    expect(queryByText('visible')).not.toBeNull();
  });
});
