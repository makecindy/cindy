import assert from 'node:assert/strict';

export default {
  name: 'gamepad-settings',
  entry: './gamepad-settings-fixture.tsx',
  viewport: { width: 800, height: 1500 },
  real: 'XboxGamepadSettings, WorkLouderCodexSettings, SettingsCard, SettingsRow, SettingsSection, Select, Switch, themes and translations',
  notCovered: 'Real devices, input monitoring, saving and the Codex guard; hooks supply one connected device with default settings',
  stubs: {
    'src/renderer/hooks/useXboxGamepad': './stubs.ts',
    'src/renderer/hooks/useWorkLouderCodex': './stubs.ts',
    'src/renderer/hooks/useCodexMicroGuard': './stubs.ts',
    'src/renderer/features/skillhub/hooks/useSkillhub': './stubs.ts',
  },
  cases: {
    default: { about: 'Connected Xbox controller with default bindings' },
    worklouder: { about: 'Connected Codex Micro keyboard with default settings; sections use the shared rows' },
  },
  async check(page, ui) {
    // Settings page rows: 13px/500 names, 16px section titles, dividers on the settings card border token.
    if (ui.case === 'worklouder') {
      const row = await page.getByText(await ui.t('settings.shortcuts.workLouderCodex.agentKeys.singleTap.label'), { exact: true }).evaluate((el) => {
        const row = el.closest('.relative');
        const style = getComputedStyle(el.parentElement);
        const probe = document.createElement('i');
        probe.style.color = 'var(--settings-theme-card-border)';
        document.body.append(probe);
        const border = getComputedStyle(probe).color;
        probe.remove();
        return { size: style.fontSize, weight: style.fontWeight, divider: getComputedStyle(row, '::before').backgroundColor, border };
      });
      const title = await page.getByRole('heading', { name: await ui.t('settings.shortcuts.workLouderCodex.agentKeys.title') }).evaluate((el) => getComputedStyle(el).fontSize);
      assert.deepEqual([row.size, row.weight, title], ['13px', '500', '16px']);
      assert.equal(row.divider, row.border, 'Row divider uses --settings-theme-card-border');
    }
    // Rows in an editor dialog sit flush with its padding and keep their dividers.
    const opener = ui.case === 'worklouder'
      ? page.getByRole('button', { name: /AG02/ })
      : page.getByRole('button', { name: await ui.t('settings.shortcuts.xboxGamepad.familyControls.xbox.leftStick') }).first();
    await opener.click();
    await page.getByRole('dialog').waitFor();
    await page.waitForTimeout(300);
    await ui.capture('editor');
  },
};
