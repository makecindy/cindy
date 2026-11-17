import assert from 'node:assert/strict';

// UI tier: the production connection banner and shared controls, no Host/account.
// Stream parsing and store recovery are verified by the adjacent unit suites.
export default {
  name: 'host-connection', entry: './fixture.tsx',
  viewport: { width: 840, height: 360 },
  real: 'HostConnectionBanner, ErrorNotice, Button, Spinner and translated text',
  notCovered: 'Full application, real authentication, networking or model execution',
  cases: {
    default: { about: 'Disconnected client keeps its page and retries', data: { status: 'disconnected' } },
    'host-pairing': { about: 'Pair again without leaving the editor, at phone width', viewport: { width: 320, height: 420 }, data: { status: 'authorization-required' } },
    'host-restoring': { about: 'Snapshot reconciliation after a restart', data: { status: 'connected', restoring: true } },
    'host-retry': { about: 'Failed read recovery offers retry', data: { status: 'connected', failed: true } },
  },
  async check(page, ui) {
    await page.getByRole('status').waitFor();
    const retry = page.getByRole('button', { name: await ui.t('hostConnection.retry'), exact: true });
    await retry.click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.retried), 'true');
  },
};
