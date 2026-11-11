import assert from 'node:assert/strict';
export default {
  name: 'automation-unread',
  entry: './fixture.tsx',
  viewport: { width: 360, height: 640 },
  real: 'AutomationSessionGroupItem, SessionItem, automationSidebarGrouping',
  notCovered: 'Scheduler delivery, persisted read state, full sidebar ancestors and remote devices',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      partial: 'export const useAuth = () => ({dataOwnerId: "fixture", isAuthenticated: false});',
    },
  },
  cases: {
    demo: {
      about: 'Interactive task sidebar preview with reading and reset controls',
      viewport: { width: 960, height: 640 },
    },
    default: { about: 'Expanded history includes the header task; collapsed unread rows exclude it' },
  },
  async check(page, ui) {
    for (let i = 1; i <= 6; i++)
      assert.equal(await page.locator(`[data-session-id="run-${i}"]`).count(), 1);
    assert.equal(await page.locator('[data-session-id="run-0"]').count(), 0);
    assert.equal(await page.getByText('已读结果', { exact: true }).count(), 0);
    await page
      .getByRole('button', {
        name: await ui.t('ccAgent.sidebar.automationGroup.expand', { title: '每日巡检' }),
        exact: true,
      })
      .click();
    await page.locator('[data-session-id="run-7"]').waitFor();
    assert.equal(await page.locator('[data-session-id="run-0"]').count(), 1);
    assert.equal(await page.locator('[data-sidebar-session-row="true"]').count(), 8);
    await ui.capture('expanded-all-runs');
    await page
      .getByRole('button', {
        name: await ui.t('ccAgent.sidebar.automationGroup.collapse', { title: '每日巡检' }),
        exact: true,
      })
      .click();
    await page.locator('[data-session-id="run-7"]').waitFor({ state: 'detached' });
    assert.equal(await page.locator('[data-session-id="run-0"]').count(), 0);
    await page.locator('[data-session-id="run-6"]').click();
    await page.locator('[data-session-id="run-6"]').waitFor({ state: 'detached' });
  },
};
