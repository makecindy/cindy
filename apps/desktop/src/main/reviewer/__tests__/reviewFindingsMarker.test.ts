import { describe, expect, it } from 'vitest';

import { splitReviewFindingsMarker } from '../reviewFindingsMarker.js';

describe('splitReviewFindingsMarker', () => {
  it('reads and strips the trailing count', () => {
    expect(splitReviewFindingsMarker('1. P1: bug\n\n<review-findings count="2"/>')).toEqual({
      text: '1. P1: bug',
      findingsCount: 2,
    });
  });

  it('reports zero findings explicitly', () => {
    expect(splitReviewFindingsMarker('未发现需要修改的问题。\n<review-findings count="0" />')).toEqual({
      text: '未发现需要修改的问题。',
      findingsCount: 0,
    });
  });

  it('keeps the last restated count and removes every marker', () => {
    const parsed = splitReviewFindingsMarker(
      'draft <review-findings count="3"/>\nfinal\n<review-findings count=1>',
    );
    expect(parsed).toEqual({ text: 'draft\nfinal', findingsCount: 1 });
  });

  it('returns an unknown count when the Reviewer omitted the marker', () => {
    expect(splitReviewFindingsMarker('P1: bug')).toEqual({ text: 'P1: bug', findingsCount: null });
  });
});
