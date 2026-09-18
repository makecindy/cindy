import type { RefObject } from 'react';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BillingCatalogOffer, BillingCatalogProduct } from '../../../shared/billing';
import { formatBillingAmount } from './money';

export type ComparisonOffer = {
  offer: BillingCatalogOffer;
  current?: boolean;
  actionRef?: RefObject<HTMLButtonElement | null>;
  disabled?: boolean;
  action: string;
  onSelect: () => void;
};

export type ComparisonPlan = {
  product: BillingCatalogProduct;
  offers: ComparisonOffer[];
  defaultOfferCode: string;
  purchasableOffers?: BillingCatalogOffer[];
  action?: Pick<ComparisonOffer, 'action' | 'disabled' | 'onSelect'>;
};

/** Catalog amounts and availability come from the server; this component only presents them. */
export function PlanComparison({
  plans,
  freeAction,
  freeHint,
  onFreeAction,
  freeDisabled = false,
}: {
  plans: ComparisonPlan[];
  freeAction: string;
  freeHint: string;
  onFreeAction: () => void;
  freeDisabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const selected = plans.map((plan) => {
    const entry =
      plan.offers.find((entry) => entry.offer.code === plan.defaultOfferCode) ?? plan.offers[0];
    // Each displayed price and its terms must describe the same available offer.
    // Keep currencies and billing periods separate; current contracts use their snapshot.
    const groups = new Map<string, BillingCatalogOffer[]>();
    for (const offer of plan.purchasableOffers?.length
      ? plan.purchasableOffers
      : entry
        ? [entry.offer]
        : []) {
      const key = `${offer.currency}:${offer.interval}`;
      const group = groups.get(key);
      if (group) group.push(offer);
      else groups.set(key, [offer]);
    }
    const prices = [...groups].map(([key, offers]) => {
      const pricedOffers = offers.filter((offer) => offer.amount !== null);
      const lowest = pricedOffers.reduce<BillingCatalogOffer | undefined>(
        (min, offer) => (!min || Number(offer.amount) < Number(min.amount) ? offer : min),
        undefined,
      );
      return {
        key,
        offer: lowest ?? offers[0],
        hasDifferentPrices: pricedOffers.some(
          (offer) => Number(offer.amount) !== Number(lowest?.amount),
        ),
      };
    });
    return {
      ...plan,
      entry,
      prices,
      actionEntry: plan.offers.find((entry) => entry.current) ?? entry,
    };
  });
  const currency = selected[0]?.entry?.offer.currency;
  const buttonClass =
    'flex min-h-9 w-full items-center justify-center rounded-full border border-[var(--border-default)] px-3 py-2 text-13 font-medium transition-colors enabled:hover:bg-[var(--surface-hover-soft)] enabled:active:bg-[var(--surface-chip)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50';
  const feature = (key: string) => (
    <li key={key} className="flex items-start gap-2 text-13 leading-relaxed">
      <Check size={15} className="mt-0.5 shrink-0 text-[var(--text-secondary)]" aria-hidden />
      <span>{t(`billing.comparison.${key}`)}</span>
    </li>
  );
  return (
    <div className="overflow-x-auto pb-2">
      <div className="grid min-h-[460px] auto-cols-[minmax(220px,1fr)] grid-flow-col divide-x divide-[var(--border-default)]">
        <section className="flex min-w-0 flex-col px-6 first:pl-0 last:pr-0">
          <h3 className="min-h-7 text-14 font-medium">{t('billing.comparison.free')}</h3>
          <p className="mt-5 text-28 font-medium tabular-nums">
            {currency ? formatBillingAmount('0', currency, locale) : '0'}
          </p>
          <p className="mt-1 min-h-5 text-12 text-[var(--text-secondary)]">
            {t('billing.comparison.freeUsage')}
          </p>
          <div className="mt-6 min-h-16">
            <p className="text-13 font-medium">{t('billing.comparison.topup')}</p>
            <p className="mt-1 text-12 text-[var(--text-secondary)]">
              {t('billing.comparison.topupExpiry')}
            </p>
          </div>
          <ul className="mb-10 space-y-3 border-t border-[var(--border-default)] pt-5">
            {['agent', 'apiKey', 'existingSubscription', 'localModels', 'basicModels'].map(feature)}
          </ul>
          <div className="mt-auto">
            <p className="mb-3 text-11 leading-relaxed text-[var(--text-secondary)]">{freeHint}</p>
            <button
              type="button"
              className={buttonClass}
              disabled={freeDisabled}
              onClick={onFreeAction}
            >
              {freeAction}
            </button>
          </div>
        </section>
        {selected.map(({ product, offers, entry, prices, action, actionEntry }) => {
          if (!entry || !actionEntry) return null;
          const offer = prices[0].offer;
          const baseline = selected[0];
          const baseOffer = baseline?.prices[0]?.offer;
          const multiple =
            prices.length === 1 &&
            baseline.prices.length === 1 &&
            baseOffer &&
            product.code !== baseline.product.code &&
            baseOffer.currency === offer.currency &&
            baseOffer.interval === offer.interval &&
            Number(baseOffer.creditAmount) > 0 &&
            offer.creditAmount !== null
              ? Number(offer.creditAmount) / Number(baseOffer.creditAmount)
              : null;
          return (
            <section key={product.code} className="flex min-w-0 flex-col px-6 last:pr-0">
              <div className="flex min-h-7 flex-wrap items-center gap-2">
                <h3 className="break-words text-14 font-medium">{product.name}</h3>
                {offers.some((option) => option.current) && (
                  <span className="rounded-full bg-[var(--surface-chip)] px-2 py-1 text-10 text-[var(--text-secondary)]">
                    {t('billing.catalog.currentPlan')}
                  </span>
                )}
              </div>
              <div className="mt-5 text-28 font-medium tabular-nums">
                {prices.map(({ key, offer: price, hasDifferentPrices }) => {
                  return (
                    <p key={key}>
                      {price.amount !== null
                        ? formatBillingAmount(price.amount, price.currency, locale)
                        : '—'}
                      {hasDifferentPrices && (
                        <span className="ml-1 text-12 font-normal text-[var(--text-secondary)]">
                          {t('billing.comparison.priceFromSuffix')}
                        </span>
                      )}
                      {price.interval && (
                        <span className="ml-1 text-12 font-normal text-[var(--text-secondary)]">
                          / {t(`billing.intervals.${price.interval}`)}
                        </span>
                      )}
                    </p>
                  );
                })}
              </div>
              <div className="mt-1 min-h-5 text-12 text-[var(--text-secondary)]">
                {t('billing.comparison.subscription')}
              </div>
              <div className="mt-6 min-h-16 space-y-3">
                {prices.map(({ key, offer }) => (
                  <div key={key}>
                    {offer.creditAmount !== null && (
                      <p className="text-13 font-medium">
                        {t(
                          offer.interval
                            ? `billing.comparison.credits.${offer.interval}`
                            : 'billing.credits',
                          {
                            amount: formatBillingAmount(offer.creditAmount, offer.currency, locale),
                          },
                        )}
                      </p>
                    )}
                    {offer.rolloverCap !== null && (
                      <p className="mt-1 text-12 text-[var(--text-secondary)]">
                        {t('billing.comparison.rollover', {
                          amount: formatBillingAmount(offer.rolloverCap, offer.currency, locale),
                          period: t(`billing.comparison.nextPeriod.${offer.interval ?? 'OTHER'}`),
                        })}
                      </p>
                    )}
                  </div>
                ))}
              </div>
              <div className="mb-10 border-t border-[var(--border-default)] pt-5">
                <p className="mb-4 text-12 text-[var(--text-secondary)]">
                  {t('billing.comparison.includesFree')}
                </p>
                <ul className="space-y-3">
                  {['advancedModels', 'managedService'].map(feature)}
                  {multiple !== null && Number.isInteger(multiple) && multiple > 1 && (
                    <li className="flex items-start gap-2 text-13 leading-relaxed">
                      <Check
                        size={15}
                        className="mt-0.5 shrink-0 text-[var(--text-secondary)]"
                        aria-hidden
                      />
                      <span>
                        {t('billing.comparison.creditMultiple', {
                          name: baseline.product.name,
                          multiple,
                        })}
                      </span>
                    </li>
                  )}
                </ul>
              </div>
              <div className="mt-auto">
                <button
                  type="button"
                  ref={actionEntry.actionRef}
                  disabled={action ? action.disabled : actionEntry.disabled || actionEntry.current}
                  onClick={action?.onSelect ?? actionEntry.onSelect}
                  className={buttonClass}
                >
                  {action?.action ?? actionEntry.action}
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
