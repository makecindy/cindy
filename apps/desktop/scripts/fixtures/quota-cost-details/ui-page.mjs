import assert from 'node:assert/strict';

export default {
  name: 'quota-cost-details',
  entry: './quota-cost-details-fixture.tsx',
  viewport: { width: 1280, height: 900 },
  real: 'QuotaHoverCard, UsageCostDetails, translations and themes',
  notCovered: 'TodaySpendChip popover positioning, live quota reads and cost detail loading. Synthetic account and rows only.',
  cases: {
    default: { about: 'Account card with identity keeps its quota width while showing cost details' },
    narrow: { about: 'Same card at 320 px', viewport: { width: 320, height: 900 } },
  },
  async check(page) {
    const card = page.getByTestId('quota-hover-card');
    await page.getByTestId('usage-cost-details').waitFor();
    const { width } = await card.boundingBox();
    // 费用说明长句不得把 w-max 卡片撑宽：卡片宽度仍由额度行决定（最小 340px）。
    assert.ok(width <= 400, `quota card width ${width}px should stay near its 340px minimum`);
  },
};
