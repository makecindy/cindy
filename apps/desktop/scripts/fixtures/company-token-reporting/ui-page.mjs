import assert from 'node:assert/strict';

export default {
  name: 'company-token-reporting',
  entry: './view.tsx',
  viewport: { width: 520, height: 180 },
  real: 'Company statistics settings, switch, copy and themes',
  notCovered: 'Server policy, authentication and network transport',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({isAuthenticated:true,mode:"cloud",user:{orgId:"fixture",membershipKind:"org"},dataOwnerGeneration:1});',
  },
  cases: { default: { about: 'Enterprise account with reporting enabled' } },
  async ready(page) { await page.getByRole('switch').waitFor(); },
  async check(page) {
    const toggle = page.getByRole('switch');
    assert.equal(await toggle.isChecked(), true);
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('[role=switch]')?.getAttribute('aria-checked') === 'false');
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('[role=switch]')?.getAttribute('aria-checked') === 'true');
  },
};
