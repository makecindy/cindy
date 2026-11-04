// @vitest-environment jsdom
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSessionSwitchFocusIntent } from '../useSessionSwitchFocusIntent';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(initial: { sessionId: string | undefined; enabled: boolean; awaiting?: boolean }) {
  return renderHook(
    ({ sessionId, enabled, awaiting = true }) =>
      useSessionSwitchFocusIntent(sessionId, enabled, awaiting),
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

  // 键盘切换：切换用的 Enter 还按着，确认卡要等历史重建后才出现。期间的自动重复不是
  // 新操作，不能撤销意图；用户真正新按一个键才撤销。
  it('切换时仍按着的 Enter / 空格产生的重复不撤销意图', () => {
    const { result } = setup({ sessionId: 'a', enabled: true });
    act(() => fireEvent.keyDown(window, { key: 'Enter', repeat: true }));
    act(() => fireEvent.keyDown(window, { key: ' ', repeat: true }));
    expect(result.current.armed).toBe(true);
    act(() => fireEvent.keyDown(window, { key: 'Enter' }));
    expect(result.current.armed).toBe(false);
  });

  // 读屏等辅助技术激活控件时只发一次可信 click，没有 pointerdown / keydown。jsdom 造不出
  // isTrusted=true 的事件，所以取到真实挂上的 click 监听，直接按可信与否各调一次。
  it('辅助技术的可信 click 撤销意图，代码里的 .click() 不撤销', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const { result } = setup({ sessionId: 'a', enabled: true });
    const clickListener = add.mock.calls.find(([type]) => type === 'click')?.[1] as
      | ((e: Pick<MouseEvent, 'isTrusted'>) => void)
      | undefined;
    expect(clickListener).toBeTypeOf('function');

    act(() => fireEvent.click(document.body));
    expect(result.current.armed).toBe(true);
    act(() => clickListener?.({ isTrusted: false }));
    expect(result.current.armed).toBe(true);
    act(() => clickListener?.({ isTrusted: true }));
    expect(result.current.armed).toBe(false);
  });

  // 切到一个还在跑、没在等授权的任务，用户只是看输出；之后才弹出的新请求不是这次切换要
  // 交接的，不能把焦点从侧栏行抢走（那时回车就成了批准）。
  it('切换时没在等授权就不武装，之后才到的新请求不抢焦点', () => {
    const { result, rerender } = setup({ sessionId: 'a', enabled: true, awaiting: false });
    expect(result.current.armed).toBe(false);
    rerender({ sessionId: 'a', enabled: true, awaiting: true });
    expect(result.current.armed).toBe(false);
    rerender({ sessionId: 'b', enabled: true, awaiting: false });
    rerender({ sessionId: 'b', enabled: true, awaiting: true });
    expect(result.current.armed).toBe(false);
  });

  // 切换时在等授权、确认卡还没重建，这条请求就在别处被处理掉了；之后的新请求同样不抢焦点。
  it('恢复期间请求已被处理掉，之后的新请求不抢焦点', () => {
    const { result, rerender } = setup({ sessionId: 'a', enabled: true, awaiting: true });
    expect(result.current.armed).toBe(true);
    rerender({ sessionId: 'a', enabled: true, awaiting: false });
    rerender({ sessionId: 'a', enabled: true, awaiting: true });
    expect(result.current.armed).toBe(false);
  });

  it('未启用（分屏非主 pane、只读等）时从不武装', () => {
    const { result, rerender } = setup({ sessionId: 'a', enabled: false });
    expect(result.current.armed).toBe(false);
    rerender({ sessionId: 'b', enabled: false });
    expect(result.current.armed).toBe(false);
  });

  // 分屏里已挂载的 pane 被选中成为主视图：sessionId 不变，只有 enabled false → true。
  it('同一任务的视图重新成为主视图时重新武装', () => {
    const { result, rerender } = setup({ sessionId: 'a', enabled: true });
    act(() => result.current.consume());
    rerender({ sessionId: 'a', enabled: false });
    expect(result.current.armed).toBe(false);
    rerender({ sessionId: 'a', enabled: true });
    expect(result.current.armed).toBe(true);
  });
});
