export default {
  name: 'agent-island-settings',
  entry: './island-fixture.tsx',
  viewport: { width: 900, height: 640 },
  real: 'AgentIslandSection, useAgentIslandSettings, Switch',
  notCovered: 'Native macOS window, IPC authorization, actual notification delivery and sound',
  cases: {
    default: { about: 'Existing automatic cards remain the default' },
    subtle: { about: 'Subtle reminders enabled' },
  },
  async check(page, ui) {
    const toggle = page.getByRole('switch', { name: await ui.t('settings.agentIsland.subtleRemindersLabel'), exact: true });
    const before = await toggle.getAttribute('aria-checked');
    await toggle.click();
    await page.waitForFunction(expected => globalThis.localStorage.getItem('notifications.agentIslandSubtleReminders') === expected,
      String(before !== 'true'));
    if (await toggle.getAttribute('aria-checked') === before) throw new Error('Reminder switch did not update');
    await ui.capture('toggled');
    await page.getByRole('button', { name: await ui.t('settings.defaults.restore'), exact: true }).click();
    await page.waitForFunction(() => globalThis.localStorage.getItem('notifications.agentIslandSubtleReminders') === null);
    if (await toggle.getAttribute('aria-checked') !== 'false') throw new Error('Reminder reset did not restore the default');
    await ui.capture('reset');
    const complete = page.locator('#agent-island-sound-complete');
    const card = page.locator('#settings-search-settings-agentIsland-soundLabel').locator('..').locator('..').locator('..');
    await complete.selectOption('none');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('notifications.agentIslandSoundSettings') ?? '{}').sounds?.complete?.id === 'none');
    await ui.capture('follow-system', { locator: card });
    await complete.selectOption('gem-collect');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('notifications.agentIslandSoundSettings') ?? '{}').sounds?.complete?.id === 'gem-collect');
    await ui.capture('event-sounds', { locator: card });
  },
};
