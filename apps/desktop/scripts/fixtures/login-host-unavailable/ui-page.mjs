import assert from 'node:assert/strict';

const REASONS = [
  'HOST_PROFILE_IN_USE_BY_DESKTOP',
  'HOST_ACCOUNT_MISMATCH',
  'HOST_DATABASE_LOCKED',
  'HOST_DATABASE_UNAVAILABLE',
  'HOST_SIGN_IN_SERVICE_UNREACHABLE',
  'HOST_START_FAILED',
];

export default {
  name: 'login-host-unavailable',
  entry: './fixture.tsx',
  viewport: { width: 1040, height: 760 },
  real: 'LoginPage, LoginStage, the error panel for a Host that did not start, and its localized reasons',
  notCovered: 'The Host auth state and the window refusal are replaced by a synthetic reason; their behaviour is covered by vitest',
  stubs: {
    'src/renderer/hooks/useLogin': `export const useLogin = () => ({
      isLoading: false, errorCode: null, loginState: { step: 'entry' },
      hostUnavailableReason: window.__uiPage.ctx.data.reason,
      dispatch: async () => false, dispatchWithResult: async () => ({ success: false, code: null }),
      clearError: () => {},
    });`,
  },
  // `default` is the longest copy (the database case); every other reason is its own case.
  cases: Object.fromEntries(REASONS.map(reason => [
    reason === 'HOST_DATABASE_UNAVAILABLE' ? 'default' : reason.toLowerCase().replaceAll('_', '-'),
    { about: `The Host did not start: ${reason}`, data: { reason } },
  ])),
  async check(page, ui) {
    const panel = page.getByTestId('login-panel-host-unavailable');
    await panel.waitFor();
    await page.getByText(await ui.t('login.hostUnavailable.title'), { exact: true }).waitFor();
    assert.equal(await page.getByTestId('login-skip-entry').count(), 0);
    assert.equal(await page.getByTestId('login-local-mode').count(), 0);
    // No action under the text: the panel lays out with its title and body only.
    assert.equal(await panel.getByRole('button').count(), 0);
    await ui.capture('panel', { locator: panel });
  },
};
