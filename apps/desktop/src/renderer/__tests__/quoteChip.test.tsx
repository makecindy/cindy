// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuoteChip } from '@/components/chat/QuoteChip';

afterEach(() => {
  cleanup();
});

describe('QuoteChip', () => {
  it('collapses multiline quote text into a single-line summary', () => {
    const { container } = render(<QuoteChip quote={{ text: 'first line\n\nsecond line' }} />);

    const chip = container.querySelector<HTMLElement>('[aria-label]');
    expect(chip?.getAttribute('aria-label')).toBe('first line\n\nsecond line');
    expect(chip?.textContent).toBe('first line second line');
    // 引用 chip 是消息内 chip 里唯一保留 select-none 的:它展示的是折叠成单行的
    // 摘要而非原文,不该跟着复制出去(其余 chip 默认可选中,见 inlineReferenceChip
    // 的剪贴板契约测试)。
    expect(chip?.className).toContain('select-none');
  });

  // #7387 unit: real chip/form interactions, absent from the old read-only
  // chip tests. Minimal failure: click a quote with a bound multiline comment.
  it('opens the complete original and its comment in history', () => {
    render(<QuoteChip quote={{ text: 'quoted\noriginal', comment: 'my\ncomment' }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('dialog').textContent).toContain('quoted\noriginal');
    expect(screen.getByRole('dialog').textContent).toContain('my\ncomment');
  });

  it('cancels a local edit, saves multiline comments, and deletes the whole quote', async () => {
    const edit = vi.fn();
    const remove = vi.fn();
    render(<QuoteChip quote={{ text: 'original', comment: 'old' }} onEditComment={edit} onDelete={remove} />);
    const open = () => fireEvent.click(screen.getByRole('button', { name: 'original\nold' }));
    open();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'discard' } });
    fireEvent.click(screen.getByRole('button', { name: 'chat.quote.cancel' }));
    expect(edit).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'original\nold' })));
    open();
    expect(screen.getByRole('textbox')).toHaveProperty('value', 'old');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'one\n\ntwo\n' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true });
    expect(edit).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: true });
    expect(edit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'chat.quote.save' }));
    expect(edit).toHaveBeenCalledWith('one\n\ntwo\n');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'original\nold' })));
    open();
    fireEvent.click(screen.getByRole('button', { name: 'chat.quote.remove' }));
    expect(remove).toHaveBeenCalledOnce();
  });
});
