import assert from 'node:assert/strict';

export default {
  name: 'group-avatar',
  entry: './group-avatar-fixture.tsx',
  viewport: { width: 560, height: 900 },
  real: 'ChatGroupSettings and ProfileEditDialog, real controls, translations and Light/Dark themes',
  notCovered: 'Real login, image uploads, server persistence and mobile rendering; network and stores use fixture data',
  stubs: {
    'src/renderer/features/bots/botStore': 'export const useBotProfiles = () => [];',
    'src/renderer/features/bots/botGroupStore': 'export const refreshBotGroups = () => {};',
    'src/renderer/features/bots/ChatServerControls': 'export const chatErrorKey = () => "bots.groupChat.server.requestFailed";',
  },
  cases: {
    default: { about: 'Group-only avatar editor, without account profile controls' },
    'human-owner': { about: 'Only human group members have an ownership transfer action' },
  },
  async check(page, ui) {
    const key = 'bots.groupChat.server.settings.';
    if (ui.case === 'human-owner') {
      await page.getByRole('button', { name: /Companion/ }).click();
      assert.equal(await page.getByRole('button', { name: await ui.t(key + 'transfer'), exact: true }).count(), 0);
      await ui.capture('companion-no-transfer');
      await page.getByRole('button', { name: /Alex/ }).click();
      await page.getByRole('button', { name: await ui.t(key + 'transfer'), exact: true }).waitFor();
      await ui.capture('human-transfer');
      await page.getByRole('button', { name: await ui.t(key + 'transfer'), exact: true }).click();
      await page.getByText(await ui.t(key + 'transferHint'), { exact: true }).waitFor();
      await ui.capture('human-transfer-confirmation');
      return;
    }
    const edit = page.getByRole('button', { name: await ui.t(key + 'groupAvatar'), exact: true });
    await edit.click();
    await page.getByText(await ui.t(key + 'groupAvatarHint'), { exact: true }).waitFor();
    assert.equal(await page.getByRole('alertdialog').getByRole('textbox').count(), 0);
    await ui.capture('group-avatar-dialog');
  },
};
