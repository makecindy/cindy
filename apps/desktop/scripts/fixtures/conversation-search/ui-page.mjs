import assert from 'node:assert/strict';

export default {
  name: 'conversation-search',
  entry: './fixture.tsx',
  viewport: { width: 360, height: 340 },
  real: 'SearchResultsBody, SearchResultRow, SearchResultTaskMenu, SessionTaskMenu, TaskTagDots and theme tokens',
  notCovered: 'Live database search, device-link transport and the mobile native screen',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      partial: 'export const useAuth = () => ({ dataOwnerId: "fixture-owner", isAuthenticated: true }); export const useOptionalAuthDeviceId = () => null; export const useOptionalAuthUser = () => null; export const useOptionalDataOwnerGeneration = () => 0;',
    },
  },
  cases: {
    default: { about: 'Labels beside short/long search titles; untagged and old-host results' },
    'many-tags': { about: '32 tags must not collapse the title or overflow a narrow result', viewport: { width: 260, height: 440 } },
    narrow: { about: 'Labels stay visible in the narrow sidebar', viewport: { width: 260, height: 340 } },
    'context-menu': { about: 'Right-clicking a searched task opens SessionTaskMenu; companion chats stay excluded', viewport: { width: 420, height: 520 } },
  },
  async check(page, ui) {
    if (ui.case === 'context-menu') {
      const companionRow = page.locator('[data-session-id="fixture-companion"]');
      await companionRow.click({ button: 'right', position: { x: 60, y: 16 } });
      assert.equal(await page.getByRole('menu').count(), 0, 'companion canonical chat does not open task menu');

      const taskRow = page.locator('[data-session-id="fixture-0"]');
      await taskRow.click({ button: 'right', position: { x: 80, y: 16 } });
      const menu = page.getByRole('menu');
      await menu.waitFor();
      for (const key of [
        'ccAgent.sidebar.sessionMenu.pin',
        'ccAgent.sidebar.sessionMenu.rename',
        'ccAgent.sidebar.sessionMenu.copySessionLink',
        'ccAgent.sidebar.sessionMenu.openInNewWindow',
        'ccAgent.sidebar.sessionMenu.archived',
        'ccAgent.sidebar.sessionMenu.delete',
      ]) {
        const item = menu.getByRole('menuitem', { name: await ui.t(key), exact: true });
        assert.equal(await item.count(), 1, `task menu shows ${key}`);
      }
      assert.equal(
        await page.locator('body').getAttribute('data-selected-session'),
        null,
        'right-clicking a search result must not trigger navigation',
      );
      return;
    }
    const row = page.locator('[data-session-id="fixture-1"]');
    if (ui.case === 'many-tags') {
      const title = row.locator('span.truncate');
      const box = await title.boundingBox();
      assert(box && box.width >= 96, 'title keeps readable width with 32 tags');
      assert.equal(await row.locator('[aria-label="Tag 31"]').count(), 1);
      const bounds = await row.boundingBox();
      assert(bounds && await row.evaluate(el => el.scrollWidth <= el.clientWidth), 'row does not overflow');
      return;
    }
    for (const name of ['Important', 'Later']) {
      const dot = row.getByLabel(name, { exact: true });
      assert(await dot.isVisible(), `${name} label remains visible`);
      const dotBox = await dot.boundingBox();
      const rowBox = await row.boundingBox();
      assert(dotBox && rowBox && dotBox.x + dotBox.width <= rowBox.x + rowBox.width,
        'labels remain inside the row');
    }
    await row.getByRole('button').click();
    assert.equal(await page.locator('body').getAttribute('data-selected-session'), 'fixture-1');
  },
};
