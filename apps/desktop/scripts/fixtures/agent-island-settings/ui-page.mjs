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
    await page.waitForFunction(expected => localStorage.getItem('notifications.agentIslandSubtleReminders') === expected,
      String(before !== 'true'));
    if (await toggle.getAttribute('aria-checked') === before) throw new Error('Reminder switch did not update');
    await ui.capture('toggled');
  },
};
