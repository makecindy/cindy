// @vitest-environment jsdom
/**
 * Tip 的 controlledOpen 在「受控 → 交回 hover」之间切换时不能触发 Radix 的
 * uncontrolled/controlled 切换警告。语音按钮就是这种用法:精修中强制展示,结束后
 * 交回 hover;之前每次提交都会在控制台报一次警告。
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Tip } from '../tooltip';

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
