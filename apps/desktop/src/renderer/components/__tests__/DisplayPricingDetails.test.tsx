// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { parseModelDisplayPricing, type CatalogModel } from '@cindy/model-providers';
import en from '@/i18n/locales/en/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';
import { DisplayPricingDetails, DisplayPricingQuote } from '../DisplayPricingDetails';

const locales = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko };
type PricingModel = Pick<CatalogModel, 'displayPricing' | 'currency' | 'costDiscount'>;
const item = { label: 'Output', price: 0.5, unit: 'second', quantity: 1 };

async function renderPricing(model: PricingModel, locale: keyof typeof locales = 'en', summary = false) {
  const i18n = createInstance();
  await i18n.init({ lng: locale, resources: { [locale]: { translation: locales[locale] } } });
  return render(
    <I18nextProvider i18n={i18n}>
      {summary ? <DisplayPricingQuote quote={model.displayPricing!.summary!.output![0]} currency={model.currency!} costDiscount={model.costDiscount} /> : <DisplayPricingDetails model={model} />}
    </I18nextProvider>,
  );
}

afterEach(cleanup);

describe('DisplayPricingDetails', () => {
  // Unit contract: summary starting_at is invalid, but published item starting_at remains visible.
  // Previous render cases bypassed parsing; minimum input is the same qualifier on one item and summary.
  it('preserves and renders item starting prices after discarding an invalid summary', async () => {
    const displayPricing = parseModelDisplayPricing({
      items: [{ ...item, priceType: 'starting_at' }],
      summary: { output: [{ ...item, priceType: 'starting_at' }] },
    });
    expect(displayPricing?.summary).toBeUndefined();
    expect(displayPricing?.items).toEqual([{ ...item, priceType: 'starting_at' }]);
    await renderPricing({ currency: 'CNY', displayPricing }, 'zh-CN');
    expect(screen.getByText('Output')).toBeTruthy();
    expect(screen.getByText('¥0.5 起')).toBeTruthy();
    expect(screen.getByText('/ 秒')).toBeTruthy();
  });

  it('groups repeated labels in first-seen order and keeps tiers, quote qualifiers and notes', async () => {
    const { container } = await renderPricing({
      currency: 'USD',
      costDiscount: 0.2,
      displayPricing: {
        items: [
          { ...item, tier: 'HD', priceType: 'estimated' },
          { ...item, label: 'Input', price: 2, unit: 'token', quantity: 1000000 },
          { ...item, tier: '4K', price: 1, unit: 'custom-unit', quantity: 3, priceType: 'starting_at' },
        ],
        notes: ['Billed by output duration.', '<b>Provider terms</b>'],
      },
    });
    expect(screen.getAllByText('Output')).toHaveLength(1);
    const output = screen.getByText('Output').parentElement!;
    const input = screen.getByText('Input').parentElement!;
    expect(output.nextElementSibling).toBe(input);
    expect(within(output).getByText('HD')).toBeTruthy();
    expect(within(output).getByText('4K')).toBeTruthy();
    expect(within(output).getByText('About $0.4')).toBeTruthy();
    expect(within(output).getByText('From $0.8')).toBeTruthy();
    expect(within(output).getByText('$0.5').tagName).toBe('S');
    expect(within(output).getByText('/ second')).toBeTruthy();
    expect(within(output).getByText('/ 3 custom-unit')).toBeTruthy();
    expect(within(input).getByText('/ million tokens')).toBeTruthy();
    expect(screen.getByText('Billed by output duration.')).toBeTruthy();
    expect(screen.getByText('<b>Provider terms</b>')).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
  });

  it.each([{ currency: 'USD' as const }, { displayPricing: { items: [item] } }])(
    'renders nothing when the quote or its currency is absent: %j',
    async model => {
      const { container } = await renderPricing(model);
      expect(container.textContent).toBe('');
    },
  );

  describe.each(Object.keys(locales) as Array<keyof typeof locales>)('%s', locale => {
    // Unit contract: the 13 published labels are localized; supplier text must not be guessed.
    // Old cases only used custom labels. Render one item for each published label and two raw labels.
    it('localizes published charge labels and preserves custom labels exactly', async () => {
      const copy = locales[locale].newChat.modelSelector.displayPricing;
      const labels = [
        ['Text Input', copy.roles.text.input], ['Text Output', copy.roles.text.output],
        ['Image Input', copy.roles.image.input], ['Image Output', copy.roles.image.output],
        ['Audio Input', copy.roles.audio.input], ['Audio Output', copy.roles.audio.output],
        ['Video Input', copy.roles.video.input], ['Video Output', copy.roles.video.output],
        ['Text Cache Read', copy.roles.text.cacheRead], ['Text Cache Write', copy.roles.text.cacheWrite],
        ['Image Cache Read', copy.roles.image.cacheRead],
        ['Duration Input', copy.durationInput], ['Duration Output', copy.durationOutput],
        ['Text input', 'Text input'], ['<b>Custom charge</b>', '<b>Custom charge</b>'],
      ];
      const { container } = await renderPricing({ currency: 'CNY', displayPricing: {
        items: labels.map(([label]) => ({ ...item, label })),
      } }, locale);
      for (const [, expected] of labels) {
        expect(screen.getAllByText(expected)).toHaveLength(labels.filter(([, text]) => text === expected).length);
      }
      expect(container.querySelector('b')).toBeNull();
    });
    it.each([{ price: 0, discount: 0 }, { price: 0.5, discount: 1 }])(
      'shows neutral free wording for %j without implying a limited-time offer',
      async ({ price, discount }) => {
        await renderPricing({
          currency: 'CNY', costDiscount: discount,
          displayPricing: { items: [{ ...item, price }] },
        }, locale);
        const copy = locales[locale].newChat.modelSelector;
        expect(screen.getByText(copy.displayPricing.free)).toBeTruthy();
        expect(screen.queryByText(copy.pricing.free)).toBeNull();
        expect(screen.getByText(`/ ${copy.displayPricing.units.second}`)).toBeTruthy();
        if (discount === 1) expect(screen.getByText('¥0.5').tagName).toBe('S');
      },
    );

    // Summary contract, unit tier: real quote/table rendering with million quantities and range qualifiers.
    // Earlier cases had no summary or localized million denominator; minimal input is one output quote.
    it.each(['exact', 'estimated'] as const)('renders summary range, tier, discount and %s in this locale', async priceType => {
      const copy = locales[locale].newChat.modelSelector.displayPricing;
      const { container } = await renderPricing({ currency: 'CNY', costDiscount: 0.2, displayPricing: {
        items: [item], summary: { output: [{ price: 6, maxPrice: 10, tier: '480P/720P', unit: 'token', quantity: 1000000, priceType }] },
      } }, locale, true);
      expect(container.textContent).toContain('480P/720P');
      expect(container.textContent).toContain((priceType === 'estimated' ? copy.estimated.replace('{{price}}', '¥4.8–¥8') : '¥4.8–¥8'));
      expect(container.querySelector('s')?.textContent).toBe('¥6–¥10');
      expect(screen.getByText(locales[locale].settings.providers.models.advanced.perMtok)).toBeTruthy();
    });
    it('uses the same million denominator in the supplementary price table', async () => {
      await renderPricing({ currency: 'CNY', displayPricing: { items: [{ ...item, unit: 'character', quantity: 1000000 }] } }, locale);
      const copy = locales[locale].newChat.modelSelector.displayPricing;
      const separator = locale === 'en' || locale === 'ko' ? ' ' : '';
      expect(screen.getByText(`/ ${copy.million}${separator}${copy.units.character}`)).toBeTruthy();
    });

    // Unit: token spelling must agree with chat prices for both quote surfaces in all five languages.
    it.each([false, true])('uses the chat token wording (summary=%s)', async summary => {
      const quote = { ...item, unit: 'token', quantity: 1000000 };
      await renderPricing({ currency: 'USD', displayPricing: { items: [quote], summary: { output: [quote] } } }, locale, summary);
      expect(screen.getByText(locales[locale].settings.providers.models.advanced.perMtok)).toBeTruthy();
    });

    it('localizes known image units and keeps unknown provider units unchanged', async () => {
      await renderPricing({
        currency: 'CNY',
        displayPricing: { items: [{ ...item, unit: 'image' }, { ...item, unit: 'future-unit' }] },
      }, locale);
      expect(screen.getByText(`/ ${locales[locale].newChat.modelSelector.displayPricing.units.image}`)).toBeTruthy();
      expect(screen.getByText('/ future-unit')).toBeTruthy();
      expect(screen.getAllByText('¥0.5')).toHaveLength(2);
    });
  });
});
