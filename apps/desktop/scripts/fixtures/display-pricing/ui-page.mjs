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
    video: { about: 'Video category with a resolution tier and discounted range' },
    components: { about: 'Charge categories distinguish image tokens from text tokens' },
    'mixed-components': { about: 'Different categories in one role get per-quote prefixes' },
    'unknown-component': { about: 'Unknown categories fall back to the original direction' },
    labels: { about: 'All published item labels are translated; custom labels are verbatim', viewport: { width: 800, height: 1600 } },
    compact: { about: 'Short quotes stay on separate right-aligned rows' },
    default: { about: 'Multiple units, all four roles and supplementary conditions' },
    legacy: { about: 'Existing table without summary' },
  },
  async check(page, ui) {
    const expectText = async text => {
      if (!await page.getByText(text, { exact: true }).count()) throw Error(`Missing localized pricing text: ${text}`);
    };
    const pricing = page.getByText(await ui.t('settings.providers.models.advanced.pricing'), {
      exact: true,
    });
    await pricing.scrollIntoViewIfNeeded();
    await ui.capture('pricing', { locator: pricing.locator('..').locator('..') });
    if (!['legacy', 'labels'].includes(ui.case)) {
      const role = ui.case === 'video' ? 'output' : 'input';
      const component = { speech: 'text', image: 'image', video: 'video', components: 'text' }[ui.case];
      const key = component
        ? `newChat.modelSelector.displayPricing.roles.${component}.${role}`
        : `settings.providers.models.advanced.price.${role}`;
      await expectText(await ui.t(key));
    }
    const discount = page.getByText(await ui.t('settings.providers.models.advanced.discount'), { exact: true });
    if (['speech', 'image', 'legacy', 'components', 'mixed-components', 'unknown-component', 'labels'].includes(ui.case)) {
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
    // Browser regression: multiple quotes used to share a line with a separator.
    // Check rendered positions so wrapping and right alignment hold across locales/themes.
    if (['default', 'compact', 'mixed-components'].includes(ui.case)) {
      const layout = await page
        .getByText(await ui.t('settings.providers.models.advanced.price.input'), { exact: true })
        .evaluate(label => {
          const value = label.parentElement.lastElementChild;
          return {
            text: value.textContent,
            quotes: Array.from(value.firstElementChild.children, quote => {
              const rect = quote.getBoundingClientRect();
              return { top: rect.top, bottom: rect.bottom, right: rect.right };
            }),
          };
        });
      const [first, second] = layout.quotes;
      if (layout.quotes.length !== 2 || layout.text.includes('·')
        || second.top < first.bottom || Math.abs(first.right - second.right) > 1) {
        throw Error(`Multiple quotes must be separate right-aligned rows: ${JSON.stringify(layout)}`);
      }
    }
    if (ui.case === 'components') {
      for (const [component, role] of [['text', 'input'], ['image', 'output'], ['audio', 'cacheRead'], ['video', 'cacheWrite']]) {
        await expectText(await ui.t(`newChat.modelSelector.displayPricing.roles.${component}.${role}`));
      }
    }
    if (ui.case === 'mixed-components') {
      for (const component of ['text', 'image']) {
        await expectText(await ui.t(`newChat.modelSelector.displayPricing.components.${component}`));
      }
    }
    if (ui.case === 'unknown-component' && await page.getByText('future_kind', { exact: true }).count()) {
      throw Error('Unknown category leaked into the quote label');
    }
    if (ui.case === 'labels') {
      for (const component of ['text', 'image', 'audio', 'video']) {
        for (const role of ['input', 'output']) {
          await expectText(await ui.t(`newChat.modelSelector.displayPricing.roles.${component}.${role}`));
        }
      }
      await expectText(await ui.t('newChat.modelSelector.displayPricing.durationOutput'));
      await expectText('Custom fee');
    }
  },
};
