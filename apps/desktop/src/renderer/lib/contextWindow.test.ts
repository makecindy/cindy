import { describe, expect, it } from 'vitest';

import { isCommittableWindowText, parseWindowText } from './contextWindow';

describe('isCommittableWindowText', () => {
  it('accepts empty text (clear window)', () => {
    expect(isCommittableWindowText('')).toBe(true);
    expect(isCommittableWindowText('   ')).toBe(true);
  });

  it('accepts plain positive integers', () => {
    expect(isCommittableWindowText('1000000')).toBe(true);
    expect(isCommittableWindowText('200000')).toBe(true);
  });

  it('accepts grouped separators between digit groups', () => {
    expect(isCommittableWindowText('1,000,000')).toBe(true);
    expect(isCommittableWindowText('1_000_000')).toBe(true);
    expect(isCommittableWindowText('1 000 000')).toBe(true);
  });

  it('rejects scientific notation, decimals, zero and negative values', () => {
    expect(isCommittableWindowText('1e6')).toBe(false);
    expect(isCommittableWindowText('262144.0')).toBe(false);
    expect(isCommittableWindowText('0')).toBe(false);
    expect(isCommittableWindowText('-5')).toBe(false);
    expect(isCommittableWindowText('abc')).toBe(false);
    expect(isCommittableWindowText('1,,000')).toBe(false);
  });

  it('rejects values beyond MAX_SAFE_INTEGER but accepts the bound itself', () => {
    expect(isCommittableWindowText(String(Number.MAX_SAFE_INTEGER))).toBe(true);
    expect(isCommittableWindowText(String(Number.MAX_SAFE_INTEGER + 1))).toBe(false);
  });
});

describe('parseWindowText', () => {
  it('returns undefined for empty text', () => {
    expect(parseWindowText('')).toBeUndefined();
    expect(parseWindowText('   ')).toBeUndefined();
  });

  it('parses grouped separators to the exact number', () => {
    expect(parseWindowText('1,000,000')).toBe(1_000_000);
    expect(parseWindowText('1_000_000')).toBe(1_000_000);
    expect(parseWindowText('1 000 000')).toBe(1_000_000);
  });

  it('parses the maximum safe integer without rounding', () => {
    expect(parseWindowText(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });
});
