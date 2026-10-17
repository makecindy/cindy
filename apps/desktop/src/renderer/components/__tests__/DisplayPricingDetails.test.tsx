// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { CatalogModel } from '@cindy/model-providers';
import en from '@/i18n/locales/en/common.json';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';
import { DisplayPricingDetails } from '../DisplayPricingDetails';

const locales = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko };
type PricingModel = Pick<CatalogModel, 'displayPricing' | 'currency' | 'costDiscount'>;
const item = { label: 'Output', price: 0.5, unit: 'second', quantity: 1 };

async function renderPricing(model: PricingModel, locale: keyof typeof locales = 'en') {
  const i18n = createInstance();
  await i18n.init({ lng: locale, resources: { [locale]: { translation: locales[locale] } } });
  return render(
    <I18nextProvider i18n={i18n}>
      <DisplayPricingDetails model={model} />
    </I18nextProvider>,
  );
}

afterEach(cleanup);

describe('DisplayPricingDetails', () => {
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
    expect(within(input).getByText('/ 1,000,000 tokens')).toBeTruthy();
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
