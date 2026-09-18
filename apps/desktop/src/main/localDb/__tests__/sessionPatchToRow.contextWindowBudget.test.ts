import { describe, expect, it } from 'vitest';

import { sessionCreateToRow, sessionPatchToRow } from '../mapper';

describe('sessionPatchToRow context window budget', () => {
  it('writes a sane token budget rounded to an integer', () => {
    expect(sessionPatchToRow({ contextWindowBudget: 300_000.4 }).contextWindowBudget).toBe(
      300_000,
    );
  });

  it('treats null as "follow the model default"', () => {
    expect(sessionPatchToRow({ contextWindowBudget: null }).contextWindowBudget).toBeNull();
  });

  it('drops out-of-range or non-numeric values instead of persisting them', () => {
    // normalizeContextWindowBudget 把非法值收敛成 null（跟随默认）；这里锁定的是
    // 入口不会把 999 / NaN / 字符串写进列。
    for (const value of [999, Number.NaN, '300000' as unknown as number, -5]) {
      expect(sessionPatchToRow({ contextWindowBudget: value }).contextWindowBudget).toBeNull();
    }
  });

  it('omits the column when the patch does not mention it', () => {
    expect(sessionPatchToRow({ model: 'grok-4.6' }).contextWindowBudget).toBeUndefined();
  });
});

describe('sessionCreateToRow context window budget', () => {
  it('persists a draft tier so the first send starts with it', () => {
    const row = sessionCreateToRow('s1', { model: 'grok-4.6', contextWindowBudget: 500_000 }, 1);
    expect(row.contextWindowBudget).toBe(500_000);
  });

  it('leaves the column NULL when the draft follows the model default', () => {
    expect(sessionCreateToRow('s1', { model: 'grok-4.6' }, 1).contextWindowBudget).toBeNull();
  });
});
