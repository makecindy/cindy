import { describe, expect, it } from 'vitest';

import { closingSymbolFor, computePairedSelectionEdit } from '../pairedSelection';

describe('paired selection', () => {
  it.each([
    ['"', '"'],
    ["'", "'"],
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
    ['<', '>'],
  ])('maps %s to %s', (open, close) => {
    expect(closingSymbolFor(open)).toBe(close);
  });

  it('wraps a multiline selection and keeps its contents selected', () => {
    expect(computePairedSelectionEdit('before\na\nb\nafter', 7, 10, '(')).toEqual({
      value: 'before\n(a\nb)\nafter',
      selectionStart: 8,
      selectionEnd: 11,
    });
  });

  it.each(['x', ')', ''])('ignores unsupported input %j', (input) => {
    expect(computePairedSelectionEdit('abc', 0, 3, input)).toBeNull();
  });

  it('ignores a collapsed selection', () => {
    expect(computePairedSelectionEdit('abc', 1, 1, '"')).toBeNull();
  });
});
