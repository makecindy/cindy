import assert from 'node:assert/strict';
export default {
  name: 'login-network-response',
  entry: './fixture.tsx',
  viewport: { width: 1040, height: 760 },
  real: 'LoginPage, LoginStage, error controls, theme and localized network response guidance',
  notCovered: 'IPC and transport are replaced by a synthetic 418 login state; full Electron scenario is verified separately',
  stubs: {
    'src/renderer/hooks/useLogin': `export const useLogin = () => ({
      isLoading: false, errorCode: 'INVALID_RESPONSE',
      loginState: { step: 'error', code: 'INVALID_RESPONSE', recoverTo: 'identifier', httpStatus: 418 },
      dispatch: async () => false, dispatchWithResult: async () => ({ success: false, code: 'INVALID_RESPONSE' }),
      clearError: () => {},
    });`,
  },
  cases: { default: { about: '#10617: non-JSON HTTP 418 sign-in failure' } },
  async check(page, ui) {
    assert.equal(await page.getByText('HTTP 418', { exact: true }).count(), 1);
    await page.getByText(await ui.t('login.networkResponseHint'), { exact: true }).waitFor();
    await ui.capture('error-panel', { locator: page.getByTestId('login-panel-error') });
  },
};
