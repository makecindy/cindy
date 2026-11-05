import assert from 'node:assert/strict';

export default {
  name: 'billing-orders',
  entry: './preview.tsx',
  viewport: { width: 1040, height: 700 },
  real: 'Existing OrderHistoryCard, InvoiceRequestDialog, billing money/date formatting and localized strings',
  notCovered: 'Real payment/provider traffic, main/preload IPC, account loading, current subscription management and native mail application',
  cases: {
    default: { about: 'Paid renewal, tax-inclusive top-up and partially refunded upgrade in the existing list' },
    narrow: { about: 'Narrow existing list with long historical product name', viewport: { width: 560, height: 900 } },
    legacy: { about: 'Missing historical payment facts and a zero-paid settled invoice' },
    error: { about: 'Read failure keeps existing rows and offers reload' },
    'invoice-alipay': { about: 'Invoice request shows the Alipay transaction number' },
    'invoice-stripe': { about: 'Invoice request shows the Stripe PaymentIntent ID' },
    'invoice-missing': { about: 'Historical invoice without a saved transaction number' },
    'invoice-narrow': { about: 'Long transaction number in a narrow invoice dialog', viewport: { width: 360, height: 900 } },
  },
  async check(page, ui) {
    if (ui.case.startsWith('invoice-')) {
      const index = ui.case === 'invoice-stripe' ? 1 : 0;
      await page.getByRole('button', { name: await ui.t('billing.orders.invoice.action'), exact: true }).nth(index).click();
      const dialog = page.getByRole('alertdialog');
      assert.equal(await dialog.getByText(await ui.t('billing.orders.invoice.fields.providerTransactionId'), { exact: true }).count(), 1);
      const transactionId = ui.case === 'invoice-missing' ? await ui.t('billing.orders.invoice.notAvailable')
        : ui.case === 'invoice-stripe' ? 'pi_topup_fixture' : '2026110522001400000000123456';
      assert.equal(await dialog.getByText(transactionId, { exact: true }).count(), 1);
      await ui.capture('invoice-dialog');
    }
    if (ui.case === 'default' || ui.case === 'narrow') {
      // 用户要求沿用原列表密度：订阅账单不能因商品名、账期而比充值订单更高。
      const heights = await page.getByRole('listitem').evaluateAll((items) =>
        items.map((item) => {
          // divide-y 给首行之后的订单加1px分隔线，只比较内容与内边距。
          const style = getComputedStyle(item);
          return item.getBoundingClientRect().height
            - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
        }));
      assert.equal(heights[0], heights[1], 'Subscription invoices must keep the existing order row height');
    }
    if (ui.case === 'default') {
      await page.getByRole('button', { name: await ui.t('billing.orders.history.next'), exact: true }).click();
      assert.equal(await page.getByRole('listitem').count(), 1);
      await ui.capture('earlier-page');
      await page.getByRole('button', { name: await ui.t('billing.orders.history.previous'), exact: true }).click();
      assert.equal(await page.getByRole('listitem').count(), 3);
    }
    if (ui.case === 'error') {
      await page.getByRole('button', { name: await ui.t('billing.orders.history.retry'), exact: true }).click();
      assert.equal(await page.getByRole('alert').count(), 0);
    }
  },
};
