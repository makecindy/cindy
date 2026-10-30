import { describe, expect, it } from 'vitest';

import { replaceUneditedSpan, spliceText } from '../components/new-chat/askUserDictation';

describe('ask user dictation text', () => {
  it('inserts at the caret and replaces a selection', () => {
    expect(spliceText('hello ', { start: 6, end: 6 }, 'world')).toEqual({
      value: 'hello world',
      range: { start: 6, end: 11 },
    });
    expect(spliceText('keep this', { start: 5, end: 9 }, 'that')).toEqual({
      value: 'keep that',
      range: { start: 5, end: 9 },
    });
  });

  it('clamps a stale caret instead of throwing', () => {
    expect(spliceText('ab', { start: 20, end: 40 }, '!')).toEqual({
      value: 'ab!',
      range: { start: 2, end: 3 },
    });
  });

  it('replaces a submitted span only while the user has not edited it', () => {
    const committed = spliceText('', { start: 0, end: 0 }, '原始');
    expect(replaceUneditedSpan(committed.value, committed.range, ['原始'], '润色后')).toEqual({
      value: '润色后',
      range: { start: 0, end: 3 },
    });
    expect(replaceUneditedSpan('我改过了', committed.range, ['原始'], '润色后')).toBeNull();
  });
});
