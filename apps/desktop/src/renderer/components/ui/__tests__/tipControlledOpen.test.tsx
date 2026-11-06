// @vitest-environment jsdom
/**
 * Tip 的 controlledOpen 在「受控 → 交回 hover」之间切换时不能触发 Radix 的
 * uncontrolled/controlled 切换警告。语音按钮就是这种用法:精修中强制展示,结束后
 * 交回 hover;之前每次提交都会在控制台报一次警告。
 *
 * 还覆盖 hover 浮层在窗口失活时的收口:Radix 只认 trigger 的 pointerleave,
 * 切到别的窗口后指针事件断在那边,受控浮层会一直挂在屏幕上。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Tip } from '../tooltip';

/** 行级 hover 浮层的接线形状：调用方自己持受控 open（侧栏行就是这样抑制行内动作浮层的）。 */
function ControlledTip() {
  const [open, setOpen] = useState(false);
  return (
    <Tip text="tip" delay={0} controlledOpen={open} onOpenChange={setOpen}>
      <button type="button" onPointerOver={() => setOpen(true)}>
        hover
      </button>
    </Tip>
  );
}

describe('Tip controlledOpen transitions', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('does not warn when controlledOpen goes from boolean back to undefined', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { rerender } = render(
      <Tip text="tip" controlledOpen={undefined}>
        <button type="button">voice</button>
      </Tip>,
    );
    rerender(
      <Tip text="tip" controlledOpen>
        <button type="button">voice</button>
      </Tip>,
    );
    rerender(
      <Tip text="tip" controlledOpen={undefined}>
        <button type="button">voice</button>
      </Tip>,
    );

    const messages = [...warn.mock.calls, ...error.mock.calls].map((call) => String(call[0]));
    expect(messages.filter((message) => /uncontrolled to controlled|controlled to uncontrolled/i.test(message))).toEqual([]);
  });
});

describe('tooltip window deactivation', () => {
  afterEach(cleanup);

  it('closes a controlled hover tooltip when the window loses focus', async () => {
    render(<ControlledTip />);
    fireEvent.pointerOver(screen.getByRole('button'));
    await screen.findByRole('tooltip');

    fireEvent.blur(window);

    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('leaves uncontrolled tooltips to Radix when the window loses focus', async () => {
    render(
      <Tip text="tip" delay={0}>
        <button type="button">hover</button>
      </Tip>,
    );
    fireEvent.pointerMove(screen.getByRole('button'), { pointerType: 'mouse' });
    await screen.findByRole('tooltip');

    fireEvent.blur(window);

    // 未受控浮层没有调用方可复位，保持既有行为（Radix 自己按 pointerleave 收口）。
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.queryByRole('tooltip')).not.toBeNull();
  });

  it('hands the close request to a controlled caller', async () => {
    const onOpenChange = vi.fn();
    render(
      <Tip text="tip" controlledOpen onOpenChange={onOpenChange}>
        <button type="button">hover</button>
      </Tip>,
    );
    await screen.findByRole('tooltip');

    fireEvent.blur(window);
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // 点别处 / Esc 的关闭请求同样要能传出去,否则受控 open 永远关不掉。
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(onOpenChange.mock.calls.length).toBeGreaterThan(1));
  });

});

describe('tooltip focus modality', () => {
  afterEach(cleanup);

  it('does not open on focus handed back after a pointer-dismissed menu', async () => {
    // 菜单用鼠标点空白关闭时会把焦点还给触发按钮，此时指针不在按钮上；Radix 的
    // focus-open 不能借这次焦点把提示弹出来（弹出来也没有 pointerleave 能收掉）。
    render(
      <Tip text="tip" delay={0}>
        <button type="button">more</button>
      </Tip>,
    );

    fireEvent.pointerDown(document.body);
    fireEvent.focus(screen.getByRole('button'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('still opens on keyboard focus', async () => {
    render(
      <Tip text="tip" delay={0}>
        <button type="button">more</button>
      </Tip>,
    );

    fireEvent.keyDown(document.body, { key: 'Tab' });
    fireEvent.focus(screen.getByRole('button'));

    expect(await screen.findByRole('tooltip')).not.toBeNull();
  });
});

describe('tooltip close requests', () => {
  afterEach(cleanup);

  it('forwards close requests only, never Radix open requests', async () => {
    // 行的 onPointerOver / onFocusCapture 谓词独占打开逻辑(行内动作按钮上不弹行级浮层),
    // Radix Trigger 的打开请求不得写回受控调用方。
    const onOpenChange = vi.fn();
    render(
      <Tip text="tip" delay={0} controlledOpen={false} onOpenChange={onOpenChange}>
        <button type="button">hover</button>
      </Tip>,
    );

    fireEvent.pointerMove(screen.getByRole('button'), { pointerType: 'mouse' });
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    fireEvent.blur(window);

    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });
});
