import assert from 'node:assert/strict';

const sessions = (roots) => roots.map((workingDir, index) => ({
  id: `fixture-${index}`, workingDir, workspaceKind: 'project', status: 'active',
  createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z',
  userSendAt: '2026-09-08T00:00:00Z', pinnedAt: null,
}));

export default {
  name: 'skillhub-projects',
  entry: './skillhub-projects-fixture.tsx',
  viewport: { width: 720, height: 760 },
  real: 'LocalSkillhubStoreSync, projectGrouping, SkillHub store, SkillhubHomeContent, local skill cards and InstallTargetPicker',
  notCovered: 'Real filesystem discovery, account services, market requests and Skill mutations; scanner deduplication has separate unit coverage',
  stubs: {
    'src/renderer/contexts/AuthContext': `export const useAuth=()=>({dataOwnerId:'fixture',mode:'local',user:null,isAuthenticated:false});export const useOptionalAuthDeviceId=()=>null;export const useOptionalAuthUser=()=>null;`,
    'src/renderer/hooks/useCCSessions': `export const useCCSessions=()=>({sessions:window.__uiPage.ctx.data.sessions,isLoading:false});`,
    'src/renderer/features/cc-agent/useRegisterCCAgentSidebar': `export const useRegisterCCAgentSidebar=()=>{};`,
    'src/renderer/features/skillhub/hooks/useMarketList': `export const MARKET_PAGE_SIZE=24;export const deriveLocalInstall=()=>undefined;export const useCategoryList=()=>({categories:[]});const noop=()=>{};export const useMarketList=()=>({items:[],loading:false,loadingMore:false,hasMore:false,resolvedScope:'market',resolvedMine:false,setSearchQuery:noop,setSortBy:noop,setCatalogScope:noop,setCategoryFilter:noop,setVisibility:noop,loadMore:noop,reload:noop});`,
    'src/renderer/features/skillhub/hooks/useMarketManagement': `export const useMarketManagement=()=>({});export const MarketManagementDialogs=()=>null;`,
    // Lazy detail panels import chat/voice modules; recording is outside this
    // catalogue scenario and its worklet asset requires Vite's full app loader.
    'src/renderer/voice-input/useVoiceInput': `export const useVoiceInput=()=>({});`,
  },
  cases: {
    'installed-unc': { about: 'Merged UNC project stays installed instead of being misclassified as global', data: {
      picker: true, sessions: sessions(['//Server/Share/hf-parent', '//server/share/hf-parent']),
      selectedInstallPath: '//Server/Share/hf-parent/.agents/skills/add-feature',
    } },
    default: { about: 'Drive-path casing aliases merge on Windows and remain distinct on POSIX', data: { sessions: sessions(['D:/Projects/hf-parent', 'd:/projects/hf-parent']), count: 2, windowsCount: 1 } },
    unc: { about: 'UNC casing aliases merge on Windows and remain distinct on POSIX', data: { sessions: sessions(['//Server/Share/hf-parent', '//server/share/hf-parent']), count: 2, windowsCount: 1 } },
    worktrees: { about: 'Separate working directories retain separate Skill sections', data: { sessions: sessions(['D:/Projects/hf-parent', 'D:/Projects/hf-parent/.cindy-worktrees/task']), count: 2 } },
  },
  async ready(page) {
    const picker = await page.evaluate(() => window.__uiPage.ctx.data.picker);
    if (picker) await page.getByText('v1.2.3', { exact: true }).waitFor();
    else await page.getByText('add-feature', { exact: true }).first().waitFor();
  },
  async check(page, ui) {
    if (ui.data.picker) {
      const dialog = page.getByRole('dialog');
      const project = dialog.getByRole('button').filter({ has: page.getByText(ui.data.selectedInstallPath, { exact: true }) });
      const global = dialog.getByRole('button').filter({ has: page.getByText('~/.agents/skills/add-feature', { exact: true }) });
      assert.equal(await project.isDisabled(), ui.platform === 'win32');
      assert.equal(await global.isDisabled(), false);
      if (ui.platform === 'win32') assert.equal(await project.getByText('v1.2.3', { exact: true }).count(), 1);
      else {
        const installed = dialog.getByRole('button').filter({ has: page.getByText('//server/share/hf-parent/.agents/skills/add-feature', { exact: true }) });
        assert.equal(await installed.isDisabled(), true);
        assert.equal(await installed.getByText('v1.2.3', { exact: true }).count(), 1);
      }
      return;
    }
    const count = ui.platform === 'win32' ? (ui.data.windowsCount ?? ui.data.count) : ui.data.count;
    assert.equal(await page.getByText('add-feature', { exact: true }).count(), count);
    if (count === 1) assert.equal(await page.getByText('hf-parent', { exact: true }).count(), 1);
  },
};
