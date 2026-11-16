import { AppFrame, forbid, mountPage, subscription } from '../../ui-page/harness';
import { LocalSkillhubStoreSync } from '../../../src/renderer/features/skillhub/SkillhubFeatureLayout';
import { SkillhubHomeContent } from '../../../src/renderer/features/skillhub/SkillhubHomeView';
import { InstallTargetPicker } from '../../../src/renderer/features/skillhub/components/InstallTargetPicker';

void mountPage({
  route: '/skillhub/local?tab=local',
  host: {
    onAuthStateChange: subscription('authState'),
    skillhub: {
      onLocalStateChanged: subscription('skills'),
      registry: { getByName: async () => ({
        success: true,
        manifest: { installs: { '//server/share/hf-parent/.agents/skills/add-feature': { version: '1.2.3' } } },
      }) },
      // Each requested project supplies the same scenario Skill. The real
      // collector/store must collapse casing aliases before they reach this API.
      scan: async ({ projects }: { projects: Array<{ projectRoot: string; hash: string }> }) => ({
        success: true, sources: [], learnSkillEnabled: true,
        skills: projects.map(({ projectRoot, hash }) => ({
          id: `claude-code:skill:project:${hash}:add-feature`,
          urlKey: `skill:project:${hash}:add-feature`,
          engine: 'claude-code', linkedEngines: [{ engine: 'claude-code', label: 'Claude' }],
          kind: 'skill', scope: 'project', name: 'add-feature', description: '新增项目功能的协议与业务实现。',
          absolutePath: `${projectRoot}/.agents/skills/add-feature`,
          discoveredPath: `${projectRoot}/.agents/skills/add-feature`,
          mdPath: `${projectRoot}/.agents/skills/add-feature/SKILL.md`,
          files: [], registryEntry: null, projectRoot, projectHash: hash, cindyEnabled: true,
        })),
      }),
      pickLocal: forbid('skillhub.pickLocal'),
      install: forbid('skillhub.install'),
      reconcileMineRegistry: forbid('skillhub.reconcileMineRegistry'),
    },
  },
  render: ({ data }) => <AppFrame header={false}>{data.picker
    ? <InstallTargetPicker open skill={{ name: 'add-feature' }} onClose={() => {}} onInstallComplete={() => {}} />
    : <><LocalSkillhubStoreSync /><SkillhubHomeContent embedded /></>}
  </AppFrame>,
});
