import assert from 'node:assert/strict';

export default {
  name: 'provider-share-link',
  entry: './fixture.tsx',
  viewport: { width: 720, height: 600 },
  real: 'ProviderShareLinkDialog, standard Buttons, modal, ToastContainer, translations and themes',
  notCovered: 'Real task persistence, model admission and phone/device-link delivery. All names and link tokens are synthetic.',
  cases: {
    default: { about: 'Ready link with explicit Send to myself action' },
    'save-error': { about: 'Failed message save keeps the dialog and copy action available' },
  },
  async ready(page) {
    await page.getByTestId('provider-share-link-dialog').locator('input').waitFor();
  },
  async check(page, ui) {
    const send = page.getByRole('button', { name: await ui.t('providerShare.link.sendToSelf'), exact: true });
    assert.equal(await send.isEnabled(), true);
    if (ui.case === 'save-error') {
      await send.click();
      await page.getByText(await ui.t('providerShare.link.sendFailed'), { exact: true }).waitFor();
      assert.equal(await send.isEnabled(), true);
      assert.equal(await page.getByRole('button', { name: await ui.t('providerShare.link.copy'), exact: true }).isEnabled(), true);
    }
  },
};
