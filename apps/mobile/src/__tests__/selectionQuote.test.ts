import { describe, expect, it, vi } from 'vitest';
import {
  handleSelectionQuoteMenuAction,
  sliceRenderedSelection,
  withSelectionQuoteComment,
} from '@/session/selectionQuote';

describe('sliceRenderedSelection', () => {
  const lines = ['first line\n', 'second line\n', 'third'];

  it('slices within a single line', () => {
    expect(sliceRenderedSelection(lines, 0, 5)).toBe('first');
  });

  it('slices across line boundaries (lines join to the full rendered string)', () => {
    expect(sliceRenderedSelection(lines, 6, 17)).toBe('line\nsecond');
  });

  it('clamps out-of-range offsets from stale layouts', () => {
    expect(sliceRenderedSelection(lines, 23, 999)).toBe('third');
  });

  it('returns null for collapsed, inverted, or whitespace-only selections', () => {
    expect(sliceRenderedSelection(lines, 5, 5)).toBeNull();
    expect(sliceRenderedSelection(lines, 7, 3)).toBeNull();
    expect(sliceRenderedSelection(lines, 10, 11)).toBeNull();
    expect(sliceRenderedSelection([], 0, 5)).toBeNull();
  });
});

describe('handleSelectionQuoteMenuAction', () => {
  const lines = ['abc\n', 'defg'];

  it('commits the sliced selection text', () => {
    const commitQuote = vi.fn();
    handleSelectionQuoteMenuAction(
      { nativeEvent: { target: 1, start: 0, end: 3 } },
      lines,
      { commitQuote },
    );
    expect(commitQuote).toHaveBeenCalledWith('abc');
  });

  it('ignores events when layout lines are missing or the slice is empty', () => {
    const commitQuote = vi.fn();
    handleSelectionQuoteMenuAction(
      { nativeEvent: { target: 1, start: 0, end: 3 } },
      [],
      { commitQuote },
    );
    handleSelectionQuoteMenuAction(
      { nativeEvent: { target: 1, start: 3, end: 4 } },
      lines,
      { commitQuote },
    );
    expect(commitQuote).not.toHaveBeenCalled();
  });
});

describe('withSelectionQuoteComment', () => {
  it('preserves a non-empty multiline comment byte-for-byte without changing quote metadata', () => {
    expect(withSelectionQuoteComment(
      { text: 'selected', sourcePath: 'src/a.ts', startLine: 2, endLine: 3 },
      '\n  first\nsecond  \n',
    )).toEqual({
      text: 'selected',
      sourcePath: 'src/a.ts',
      startLine: 2,
      endLine: 3,
      comment: '\n  first\nsecond  \n',
    });
  });

  it('keeps an empty comment out of the shared quote model', () => {
    expect(withSelectionQuoteComment({ text: 'selected' }, '   ')).toEqual({ text: 'selected' });
  });
});
