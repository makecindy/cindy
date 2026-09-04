// @vitest-environment jsdom

/**
 * ListComposerTextarea 包装的键盘契约(codex P2 回归):
 * - Alt+Enter 一律作为换行消费,绝不下沉到消费方"Enter=发送"(消费方多只排除 shiftKey)。
 * - 列表接续受 maxLength 约束(受控 value setter 绕过原生 maxlength,超长则不接续)。
 * jsdom 无布局,只验键盘 → 文本 / onKeyDown 派发。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ListComposerTextarea } from '../components/new-chat/ListComposerTextarea';

afterEach(cleanup);

function setup(opts: { value: string; caret: number; maxLength?: number }) {
  const onKeyDown = vi.fn();
  render(
    <ListComposerTextarea
      aria-label="t"
      defaultValue={opts.value}
      onKeyDown={onKeyDown}
      maxLength={opts.maxLength}
    />,
  );
  const el = screen.getByLabelText('t') as HTMLTextAreaElement;
  el.setSelectionRange(opts.caret, opts.caret);
  return { el, onKeyDown };
}

describe('ListComposerTextarea 键盘契约', () => {
  it('输入左符号时包裹并保留非空选区', () => {
    const { el, onKeyDown } = setup({ value: 'before abc after', caret: 0 });
    el.setSelectionRange(7, 10);

    fireEvent.keyDown(el, { key: '(' });

    expect(el.value).toBe('before (abc) after');
    expect(el.selectionStart).toBe(8);
    expect(el.selectionEnd).toBe(11);
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it('IME 组字时不介入成对符号输入', () => {
    const { el, onKeyDown } = setup({ value: 'abc', caret: 0 });
    el.setSelectionRange(0, 3);

    fireEvent.keyDown(el, { key: '(', isComposing: true });

    expect(el.value).toBe('abc');
    expect(onKeyDown).toHaveBeenCalledOnce();
  });

  it('包裹会超过 maxLength 时消费输入且保留原选区', () => {
    const { el, onKeyDown } = setup({ value: 'abc', caret: 0, maxLength: 4 });
    el.setSelectionRange(0, 3);

    fireEvent.keyDown(el, { key: '"' });

    expect(el.value).toBe('abc');
    expect(el.selectionStart).toBe(0);
    expect(el.selectionEnd).toBe(3);
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it('Alt+Enter 在非列表行:插换行并消费,不下沉到消费方(不误发送)', () => {
    const { el, onKeyDown } = setup({ value: 'hello', caret: 5 });
    fireEvent.keyDown(el, { key: 'Enter', altKey: true });
    expect(el.value).toBe('hello\n');
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it('Shift+Enter 在非列表行:放行给消费方(维持原发送/换行语义)', () => {
    const { el, onKeyDown } = setup({ value: 'hello', caret: 5 });
    fireEvent.keyDown(el, { key: 'Enter', shiftKey: true });
    expect(el.value).toBe('hello'); // 包装未改文本
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it('列表接续在限额内:接续并消费', () => {
    const { el, onKeyDown } = setup({ value: '1. a', caret: 4, maxLength: 100 });
    fireEvent.keyDown(el, { key: 'Enter', shiftKey: true });
    expect(el.value).toBe('1. a\n2. ');
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it('列表接续会超过 maxLength:跳过接续、放行默认(不撑过共享上限)', () => {
    // "1. 12345"(8) + "\n2. "(4) = 12 > 10 → 跳过,文本不变,下沉消费方
    const { el, onKeyDown } = setup({ value: '1. 12345', caret: 8, maxLength: 10 });
    fireEvent.keyDown(el, { key: 'Enter', shiftKey: true });
    expect(el.value).toBe('1. 12345');
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it('Alt+Enter 超过 maxLength:消费(不发送)但也不插换行', () => {
    const { el, onKeyDown } = setup({ value: '0123456789', caret: 10, maxLength: 10 });
    fireEvent.keyDown(el, { key: 'Enter', altKey: true });
    expect(el.value).toBe('0123456789'); // 满额不插
    expect(onKeyDown).not.toHaveBeenCalled(); // 仍消费,不误发送
  });
});
