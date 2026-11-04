// @vitest-environment jsdom
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useSessionSwitchFocusIntent } from '../useSessionSwitchFocusIntent';

afterEach(cleanup);

function setup(initial: { sessionId: string | undefined; enabled: boolean }) {
  return renderHook(
    ({ sessionId, enabled }) => useSessionSwitchFocusIntent(sessionId, enabled),
    { initialProps: initial },
  );
}

describe('useSessionSwitchFocusIntent', () => {
  it('首次打开任务即武装，消费后不再武装', () => {
    const { result } = setup({ sessionId: 'a', enabled: true });
    expect(result.current.armed).toBe(true);
    act(() => result.current.consume());
    expect(result.current.armed).toBe(false);
  });

  it('切换到另一个任务时重新武装', () => {
    const { result, rerender } = setup({ sessionId: 'a', enabled: true });
    act(() => result.current.consume());
    rerender({ sessionId: 'b', enabled: true });
    expect(result.current.armed).toBe(true);
  });

  it('同一任务内重渲染不会重新武装', () => {
    const { result, rerender } = setup({ sessionId: 'a', enabled: true });
    act(() => result.current.consume());
    rerender({ sessionId: 'a', enabled: true });
    expect(result.current.armed).toBe(false);
  });

  it('切换后用户点击或按键即撤销，晚到的请求不抢焦点', () => {
    const { result, rerender } = setup({ sessionId: 'a', enabled: true });
    act(() => fireEvent.pointerDown(window));
    expect(result.current.armed).toBe(false);
    rerender({ sessionId: 'b', enabled: true });
    expect(result.current.armed).toBe(true);
    act(() => fireEvent.keyDown(window, { key: 'a' }));
    expect(result.current.armed).toBe(false);
  });

  it('未启用（分屏非主 pane、只读等）时从不武装', () => {
    const { result, rerender } = setup({ sessionId: 'a', enabled: false });
    expect(result.current.armed).toBe(false);
    rerender({ sessionId: 'b', enabled: false });
    expect(result.current.armed).toBe(false);
  });
});
