import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const desktop = fileURLToPath(new URL('../../../', import.meta.url));
const run = promisify(execFile);
const scanScript = `
  const path = require('node:path');
  const { scanClaudeCustomizations } = require('@cindy/maker-core/customization-scanner');
  const { buildSkillList } = require('./src/main/skillhub/skillListProjection.ts');
  const [root, hash] = process.argv.slice(1);
  const projectRoot = path.join(root, 'hf-parent');
  scanClaudeCustomizations({ workingDirs: [projectRoot] }).then((listed) => {
    const result = buildSkillList({
      projects: [{ projectRoot, hash }], listed, registryEntries: [], managedSkillRoots: [],
      builtInSkills: [], disabledPaths: [], userDataDir: root, appDataDir: root,
    });
    console.log(JSON.stringify({ success: true, ...result }));
  });
`;

async function writeSkill(root, name, description) {
  const folder = path.join(root, '.claude', 'skills', name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nSynthetic UI fixture.\n`);
}

const sessions = (roots) => roots.map((workingDir, index) => ({
  id: `fixture-${index}`, workingDir, workspaceKind: 'project', status: 'active',
  createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z',
  userSendAt: '2026-09-08T00:00:00Z', pinnedAt: null,
}));

export default {
  name: 'skillhub-projects',
  entry: './skillhub-projects-fixture.tsx',
  viewport: { width: 720, height: 760 },
  real: 'LocalSkillhubStoreSync, projectGrouping, SkillHub store, SkillhubHomeContent, local skill cards, InstallTargetPicker, and Claude filesystem discovery plus list projection in the refresh scenario',
  notCovered: 'Desktop IPC/utility-process transport, other engine discovery, account services, market requests and Skill mutations',
  stubs: {
    'src/renderer/contexts/AuthContext': `export const useAuth=()=>({dataOwnerId:'fixture',mode:'local',user:null,isAuthenticated:false});export const useOptionalAuthDeviceId=()=>null;export const useOptionalAuthUser=()=>null;export const useOptionalDataOwnerGeneration=()=>0;`,
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
    refresh: { about: 'Refresh in place after external global addition and project edit, retaining the list on failure', data: {
      sessions: sessions(['D:/Projects/hf-parent']), count: 1,
    } },
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
    if (ui.case === 'refresh' && ui.role !== 'before') {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-skills-refresh-'));
      const project = path.join(root, 'hf-parent');
      const refresh = page.getByRole('button', { name: await ui.t('skillhub.home.refreshLocal'), exact: true });
      const oldDescription = page.getByText('新增项目功能的协议与业务实现。', { exact: true });
      const newDescription = page.getByText('Updated project description from disk.', { exact: true });
      const globalSkill = page.getByText('fixture-global-skill', { exact: true });
      const failure = Promise.withResolvers();
      let requests = 0;
      try {
        await writeSkill(project, 'add-feature', '新增项目功能的协议与业务实现。');
        await page.exposeFunction('scanSyntheticSkillFiles', async ({ projects }) => {
          assert.deepEqual(projects.map(({ projectRoot }) => projectRoot), ['D:/Projects/hf-parent']);
          if (++requests === 1) return failure.promise;
          const { stdout } = await run(process.execPath, ['--import', 'tsx', '-e', scanScript, root, projects[0].hash], {
            cwd: desktop,
            env: {
              HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root,
              PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
            },
            timeout: 5000,
          });
          return JSON.parse(stdout);
        });
        await refresh.focus();
        await refresh.press('Enter');
        await refresh.and(page.locator('[aria-busy="true"]')).waitFor();
        assert.ok(await refresh.isDisabled());
        assert.ok(await oldDescription.isVisible());
        await ui.capture('scanning');

        failure.resolve({ success: false, error: 'Synthetic scan failure' });
        const error = page.getByRole('alert').filter({ hasText: await ui.t('skillhub.home.refreshLocalFailed') });
        await error.waitFor();
        assert.ok(await oldDescription.isVisible());
        await ui.capture('retained-on-error');

        await writeSkill(root, 'fixture-global-skill', 'New global Skill from disk.');
        await writeSkill(project, 'add-feature', 'Updated project description from disk.');
        assert.equal(await globalSkill.count(), 0);
        assert.ok(await oldDescription.isVisible());
        await refresh.click();
        await globalSkill.waitFor();
        await newDescription.waitFor();
        await error.waitFor({ state: 'detached' });
        assert.equal(await oldDescription.count(), 0);
        assert.equal(requests, 2);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    const count = ui.platform === 'win32' ? (ui.data.windowsCount ?? ui.data.count) : ui.data.count;
    assert.equal(await page.getByText('add-feature', { exact: true }).count(), count);
    if (count === 1) assert.equal(await page.getByText('hf-parent', { exact: true }).count(), 1);
  },
};
