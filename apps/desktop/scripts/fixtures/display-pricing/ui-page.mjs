export default {
  name: 'display-pricing',
  entry: './display-pricing-fixture.tsx',
  viewport: { width: 800, height: 800 },
  real: 'ModelAdvancedDrawer, DisplayPricingDetails, localized roles, quantities, ranges and discounts',
  notCovered:
    'Live Gateway responses, account permissions and actual billing; prices are fixture inputs',
  cases: {
    speech: { about: 'Character input per million' },
    image: { about: 'Input and output per image' },
    video: { about: 'Resolution tier with discounted range and starting price' },
    default: { about: 'Multiple units, all four roles and supplementary conditions' },
    legacy: { about: 'Existing table without summary' },
  },
  async check(page, ui) {
    const pricing = page.getByText(await ui.t('settings.providers.models.advanced.pricing'), {
      exact: true,
    });
    await pricing.scrollIntoViewIfNeeded();
    if (ui.case !== 'legacy') {
      const role = ui.case === 'video' ? 'output' : 'input';
      await page
        .getByText(await ui.t(`settings.providers.models.advanced.price.${role}`), {
          exact: true,
        })
        .waitFor();
    }
    const discount = page.getByText(await ui.t('settings.providers.models.advanced.discount'), { exact: true });
    if (['speech', 'image', 'legacy'].includes(ui.case)) {
      if (await discount.count()) throw Error('Unexpected discount on an undiscounted model');
    } else {
      await discount.waitFor();
      await page.getByText('↓40%', { exact: true }).waitFor();
    }
    // Browser regression: the original range split across lines in the real video drawer.
    // Measure rendered text, not Tailwind classes; tier must sit above the amount group.
    if (ui.case === 'video') {
      const layout = await page.getByText('¥0.05–¥0.2', { exact: true }).evaluate(original => {
        const amounts = original.parentElement;
        const tier = amounts.previousElementSibling;
        return {
          lines: Array.from(amounts.children, part => {
            const range = original.ownerDocument.createRange();
            range.selectNodeContents(part);
            return range.getClientRects().length;
          }),
          tierBelowAmounts: tier.getBoundingClientRect().bottom > amounts.getBoundingClientRect().top,
        };
      });
      if (layout.lines.some(count => count !== 1) || layout.tierBelowAmounts) {
        throw Error(`Broken video quote wrapping: ${JSON.stringify(layout)}`);
      }
    }
    await ui.capture('pricing');
  },
};
