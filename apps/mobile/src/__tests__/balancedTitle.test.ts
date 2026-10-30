import { describe, expect, it } from 'vitest';
import { balancedTitleShift } from '@/platform/chrome/balancedTitle';

// 402pt bar: one leading button, two trailing buttons, title slot 68…266.
const slot = { center: 201, slotEnd: 266, slotStart: 68 };

describe('balancedTitleShift', () => {
  it('centers a title that fits between the symmetric margins', () => {
    const contentWidth = 100;
    const shift = balancedTitleShift({ ...slot, contentWidth });
    const end = slot.slotEnd + shift;
    expect(end - contentWidth / 2).toBe(slot.center);
  });

  it('pins a title that overflows the centered space to the trailing actions', () => {
    expect(balancedTitleShift({ ...slot, contentWidth: 150 })).toBe(0);
    expect(balancedTitleShift({ ...slot, contentWidth: 198 })).toBe(0);
  });

  it('keeps the title inside the slot when the slot sits right of the midline', () => {
    const shift = balancedTitleShift({ center: 100, contentWidth: 80, slotEnd: 300, slotStart: 120 });
    expect(300 + shift - 80).toBe(120);
  });

  it('never shifts toward the trailing edge', () => {
    expect(balancedTitleShift({ center: 400, contentWidth: 40, slotEnd: 266, slotStart: 68 })).toBe(0);
  });
});
