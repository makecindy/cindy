import assert from 'node:assert/strict';

export default {
  name: 'group-external-links',
  entry: './fixture.tsx',
  viewport: { width: 800, height: 900 },
  real: 'Production group message row, MarkdownRenderer link rendering and the inline GitHub chip',
  notCovered: 'Live GitHub API calls (status IPC returns synthetic PR rows) and native Mobile rendering',
  stubs: {
    'src/renderer/contexts/AuthContext': { partial: 'export const useAuth = () => ({ user: { id: "group-links-fixture" } }); export const useOptionalAuthDeviceId = () => undefined;' },
  },
  cases: {
    default: { about: 'GitHub PR / issue / commit / file / repo links and long web links in group messages' },
    narrow: { about: '320px group message', viewport: { width: 320, height: 1400 } },
  },
  async check(page, ui) {
    if (ui.role === 'before') return;
    // PR titles and states arrive from the local status cache once the chips are on screen.
    await page.locator('[data-github-link-chip][data-pr-status="merged"]').waitFor();
    assert.equal(await page.locator('[data-github-link-chip][data-pr-status="open"]').count(), 1);
    // Unknown PR state keeps GitHub's short reference; my own message keeps its text.
    assert.equal(await page.getByText('makecindy/cindy#99001', { exact: true }).count(), 1);
    assert.equal(await page.getByRole('link', { name: 'https://github.com/makecindy/cindy/issues/12001', exact: true }).count(), 1);
    assert.equal(await page.getByRole('link', { name: '设计规范', exact: true }).count(), 1);
    assert.equal(await page.getByText('docs.github.com/en/…/about-pull-request-reviews', { exact: true }).count(), 1);
    assert.equal(await page.getByTestId('bot-group-link-card').count(), 0);
    await ui.capture('statuses');
  },
};
