// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string, params?: Record<string, string>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));
vi.mock('qrcode', () => ({
  toDataURL: vi.fn(async () => 'data:image/png;base64,fixture'),
}));

import * as QRCode from 'qrcode';
import {
  PlanChangeStatusDialog,
  PlanChangeTargetDialog,
  type PlanChangeCandidate,
} from '../PlanChangeDialog';
import type { PlanChangeState } from '../usePlanChange';
import { PlanComparison } from '../PlanComparison';

function quoteReadyState(overrides: Partial<PlanChangeState> = {}): PlanChangeState {
  return {
    open: true,
    phase: 'QUOTE_READY',
    planChange: {
      planChangeId: 'plan_change_1',
      changeType: 'UPGRADE',
      status: 'QUOTED',
      quotedAmountMinor: 1500,
      quotedCurrency: 'cny',
      quoteExpiresAt: '2099-01-01T00:00:00.000Z',
      effectiveAt: '2026-08-01T00:00:00.000Z',
      paymentAction: null,
    },
    targetPlan: null,
    error: false,
    quoteFailureReason: null,
    stale: false,
    ...overrides,
  };
}

describe('PlanChangeStatusDialog stale snapshot handling', () => {
  it('renders a logo QR code with high error correction while awaiting Alipay payment', async () => {
    const paymentAction = {
      type: 'QR_CODE' as const,
      value: 'https://u.alipay.cn/fixture',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const quoted = quoteReadyState().planChange!;
    render(
      <PlanChangeStatusDialog
        state={quoteReadyState({
          phase: 'AWAITING_PAYMENT',
          planChange: { ...quoted, status: 'AWAITING_PAYMENT', paymentAction },
        })}
        targetName={null}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        onRefresh={vi.fn()}
        onReselect={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );

    const qrCode = await screen.findByAltText('billing.checkout.qrAlt');
    expect(qrCode.parentElement?.querySelectorAll('img')).toHaveLength(2);
    expect(vi.mocked(QRCode.toDataURL)).toHaveBeenCalledWith(
      paymentAction.value,
      expect.objectContaining({ errorCorrectionLevel: 'H', margin: 4, width: 320 }),
    );
  });

  it('lets a fresh quote be confirmed or abandoned', () => {
    render(
      <PlanChangeStatusDialog
        state={quoteReadyState()}
        targetName={null}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        onRefresh={vi.fn()}
        onReselect={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );

    expect(screen.getByText('billing.planChange.confirm')).toBeTruthy();
    expect(screen.getByText('billing.planChange.abandon')).toBeTruthy();
    expect(screen.queryByText('billing.actions.refresh')).toBeNull();
  });

  it('never offers confirm or abandon on a stale snapshot, only resync', () => {
    const onRefresh = vi.fn();
    render(
      <PlanChangeStatusDialog
        state={quoteReadyState({ error: true, stale: true })}
        targetName={null}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        onRefresh={onRefresh}
        onReselect={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );

    expect(screen.queryByText('billing.planChange.confirm')).toBeNull();
    expect(screen.queryByText('billing.planChange.abandon')).toBeNull();
    expect(screen.getByText('billing.planChange.resyncHint')).toBeTruthy();

    fireEvent.click(screen.getByText('billing.actions.refresh'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows provider-pending progress without offering another confirm', () => {
    const onRefresh = vi.fn();
    render(
      <PlanChangeStatusDialog
        state={quoteReadyState({
          phase: 'PENDING_PROVIDER',
          planChange: {
            ...quoteReadyState().planChange!,
            status: 'PENDING_PROVIDER',
          },
        })}
        targetName={null}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        onRefresh={onRefresh}
        onReselect={vi.fn()}
        onAbandon={vi.fn()}
      />,
    );

    expect(screen.getByText('billing.planChange.pendingProviderTitle')).toBeTruthy();
    expect(screen.getByText('billing.planChange.pendingProviderBody')).toBeTruthy();
    expect(screen.queryByText('billing.planChange.confirm')).toBeNull();
    expect(screen.queryByText('billing.planChange.abandon')).toBeNull();

    fireEvent.click(screen.getByText('billing.actions.refresh'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('explains a rejected target and returns to plan selection', () => {
    const onReselect = vi.fn();
    render(
      <PlanChangeStatusDialog
        state={quoteReadyState({
          phase: 'FAILED',
          planChange: null,
          error: true,
          quoteFailureReason: 'TARGET_NOT_ALLOWED',
        })}
        targetName="Max"
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        onRefresh={vi.fn()}
        onReselect={onReselect}
        onAbandon={vi.fn()}
      />,
    );

    expect(screen.getByText('billing.planChange.quoteRejected')).toBeTruthy();
    fireEvent.click(screen.getByText('billing.planChange.chooseAnotherPlan'));
    expect(onReselect).toHaveBeenCalledTimes(1);
  });
});

describe('PlanChangeTargetDialog product-first selection', () => {
  const currentPlan: PlanChangeCandidate = {
    product: {
      code: 'pro',
      name: 'Pro',
      kind: 'SUBSCRIPTION',
      level: 1,
      sortOrder: 1,
      offers: [],
    },
    offer: {
      code: 'pro_month',
      interval: 'MONTH',
      currency: 'usd',
      amount: '9',
      minAmount: null,
      maxAmount: null,
      creditAmount: '100',
      rolloverCap: '0',
      purchaseOptions: [],
    },
    providers: ['stripe'],
    direction: null,
  };

  const candidates: PlanChangeCandidate[] = [
    {
      ...currentPlan,
      offer: {
        ...currentPlan.offer,
        code: 'pro_month_more',
        amount: '20',
        creditAmount: '250',
      },
      direction: 'SAME_LEVEL',
    },
    {
      product: {
        code: 'max',
        name: 'Max',
        kind: 'SUBSCRIPTION',
        level: 2,
        sortOrder: 2,
        offers: [],
      },
      offer: {
        code: 'max_month',
        interval: 'MONTH',
        currency: 'usd',
        amount: '20',
        minAmount: null,
        maxAmount: null,
        creditAmount: '250',
        rolloverCap: '0',
        purchaseOptions: [],
      },
      providers: ['stripe'],
      direction: 'UPGRADE',
    },
    {
      product: {
        code: 'max',
        name: 'Max',
        kind: 'SUBSCRIPTION',
        level: 2,
        sortOrder: 2,
        offers: [],
      },
      offer: {
        code: 'max_month_more',
        interval: 'MONTH',
        currency: 'usd',
        amount: '200',
        minAmount: null,
        maxAmount: null,
        creditAmount: '3000',
        rolloverCap: '0',
        purchaseOptions: [],
      },
      providers: ['stripe'],
      direction: 'UPGRADE',
    },
  ];

  it('keeps the current plan disabled without a price selector', () => {
    const onSelect = vi.fn();
    render(
      <PlanChangeTargetDialog
        open
        currentPlan={currentPlan}
        candidates={candidates.slice(1)}
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole('button', { name: 'billing.catalog.currentPlan' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    const modelLinks = screen.getAllByRole('link', { name: 'billing.comparison.advancedModels' });
    expect(modelLinks).toHaveLength(2);
    for (const link of modelLinks) {
      expect(link.getAttribute('href')).toBe('#/settings?tab=providers&connect=xd');
    }
    fireEvent.click(screen.getByRole('button', { name: 'billing.catalog.currentPlan' }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps alternative server offers selectable after the plan action without a dropdown', () => {
    const onSelect = vi.fn();
    render(
      <PlanChangeTargetDialog
        open
        currentPlan={currentPlan}
        candidates={candidates}
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText('max_month_more')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /billing.comparison.upgrade.*Max/ }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText('max_month_more')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /\$200\.00/ }));
    expect(onSelect).toHaveBeenCalledWith(candidates[2]);
  });

  it('keeps the current contract as the action instead of offering unsupported same-level changes', () => {
    const onSelect = vi.fn();
    render(
      <PlanChangeTargetDialog
        open
        currentPlan={currentPlan}
        candidates={candidates.map((candidate) =>
          candidate.direction === 'SAME_LEVEL' ? { ...candidate, available: false } : candidate,
        )}
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText('$9.00')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'billing.catalog.currentPlan' });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(button);
    expect(onSelect).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'billing.settings.subscriptionCard.changeAction' }),
    ).toBeNull();
  });

  it('uses the current offer action even when a cheaper offer is displayed', () => {
    const onSelect = vi.fn();
    render(
      <PlanComparison
        plans={[
          {
            product: currentPlan.product,
            defaultOfferCode: 'cheaper',
            offers: [
              {
                offer: { ...currentPlan.offer, code: 'cheaper', amount: '1' },
                action: 'Select',
                onSelect,
              },
              { offer: currentPlan.offer, current: true, action: 'Current', onSelect },
            ],
          },
        ]}
        freeAction="Top up"
        onViewModels={vi.fn()}
        onFreeAction={vi.fn()}
      />,
    );
    expect(screen.getByText('$1.00')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Current' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Select' })).toBeNull();
  });

  it('links model access to Cindy AI and closes the purchase comparison', () => {
    const onViewModels = vi.fn();
    render(
      <PlanComparison
        plans={[
          {
            product: currentPlan.product,
            defaultOfferCode: currentPlan.offer.code,
            offers: [{ offer: currentPlan.offer, action: 'Select', onSelect: vi.fn() }],
          },
        ]}
        freeAction="Top up"
        onViewModels={onViewModels}
        onFreeAction={vi.fn()}
      />,
    );
    const link = screen.getByRole('link', { name: 'billing.comparison.advancedModels' });
    expect(link.getAttribute('href')).toBe('#/settings?tab=providers&connect=xd');
    fireEvent.click(link);
    expect(onViewModels).toHaveBeenCalledOnce();
  });

  it('uses the remaining server Offer when the default Offer disappears', () => {
    const onSelect = vi.fn();
    const view = render(
      <PlanChangeTargetDialog
        open
        currentPlan={currentPlan}
        candidates={candidates}
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    view.rerender(
      <PlanChangeTargetDialog
        open
        currentPlan={currentPlan}
        candidates={[candidates[0], candidates[2]]}
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /billing.comparison.upgrade.*Max/ }));
    expect(onSelect).toHaveBeenCalledWith(candidates[2]);
  });

  it.each(['OFFER_COMING_SOON', 'NO_AVAILABLE_PAYMENT_CHANNEL'] as const)(
    'preserves the server unavailable reason %s in plan comparison',
    (unavailableReason) => {
      const onSelect = vi.fn();
      render(
        <PlanChangeTargetDialog
          open
          currentPlan={currentPlan}
          candidates={[{ ...candidates[1], available: false, unavailableReason }]}
          onClose={vi.fn()}
          onSelect={onSelect}
        />,
      );
      expect(
        screen.getByText(`billing.catalog.unavailableReasons.${unavailableReason}`),
      ).toBeTruthy();
      expect(screen.getByText('billing.planChange.emptyTitle')).toBeTruthy();
      const button = screen.getByRole('button', {
        name: `billing.catalog.unavailableReasons.${unavailableReason}`,
      });
      expect(button).toHaveProperty('disabled', true);
      fireEvent.click(button);
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it.each([
    { amounts: ['90', '100'], from: true },
    { amounts: ['100', '100'], from: false },
  ])('summarizes available target prices $amounts', ({ amounts, from }) => {
    const onSelect = vi.fn();
    const offers = [candidates[1], candidates[2]].map((candidate, index) => ({
      ...candidate,
      offer: { ...candidate.offer, amount: amounts[index] },
    }));
    render(
      <PlanChangeTargetDialog
        open
        currentPlan={currentPlan}
        candidates={[...offers].reverse()}
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    );
    expect(Boolean(screen.queryByText('billing.comparison.priceFromSuffix'))).toBe(from);
    fireEvent.click(screen.getByRole('button', { name: /billing.comparison.upgrade.*Max/ }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: /billing.providers.stripe/ })).toHaveLength(2);
  });

  it('excludes unavailable lower prices and keeps the target stable while refreshing', () => {
    const onSelect = vi.fn();
    const offers = [{ ...candidates[1], available: false }, candidates[2]];
    const view = render(
      <PlanChangeTargetDialog
        open
        currentPlan={currentPlan}
        candidates={offers}
        onClose={vi.fn()}
        onSelect={onSelect}
        disabled
      />,
    );
    expect(screen.getByText('$200.00')).toBeTruthy();
    expect(screen.queryByText('billing.comparison.priceFromSuffix')).toBeNull();
    expect(screen.getByRole('button', { name: /billing.comparison.upgrade.*Max/ })).toHaveProperty(
      'disabled',
      true,
    );
    view.rerender(
      <PlanChangeTargetDialog
        open
        currentPlan={currentPlan}
        candidates={offers}
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /billing.comparison.upgrade.*Max/ }));
    expect(onSelect).toHaveBeenCalledWith(candidates[2]);
  });

  it('defaults to an available offer when the first offer in a target product is unavailable', () => {
    const onSelect = vi.fn();
    render(
      <PlanChangeTargetDialog
        open
        currentPlan={currentPlan}
        candidates={[{ ...candidates[1], available: false }, candidates[2]]}
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    );
    const button = screen.getByRole('button', { name: /billing.comparison.upgrade.*Max/ });
    expect(button).toHaveProperty('disabled', false);
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith(candidates[2]);
  });

  it('disables topup during catalog refresh and re-enables it when ready', () => {
    const onSelect = vi.fn();
    const onTopup = vi.fn();
    const view = render(
      <PlanChangeTargetDialog
        open
        currentPlan={currentPlan}
        candidates={[candidates[1]]}
        onClose={vi.fn()}
        onSelect={onSelect}
        onTopup={onTopup}
        topupDisabled
        disabled
      />,
    );
    const button = screen.getByRole('button', { name: /billing.comparison.upgrade.*Max/ });
    expect(button).toHaveProperty('disabled', true);
    expect(button.hasAttribute('aria-pressed')).toBe(false);
    expect(button.className).not.toContain('accent-cta');
    const free = screen.getByRole('button', { name: 'billing.comparison.topup' });
    expect(free).toHaveProperty('disabled', true);
    fireEvent.click(button);
    fireEvent.click(free);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onTopup).not.toHaveBeenCalled();
    view.rerender(
      <PlanChangeTargetDialog
        open
        currentPlan={currentPlan}
        candidates={[]}
        onClose={vi.fn()}
        onSelect={onSelect}
        onTopup={onTopup}
      />,
    );
    expect(screen.getByRole('button', { name: 'billing.comparison.topup' })).toHaveProperty(
      'disabled',
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'billing.comparison.topup' }));
    expect(onTopup).toHaveBeenCalledOnce();
  });

  it('keeps unavailable plans visible without quoting and routes FREE to topup', () => {
    const onSelect = vi.fn();
    const onTopup = vi.fn();
    render(
      <PlanChangeTargetDialog
        open
        currentPlan={currentPlan}
        candidates={[{ ...candidates[1], available: false }]}
        onClose={vi.fn()}
        onSelect={onSelect}
        onTopup={onTopup}
      />,
    );
    const upgrade = screen.getByRole('button', { name: 'billing.comparison.changeUnavailable' });
    expect(upgrade).toHaveProperty('disabled', true);
    fireEvent.click(upgrade);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'billing.comparison.topup' }));
    expect(onTopup).toHaveBeenCalledOnce();
  });
});
