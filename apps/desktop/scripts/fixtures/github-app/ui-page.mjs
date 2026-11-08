import assert from 'node:assert/strict';
export default {
  name: 'github-app',
  entry: './fixture.tsx',
  viewport: { width: 420, height: 320 },
  real: 'GithubAppCard, Button, ErrorNotice and translated connection text',
  notCovered: 'Live GitHub OAuth, installation and Electron IPC; server and client boundaries have targeted tests',
  cases: {
    default: { about: 'Connect a GitHub identity before selecting repositories', data: {} },
    connected: { about: 'Connected identity and selected repositories', data: { login: 'example-user', repositories: ['example/project'] } },
    missing: { about: 'A followed repository needs installation or access', viewport: { width: 320, height: 440 },
      data: { login: 'example-user', repositories: [], unavailable: ['example/' + 'longrepository'.repeat(7)] } },
    error: { about: 'Connection failure offers retry', data: { failed: true } },
  },
  async ready(page) { await page.locator('[aria-live="polite"] button').first().waitFor(); },
  async check(page, ui) {
    const key = 'ccAgent.gitContext.pr.setup.app.';
    assert.ok(await page.getByText(await ui.t(key + 'title'), { exact: true }).isVisible());
    if (ui.case === 'error') assert.ok(await page.getByRole('alert').isVisible());
    else assert.ok(await page.getByRole('button', { name: await ui.t(key + (ui.data.login ? 'repositories' : 'connect')), exact: true }).isEnabled());
  },
};
