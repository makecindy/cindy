import assert from 'node:assert/strict';

export default {
  name: 'group-notifications',
  entry: './group-notifications-fixture.tsx',
  viewport: { width: 560, height: 900 },
  real: 'ChatGroupSettings personal notification control, real Select, translations and themes',
  notCovered: 'Network persistence, native system alerts and mobile rendering; account and stores use fixtures',
  stubs: {
    'src/renderer/features/bots/botStore': 'export const useBotProfiles = () => [];',
    'src/renderer/features/bots/botGroupStore': 'export const refreshBotGroups = () => {};',
    'src/renderer/features/bots/ChatServerControls': 'export const chatErrorKey = () => "bots.groupChat.server.requestFailed";',
    'src/renderer/features/bots/BotRosterView': 'export const BotRosterView = () => null;',
  },
  cases: {
    default: { about: 'Ordinary member can choose and save a personal notification preference' },
    mentions: { about: 'Mentions-only explanation includes existing work split reminders' },
    none: { about: 'Off keeps unread messages' },
    failure: { about: 'Rejected write keeps confirmed value and displays a localized error' },
    saving: { about: 'Pending write disables repeated edits' },
  },
  async check(page, ui) {
    const key = 'bots.groupChat.server.settings.notifications.';
    const control = page.getByRole('combobox', { name: await ui.t(key + 'title'), exact: true });
    await control.evaluate(node => node.scrollIntoView({ block: 'center' }));
    await ui.capture('personal-settings');
    if (ui.case === 'mentions' || ui.case === 'none') return;
    await control.click();
    await ui.capture('choices');
    await page.getByRole('option', { name: await ui.t(key + 'mentions'), exact: true }).click();
    if (ui.case === 'failure') {
      await page.getByRole('alert').waitFor();
      assert.ok((await control.textContent()).includes(await ui.t(key + 'all')));
    } else if (ui.case === 'saving') assert.equal(await control.isDisabled(), true);
    else await page.getByText(await ui.t(key + 'mentionsHint'), { exact: true }).waitFor();
    await ui.capture(ui.case === 'default' ? 'saved' : ui.case);
  },
};
