// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
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

  it('submits a Product with one alternative Offer directly', () => {
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

    const proProduct = screen
      .getAllByText('Pro')
      .map((element) => element.closest('button'))
      .find((button): button is HTMLButtonElement => button !== null)!;
    expect(proProduct).toHaveProperty('disabled', false);
    fireEvent.click(proProduct);
    expect(onSelect).toHaveBeenCalledWith(candidates[0]);
  });

  it('defaults to the first Offer in server order and lets the user switch before submitting', () => {
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

    fireEvent.click(screen.getByText('Max').closest('button')!);

    const firstOffer = screen.getByText('$20.00').closest('button')!;
    const secondOffer = screen.getByText('$200.00').closest('button')!;
    expect(screen.queryByText('max_month')).toBeNull();
    expect(screen.queryByText('max_month_more')).toBeNull();
    expect(firstOffer.getAttribute('aria-pressed')).toBe('true');
    expect(secondOffer.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('billing.planChange.back').closest('button')).toBeTruthy();

    const submitButton = screen
      .getByText('billing.settings.subscriptionCard.changeAction')
      .closest('button')!;
    expect(submitButton.className).toContain('bg-[var(--accent-cta-bg)]');
    expect(submitButton.className).toContain('text-[var(--accent-pure-cta-fg)]');

    fireEvent.click(secondOffer);
    fireEvent.click(submitButton);
    expect(onSelect).toHaveBeenCalledWith(candidates[2]);
  });

  it('returns to the Product list when the selected Product disappears', async () => {
    const view = render(
      <PlanChangeTargetDialog
        open
        currentPlan={currentPlan}
        candidates={candidates}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Max').closest('button')!);
    expect(screen.getByText('$200.00')).toBeTruthy();

    view.rerender(
      <PlanChangeTargetDialog
        open
        currentPlan={currentPlan}
        candidates={[candidates[0]]}
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(await screen.findByText('billing.planChange.targetTitle')).toBeTruthy();
    const proProduct = screen
      .getAllByText('Pro')
      .map((element) => element.closest('button'))
      .find((button): button is HTMLButtonElement => button !== null)!;
    expect(proProduct).toHaveProperty('disabled', false);
    expect(screen.queryByLabelText('settings.back')).toBeNull();
  });
});
