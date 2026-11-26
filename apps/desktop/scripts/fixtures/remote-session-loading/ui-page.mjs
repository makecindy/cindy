import assert from 'node:assert/strict';

export default {
  name: 'remote-session-loading',
  entry: './fixture.tsx',
  viewport: { width: 480, height: 200 },
  real: 'RemoteSessionLoading, Spinner and RightSidebarToggle',
  notCovered: 'Remote sync transport and MainLayout action selection; the fixture supplies corner geometry.',
  cases: {
    default: { about: 'Sync status and two right-corner actions', data: { side: 'right', count: 2, width: 300 } },
    'narrow-right': { about: 'Status drops below the actions when the line is too short', data: { side: 'right', count: 2, width: 172, below: true } },
    'narrow-left': { about: 'Left-side controls reserve space in a narrow pane', data: { side: 'left', count: 4, width: 200, below: true } },
    embedded: { about: 'No corner actions in an embedded panel', data: { side: 'right', count: 0, width: 260 } },
  },
  async check(page, ui) {
    const status = page.getByRole('status');
    const label = status.getByText(await ui.t('ccAgent.remoteSession.syncing'), { exact: true });
    const spinner = status.locator('svg');
    const [row, text, icon] = await Promise.all([status.boundingBox(), label.boundingBox(), spinner.boundingBox()]);
    assert.ok(row && text && icon, 'The complete status and spinner must be visible');
    const left = Math.min(text.x, icon.x);
    const right = Math.max(text.x + text.width, icon.x + icon.width);
    const top = Math.min(text.y, icon.y);
    assert.ok(left >= row.x && right <= row.x + row.width, 'The status must fit inside the pane');

    if (!ui.data.count) {
      assert.equal(right, row.x + row.width - 16, 'Embedded status keeps its original right alignment');
      return;
    }
    const actions = await page.locator('[data-corner-actions]').boundingBox();
    assert.ok(actions);
    if (ui.data.below) {
      assert.ok(top >= actions.y + actions.height, 'The status moves below the actions and stays intact');
    } else {
      assert.ok(top < actions.y + actions.height, 'The status stays on the same line when it fits');
      assert.ok(right <= actions.x - 4, 'The sync status must not overlap the right-corner actions');
    }
  },
};
