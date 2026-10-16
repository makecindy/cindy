import { describe, expect, it } from 'vitest';

import { TEAMMATE_ROWS_BY_DEFAULT, limitTeammateRows } from '../teammatesRowLimit';

const rows = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
const never = () => false;

describe('limitTeammateRows', () => {
  it('列表本来就放得下时原样返回,没有可展开的尾巴', () => {
    const fits = TEAMMATE_ROWS_BY_DEFAULT - 2;
    const result = limitTeammateRows(rows(fits), { keep: never });

    expect(result.rows).toEqual(rows(fits));
    expect(result.hiddenCount).toBe(0);
  });

  it('默认保留最近的一批,其余按原顺序收进尾部', () => {
    const result = limitTeammateRows(rows(23), { keep: never });

    expect(result.rows).toEqual(rows(TEAMMATE_ROWS_BY_DEFAULT));
    expect(result.hiddenCount).toBe(23 - TEAMMATE_ROWS_BY_DEFAULT);
  });

  it('豁免行停在自己的位置上,并且不占用上限', () => {
    // 第 5、10、15 行豁免(置顶 / 正在看),另外再按上限补足普通行。
    const result = limitTeammateRows(rows(15), {
      keep: (row) => row % 5 === 0,
    });

    expect(result.rows).toEqual([1, 2, 3, 4, 5, 6, 10, 15]);
    expect(result.hiddenCount).toBe(7);
  });

  it('豁免行被移到最后一位时也留在列表里', () => {
    const result = limitTeammateRows(rows(14), { keep: (row) => row === 14 });

    expect(result.rows).toContain(14);
    expect(result.rows).toHaveLength(TEAMMATE_ROWS_BY_DEFAULT + 1);
    expect(result.hiddenCount).toBe(14 - TEAMMATE_ROWS_BY_DEFAULT - 1);
  });

  it('上限为 0 或负数时不收敛 —— 调用方没给上限就别折叠', () => {
    expect(limitTeammateRows(rows(30), { keep: never, limit: 0 }).hiddenCount).toBe(0);
    expect(limitTeammateRows(rows(30), { keep: never, limit: -1 }).rows).toHaveLength(30);
  });

  it('不改动传入的数组', () => {
    const input = rows(12);
    limitTeammateRows(input, { keep: never });

    expect(input).toHaveLength(12);
  });
});
