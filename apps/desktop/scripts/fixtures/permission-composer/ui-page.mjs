import assert from 'node:assert/strict';
import companion from '../companion-composer/ui-page.mjs';
const stubs = { ...companion.stubs };
delete stubs['src/renderer/components/new-chat/PermissionSelector'];
delete stubs['src/renderer/components/new-chat/ExtraDirsButton'];
stubs['src/renderer/hooks/useAgentCapabilities'] = {
  partial: `export const useAgentCapabilities = () => ({ loading: false, capabilities: {
    hasFastMode: false, availableModels: [], effortLevels: [],
    permissionModes: ['ask', 'acceptEdits', 'auto', 'bypassPermissions'].map(id => ({ id, displayName: id }))
  } });`,
};
export default {
  name: 'permission-composer', entry: './fixture.tsx', viewport: { width: 760, height: 420 },
  real: 'ChatInput, ExtraDirsButton and PermissionSelector, real tooltips and permission menu, themes and translations',
  notCovered: 'Live task persistence and execution; model catalog, capabilities and voice input use scenario data',
  stubs,
  cases: {
    default: { about: 'Existing task uses a quiet icon beside the attachment button' },
    'new-task': { about: 'New task keeps the complete permission label' },
    narrow: { about: 'Existing task in narrow desktop pane', viewport: { width: 390, height: 420 } },
  },
  async check(page, ui) {
    const label = await ui.t('newChat.permissionSelector.modes.claude-code.bypassPermissions.label');
    const button = page.getByRole('button', { name: await ui.t('newChat.permissionSelector.triggerAria', { label }), exact: true });
    await button.waitFor();
    assert.equal((await button.textContent()).trim(), ui.case === 'new-task' ? label : '');
    if (ui.case !== 'new-task') {
      const plus = await page.locator('[data-composer-suggestion-trigger]').boundingBox();
      const permission = await button.boundingBox();
      const mic = await page.locator('button').filter({ has: page.locator('svg.lucide-mic') }).boundingBox();
      const send = await page.getByRole('button', { name: await ui.t('newChat.sendButton.send'), exact: true }).boundingBox();
      const leftSpacing = permission.x + permission.width / 2 - plus.x - plus.width / 2;
      const rightSpacing = send.x + send.width / 2 - mic.x - mic.width / 2;
      assert.ok(Math.abs(leftSpacing - (rightSpacing - 4)) < 0.5, `Button spacing: left=${leftSpacing}, right=${rightSpacing}`);
    }
    await ui.capture('collapsed');
    if (ui.case !== 'new-task') {
      // Regression: the permission icon used a soft fill without the + button's border.
      // Compare actual painted styles after each real hover, in both themes.
      const paint = (element) => {
        const style = getComputedStyle(element);
        return [style.backgroundColor, style.borderTopColor, style.color];
      };
      const plusButton = page.locator('[data-composer-suggestion-trigger]');
      await plusButton.hover();
      await ui.capture('plus-hover');
      const plusPaint = await plusButton.evaluate(paint);
      await button.hover();
      await ui.capture('permission-hover');
      assert.deepEqual(await button.evaluate(paint), plusPaint, 'Permission and + hover paint must match');
    }
    await button.click();
    await page.getByRole('listbox').waitFor();
    assert.equal(await page.getByRole('option').count(), 4);
    await ui.capture('menu');
    await page.keyboard.press('Escape');
  },
};
