import assert from 'node:assert/strict';
export default {
  name: 'cloud-login',
  authRegion: 'cn',
  entry: './fixture.tsx',
  viewport: { width: 760, height: 720 },
  real: 'CloudLoginWindowLayout/CloudInstanceLoginFlow and shared client LoginPageView/brand/controls, SSO entry and enterprise ID input',
  notCovered:
    'Synthetic admission and cloud IPC; real provider authorization, main process, credential deposit and cloud startup require separate acceptance',
  stubs: {
    'src/renderer/contexts/AuthContext':
      'export const useAuth=()=>({mode:"cloud",isAuthenticated:true,isInitializing:false,canEnterApp:true,dataOwnerId:"fixture-owner",dataOwnerGeneration:1});',
  },
  cases: {
    default: { about: 'Client SMS, WeChat, Apple and SSO entry' },
    windows: { about: 'Auxiliary close controls without main-window shutdown prompts', data: { platform: 'win32' } },
    sso: { about: 'Existing enterprise ID input, without preselecting an organization' },
    code: { about: 'SMS verification in the existing client controls' },
    binding: { about: 'Required contact binding in the existing client controls' },
    verification: { about: 'SSO extra verification remains available' },
  },
  async ready(page) {
    await page.getByTestId('cloud-login-target').waitFor();
  },
  async check(page, ui) {
    if (['default', 'sso'].includes(ui.case)) {
      await page.getByTestId('login-social-sso').waitFor();
      assert.equal(await page.getByTestId('login-social-wechat').count(), 1);
      assert.equal(await page.getByTestId('login-social-apple').count(), 1);
    }
    if (ui.case === 'sso') {
      await page.getByTestId('login-social-sso').click();
      await page.getByTestId('login-sso-org-input').fill('example-enterprise');
      assert.equal(await page.getByTestId('login-sso-org-continue').isEnabled(), true);
      await ui.capture('enterprise-id');
    }
  },
};
