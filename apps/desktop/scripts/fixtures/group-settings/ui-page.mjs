import assert from 'node:assert/strict';

const key = name => `bots.groupChat.server.settings.${name}`;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A settings row is one button whose name starts with its title and continues with its hint. */
const row = async (page, text) => page.getByRole('button', { name: new RegExp(`^${escape(text)}`) });

export default {
  name: 'group-settings',
  entry: './group-settings-fixture.tsx',
  viewport: { width: 1040, height: 860 },
  real: 'BotGroupSettingsDrawer, ChatGroupSettings (群设置 | 成员, 群管理, 编辑群资料, 本群资料, 伙伴在本群), ChatGroupMembersTab, ChatGroupInviteMenu, ChatBotAccessField, ProfileEditDialog',
  notCovered: 'Server writes (every chatServer.manage call is forbidden), the invite link dialog, AI 代答 (see group-mask), real accounts and mobile rendering',
  stubs: {
    // 新建伙伴 opens the full roster; it is not part of these settings.
    'src/renderer/features/bots/BotRosterView': 'export const BotRosterView = () => null;',
  },
  cases: {
    default: { about: 'Owner: 群管理 with 解散, member menus, invite menu with both items', data: { role: 'owner' } },
    admin: { about: 'Admin: 群管理 without 解散, cannot manage the owner', data: { role: 'admin' } },
    member: { about: 'Member: no 群管理, read-only 群介绍, 邀请朋友 locked', data: { role: 'member' } },
    'member-no-about': { about: 'Member of a group without 群介绍: the section is hidden', data: { role: 'member', noAbout: true } },
    alone: { about: 'Only the owner is left: notice, no 退出群聊', data: { role: 'owner', alone: true } },
    archived: { about: 'Archived group seen by its owner', data: { role: 'owner', archived: true } },
    dissolved: { about: 'Dissolved group: no invite, no personal sections', data: { role: 'member', dissolved: true } },
    'many-teammates': { about: '邀请伙伴 with 30 spare teammates: search and scrolling', data: { role: 'owner', spare: 30 } },
  },
  async ready(page) { await page.getByRole('dialog').waitFor(); },
  async check(page, ui) {
    const t = name => ui.t(key(name));
    const dialog = page.getByRole('dialog');
    const invite = page.getByTestId('chat-group-invite');
    const manage = await row(page, await t('manage'));
    const role = ui.case === 'default' || ['alone', 'archived', 'many-teammates'].includes(ui.case) ? 'owner' : ui.case === 'admin' ? 'admin' : 'member';

    if (ui.case === 'dissolved') {
      assert.equal(await invite.count(), 0, 'a dissolved group takes no invitations');
      await dialog.getByText(await ui.t('bots.groupChat.lifecycle.dissolved')).waitFor();
      assert.equal(await manage.count(), 0);
      return;
    }
    if (ui.case === 'alone') {
      await dialog.getByText(await t('soleOwnerHint')).waitFor();
      assert.equal(await (await row(page, await ui.t('bots.groupChat.lifecycle.leave'))).count(), 0, 'nobody to hand the group to');
      return;
    }
    if (ui.case === 'archived') {
      await dialog.getByText(await t('archived')).first().waitFor();
      await manage.click();
      await (await row(page, await t('unarchive'))).waitFor();
      await ui.capture('archived-manage');
      return;
    }
    if (ui.case === 'member-no-about') {
      assert.equal(await dialog.getByRole('heading', { name: await t('about') }).count(), 0, 'an empty 群介绍 is hidden from members');
      return;
    }

    // 邀请: two items; links only for owners and admins, teammates for everyone.
    await invite.click();
    const menu = page.getByTestId('chat-group-invite-menu');
    await menu.waitFor();
    const friends = menu.getByRole('menuitem', { name: new RegExp(escape(await t('inviteFriendsItem'))) });
    assert.equal(await friends.getAttribute('aria-disabled') === 'true', role === 'member');
    await ui.capture('invite-menu');
    await menu.getByRole('menuitem', { name: new RegExp(escape(await t('inviteBotsItem'))) }).click();
    if (ui.case === 'many-teammates') {
      const search = menu.getByRole('textbox', { name: await t('searchTeammates') });
      await search.waitFor();
      await ui.capture('invite-bots-many');
      await search.fill('伙伴 2');
      assert.ok(await menu.getByRole('menuitem', { name: '伙伴 2', exact: true }).count() === 1);
      await ui.capture('invite-bots-search');
      return;
    }
    await menu.getByRole('menuitem', { name: '伙伴 1', exact: true }).waitFor();
    // Teammates already in the group are not offered again.
    assert.equal(await menu.getByRole('menuitem', { name: 'Aster', exact: true }).count(), 0);
    await ui.capture('invite-bots');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });

    // 群设置: your own things first; 群管理 only for owners and admins.
    assert.equal(await manage.count(), role === 'member' ? 0 : 1);
    const edit = dialog.getByRole('button', { name: await t('edit'), exact: true });
    assert.equal(await edit.count(), role === 'member' ? 0 : 1, 'only managers edit 群介绍');

    // 成员: search and the ⋯ menu.
    await dialog.getByRole('tab', { name: new RegExp(escape(await ui.t('bots.groupChat.settings.members'))) }).click();
    const members = page.getByTestId('chat-group-members');
    await members.waitFor();
    await ui.capture('members');
    const menuFor = name => members.getByRole('button', { name, exact: true });
    if (role === 'owner') {
      await menuFor('Alex').click();
      await page.getByRole('menuitem', { name: await t('transfer'), exact: true }).waitFor();
      await ui.capture('member-menu-owner');
      await page.keyboard.press('Escape');
      // Ownership only goes to a person.
      await menuFor('Aster').click();
      await page.getByRole('menuitem', { name: await t('accessMenu'), exact: true }).waitFor();
      assert.equal(await page.getByRole('menuitem', { name: await t('transfer'), exact: true }).count(), 0);
      await page.keyboard.press('Escape');
    } else if (role === 'admin') {
      assert.equal(await menuFor('Alex').count(), 0, 'admins do not manage the owner');
      await menuFor('Lin').click();
      await page.getByRole('menuitem', { name: await t('makeAdmin'), exact: true }).waitFor();
      assert.equal(await page.getByRole('menuitem', { name: await t('transfer'), exact: true }).count(), 0);
      await page.keyboard.press('Escape');
    } else {
      assert.equal(await menuFor('Lin').count(), 0, 'members manage nobody');
      await menuFor('Aster').click();
      await page.getByRole('menuitem', { name: await t('accessMenu'), exact: true }).waitFor();
      await page.keyboard.press('Escape');
    }
    await dialog.getByRole('textbox', { name: await t('searchMembers') }).fill('zzz');
    await dialog.getByText(await ui.t(key('membersNoMatch'), { query: 'zzz' })).waitFor();
    await dialog.getByRole('tab', { name: await t('tabSettings') }).click();

    const back = dialog.getByRole('button', { name: await t('back'), exact: true });
    if (role !== 'member') {
      await manage.click();
      await back.waitFor();
      const dissolve = await row(page, await ui.t('bots.groupChat.lifecycle.dissolve'));
      assert.equal(await dissolve.count(), role === 'owner' ? 1 : 0, 'only the owner dissolves');
      if (role === 'owner') {
        await dialog.getByRole('switch', { name: await ui.t('bots.groupChat.settings.allowMentionAllBots'), exact: true }).waitFor();
        await dialog.getByText(await ui.t('bots.groupChat.settings.allowMentionAllBotsHint'), { exact: true }).waitFor();
      }
      await ui.capture('manage');
      await back.click();
      await edit.click();
      await dialog.getByRole('textbox').first().waitFor();
      await ui.capture('edit');
      await back.click();
    }

    // 伙伴在本群: three choices in second person.
    await (await row(page, 'Aster')).click();
    await dialog.getByRole('radiogroup').waitFor();
    await ui.capture('companion');
    await back.click();

    // 本群资料: nickname and the group-only avatar, without account profile controls.
    await (await row(page, 'Nana')).click();
    await dialog.getByRole('button', { name: await t('groupAvatar'), exact: true }).click();
    await page.getByText(await t('groupAvatarHint'), { exact: true }).last().waitFor();
    assert.equal(await page.getByRole('alertdialog').getByRole('textbox').count(), 0);
    await ui.capture('profile-avatar');
  },
};
