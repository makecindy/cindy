import assert from 'node:assert/strict';

export default {
  name: 'login-signup',
  entry: './fixture.tsx',
  viewport: { width: 1040, height: 760 },
  real: 'LoginPageView, LoginStage, LoginControls (method rows, social row, panel), theme and localized copy for sign-up confirmation',
  notCovered:
    'IPC and the auth server are replaced by a synthetic login state; the confirm-signup action is covered by LoginPage.pr2a.harness.test.tsx, the server flow by cindy-server#1690',
  cases: {
    default: { about: 'Email verified but no account: confirm before creating one', data: { step: 'signup-confirmation', channel: 'email' } },
    'signup-social': { about: 'Google account not registered yet', data: { step: 'signup-confirmation', channel: 'google' } },
    identifier: { about: 'Sign-in entry: no QR login on the computer login page', data: { step: 'identifier' } },
  },
  async check(page, ui) {
    if (ui.case === 'identifier') {
      await page.getByTestId('login-panel-identifier').waitFor();
      // 扫码登录只有「已登录电脑出码、手机扫码」一个方向，电脑登录页不出码。
      assert.equal(await page.getByTestId('login-social-qr').count(), 0);
      return;
    }
    const panel = page.getByTestId('login-panel-signup-confirmation');
    await panel.waitFor();
    await page.getByText(await ui.t('login.signup.title'), { exact: true }).waitFor();
    await page.getByText(await ui.t('login.signup.create'), { exact: true }).waitFor();
    assert.equal(await page.getByTestId('login-signup-qr').count(), 0);
    await ui.capture('panel', { locator: panel });
  },
};
