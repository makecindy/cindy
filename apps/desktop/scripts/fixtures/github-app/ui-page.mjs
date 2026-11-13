import assert from 'node:assert/strict';
export default {
  name: 'github-app',
  entry: './fixture.tsx',
  viewport: { width: 420, height: 320 },
  real: 'GithubAppCard, Button, ErrorNotice and translated connection text',
  notCovered: 'Live GitHub OAuth, installation and Electron IPC; server and client boundaries have targeted tests',
  cases: {
    loading: { about: 'Initial status check does not offer reconnect', data: { loading: true } },
    default: { about: 'Connect a GitHub identity before selecting repositories', data: {} },
    connected: { about: 'Connected identity and selected repositories', data: { login: 'example-user', repositories: ['example/project'] } },
    missing: { about: 'A followed repository needs installation or access', viewport: { width: 320, height: 440 },
      data: { login: 'example-user', repositories: [], unavailable: ['example/' + 'longrepository'.repeat(7)] } },
    error: { about: 'Connection failure offers retry', data: { failed: true } },
    'failed-refresh': { about: 'A failed check must not offer connection from an outdated snapshot', data: { failRefresh: true } },
  },
  async ready(page) { await page.locator('[aria-live="polite"]').waitFor(); },
  async check(page, ui) {
    const key = 'ccAgent.gitContext.pr.setup.app.';
    assert.ok(await page.getByText(await ui.t(key + 'title'), { exact: true }).isVisible());
    if (ui.case === 'failed-refresh') {
      await page.getByRole('button', { name: await ui.t(key + 'connect'), exact: true }).waitFor();
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.getByRole('alert').waitFor();
      assert.equal(await page.getByRole('button', { name: await ui.t(key + 'connect'), exact: true }).count(), 0);
      return;
    }
    if (ui.case === 'loading') {
      assert.ok(await page.getByRole('status').isVisible());
      assert.equal(await page.getByRole('button').count(), 0);
    } else if (ui.case === 'error') {
      assert.ok(await page.getByRole('alert').isVisible());
      assert.equal(await page.getByRole('button', { name: await ui.t(key + 'connect'), exact: true }).count(), 0);
    }
    else assert.ok(await page.getByRole('button', { name: await ui.t(key + (ui.data.login ? 'repositories' : 'connect')), exact: true }).isEnabled());
  },
};
