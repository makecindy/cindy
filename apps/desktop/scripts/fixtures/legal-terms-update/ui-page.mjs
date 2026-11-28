import assert from 'node:assert/strict';

export default {
  name: 'legal-terms-update',
  entry: './fixture.tsx',
  viewport: { width: 1040, height: 680 },
  real: 'LegalTermsUpdateGate, PendingInputBlocker, shared modal scrim/panel and localized strings',
  notCovered: 'Main-process consent records, sign-out after declining, the update notice deferral in MainLayout',
  stubs: {
    'src/renderer/contexts/AuthContext':
      'export const useAuth = () => ({ mode: "cloud", user: { membershipKind: "personal" }, isInitializing: false, logout: async () => {} });',
  },
  cases: {
    default: { about: 'An existing personal account must agree to the updated Terms of Service and Privacy Policy before using Cindy' },
    narrow: { about: 'The confirmation at a narrow window width', viewport: { width: 420, height: 640 } },
  },
  async ready(page) {
    await page.getByRole('alertdialog').waitFor();
  },
  async check(page, ui) {
    const dialog = page.getByRole('alertdialog');
    await dialog.getByText(await ui.t('legalTermsUpdate.title'), { exact: true }).waitFor();
    const agree = dialog.getByRole('button', { name: await ui.t('legalTermsUpdate.agree'), exact: true });
    assert.equal(await agree.evaluate((el) => el === document.activeElement), true);
    await ui.capture('confirm');
    await agree.click();
    await dialog.waitFor({ state: 'hidden' });
    await ui.capture('after-agree');
  },
};
