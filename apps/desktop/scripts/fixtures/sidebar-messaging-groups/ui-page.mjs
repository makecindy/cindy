import assert from 'node:assert/strict';

// 主列表「按消息平台」分组(docs/product-rules/sidebar-redesign-plan.md §3.1)。
const storage = {
  'sidebar.mainListMode': 'text',
  'cc-agent.sidebar.filter.groupBy': 'project',
  'cc-agent.sidebar.filter.sortBy': 'recency',
  'cc-agent.sidebar.filter.groupDialogue': 'true',
  'cc-agent.sidebar.filter.groupAutomation': 'true',
};
const grouped = { ...storage, 'cc-agent.sidebar.filter.groupMessaging': 'true' };

export default {
  name: 'sidebar-messaging-groups',
  entry: './fixture.tsx',
  viewport: { width: 348, height: 520 },
  real: 'ProjectsSection main list (project row, chat group, messaging platform groups) and the grouping options of the display menu',
  notCovered:
    'Uses example tasks on this computer only. Device sections, the flat list, manual project order and real sessions created by a messaging platform are not exercised.',
  stubs: {
    'src/renderer/features/device-link/useDeviceLinkDeviceList': {
      partial: 'export const useDeviceLinkDeviceList=()=>[];',
    },
    'src/renderer/features/scheduler/lib/scheduleSessionBinding': {
      partial: 'export const useSessionBoundSchedules=()=>[];',
    },
    'src/renderer/contexts/AuthContext': {
      partial: 'export const useAuth = () => ({dataOwnerId:"fixture", isAuthenticated:false});',
    },
    'src/renderer/features/device-link/useMachineSwitcher': {
      partial:
        "export const useEffectiveSelectedMachineId=()=> 'all'; export const useMachineSwitcher=()=>({devices:[],selectedDeviceId:'all'}); export const useRemoteSessionBootstrapLoading=()=>false;",
    },
    'src/renderer/features/cc-agent/hooks/useRemoteHostProjectOrders': {
      partial:
        "export const useLocalHostProjectOrder=()=>({snapshot:undefined}); export const useRemoteHostProjectOrders=()=>({orders:new Map()}); export const projectOrderWriteScopeForSelection=()=>({kind:'viewer'});",
    },
    'src/renderer/contexts/PrRefsContext': {
      partial:
        'export const usePrRefsForSession=()=>[]; export const usePrStatus=()=>({ok:true,status:null,unresolvedCount:0});',
    },
    'src/renderer/features/bots/botFollowScopes': {
      partial: 'export const useSessionFollowers=()=>[];',
    },
  },
  cases: {
    default: {
      about: 'Option off (the default): tasks from Feishu and Slack stay in the chat group',
      storage,
    },
    on: {
      about: 'Grouped by messaging platform: one group per platform beside the chat group',
      storage: grouped,
    },
    menu: {
      about: 'Turning the option on from the display menu regroups the list in place',
      storage,
      // 比侧栏宽:「分组」子菜单在右侧展开,截图里能看到全部选项。
      viewport: { width: 820, height: 520 },
    },
  },
  async check(page, ui) {
    const chats = await ui.t('ccAgent.sidebar.dialogues');
    const feishu = await ui.t('settings.feishuBot.services.feishu');
    const slack = await ui.t('settings.tina.prefs.providerSlack');
    // 组头标题就是组名;任务行标题带「[飞书·DM]」之类的前缀,不会与组名的精确匹配撞上。
    const header = (name) => page.getByText(name, { exact: true });
    // 组头(role=button)的父节点就是这一组:组头 + 组内任务。
    const group = (name) => header(name).locator('xpath=ancestor::div[@role="button"][1]/..');
    const row = (scope, index) => scope.locator('[data-session-id="messaging-' + index + '"]');
    await header(chats).first().waitFor();

    const expectPlatformGroups = async () => {
      await header(feishu).waitFor();
      await header(slack).waitFor();
      // 飞书来的三条无项目任务在飞书组里,不在「对话」组里;对话组只剩本机对话。
      for (const index of [0, 3, 6]) {
        assert.equal(await row(group(feishu), index).count(), 1, 'Feishu task ' + index + ' in the Feishu group');
        assert.equal(await row(group(chats), index).count(), 0, 'Feishu task ' + index + ' left the chat group');
      }
      assert.equal(await row(group(slack), 4).count(), 1);
      for (const index of [1, 7]) assert.equal(await row(group(chats), index).count(), 1);
      // 落在项目里的飞书任务不进平台组。
      assert.equal(await row(group(feishu), 5).count(), 0);
    };

    if (ui.case === 'default') {
      assert.equal(await header(feishu).count(), 0);
      assert.equal(await header(slack).count(), 0);
      // 飞书与 Slack 来的任务和本机对话一起排在「对话」组里(组内只先显示前几条)。
      for (const index of [0, 1, 3, 4, 6]) assert.equal(await row(group(chats), index).count(), 1);
      return;
    }
    if (ui.case === 'on') {
      await expectPlatformGroups();
      return;
    }

    // menu:从显示设置菜单勾选「消息平台」,列表原地重排。
    await page
      .locator('button')
      .filter({ has: page.locator('svg.lucide-sliders-horizontal') })
      .click({ force: true });
    await page
      .getByRole('menuitem')
      .filter({ hasText: await ui.t('ccAgent.sidebar.filterGroupByHeading') })
      .first()
      .press('ArrowRight');
    const option = page.getByRole('menuitemcheckbox', {
      name: await ui.t('ccAgent.sidebar.filterGroupBy.messaging'),
      exact: true,
    });
    await option.waitFor();
    assert.equal(await option.getAttribute('aria-checked'), 'false');
    await ui.capture('menu');
    await option.click();
    assert.equal(await option.getAttribute('aria-checked'), 'true');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.mouse.click(2, 2);
    await page.mouse.move(0, 0);
    await expectPlatformGroups();
  },
};
