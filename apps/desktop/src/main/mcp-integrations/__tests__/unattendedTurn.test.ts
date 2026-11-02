import { describe, expect, it } from 'vitest';

import {
  beginUnattendedTurn,
  isUnattendedTurn,
  noteUnattendedPlanReviewDeclined,
  takeUnattendedPlanReviewDeclines,
} from '../unattendedTurn';

describe('unattended turn marker', () => {
  it('is turn scoped, ref counted and idempotent on release', () => {
    expect(isUnattendedTurn('s')).toBe(false);
    const first = beginUnattendedTurn('s');
    const second = beginUnattendedTurn('s');
    expect(isUnattendedTurn('s')).toBe(true);
    first();
    expect(isUnattendedTurn('s')).toBe(true);
    second();
    expect(isUnattendedTurn('s')).toBe(false);
    first();
    expect(isUnattendedTurn('s')).toBe(false);
  });

  it('keeps sessions independent', () => {
    const release = beginUnattendedTurn('a');
    try {
      expect(isUnattendedTurn('b')).toBe(false);
    } finally {
      release();
    }
    expect(isUnattendedTurn('a')).toBe(false);
  });

  it('records declined plan reviews once per run and starts each turn clean', () => {
    const first = beginUnattendedTurn('p');
    noteUnattendedPlanReviewDeclined('p');
    noteUnattendedPlanReviewDeclined('p');
    expect(takeUnattendedPlanReviewDeclines('p')).toBe(2);
    expect(takeUnattendedPlanReviewDeclines('p')).toBe(0);
    first();

    // 上一轮没收口的记录不能带进下一轮。
    noteUnattendedPlanReviewDeclined('p');
    const second = beginUnattendedTurn('p');
    expect(takeUnattendedPlanReviewDeclines('p')).toBe(0);
    second();
  });
});
