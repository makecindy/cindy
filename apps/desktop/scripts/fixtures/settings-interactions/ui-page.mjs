export default {
  name: 'settings-interactions', entry: './fixture.tsx', viewport: { width: 560, height: 360 },
  real: 'SettingsLinkChip, PluginSetupPrompt and RemoteOauthSetupCard with production theme and translations',
  notCovered: 'Preview-only plugin identity and state. No authorization, navigation or credentials are submitted. Narrow desktop cards are not native mobile screenshots.',
  cases: {
    settings: { about: 'Device-bound settings entries', viewport: { width: 560, height: 210 } },
    default: { about: 'Native account connection button' },
    waiting: { about: 'Waiting for browser authorization' },
    secret: { about: 'Protected manual credential entry', viewport: { width: 560, height: 420 } },
    'remote-settings': { about: 'Unsupported remote setup action offers the existing remote desktop', viewport: { width: 560, height: 440 } },
    connected: { about: 'Connection completed' },
    retry: { about: 'Failed authorization can be retried' },
    narrow: { about: 'Remote desktop card at phone-column width, not native mobile', viewport: { width: 320, height: 400 } },
  },
  async check(page, ui) { await ui.capture('card', { locator: page.locator('[data-ui-page-subject]') }); },
  async ready(page) { await page.locator('[data-ui-page-subject]').waitFor(); },
};
