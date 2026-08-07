import { describe, expect, it } from 'vitest';

import { TELEGRAM_CARD_LAYOUT } from '../cardLayout.js';

describe('TELEGRAM_CARD_LAYOUT', () => {
  it('取个人车道现值(behavior-preserving 64/12/3800), 不采用官方旧 60/4000', () => {
    expect(TELEGRAM_CARD_LAYOUT.buttonLabelMax).toBe(64);
    expect(TELEGRAM_CARD_LAYOUT.pairLabelMax).toBe(12);
    expect(TELEGRAM_CARD_LAYOUT.cardTextMax).toBe(3800);
  });

  it('pairLabelMax 严格小于 buttonLabelMax(并排阈值不超过截断上限)', () => {
    expect(TELEGRAM_CARD_LAYOUT.pairLabelMax).toBeLessThan(TELEGRAM_CARD_LAYOUT.buttonLabelMax);
  });
});
