import { describe, expect, it } from 'vitest';

import { INTERACTION_CARD_MODEL } from '../interactionCardModel.js';

describe('INTERACTION_CARD_MODEL', () => {
  it('取个人车道现值(behavior-preserving 64/12/3800), 不采用官方旧 60/4000', () => {
    expect(INTERACTION_CARD_MODEL.buttonLabelMax).toBe(64);
    expect(INTERACTION_CARD_MODEL.pairLabelMax).toBe(12);
    expect(INTERACTION_CARD_MODEL.cardTextMax).toBe(3800);
  });

  it('pairLabelMax 严格小于 buttonLabelMax(并排阈值不超过截断上限)', () => {
    expect(INTERACTION_CARD_MODEL.pairLabelMax).toBeLessThan(INTERACTION_CARD_MODEL.buttonLabelMax);
  });
});
