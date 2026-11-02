import { useTranslation } from 'react-i18next';
import type { CatalogModel, ModelDisplayPricing, SummaryQuote } from '@cindy/model-providers';
import { displayPricingAmount, displayPricingDenominator, displayPricingQuantity } from '@/lib/displayPricingFormat';

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

// Only the published labels are localized. Provider-authored or future labels remain verbatim.
const ITEM_LABEL_KEYS = {
  'Text Input': 'roles.text.input',
  'Text Output': 'roles.text.output',
  'Image Input': 'roles.image.input',
  'Image Output': 'roles.image.output',
  'Audio Input': 'roles.audio.input',
  'Audio Output': 'roles.audio.output',
  'Video Input': 'roles.video.input',
  'Video Output': 'roles.video.output',
  'Text Cache Read': 'roles.text.cacheRead',
  'Text Cache Write': 'roles.text.cacheWrite',
  'Image Cache Read': 'roles.image.cacheRead',
  'Duration Input': 'durationInput',
  'Duration Output': 'durationOutput',
} as const;

/** Shared amount and denominator for both detailed items and primary summary quotes. */
export function DisplayPricingQuote({
  quote,
  currency,
  costDiscount,
  componentLabel,
}: {
  quote: SummaryQuote | ModelDisplayPricing['items'][number];
  currency: 'CNY' | 'USD';
  costDiscount?: number;
  componentLabel?: string;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const amount = displayPricingAmount(quote, currency, costDiscount, locale);
  const unit = Object.hasOwn(UNIT_KEYS, quote.unit)
    ? t(UNIT_KEYS[quote.unit as keyof typeof UNIT_KEYS])
    : quote.unit;
  const quantity = displayPricingQuantity(
    quote.quantity,
    locale,
    t('newChat.modelSelector.displayPricing.million'),
  );
  const denominator = quote.unit === 'token' && quote.quantity === 1_000_000
    ? t('settings.providers.models.advanced.perMtok')
    : displayPricingDenominator(quantity, unit, locale);
  const price = amount.free ? t('newChat.modelSelector.displayPricing.free') : amount.current;
  const qualifiedPrice =
    quote.priceType === 'estimated'
      ? t('newChat.modelSelector.displayPricing.estimated', { price })
      : quote.priceType === 'starting_at'
        ? t('newChat.modelSelector.displayPricing.startingAt', { price })
        : price;
  return (
    <span className="inline-flex min-w-0 max-w-full flex-col gap-1 tabular-nums">
      {quote.tier && <span className="break-words text-[var(--text-secondary)]">{quote.tier}</span>}
      <span className="flex flex-wrap items-baseline justify-end gap-x-1.5 gap-y-1">
        {componentLabel && <span className="whitespace-nowrap">{componentLabel}</span>}
        <span className="whitespace-nowrap">{qualifiedPrice}</span>
        {amount.original && <s className="whitespace-nowrap text-[var(--text-tertiary)]">{amount.original}</s>}
        <span className="whitespace-nowrap text-[var(--text-tertiary)]">
          {denominator}
        </span>
      </span>
    </span>
  );
}

/** Uses the selected source's snapshot, including currency and undiscounted amounts. */
export function DisplayPricingDetails({ model }: { model: PricingModel }) {
  const { t } = useTranslation();
  if (!model.displayPricing || !model.currency) return null;
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
          <div className="break-words font-medium text-[var(--text-primary)]">
            {Object.hasOwn(ITEM_LABEL_KEYS, label)
              ? t(`newChat.modelSelector.displayPricing.${ITEM_LABEL_KEYS[label as keyof typeof ITEM_LABEL_KEYS]}`)
              : label}
          </div>
          {items.map((item, index) => (
            <div
              key={index}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
            >
              {item.tier && <span className="min-w-0 break-words">{item.tier}</span>}
              <DisplayPricingQuote
                quote={{ ...item, tier: undefined }}
                currency={model.currency!}
                costDiscount={model.costDiscount}
              />
            </div>
          ))}
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
