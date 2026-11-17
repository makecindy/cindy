import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { mountPage, type UiPageContext } from '../../ui-page/harness';
import { BillingSettingsSection, OrderHistoryCard } from '../../../src/renderer/features/billing/BillingPage';
import type { BillingPaymentHistoryRecord } from '../../../src/shared/billing';

const base: BillingPaymentHistoryRecord = {
  recordId: 'SUBSCRIPTION_INVOICE:invoice_cycle_fixture', sourceType: 'SUBSCRIPTION_INVOICE',
  sourceId: 'invoice_cycle_fixture', subscriptionId: 'ended_subscription_fixture',
  productName: 'Plus', billingReason: 'subscription_cycle', amountPaidMinor: 8000, amount: '80.00', currency: 'cny',
  provider: 'alipay', providerTransactionId: '2026110522001400000000123456',
  paidAt: '2026-10-30T08:15:00.000Z', createdAt: '2026-10-29T08:00:00.000Z',
  periodStartAt: '2026-11-01T08:00:00.000Z', periodEndAt: '2026-12-01T08:00:00.000Z',
  refundSummary: { status: 'UNREFUNDED', refundedMinor: 0, refundedAmount: '0.00' },
};
const topup: BillingPaymentHistoryRecord = {
  ...base, recordId: 'CREDIT_TOPUP:topup_fixture', sourceType: 'CREDIT_TOPUP', sourceId: 'topup_fixture',
  subscriptionId: null, productName: null, billingReason: null, amountPaidMinor: 1100, amount: '11.00',
  currency: 'usd', provider: 'stripe', providerTransactionId: 'pi_topup_fixture', periodStartAt: null, periodEndAt: null,
};

function Preview({ ctx }: { ctx: UiPageContext }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [error, setError] = useState(ctx.case === 'error');
  if (ctx.case.startsWith('support-footer')) {
    return (
      <main data-ui-page-subject className="h-screen overflow-auto p-5">
        <BillingSettingsSection accountId="billing-preview" />
      </main>
    );
  }
  const records = ctx.case === 'legacy' ? [
      { ...topup, provider: null, paidAt: null, amount: null, amountPaidMinor: null,
        refundSummary: { status: null, refundedMinor: 100, refundedAmount: '1.00' } },
      { ...base, amount: '0.00', amountPaidMinor: 0, productName: null },
    ] : page === 2 ? [{ ...base, productName: 'Earlier Plus', billingReason: 'subscription_create' }]
      : [{ ...base, providerTransactionId: ctx.case === 'invoice-missing' ? null : base.providerTransactionId }, topup, {
        ...base, recordId: 'SUBSCRIPTION_INVOICE:upgrade_fixture', sourceId: 'upgrade_fixture',
        productName: ctx.case === 'narrow' ? 'Historical subscription with a longer saved product name' : 'Super',
        billingReason: 'subscription_update', provider: 'stripe', providerTransactionId: 'pi_upgrade_fixture',
        amount: '40.00', amountPaidMinor: 4000,
        currency: 'usd', refundSummary: { status: 'PARTIALLY_REFUNDED' as const, refundedMinor: 1250, refundedAmount: '12.50' },
      }];
  return (
    <main data-ui-page-subject className="mx-auto w-full max-w-4xl p-5">
      <h3 className="mb-1 text-16 font-medium text-[var(--text-primary)]">{t('billing.orders.title')}</h3>
      <p className="mb-4 text-12 text-[var(--text-secondary)]">{t('billing.orders.description')}</p>
      <OrderHistoryCard
        orders={records} hasMore={page === 1 && records.length > 0} page={page}
        loading={false} error={error}
        onNext={() => setPage(2)} onPrevious={page > 1 ? () => setPage(1) : undefined}
        onRetry={() => setError(false)}
      />
    </main>
  );
}

void mountPage({
  route: '/settings?tab=billing',
  host: {
    billing: {
      getCatalog: async () => ({ products: [] }),
      getCurrentSubscription: async () => ({ subscription: null }),
      getCreditUsage: async () => ({
        available: '20',
        plan: { remaining: '0', used: '0', total: '0' },
        purchased: { remaining: '0', used: '0', total: '0' },
        promotional: { remaining: '20', used: '0', total: '20' },
        promotionalGrants: [], promotionalGrantsComplete: true,
        promotionalGrantConsistency: 'OBSERVED', ledgerUpdatedAt: null,
        scale: 9, observedAt: '2026-11-05T08:00:00.000Z',
      }),
      listPaymentHistory: async () => ({ records: [base, topup], nextCursor: 'earlier_fixture' }),
    },
  },
  render: (ctx) => <Preview ctx={ctx} />,
});
