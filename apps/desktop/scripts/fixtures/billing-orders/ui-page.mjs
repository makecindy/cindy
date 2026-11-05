import assert from 'node:assert/strict';

export default {
  name: 'billing-orders',
  entry: './preview.tsx',
  viewport: { width: 1040, height: 700 },
  real: 'Existing BillingSettingsSection, OrderHistoryCard, BillingRequestDialog, billing money/date formatting and localized strings',
  notCovered: 'Real payment/provider traffic, main/preload IPC, account loading, subscription actions and native mail application',
  cases: {
    default: { about: 'Paid renewal, tax-inclusive top-up and partially refunded upgrade in the existing list' },
    narrow: { about: 'Narrow existing list with long historical product name', viewport: { width: 560, height: 900 } },
    legacy: { about: 'Missing historical payment facts and a zero-paid settled invoice' },
    error: { about: 'Read failure keeps existing rows and offers reload' },
    'invoice-alipay': { about: 'Invoice request shows the Alipay transaction number' },
    'invoice-stripe': { about: 'Invoice request shows the Stripe PaymentIntent ID' },
    'invoice-missing': { about: 'Historical invoice without a saved transaction number' },
    'invoice-narrow': { about: 'Long transaction number in a narrow invoice dialog', viewport: { width: 360, height: 900 } },
    'refund-list': { about: 'Refund and invoice buttons are directly visible on each order row' },
    'refund-list-narrow': { about: 'Both order actions stay visible in a narrow list', viewport: { width: 560, height: 900 } },
    'refund-alipay': { about: 'Refund email dialog for an Alipay subscription invoice' },
    'refund-stripe': { about: 'Refund email dialog for a Stripe top-up' },
    'refund-narrow': { about: 'Refund dialog and long transaction ID at 360px', viewport: { width: 360, height: 900 } },
    'support-footer': { about: 'Clickable feedback email follows order history and pagination in the real billing page' },
    'support-footer-narrow': { about: 'Footer help remains readable at 360px', viewport: { width: 360, height: 900 } },
  },
  async check(page, ui) {
    if (ui.case.startsWith('support-footer')) {
      const next = page.getByRole('button', { name: await ui.t('billing.orders.history.next'), exact: true });
      await next.waitFor();
      const email = page.getByRole('link', { name: 'feedback@cindy.app', exact: true });
      assert.equal(await email.getAttribute('href'), 'mailto:feedback@cindy.app');
      await email.scrollIntoViewIfNeeded();
      const emailBox = await email.boundingBox();
      const paginationBox = await next.boundingBox();
      assert.ok(emailBox.y >= paginationBox.y + paginationBox.height, 'Help follows the complete order list and pagination');
      assert.ok(emailBox.x >= 0 && emailBox.x + emailBox.width <= ui.viewport.width, 'Email stays inside the viewport');
      await ui.capture('support-footer');
    }
    if (ui.case.startsWith('refund-') && !ui.case.startsWith('refund-list')) {
      const index = ui.case === 'refund-stripe' ? 1 : 0;
      await page.getByRole('button', { name: await ui.t('billing.orders.refund.action'), exact: true }).nth(index).click();
      const dialog = page.getByRole('alertdialog');
      assert.equal(await dialog.getByRole('button', { name: 'feedback@cindy.app', exact: true }).count(), 1);
      assert.equal(await dialog.getByText(ui.case === 'refund-stripe' ? 'pi_topup_fixture' : '2026110522001400000000123456', { exact: true }).count(), 1);
      assert.equal(await dialog.getByText(await ui.t('billing.orders.refund.fields.amount'), { exact: true }).count(), 1);
      assert.equal(await dialog.getByText(await ui.t('billing.orders.invoice.personalInvoicePolicy'), { exact: true }).count(), 0);
      await ui.capture('refund-dialog');
    }
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
    if (ui.case === 'default' || ui.case === 'narrow' || ui.case.startsWith('refund-list')) {
      const rows = page.getByRole('listitem');
      for (const row of await rows.all()) {
        const invoice = row.getByRole('button', { name: await ui.t('billing.orders.invoice.action'), exact: true });
        const refund = row.getByRole('button', { name: await ui.t('billing.orders.refund.action'), exact: true });
        assert.equal(await invoice.isVisible(), true);
        assert.equal(await refund.isVisible(), true);
        if (ui.viewport.width >= 1024) {
          const invoiceBox = await invoice.boundingBox();
          const refundBox = await refund.boundingBox();
          assert.equal(invoiceBox.y, refundBox.y, 'Order actions stay on the same desktop line');
        }
      }
      // 用户要求沿用原列表密度：订阅账单不能因商品名、账期而比充值订单更高。
      const heights = await page.getByRole('listitem').evaluateAll((items) =>
        items.map((item) => {
          // divide-y 给首行之后的订单加1px分隔线，只比较内容与内边距。
          const style = getComputedStyle(item);
          return item.getBoundingClientRect().height
            - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
        }));
      assert.equal(heights[0], heights[1], 'Subscription invoices must keep the existing order row height');
      if (ui.viewport.width >= 1024) {
        const columns = await rows.evaluateAll((items) => items.map((item) =>
          [...item.children].filter((element) => element.tagName === 'P')
            .map((element) => element.getBoundingClientRect().x)));
        for (const positions of columns) {
          assert.deepEqual(positions, columns[0], 'Amounts and payment methods stay aligned across order statuses');
        }
      }
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
