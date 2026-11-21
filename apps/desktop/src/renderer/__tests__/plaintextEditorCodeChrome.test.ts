import { describe, expect, it } from 'vitest';

import {
  findHexColors,
  getPlaintextEditorChrome,
} from '../components/markdown/plaintextEditorChrome';

describe('PlaintextEditor — unknown code language chrome fallback', () => {
  it('uses code chrome for non-markdown language intent regardless of parser support', () => {
    expect(getPlaintextEditorChrome('definitely-unsupported-language')).toBe('code');
    expect(getPlaintextEditorChrome('makefile')).toBe('code');
  });

  it('keeps markdown aliases on markdown chrome', () => {
    expect(getPlaintextEditorChrome('markdown')).toBe('markdown');
    expect(getPlaintextEditorChrome('md')).toBe('markdown');
  });

  it('uses plain chrome when no language is provided', () => {
    expect(getPlaintextEditorChrome(undefined)).toBe('plain');
  });
});

describe('PlaintextEditor — inline hex color previews', () => {
  it('finds standalone CSS hex colors without matching identifiers', () => {
    expect(findHexColors('Color(hex: "#ECF2F8")\nfill: #fff8;')).toEqual([
      { from: 12, to: 19, color: '#ECF2F8' },
      { from: 28, to: 33, color: '#fff8' },
    ]);
    expect(findHexColors('issue#123456 and foo#fff')).toEqual([]);
  });
});
