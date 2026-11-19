import assert from 'node:assert/strict';

export default {
  name: 'gift-card-purchase',
  entry: './preview.tsx',
  viewport: { width: 1040, height: 760 },
  real: 'BillingSettingsSection, GiftCardPurchaseDialog, GiftCardPurchasedDialog, PurchasedGiftCardsCard, BillingCheckoutDialog, GiftCardRedeemDialog, money formatting and localized strings',
  notCovered: 'Real payment/provider traffic, main/preload IPC and clipboard permissions, account loading, Alipay QR rendering for CN builds',
  cases: {
    default: { about: 'Buy entry on the balance card, My Gift Cards with every card state, gift card row in order history' },
    buy: { about: 'Purchase dialog with live card preview, two cards stacked, sender and message' },
    limit: { about: 'Purchase dialog when the 24-hour limit is used up' },
    custom: { about: 'Buyer-entered face value: out-of-range hint, then a valid amount on the card preview' },
    email: { about: 'Send a bought card by email from My Gift Cards: recipient and what they receive, then the sending status' },
    pay: { about: 'Existing checkout dialog with the gift card subtitle while waiting for Stripe' },
    done: { about: 'Cards-ready dialog after payment, per-card copy link and more menu' },
    redeem: { about: 'Redeeming a bought card for yourself: top-up balance, never expires' },
  },
  async check(page, ui) {
    const buy = page.getByRole('button', { name: await ui.t('billing.giftCardPurchase.action'), exact: true });
    await buy.waitFor();
    await page.getByText(await ui.t('billing.giftCardPurchase.list.title'), { exact: true }).waitFor();
    if (ui.case === 'default') {
      assert.equal(await page.getByRole('button', { name: await ui.t('billing.giftCardPurchase.actions.copyLink'), exact: true }).count(), 2);
      await ui.capture('section');
      return;
    }
    if (ui.case === 'email') {
      await page.getByRole('button', { name: await ui.t('billing.giftCardPurchase.actions.more'), exact: true }).first().click();
      await page.getByRole('menuitem', { name: await ui.t('billing.giftCardPurchase.actions.sendEmail'), exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByText(await ui.t('billing.giftCardPurchase.email.previewLabel'), { exact: true }).first().waitFor();
      await dialog.getByLabel(await ui.t('billing.giftCardPurchase.email.recipient'), { exact: true }).fill('friend@example.com');
      await ui.capture('email-dialog');
      await dialog.getByRole('button', { name: await ui.t('billing.giftCardPurchase.email.send'), exact: true }).click();
      // 同一句话也出现在提示条里；这里等的是卡片列表里的状态行。
      await page.getByRole('listitem').getByText(await ui.t('billing.giftCardPurchase.email.status.sending', { email: 'friend@example.com' }), { exact: true }).waitFor();
      assert.equal(await page.getByRole('dialog').count(), 0);
      await ui.capture('email-sending');
      return;
    }
    if (ui.case === 'redeem') {
      await page.getByRole('button', { name: await ui.t('billing.giftCardPurchase.actions.more'), exact: true }).first().click();
      await page.getByRole('menuitem', { name: await ui.t('billing.giftCardPurchase.actions.redeemSelf'), exact: true }).click();
      await page.getByText(await ui.t('billing.giftCard.fields.validityPermanent'), { exact: true }).waitFor();
      assert.equal(await page.getByText(await ui.t('billing.giftCard.fields.claimBy'), { exact: true }).count(), 0);
      await ui.capture('redeem-confirm');
      return;
    }
    await buy.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText(await ui.t('billing.giftCardPurchase.previewLabel'), { exact: true }).waitFor();
    if (ui.case === 'limit') {
      assert.equal(await dialog.getByRole('button', { name: await ui.t('billing.giftCardPurchase.pay'), exact: true }).isDisabled(), true);
      await ui.capture('limit');
      return;
    }
    if (ui.case === 'custom') {
      const customLabel = await ui.t('billing.amount.custom');
      await dialog.getByRole('button', { name: customLabel, exact: true }).click();
      const amount = dialog.getByRole('textbox', { name: customLabel, exact: true });
      await amount.fill('5');
      assert.equal(await amount.getAttribute('aria-invalid'), 'true');
      assert.equal(await dialog.getByRole('button', { name: await ui.t('billing.giftCardPurchase.pay'), exact: true }).isDisabled(), true);
      await ui.capture('custom-invalid');
      await amount.fill('75.5');
      await dialog.getByRole('button', { name: await ui.t('billing.giftCardPurchase.increase'), exact: true }).click();
      assert.equal(await dialog.getByRole('button', { name: await ui.t('billing.giftCardPurchase.pay'), exact: true }).isDisabled(), false);
      await ui.capture('custom');
      return;
    }
    await dialog.getByRole('button', { name: await ui.t('billing.giftCardPurchase.faces.cat'), exact: true }).click();
    await dialog.getByRole('button', { name: await ui.t('billing.giftCardPurchase.increase'), exact: true }).click();
    await dialog.getByRole('textbox').last().fill('Happy birthday! Use Cindy more, work late less.');
    if (ui.case === 'buy') {
      await ui.capture('buy');
      return;
    }
    await dialog.getByRole('button', { name: await ui.t('billing.giftCardPurchase.pay'), exact: true }).click();
    if (ui.case === 'pay') {
      await page.getByText(await ui.t('billing.checkout.redirectHint'), { exact: true }).waitFor();
      await ui.capture('pay');
      return;
    }
    await page.getByText(await ui.t('billing.giftCardPurchase.done.description'), { exact: true }).waitFor();
    assert.equal(await page.getByRole('dialog').getByRole('button', { name: await ui.t('billing.giftCardPurchase.actions.copyLink'), exact: true }).count(), 2);
    await ui.capture('done');
  },
};
