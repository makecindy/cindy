import assert from 'node:assert/strict';
export default {
  name: 'teammate-task-filter', entry: './fixture.tsx', viewport: { width: 840, height: 640 },
  real: 'SidebarFilterPopover, useSidebarFilter persistence/reset, task creator matching and BotFollowMark with real themes and translations',
  notCovered: 'Live cross-device transport and host database reads; task/roster snapshots are fixture data. Pinned exemptions remain in the full sidebar.',
  stubs: {
    'src/renderer/features/bots/botStore': `const bots = [{id:'cindy-default',name:'Cindy',avatar:'',avatarColor:'blue',enabled:true,status:'active'}, { id:'dash',name:'Dash',avatar:'',avatarColor:'blue',enabled:true,status:'active' }]; export const useBotProfiles=()=>bots; export const hasLoadedBotProfiles=()=>true; export const ensureBotProfilesLoaded=async()=>bots;`,
    'src/renderer/features/bots/useRemoteBots': `const bots = [{id:'remote-cindy',templateId:'cindy',name:'Cindy',avatar:'',avatarColor:'blue',deviceId:'laptop',deviceName:'MacBook Pro',delegatedSessionIds:['cindy-remote']},{id:'lizi',name:'Lizi',avatar:'',avatarColor:'green',deviceId:'laptop',deviceName:'MacBook Pro',followingSessionIds:[],delegatedSessionIds:['remote']}]; export const useRemoteBots=()=>bots; const ids = new Set(['remote-cindy']); export const useRemoteCindyIds=()=>ids;`,
    'src/renderer/features/device-link/useMachineSwitcher': `export const useEffectiveSelectedMachineId=()=> 'all';`,
    'src/renderer/features/cc-agent/hooks/useRemoteHostProjectOrders': `export const useLocalHostProjectOrder=()=>({snapshot:undefined}); export const useRemoteHostProjectOrders=()=>({orders:new Map()}); export const projectOrderWriteScopeForSelection=()=>({kind:'viewer'}); export const controllerManualOrderForDevice=()=>[];`,
  },
  cases: {
    default: { about: 'Legacy choice migration → one Cindy across computers → unrestricted → single/multiple/reset; archived creator avatar' },
    'task-info': { about: 'Hide the three row identifiers independently in the task information menu' },
    layout: { about: 'Every submenu of the display settings menu: grouping, sorting, the harness list with a plugin harness, hiding and task information' },
    'task-status': { about: 'Task status is chosen in place; viewing archived tasks no longer marks the menu or its button' },
  },
  async check(page, ui) {
    if (ui.case === 'task-info') {
      const info = page.getByRole('menuitem').filter({ hasText: await ui.t('ccAgent.sidebar.taskInfoHeading') }).first();
      await info.press('ArrowRight');
      for (const field of ['harness', 'project', 'teammate']) {
        const item = page.getByRole('menuitemcheckbox', { name: await ui.t('ccAgent.sidebar.taskInfo.' + field), exact: true });
        assert.equal(await item.getAttribute('aria-checked'), 'true');
        await item.click();
        assert.equal(await item.getAttribute('aria-checked'), 'false');
      }
      await ui.capture('hidden-identifiers');
      return;
    }
    if (ui.case === 'layout') {
      const row = async (key) => page.getByRole('menuitem', { name: new RegExp(`^${await ui.t(key)}`) }).first();
      // One submenu at a time: wait for the previous one to close before opening the next.
      const openOnly = async (key, name) => {
        await page.waitForFunction(() => document.querySelectorAll('[role="menu"]').length === 1);
        await (await row(key)).press('ArrowRight');
        await page.waitForFunction(() => document.querySelectorAll('[role="menu"]').length === 2);
        await ui.capture(name);
      };
      await openOnly('ccAgent.sidebar.filterGroupByHeading', 'grouping');
      assert.equal(await page.getByRole('menuitemcheckbox').count(), 4, 'Device, project, chat and automation');
      await page.keyboard.press('ArrowLeft');
      await openOnly('ccAgent.sidebar.filterSortByHeading', 'sorting');
      await page.keyboard.press('ArrowLeft');
      await openOnly('ccAgent.sidebar.hideHeading', 'hiding');
      await page.keyboard.press('ArrowLeft');
      await openOnly('ccAgent.sidebar.taskInfoHeading', 'task-information');
      await page.keyboard.press('ArrowLeft');
      await openOnly('ccAgent.sidebar.filterHeading', 'filters');
      await (await row('ccAgent.sidebar.filterAgentHeading')).press('ArrowRight');
      // The plugin's harness sits under the three built-in ones and can be chosen with them.
      const orbit = page.getByRole('menuitemcheckbox', { name: 'Orbit', exact: true });
      await orbit.click();
      await page.getByRole('menuitemcheckbox', { name: await ui.t('ccAgent.sidebar.filterVendor.pi'), exact: true }).click();
      assert.equal(await orbit.getAttribute('aria-checked'), 'true');
      assert.equal(await page.getByRole('menuitemcheckbox', { name: await ui.t('ccAgent.sidebar.filterVendor.cc'), exact: true }).getAttribute('aria-checked'), 'false');
      await ui.capture('harnesses');
      return;
    }
    if (ui.case === 'task-status') {
      const statusRow = page.getByRole('menuitem', { name: new RegExp(`^${await ui.t('ccAgent.sidebar.taskStatusHeading')}`) });
      for (const value of ['archived', 'all', 'active']) {
        const choice = statusRow.getByRole('radio', { name: await ui.t(`ccAgent.sidebar.taskStatus.${value}`), exact: true });
        await choice.click();
        assert.equal(await choice.getAttribute('aria-checked'), 'true');
        // 2026-11-28 user decision: no reminder dot for archived tasks, on the row or on the button.
        assert.equal(await page.locator('[data-filter-reminder]').count(), 0);
        if (value === 'archived') await ui.capture('archived');
      }
      return;
    }
    const rows = page.locator('[data-task]');
    assert.equal(await rows.count(), 4);
    const creatorsHeading = await ui.t('ccAgent.sidebar.filterCreatorsHeading');
    // Wait for each panel to open or close before the next key: keys sent mid-animation go astray.
    const menus = (count) => page.waitForFunction((n) => document.querySelectorAll('[role="menu"]').length === n, count);
    const menuRow = async (key) => page.getByRole('menuitem', { name: new RegExp(`^${await ui.t(key)}`) }).first();
    const openSubmenu = async (key, depth) => {
      await (await menuRow(key)).press('ArrowRight');
      await menus(depth);
    };
    const openCreators = async () => {
      await openSubmenu('ccAgent.sidebar.filterHeading', 2);
      await openSubmenu('ccAgent.sidebar.filterCreatorsHeading', 3);
    };
    await openCreators();
    const cindy = page.getByRole('menuitemcheckbox', { name: 'Cindy', exact: true });
    assert.equal(await cindy.count(), 1);
    assert.equal(await cindy.getAttribute('aria-checked'), 'true');
    await page.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.filterCreatorsAny'), exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-task]').length === 7);
    await page.locator('[data-task="remote"] [data-testid="bot-follow-mark"]').waitFor();
    // Hiding every teammate's tasks is a kind under 「隐藏」, beside the filters (2026-11-28 user decision).
    await page.keyboard.press('ArrowLeft');
    await menus(2);
    await page.keyboard.press('ArrowLeft');
    await menus(1);
    await openSubmenu('ccAgent.sidebar.hideHeading', 2);
    const hideTeammates = page.getByRole('menuitemcheckbox', { name: await ui.t('ccAgent.sidebar.hideOptions.teammates'), exact: true });
    await hideTeammates.click();
    await page.waitForFunction(() => document.querySelectorAll('[data-task]').length === 1);
    assert.equal(await rows.getAttribute('data-task'), 'owner');
    assert.equal(await hideTeammates.getAttribute('aria-checked'), 'true');
    await ui.capture('hide-all');
    // Choosing a teammate under 筛选 › 伙伴 replaces "hide all" with "only these".
    await page.keyboard.press('ArrowLeft');
    await menus(1);
    await openCreators();
    const local = page.getByRole('menuitemcheckbox', { name: 'Dash', exact: true });
    const remote = page.getByRole('menuitemcheckbox', { name: 'Lizi MacBook Pro', exact: true });
    await local.click();
    await page.waitForFunction(() => document.querySelectorAll('[data-task]').length === 1);
    assert.equal(await page.locator('[data-task]').getAttribute('data-task'), 'local');
    await remote.click();
    await page.waitForFunction(() => document.querySelectorAll('[data-task]').length === 2);
    await local.click();
    await page.waitForFunction(() => document.querySelectorAll('[data-task]').length === 1);
    assert.equal(await page.locator('[data-task]').getAttribute('data-task'), 'remote');
    const all = page.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.filterCreatorsAny'), exact: true });
    await all.click();
    await page.waitForFunction(() => document.querySelectorAll('[data-task]').length === 7);
    await local.click();
    await local.press('ArrowLeft');
    await page.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.filterReset'), exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-task]').length === 7);
    await page.getByRole('menuitem').filter({ hasText: creatorsHeading }).last().hover();
    await page.getByRole('menuitem').filter({ hasText: creatorsHeading }).last().press('ArrowRight');
    await local.click();
    await remote.click();
    assert.equal(await local.getAttribute('aria-checked'), 'true');
    assert.equal(await remote.getAttribute('aria-checked'), 'true');
    await all.click();
    await cindy.click();
    await page.waitForFunction(() => document.querySelectorAll('[data-task]').length === 4);
    assert.deepEqual(await rows.evaluateAll(rows => rows.map(row => row.dataset.task)), ['cindy-local', 'cindy-remote', 'routine', 'channel']);
    for (const id of ['routine', 'channel']) {
      const mark = page.locator(`[data-task="${id}"] [data-testid="bot-follow-mark"]`);
      assert.equal(await mark.getAttribute('aria-label'), await ui.t('bots.workbench.ownedMark', { names: 'Cindy' }));
    }
  },
};
