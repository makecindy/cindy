import { useTranslation } from 'react-i18next';
import type { CatalogModel, ModelDisplayPricing } from '@cindy/model-providers';
import { displayPricingAmount } from '@/lib/displayPricingFormat';

type PricingModel = Pick<CatalogModel, 'displayPricing' | 'currency' | 'costDiscount'>;
const UNIT_KEYS = {
  token: 'newChat.modelSelector.displayPricing.units.token',
  character: 'newChat.modelSelector.displayPricing.units.character',
  image: 'newChat.modelSelector.displayPricing.units.image',
  second: 'newChat.modelSelector.displayPricing.units.second',
  minute: 'newChat.modelSelector.displayPricing.units.minute',
  request: 'newChat.modelSelector.displayPricing.units.request',
  megapixel: 'newChat.modelSelector.displayPricing.units.megapixel',
  megapixel_second: 'newChat.modelSelector.displayPricing.units.megapixelSecond',
} as const;

/** Uses the selected source's snapshot, including currency and undiscounted amounts. */
export function DisplayPricingDetails({ model }: { model: PricingModel }) {
  const { t, i18n } = useTranslation();
  if (!model.displayPricing || !model.currency) return null;
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const groups = new Map<string, ModelDisplayPricing['items']>();
  for (const item of model.displayPricing.items) {
    const rows = groups.get(item.label) ?? [];
    rows.push(item);
    groups.set(item.label, rows);
  }
  return (
    <div className="space-y-3 text-12 text-[var(--text-secondary)]">
      {Array.from(groups, ([label, items]) => (
        <div key={label} className="space-y-1">
          <div className="break-words font-medium text-[var(--text-primary)]">{label}</div>
          {items.map((item, index) => {
            const amount = displayPricingAmount(item, model.currency!, model.costDiscount, locale);
            const unit = Object.hasOwn(UNIT_KEYS, item.unit)
              ? t(UNIT_KEYS[item.unit as keyof typeof UNIT_KEYS])
              : item.unit;
            const quantity =
              item.quantity === 1
                ? ''
                : new Intl.NumberFormat(locale, {
                    maximumSignificantDigits: 12,
                  }).format(item.quantity) + ' ';
            const price = amount.free ? t('newChat.modelSelector.displayPricing.free') : amount.current;
            const qualifiedPrice =
              item.priceType === 'estimated'
                ? t('newChat.modelSelector.displayPricing.estimated', { price })
                : item.priceType === 'starting_at'
                  ? t('newChat.modelSelector.displayPricing.startingAt', { price })
                  : price;
            return (
              <div
                key={index}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
              >
                {item.tier && <span className="min-w-0 break-words">{item.tier}</span>}
                <span className="min-w-0 break-words tabular-nums">
                  {qualifiedPrice}
                  {amount.original && (
                    <s className="ml-1.5 text-[var(--text-tertiary)]">{amount.original}</s>
                  )}
                  <span className="ml-1 text-[var(--text-tertiary)]">
                    / {quantity}
                    {unit}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      ))}
      {model.displayPricing.notes?.map((note, index) => (
        <p
          key={index}
          className="whitespace-pre-wrap break-words text-11 leading-relaxed text-[var(--text-tertiary)]"
        >
          {note}
        </p>
      ))}
    </div>
  );
}
