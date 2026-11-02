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
    'archived-reminder': { about: 'Display settings → Task status → Archived shows reminder at every level; Active/All clear it' },
  },
  async check(page, ui) {
    if (ui.case === 'archived-reminder') {
      const statusRow = page.getByRole('menuitem').filter({ hasText: await ui.t('ccAgent.sidebar.taskStatusHeading') }).first();
      await statusRow.press('ArrowRight');
      const archived = page.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.taskStatus.archived'), exact: true });
      for (const reset of ['all', 'active']) {
        await archived.click();
        await statusRow.locator('[data-filter-reminder]').waitFor();
        assert.equal(await archived.locator('[data-filter-reminder]').count(), 1);
        assert.equal(await page.locator('button [data-filter-reminder]').count(), 1);
        await ui.capture(`archived-before-${reset}`);
        await page.getByRole('menuitem', { name: await ui.t(`ccAgent.sidebar.taskStatus.${reset}`), exact: true }).click();
        assert.equal(await page.locator('[data-filter-reminder]').count(), 0);
      }
      return;
    }
    const rows = page.locator('[data-task]');
    assert.equal(await rows.count(), 4);
    const filterHeading = await ui.t('ccAgent.sidebar.filterHeading');
    const creatorsHeading = await ui.t('ccAgent.sidebar.filterCreatorsHeading');
    await page.getByRole('menuitem').filter({ hasText: filterHeading }).last().press('ArrowRight');
    await page.getByRole('menuitem').filter({ hasText: creatorsHeading }).last().press('ArrowRight');
    const cindy = page.getByRole('menuitemcheckbox', { name: 'Cindy', exact: true });
    assert.equal(await cindy.count(), 1);
    assert.equal(await cindy.getAttribute('aria-checked'), 'true');
    await page.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.filterCreatorsAny'), exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-task]').length === 7);
    await page.locator('[data-task="remote"] [data-testid="bot-follow-mark"]').waitFor();
    await page.getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.filterCreatorsNone'), exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-task]').length === 1);
    assert.equal(await rows.getAttribute('data-task'), 'owner');
    await ui.capture('hide-all');
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
