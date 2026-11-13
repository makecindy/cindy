import { describe, expect, it } from 'vitest';

import { androidUpdateSheetFrameWidth } from './androidUpdateSheetLayout';

describe('Android update sheet layout', () => {
  it('uses the measured native sheet width instead of the card content width', () => {
    expect(androidUpdateSheetFrameWidth(true, 360)).toBe(360);
    expect(androidUpdateSheetFrameWidth(false, 360)).toBe('100%');
  });
});
