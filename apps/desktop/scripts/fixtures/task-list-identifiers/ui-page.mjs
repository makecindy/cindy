import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const avatar =
  'data:image/png;base64,' +
  readFileSync(
    new URL('../../../../mobile/assets/bot-presets/cindy.png', import.meta.url),
  ).toString('base64');
const storage = {
  'sidebar.mainListMode': 'list',
  'cc-agent.sidebar.filter.groupBy': 'flat',
  'cc-agent.sidebar.filter.sortBy': 'created',
  'cc-agent.sidebar.filter.groupAutomation': 'true',
  'cc-agent.sidebar.filter.groupDialogue': 'true',
  'cc-agent.sidebar.dialogueGroupCollapsed': '["all","automations:all"]',
  'cc-agent.sidebar.filter.taskInfo':
    '{"version":2,"fields":["pr","harness","project","teammate"]}',
};
export default {
  name: 'task-list-identifiers',
  entry: './fixture.tsx',
  viewport: { width: 348, height: 486 },
  real: 'ProjectsSection with scope header, collapsed groups, two-line SessionCard rows, PR and activity indicators and display menu',
  notCovered: 'Uses example sessions, local device, teammate assignments and PR snapshots.',
  stubs: {
    'src/renderer/features/device-link/useDeviceLinkDeviceList': {
      partial: 'export const useDeviceLinkDeviceList=()=>[];',
    },
    'src/renderer/features/scheduler/lib/scheduleSessionBinding': {
      partial:
        "export const useSessionBoundSchedules=id=>id==='example-1'?[{id:'schedule',name:'夜间构建',status:'active',manual:true}]:[];",
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
      partial: `const refs = Object.fromEntries([1,2,3,5].map(i => ['example-'+i,[{sessionId:'example-'+i, owner:'example',repo:'desktop',prNumber:1200+i}]])); export const usePrRefsForSession=id=>refs[id]??[]; export const usePrStatus=id=>({ok:true,status:id==='example-1'?'open':'merged',unresolvedCount:id==='example-1'?1:0});`,
    },
    'src/renderer/features/bots/botFollowScopes': {
      partial:
        "export const useSessionFollowers=s=>s.id==='example-2'?[{id:'demo',name:'Cindy',avatar:'cindy://avatar/preset/cindy',avatarColor:'blue'}]:[];",
    },
  },
  cases: {
    default: {
      about: 'Reclaim title space without losing message previews, PRs or activity',
      data: { avatar },
      storage,
    },
    visible: { about: 'List with the three identifiers enabled', data: { avatar }, storage },
  },
  async check(page, ui) {
    const first = page.locator('[data-session-id="example-0"]');
    await first.waitFor();
    const checkContext = async () => {
      for (const text of [
        '#1201',
        '#1202',
        '#1203',
        '#1205',
        await ui.t('ccAgent.sidebar.dialogues'),
        await ui.t('ccAgent.layout.automations'),
      ])
        await page.getByText(text, { exact: true }).first().waitFor();
      assert.equal(await page.locator('[data-sidebar-right-status="running"]').count(), 2);
      assert.equal(await page.locator('[data-sidebar-right-status="done"]').count(), 2);
      for (const id of [0, 1, 2, 3, 4, 5])
        assert.ok(
          (await page.locator('[data-session-id="example-' + id + '"] p').innerText()).trim(),
        );
    };
    await checkContext();
    await ui.capture('before');
    if (ui.case === 'visible') return;
    await page
      .locator('button')
      .filter({ has: page.locator('svg.lucide-sliders-horizontal') })
      .click({ force: true });
    await page
      .getByRole('menuitem')
      .filter({ hasText: await ui.t('ccAgent.sidebar.taskInfoHeading') })
      .first()
      .press('ArrowRight');
    for (const field of ['harness', 'project', 'teammate'])
      await page
        .getByRole('menuitemcheckbox', {
          name: await ui.t('ccAgent.sidebar.taskInfo.' + field),
          exact: true,
        })
        .click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.mouse.click(2, 2);
    await page.mouse.move(0, 0);
    await page.getByRole('tooltip').waitFor({ state: 'hidden' });
    await first.locator('[data-project-source]').waitFor({ state: 'detached' });
    assert.equal(await page.getByTestId('bot-follow-mark').count(), 0);
    await checkContext();
    await ui.capture('after');
  },
};
